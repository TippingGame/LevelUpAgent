// Isolated native provider-wait regression. Prepare after pnpm build, then build with:
// pnpm tauri build --debug --no-bundle --config artifacts/provider-wait-review/tauri.json
// Run with LEVELUP_PLAYWRIGHT_MODULE pointing to an installed Playwright module.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = resolve("artifacts/provider-wait-review");
const identifier = "com.levelup.agent.providerwaitqa";
const expectedVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
const serverPort = 1458;
await mkdir(output, { recursive: true });

if (process.argv.includes("--prepare")) {
  const frontend = resolve(output, "dist");
  await cp(resolve("dist"), frontend, { recursive: true });
  await writeFile(resolve(frontend, "review.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="review-init.js"></script></body></html>');
  await writeFile(resolve(frontend, "review-init.js"), `
const profile = { id: "provider-wait-qa", name: "Provider Wait QA", baseUrl: "http://127.0.0.1:${serverPort}", model: "qa-model", protocol: "openai_responses", allowUnauthenticated: true, priority: 0, failoverEnabled: false };
localStorage.setItem("levelup-agent.profiles.v1", JSON.stringify([profile]));
localStorage.setItem("levelup-agent.active-profile.v1", profile.id);
localStorage.setItem("levelup-agent-locale", "en-US");
location.replace("index.html");
`);
  await writeFile(resolve(output, "tauri.json"), JSON.stringify({
    productName: "LevelUpAgent Provider Wait QA", identifier,
    build: { beforeBuildCommand: "", frontendDist: "../artifacts/provider-wait-review/dist" },
    app: { windows: [{ label: "main", title: "LevelUpAgent Provider Wait QA", url: "review.html", visible: false, width: 1440, height: 920 }] },
    bundle: { active: false },
  }, null, 2));
  console.log("Prepared isolated desktop provider-wait fixture.");
  process.exit(0);
}

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : "playwright");
let requestCount = 0;
let currentCase = "stream";
let pendingResponse;
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  for await (const _ of request) { /* drain the request body */ }
  requestCount++;
  if (requestCount === 1) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end('{"error":{"message":"temporary upstream failure"}}');
    return;
  }
  pendingResponse = response;
  if (currentCase !== "headers") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.flushHeaders();
    response.write('data: {"type":"response.created"}\n\n');
  }
});
await new Promise((done, fail) => { server.once("error", fail); server.listen(serverPort, "127.0.0.1", done); });
let child;
let browser;
let page;
let verified = false;
const errors = [];
const cases = [];
const threadId = `wait-qa-${Date.now()}`;
async function until(check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Timed out waiting for desktop provider-wait QA");
}
async function invoke(command, args) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`Native command timed out: ${command}`)), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function launch() {
  verified = false;
  const portProbe = createServer();
  await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
  const debugPort = portProbe.address().port;
  await new Promise((done) => portProbe.close(done));
  child = spawn(resolve("src-tauri/target/debug/levelup-agent.exe"), [], {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
  });
  await until(() => fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json()).then((tabs) => tabs.some((tab) => tab.url.includes("index.html"))).catch(() => false));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("index.html"));
  assert.equal(await invoke("plugin:app|identifier"), identifier, "Never use the production application for this test");
  assert.equal(await invoke("plugin:app|version"), expectedVersion, "Verify the current release version");
  verified = true;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".composer textarea").waitFor();
}
async function close() {
  if (verified && page && !page.isClosed()) {
    const closed = page.waitForEvent("close");
    await invoke("plugin:window|close", { label: "main" }).catch(() => {});
    await closed;
  }
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    // This is only the isolated, hidden process created by this test.
    const exited = new Promise((done) => child.once("exit", done));
    child.kill();
    await exited;
  }
}

try {
  await launch();
  await invoke("save_thread", { thread: {
    id: threadId, title: threadId, updatedAt: Date.now(),
    inputTokens: 0, outputTokens: 0, messages: [{
      id: `${threadId}-seed`, role: "user", content: `Ready: ${threadId}`,
      createdAt: Date.now(), toolCalls: [], attachments: [],
    }],
  } });
  await page.evaluate((id) => localStorage.setItem("levelup-agent.active-thread.v1", id), threadId);
  await page.reload();
  await page.locator(".composer textarea").waitFor();
  await page.getByText(`Ready: ${threadId}`, { exact: true }).waitFor();
  await page.setViewportSize({ width: 720, height: 920 });
  for (const [index, variant] of [
    { scheme: "light", armor: false, phase: "stream", cancel: false },
    { scheme: "dark", armor: true, phase: "headers", cancel: true },
    { scheme: "light", armor: true, phase: "stream", cancel: true },
    { scheme: "dark", armor: false, phase: "stream", cancel: false },
  ].entries()) {
    currentCase = variant.phase;
    pendingResponse = undefined;
    await page.emulateMedia({ colorScheme: variant.scheme });
    const armor = page.locator(".armor-toggle");
    if ((await armor.getAttribute("aria-pressed") === "true") !== variant.armor) await armor.click();
    await page.locator(".composer textarea").fill(`PROVIDER_WAIT_QA ${index + 1}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const waiting = page.locator(".assistant-status-segment.waiting");
    await waiting.waitFor({ timeout: 45_000 });
    assert.match(await waiting.innerText(), /waiting 30s/);
    assert.match(await waiting.innerText(), variant.phase === "headers" ? /90s/ : /300s/);
    if (index === 0) {
      assert.equal(await page.locator(".assistant-status-segment.reconnecting").count(), 1, "Headers alone must not announce recovery");
      assert.equal(await page.locator(".assistant-status-segment.reconnected").count(), 0);
    }
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await stop.hover();
    await stop.focus();
    const file = `${variant.scheme}-armor-${variant.armor ? "on" : "off"}.png`;
    await page.screenshot({ path: resolve(output, file), fullPage: true });
    const overflow = await waiting.evaluate((element) => element.scrollWidth > element.clientWidth + 2);
    assert.equal(overflow, false, "Wait label must wrap at 720px");
    if (variant.cancel) {
      await stop.click();
    } else {
      assert.ok(pendingResponse);
      pendingResponse.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: `WAIT_QA_RECOVERED_${index}` })}\n\n`);
      pendingResponse.end(`data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: { input_tokens: 23, output_tokens: 7 } } })}\n\n`);
    }
    await stop.waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await waiting.count(), 0, "A finished run must not leave a wait status");
    const saved = await invoke("get_thread", { threadId });
    assert.ok(saved.messages.every((message) => message.status !== "waiting"));
    cases.push({ ...variant, screenshot: file, cleared: true });
  }
  await page.reload();
  await page.locator(".composer textarea").waitFor();
  assert.equal(await page.locator(".assistant-status-segment.waiting").count(), 0);
  assert.deepEqual(errors, []);
  const result = { passed: true, identifier, version: expectedVersion, requestCount, cases, reloadVerified: true, errors };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
    console.error((await page.locator("body").innerText().catch(() => "")).slice(-2000));
  }
  throw error;
} finally {
  await close().catch(() => { if (child && child.exitCode === null) child.kill(); });
  server.closeAllConnections();
  server.close();
}

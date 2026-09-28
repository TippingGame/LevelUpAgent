// Isolated native IPC regression. Prepare after pnpm build, then build with:
// pnpm tauri build --debug --no-bundle --config artifacts/harness-delivery-review/tauri.json
// Run with LEVELUP_PLAYWRIGHT_MODULE pointing to an installed Playwright module.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeConversationExport } from "../src/lib/conversationExport.ts";

const output = resolve("artifacts/harness-delivery-review");
const identifier = "com.levelup.agent.harnessdeliveryqa";
const serverPort = 1457;
await mkdir(output, { recursive: true });

if (process.argv.includes("--prepare")) {
  const frontend = resolve(output, "dist");
  await cp(resolve("dist"), frontend, { recursive: true });
  await writeFile(resolve(frontend, "review.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="review-init.js"></script></body></html>');
  await writeFile(resolve(frontend, "review-init.js"), `
const profile = { id: "delivery-qa", name: "Delivery QA", baseUrl: "http://127.0.0.1:${serverPort}", model: "qa-model", protocol: "openai_responses", allowUnauthenticated: true, priority: 0, failoverEnabled: false };
localStorage.setItem("levelup-agent.profiles.v1", JSON.stringify([profile]));
localStorage.setItem("levelup-agent.active-profile.v1", profile.id);
localStorage.setItem("levelup-agent-locale", "en-US");
location.replace("index.html");
`);
  await writeFile(resolve(output, "tauri.json"), JSON.stringify({
    productName: "LevelUpAgent Delivery QA", identifier,
    build: { beforeBuildCommand: "", frontendDist: "../artifacts/harness-delivery-review/dist" },
    app: { windows: [{ label: "main", title: "LevelUpAgent Delivery QA", url: "review.html", visible: false, width: 1440, height: 920 }] },
    bundle: { active: false },
  }, null, 2));
  console.log("Prepared isolated desktop delivery fixture.");
  process.exit(0);
}

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : "playwright");
const replies = [
  { content: "DELIVERY_QA_LONG\n" + "完整故事段落。".repeat(1500), reasoning: [] },
  { content: "DELIVERY_QA_SHORT", reasoning: [{ type: "reasoning", id: "rs_qa", summary: [], encrypted_content: "x".repeat(12_000) }] },
];
let requestCount = 0;
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.stream, true);
  assert.equal(request.headers.authorization, undefined);
  const reply = replies[requestCount++];
  assert.ok(reply, "Only one provider request is allowed per prompt");
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "x-request-id": `delivery-qa-request-${requestCount}` });
  for (let offset = 0; offset < reply.content.length; offset += 64) {
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: reply.content.slice(offset, offset + 64) })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: {
    output: [...reply.reasoning, { type: "message", content: [{ type: "output_text", text: reply.content }] }],
    usage: { input_tokens: 23, output_tokens: 7 },
  } })}\n\n`);
});
await new Promise((done, fail) => { server.once("error", fail); server.listen(serverPort, "127.0.0.1", done); });
let child;
let browser;
let page;
let verified = false;
const errors = [];
const cases = [];
const threadId = `delivery-qa-${Date.now()}`;
async function until(check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Timed out waiting for desktop delivery QA");
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
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search conversations and commands" }).fill(threadId);
  await page.getByRole("option").filter({ has: page.getByText(threadId, { exact: true }) }).click();
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor({ state: "hidden" });
  await page.getByText(`Ready: ${threadId}`, { exact: true }).waitFor();
  // Exercise the real native transport while forcing the race deterministically.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.deliveryTrace = [];
    window.fetch = async (input, options) => {
      const response = await original(input, options);
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname !== "ipc.localhost") return response;
      const command = decodeURIComponent(url.pathname.slice(1));
      if (command === "harness_run") window.deliveryTrace.push({ kind: "command_returned", at: performance.now() });
      if (command === "plugin:__TAURI_CHANNEL__|fetch") {
        const result = await response.clone().json();
        if (result?.kind === "assistant_completed") {
          await new Promise((done) => setTimeout(done, 250));
          window.deliveryTrace.push({ kind: "final_event_delivered", at: performance.now(), bytes: new TextEncoder().encode(JSON.stringify(result)).length });
        }
      }
      return response;
    };
  });
  for (const [index, reply] of replies.entries()) {
    await page.locator(".composer textarea").fill(`DELIVERY_QA case ${index + 1}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const saved = await until(async () => {
      const thread = await invoke("get_thread", { threadId });
      return thread.outputTokens === (index + 1) * 7 && thread;
    });
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 5000 });
    const matches = saved.messages.filter((message) => message.role === "assistant" && message.content === reply.content);
    assert.equal(matches.length, 1, "One persisted assistant for one provider response");
    assert.ok(matches[0].requestId);
    assert.deepEqual(matches[0].providerReasoningBlocks ?? [], reply.reasoning);
    assert.equal(saved.inputTokens, (index + 1) * 23);
    assert.equal(requestCount, index + 1);
    const exported = JSON.parse(serializeConversationExport(saved));
    assert.equal(exported.messages.filter((message) => message.content === reply.content).length, 1);
    const trace = await page.evaluate(() => window.deliveryTrace);
    const command = trace.filter((entry) => entry.kind === "command_returned")[index];
    const final = trace.filter((entry) => entry.kind === "final_event_delivered")[index];
    assert.ok(final.bytes > 8192);
    assert.ok(final.at > command.at, "The final channel payload really arrived after the IPC result");
    cases.push({ name: index ? "short answer with large reasoning metadata" : "large answer", delayedByMs: Math.round(final.at - command.at), eventBytes: final.bytes, persistedMessages: matches.length });
  }
  await close();
  await launch();
  const restored = await invoke("get_thread", { threadId });
  assert.equal(restored.messages.filter((message) => message.role === "assistant").length, 2);
  assert.equal(restored.inputTokens, 46);
  assert.equal(restored.outputTokens, 14);
  assert.deepEqual(errors, []);
  const result = { passed: true, identifier, requestCount, cases, restartVerified: true, errors };
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

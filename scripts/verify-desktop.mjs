import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { verifyLocalResources } from "./verify-local-resources.mjs";

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : "playwright");
const output = resolve("artifacts/desktop-review");
const workspace = resolve(output, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(resolve(workspace, "AGENTS.md"), "Use project-convention-native-qa when reporting results.\n");
await writeFile(resolve(workspace, "sample.txt"), "first\nsecond\nthird\n");
const captured = [];
const terminalResponses = [];
const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [], balance: 0 }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(request.headers.authorization, undefined);
  if (!body.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    }));
    return;
  }
  captured.push(body);
  if (request.url === "/v1/responses") {
    const content = "Terminal event completed without waiting for HTTP EOF.";
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 23, output_tokens: 7 } } })}\n\n`);
    terminalResponses.push(response);
    const timeout = setTimeout(() => response.end(), 30000);
    response.once("close", () => clearTimeout(timeout));
    return;
  }
  const lastUser = body.messages.findLastIndex((message) => message.role === "user");
  const resourceTurn = JSON.stringify(body.messages[lastUser]?.content).includes("LOCAL_RESOURCE_QA");
  const hasResult = body.messages.slice(lastUser + 1).some((message) => message.role === "tool");
  const delta = hasResult ? { content: resourceTurn ? "Local resource read complete." : "Native QA complete: project-convention-native-qa." }
    : { tool_calls: [{ index: 0, id: resourceTurn ? "resource-read" : "native-read", type: "function", function: { name: "read_file", arguments: JSON.stringify(resourceTurn
      ? { path: resolve(output, "selected resources", "selected folder", "nested", "Dockerfile") }
      : { path: "sample.txt", start_line: 2, max_lines: 1 }) } }] };
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: hasResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(1450, "127.0.0.1", resolve); });
let browser;
let page;
let originalProviderSettings;
const errors = [];
async function connect() {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9443");
  page = browser.contexts()[0].pages().find((page) => /index.html/.test(page.url()));
  assert.ok(page, "QA application main window is available");
  const identifier = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"));
  assert.equal(identifier, "com.levelup.agent.review20260918", "Refuse to modify a production application");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".composer textarea").waitFor();
}
async function invoke(command, args) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
async function search(query) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search conversations and commands" }).fill(query);
}
async function openResult(name) {
  const item = page.getByRole("option").filter({ has: page.getByText(name, { exact: true }) });
  await item.waitFor();
  await item.click();
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector(".composer textarea")?.disabled);
}
async function closeMain() {
  const closed = page.waitForEvent("close");
  await invoke("plugin:window|close", { label: "main" }).catch(() => {});
  await closed;
}

async function launch() {
  const child = spawn(resolve("src-tauri/target/debug/levelup-agent.exe"), [], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9443" },
  });
  child.unref();
  await until(async () => {
    try {
      const targets = await fetch("http://127.0.0.1:9443/json/list").then((result) => result.json());
      return targets.some((target) => /index.html/.test(target.url));
    } catch { return false; }
  });
}

async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the native application state");
}

try {
  if (!await fetch("http://127.0.0.1:9443/json/version").then(() => true).catch(() => false)) await launch();
  await connect();
  await page.evaluate(async ({ workspace }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    for (let index = 0; index < 205; index++) {
      const id = `qa-catalog-${String(index).padStart(3, "0")}`;
      await invoke("save_thread", { thread: {
        id, title: `QA catalog ${index}`, workspace, updatedAt: index + 1,
        inputTokens: 0, outputTokens: 0,
        messages: [{ id: `${id}-message`, role: "user", content: index === 0 ? "native-search-hidden-token" : `Entry ${index}`, createdAt: 1, toolCalls: [], attachments: [] }],
      } });
      if ([0, 4, 204].includes(index)) await invoke("save_composer_draft", { threadId: id, draft: { content: "", attachments: [] } });
    }
    localStorage.setItem("levelup-agent.active-thread.v1", "qa-catalog-004");
  }, { workspace });
  await page.reload();
  await page.getByText("Entry 4", { exact: true }).waitFor();
  const initialRows = await page.locator(".project-threads .thread-row").count();
  assert.ok(initialRows >= 100 && initialRows <= 102, `Expected one catalog page plus the selected conversation, got ${initialRows}`);
  await search("native-search-hidden-token");
  await openResult("QA catalog 0");
  await page.locator(".composer textarea").fill("Native saved draft");
  await search("QA catalog 204");
  await openResult("QA catalog 204");
  await page.locator(".message.user .message-body").hover();
  await page.getByTitle("Edit this message", { exact: true }).click();
  assert.equal(await page.locator(".composer textarea").inputValue(), "Entry 204");
  await page.locator(".composer textarea").fill("Other native draft");
  await search("native-search-hidden-token");
  await openResult("QA catalog 0");
  assert.equal(await page.locator(".composer textarea").inputValue(), "Native saved draft");
  await page.locator(".composer textarea").fill("Read sample.txt line 2 with read_file, then report completion.");
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".assistant-message-content").getByText("Native QA complete: project-convention-native-qa.", { exact: false }).waitFor({ timeout: 30000 });
  assert.ok(captured.length >= 2);
  assert.ok(captured[0].messages.some((message) => message.role === "system" && message.content.includes("project-convention-native-qa")));
  assert.ok(captured[1].messages.some((message) => message.role === "tool" && message.content.includes("2: second")));
  const saved = await until(async () => {
    const thread = await invoke("get_thread", { threadId: "qa-catalog-000" });
    return thread.messages.some((message) => message.role === "tool" && message.content.includes("second")) && thread;
  });
  assert.ok(saved.messages.some((message) => message.role === "tool" && message.content.includes("second")));
  await page.screenshot({ path: resolve(output, "native-conversation.png") });
  const resourceChecks = await verifyLocalResources({ page, invoke, output, workspace, until, search, openResult });
  const resourceRequest = captured.find((body) => JSON.stringify(body.messages).includes("LOCAL_RESOURCE_QA"));
  assert.ok(JSON.stringify(resourceRequest).includes("User-selected local resource"));
  assert.ok(!JSON.stringify(resourceRequest).includes("local-resource-secret-content"), "Files are read on demand instead of included at import time");
  await page.locator(".composer textarea").fill("Native close flush preserves this exact draft");
  await closeMain();

  await launch();
  await connect();
  await page.waitForFunction(() => document.querySelector(".composer textarea")?.value === "Native close flush preserves this exact draft");
  const restarted = await invoke("get_thread", { threadId: "qa-catalog-000" });
  assert.ok(restarted.messages.some((message) => message.role === "tool" && message.content.includes("second")));
  await search("QA catalog 204");
  await openResult("QA catalog 204");
  assert.equal(await page.locator(".composer textarea").inputValue(), "Other native draft");
  originalProviderSettings = await invoke("get_provider_settings");
  await invoke("save_provider_settings", { settings: {
    ...originalProviderSettings,
    profiles: originalProviderSettings.profiles.map((profile) => ({ ...profile, protocol: "openai_responses" })),
  } });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector(".composer textarea")?.disabled);
  await page.locator(".composer textarea").fill("Reply once and finish this turn.");
  const previousRequests = captured.length;
  const started = performance.now();
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".assistant-message-content").getByText("Terminal event completed without waiting for HTTP EOF.", { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await page.locator(".thinking-row").count(), 0);
  assert.equal(captured.length, previousRequests + 1, "No extra provider request after completion");
  assert.equal(terminalResponses.length, 1);
  assert.equal(terminalResponses[0].writableEnded, false, "The server has not finished the HTTP response");
  const completionMs = Math.round(performance.now() - started);
  const completed = await until(async () => {
    const thread = await invoke("get_thread", { threadId: "qa-catalog-204" });
    return thread.outputTokens === 7 && thread;
  });
  assert.equal(completed.inputTokens, 23);
  await page.screenshot({ path: resolve(output, "native-terminal-event.png") });
  assert.deepEqual(errors, []);
  const result = { passed: ["isolated Tauri startup", "restore selected old conversation", "search outside first 100", "edit targets the selected conversation", "independent SQLite drafts", "native streamed model/tool loop", "project AGENTS injection", "line excerpt", "close and restart draft flush", "terminal event clears running UI before HTTP EOF and persists usage", ...resourceChecks], completionMs, providerRequests: captured.length, errors };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await invoke("save_provider_settings", { settings: originalProviderSettings });
  originalProviderSettings = undefined;
  await closeMain();
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(output, "failure.png") });
    console.error((await page.locator("body").innerText()).slice(-5000));
  }
  throw error;
} finally {
  if (originalProviderSettings && page && !page.isClosed()) {
    await invoke("save_provider_settings", { settings: originalProviderSettings }).catch(() => {});
  }
  server.closeAllConnections();
  server.close();
}

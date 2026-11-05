// Build with artifacts/media-history/tauri.json before running. Never writes production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url));
const { chromium } = require("playwright");
const identity = "com.levelup.agent.historyqa20261105";
const output = resolve("artifacts/media-history");
await mkdir(output, { recursive: true });
const child = spawn(resolve("src-tauri/target/debug/levelup-agent.exe"), [], {
  windowsHide: true, detached: true, stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9465" },
});
child.unref();
let browser;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9465"); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(browser, "Native QA window starts");
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  assert.equal(await invoke("plugin:app|identifier"), identity, "Refuse to touch production app data");
  const database = new DatabaseSync(join(process.env.APPDATA, identity, "levelup-agent.sqlite3"));
  const insert = database.prepare(`INSERT OR REPLACE INTO media_assets
    (id,batch_id,provider_id,provider_name,kind,status,prompt,model,created_at,updated_at)
    VALUES (?,?,'fixture','Fixture',?,'completed',?,'fixture-model',?,?)`);
  database.exec("BEGIN");
  for (const kind of ["image", "video", "audio"]) for (let i = 0; i < 125; i++) {
    const timestamp = new Date(2026, 10, 5 - i).getTime();
    insert.run(`native-${kind}-${i}`, `native-${kind}-${i}`, kind, i === 124 ? "橘猫 100%_" : `测试作品 ${i}`, timestamp, timestamp);
  }
  database.exec("COMMIT");
  database.close();
  await page.evaluate(() => localStorage.setItem("levelup-agent-locale", "zh-CN"));
  await page.reload();
  await page.getByRole("button", { name: "打开创作空间", exact: true }).click();
  const gallery = page.locator(".media-gallery-panel");
  await page.waitForFunction(() => document.querySelectorAll(".media-asset-card").length === 20);
  await gallery.getByRole("button", { name: "下一页", exact: true }).click();
  await gallery.getByText("第 2 / 7 页 · 共 125 条", { exact: true }).waitFor();
  await gallery.getByLabel("搜索创作历史").fill("橘猫");
  await gallery.getByText("橘猫 100%_", { exact: true }).waitFor();
  assert.equal(await gallery.locator(".media-asset-card").count(), 1);
  for (const kind of ["image", "video", "audio"]) {
    const pageData = await invoke("list_media_assets", { kind, limit: 0, offset: 0 });
    assert.equal(pageData.assets.length, 125);
    assert.equal(pageData.total, 125);
    assert.equal(pageData.hasMore, false);
    assert.equal((await invoke("list_media_assets", { kind, limit: 20, offset: 0, filter: { keyword: "%_" } })).total, 1);
    const dated = await invoke("list_media_assets", { kind, limit: 20, offset: 0, filter: { createdAfter: new Date(2026, 10, 4).getTime(), createdBefore: new Date(2026, 10, 6).getTime() } });
    assert.equal(dated.total, 2);
  }
  // Opening Explorer is opt-in: routine regressions must not leave native windows
  // or error dialogs on the user's desktop. Verify the resulting location manually.
  if (process.argv.includes("--open-folder")) {
    await gallery.getByRole("button", { name: "打开目录", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent.includes("打开目录"))?.disabled);
  }
  await gallery.getByRole("button", { name: "清除筛选" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".media-asset-card").length === 20);
  await page.screenshot({ path: resolve(output, "native.png") });
  await writeFile(resolve(output, "native.json"), JSON.stringify({ status: "passed", identity, pid: child.pid, directory: join(process.env.APPDATA, identity, "media"), folderVerification: process.argv.includes("--open-folder") ? "IPC accepted; verify the actual Explorer location separately" : "Not opened (opt-in only)", cases: ["real SQLite all three media kinds", "20 per page and next page", "search old record", "literal wildcard search", "date bounds"] }, null, 2));
  console.log("PASS native SQLite history/filter/pagination", child.pid);
} finally {
  await browser?.close();
  if (!process.argv.includes("--keep-open")) child.kill();
}

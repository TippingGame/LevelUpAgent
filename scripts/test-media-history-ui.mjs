// Synthetic history exercises UI pagination, full-history filtering and request races.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const local = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || (existsSync(local) ? local : import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const output = resolve("artifacts/media-history");
mkdirSync(output, { recursive: true });
const layout = JSON.parse(readFileSync(new URL("../layouts/default.layout.json", import.meta.url), "utf8"));

try {
  for (const colorScheme of ["light", "dark"]) for (const armor of [false, true]) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ armor, layout }) => {
      localStorage.setItem("levelup-agent-locale", "zh-CN");
      localStorage.setItem("levelup-agent.armor-mode.v1", String(armor));
      const profile = { id: "fixture", name: "Fixture", baseUrl: "https://example.invalid", model: "fixture", protocol: "openai_chat", priority: 1 };
      const rows = ["image", "video", "audio"].flatMap(kind => Array.from({ length: 125 }, (_, i) => ({
        id: `${kind}-${i}`, batchId: `${kind}-${i}`, kind, providerId: "fixture", providerName: "Fixture", model: "fixture-model",
        status: "completed", prompt: i === 124 ? "橘猫 100%_" : `作品 ${i}`, createdAt: new Date(2026, 10, 5 - i).getTime(), updatedAt: 1,
      })));
      window.historyTest = { calls: [], opened: 0, fail: false };
      let callbackId = 0;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId, unregisterCallback() {},
        invoke: async (command, args = {}) => {
          if (command === "get_provider_settings") return { profiles: [profile], activeProfileId: profile.id };
          if (command === "load_theme_layout") return { source: "default", definition: layout };
          if (command === "has_api_key") return true;
          if (command === "get_gateway_diagnostics") return { profileId: profile.id, healthOk: true, latencyMs: 1, usage: { balance: 10 }, checkedAt: Date.now() };
          if (command === "get_default_workspace") return "C:/media-history-test";
          if (command === "list_thread_summaries") return { threads: [], nextCursor: null };
          if (command === "get_goal" || command === "get_thread") return null;
          if (command === "get_custom_instructions") return "";
          if (command === "get_pet_runtime") return { dashboard: { activePetId: "", pets: [] }, activities: [] };
          if (command === "get_media_catalog" || command === "get_model_catalog") return { models: [], errors: [] };
          if (command === "open_media_directory") { window.historyTest.opened++; return; }
          if (command === "delete_media_asset") { rows.splice(rows.findIndex(row => row.id === args.assetId), 1); return true; }
          if (command === "list_media_assets") {
            window.historyTest.calls.push(args);
            if (window.historyTest.fail) throw new Error("History temporarily unavailable");
            const { keyword = "", createdAfter, createdBefore } = args.filter || {};
            const filtered = rows.filter(row => row.kind === args.kind && row.prompt.includes(keyword)
              && (createdAfter === undefined || row.createdAt >= createdAfter)
              && (createdBefore === undefined || row.createdAt < createdBefore));
            if (keyword === "作品") await new Promise(resolve => setTimeout(resolve, 900));
            const assets = filtered.slice(args.offset, args.limit === 0 ? undefined : args.offset + args.limit);
            return { assets, total: filtered.length, hasMore: args.offset + assets.length < filtered.length };
          }
          if (command.startsWith("list_") || command.startsWith("harness_list_")) return [];
          if (command.startsWith("plugin:")) return command.endsWith("listen") ? ++callbackId : false;
          if (command.startsWith("save_") || command.startsWith("log_")) return;
          throw new Error("Unmocked IPC: " + command);
        },
      };
    }, { armor, layout });
    const gallery = page.locator(".media-gallery-panel");
    const cards = gallery.locator(".media-asset-card");
    const count = async n => {
      await page.waitForFunction(n => document.querySelectorAll(".media-gallery-panel .media-asset-card").length === n, n);
      assert.equal(await cards.count(), n);
    };
    try {
      await page.goto(process.argv[2] || "http://127.0.0.1:1449");
      await page.getByRole("button", { name: "打开创作空间", exact: true }).click();
      await count(20);
      await gallery.getByRole("button", { name: "下一页", exact: true }).click();
      await gallery.getByText("第 2 / 7 页 · 共 125 条", { exact: true }).waitFor();
      await gallery.getByLabel("搜索创作历史").fill("橘猫");
      await count(1);
      await gallery.getByText("橘猫 100%_", { exact: true }).waitFor();
      await gallery.getByRole("button", { name: "清除筛选" }).click();
      await count(20);
      for (const size of [50, 100, 0]) {
        await gallery.getByLabel("每页历史数量").selectOption(String(size));
        await count(size || 125);
      }
      for (const tab of ["视频", "语音", "图片"]) {
        await page.locator(".media-kind-tabs").getByRole("tab", { name: tab, exact: true }).click();
        await count(125);
      }
      await gallery.getByLabel("每页历史数量").selectOption("20");
      await count(20);
      await gallery.getByLabel("创作时间范围").selectOption("custom");
      await gallery.getByLabel("开始日期", { exact: true }).fill("2026-11-04");
      await gallery.getByLabel("结束日期", { exact: true }).fill("2026-11-05");
      await count(2);
      await gallery.getByRole("button", { name: "打开目录", exact: true }).click();
      assert.equal(await page.evaluate(() => window.historyTest.opened), 1);
      await gallery.getByRole("button", { name: "打开目录", exact: true }).hover();
      await gallery.getByLabel("搜索创作历史").focus();
      await page.screenshot({ path: resolve(output, `${colorScheme}-armor-${armor}.png`) });
      await page.setViewportSize({ width: 720, height: 800 });
      await gallery.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(output, `${colorScheme}-armor-${armor}-720.png`) });
      await gallery.getByLabel("开始日期", { exact: true }).fill("2026-11-06");
      await gallery.getByText("开始日期不能晚于结束日期", { exact: true }).waitFor();
      await gallery.getByRole("button", { name: "清除筛选" }).click();
      await count(20);
      await gallery.getByLabel("搜索创作历史").fill("作品");
      await page.waitForFunction(() => window.historyTest.calls.at(-1)?.filter?.keyword === "作品");
      await gallery.getByLabel("搜索创作历史").fill("橘猫");
      await count(1);
      await page.waitForTimeout(1000);
      await count(1);
      await gallery.getByLabel("搜索创作历史").fill("no-matching-record");
      await gallery.getByText("没有符合条件的历史记录", { exact: true }).waitFor();
      await page.evaluate(() => { window.historyTest.fail = true; });
      await gallery.getByRole("button", { name: "清除筛选" }).click();
      await gallery.getByText("History temporarily unavailable", { exact: true }).waitFor();
      await page.evaluate(() => { window.historyTest.fail = false; });
      await gallery.getByRole("button", { name: "重试", exact: true }).click();
      await count(20);
      await page.emulateMedia({ colorScheme: colorScheme === "light" ? "dark" : "light" });
      await page.emulateMedia({ colorScheme });
      await page.reload();
      await page.getByRole("button", { name: "打开创作空间", exact: true }).click();
      await count(20);
      assert.deepEqual(errors, []);
      console.log(`PASS history filtering/pagination/races/retry: ${colorScheme}, armor=${armor}, 1200/720px`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, "failure.png") });
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

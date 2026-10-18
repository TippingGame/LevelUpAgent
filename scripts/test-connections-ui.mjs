// Full-app regression with synthetic credentials and local IPC responses.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const local = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || (existsSync(local) ? local : import.meta.url));
const { chromium } = require("playwright");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
const output = resolve("artifacts/connections");
mkdirSync(output, { recursive: true });
const baseUrl = process.argv[2] || "http://127.0.0.1:1437";
const layout = JSON.parse(readFileSync(new URL("../layouts/default.layout.json", import.meta.url), "utf8"));

try {
  for (const colorScheme of ["light", "dark"]) for (const armor of [false, true]) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ armor, layout }) => {
      const profiles = ["first", "media", "middle", "last"].map((id, index) => ({
        id, name: id, baseUrl: "https://example.invalid", model: id === "media" ? "" : "text-model",
        protocol: "openai_responses", allowUnauthenticated: false, priority: index * 10, failoverEnabled: id !== "media",
      }));
      localStorage.setItem("levelup-agent-locale", "zh-CN");
      localStorage.setItem("levelup-agent.armor-mode.v1", String(armor));
      localStorage.setItem("levelup-agent.profiles.v1", JSON.stringify(profiles));
      localStorage.setItem("levelup-agent.active-profile.v1", "last");
      const state = window.connectionTest = {
        settings: { profiles, activeProfileId: "last" }, calls: [], keys: new Set(profiles.map((p) => p.id)),
        balance: { first: 11, media: 22, middle: 33, last: 44 }, pending: [], hold: null, failSave: false,
      };
      let callbackId = 0;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId, unregisterCallback() {},
        invoke: async (command, args = {}) => {
          state.calls.push({ command, args });
          if (command === "get_provider_settings") return structuredClone(state.settings);
          if (command === "load_theme_layout") return { source: "default", definition: layout };
          if (command === "save_provider_settings") {
            if (state.failSave) throw new Error("Injected save failure");
            state.settings = structuredClone(args.settings); return;
          }
          if (command === "has_api_key") return state.keys.has(args.profileId);
          if (command === "save_api_key") { state.keys.add(args.profileId); return; }
          if (command === "delete_api_key") { state.keys.delete(args.profileId); return; }
          if (command === "get_gateway_diagnostics") {
            const result = { profileId: args.profile.id, healthOk: true, latencyMs: 1, usage: { balance: state.balance[args.profile.id] }, checkedAt: Date.now() };
            if (state.hold === args.profile.id) return new Promise((resolve) => state.pending.push(() => resolve(result)));
            return result;
          }
          if (command === "get_default_workspace") return "C:/connection-test";
          if (command === "list_thread_summaries") return { threads: [], nextCursor: null };
          if (command === "save_thread") return;
          if (command === "get_goal" || command === "get_thread") return null;
          if (command === "get_custom_instructions") return "";
          if (command === "get_media_catalog" || command === "get_model_catalog") return { models: [], errors: [] };
          if (command === "list_media_assets") return { assets: [], total: 0 };
          if (command === "fetch_models") return [
            { id: "gpt-image-2", outputModalities: ["image"] },
            { id: "Seedance-2.5", outputModalities: ["video"] },
            { id: "tts-1", outputModalities: ["audio"] },
          ];
          if (command.startsWith("list_") || command.startsWith("harness_list_")) return [];
          if (command.startsWith("plugin:")) return command.endsWith("listen") ? ++callbackId : false;
          throw new Error("Unmocked IPC: " + command);
        },
      };
    }, { armor, layout });
    try {
      await page.goto(baseUrl);
      const pill = page.locator(".balance-pill");
      const balance = async (value) => {
        await page.waitForFunction((expected) => document.querySelector(".balance-pill strong")?.textContent === expected, value.toFixed(2));
      };
      await balance(44);
      if (await page.locator(".toast").count()) await page.locator(".toast").click();
      await page.locator(".account-button").click();
      const picker = page.getByRole("combobox", { name: "当前连接", exact: true });
      await page.getByRole("button", { name: "添加连接", exact: true }).click();
      assert.equal(await page.getByRole("checkbox", { name: /允许作为文字备用连接/ }).isChecked(), false);
      await picker.selectOption("media");
      await balance(22);
      assert.equal(await page.evaluate(() => window.connectionTest.settings.activeProfileId), "last");
      await page.getByRole("button", { name: "LevelUpAPI 诊断", exact: true }).click();
      await page.getByText("余额 22", { exact: true }).waitFor();
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      await balance(22);
      assert.equal(await page.evaluate(() => window.connectionTest.settings.activeProfileId), "last");
      await page.reload();
      await balance(22);
      if (await page.locator(".toast").count()) await page.locator(".toast").click();
      await page.locator(".account-button").click();
      assert.equal(await picker.inputValue(), "media");
      await page.getByRole("button", { name: "检测模型", exact: true }).click();
      const modelInput = page.getByRole("combobox", { name: "模型", exact: true });
      await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="模型"]').value === "gpt-image-2");
      for (const model of ["gpt-image-2", "Seedance-2.5", "tts-1"]) {
        await modelInput.fill(model);
        await page.getByRole("button", { name: "检测模型", exact: true }).click();
        assert.equal(await modelInput.inputValue(), model);
        await page.getByRole("button", { name: "保存连接", exact: true }).click();
        await page.waitForFunction((expected) => window.connectionTest.settings.profiles.find((p) => p.id === "media").model === expected, model);
        assert.equal(await page.evaluate(() => window.connectionTest.settings.activeProfileId), "last");
        await balance(22);
        await page.locator(".account-button").click();
        assert.equal(await modelInput.inputValue(), model);
      }

      // A delayed result from the previous selection must not overwrite this one.
      await page.evaluate(() => { window.connectionTest.hold = "middle"; });
      await picker.selectOption("middle");
      await page.waitForFunction(() => window.connectionTest.pending.length > 0);
      await picker.selectOption("media");
      await balance(22);
      await page.evaluate(() => { window.connectionTest.hold = null; window.connectionTest.balance.middle = 34; });
      await picker.selectOption("middle");
      await balance(34);
      await page.evaluate(() => window.connectionTest.pending.splice(0).forEach((release) => release()));
      await page.getByRole("button", { name: "LevelUpAPI 诊断", exact: true }).click();
      await page.getByText("余额 34", { exact: true }).waitFor();
      assert.match(await pill.innerText(), /34\.00/);
      await page.evaluate(() => { window.connectionTest.balance.middle = 33; });
      await picker.selectOption("media");
      await balance(22);
      await page.getByRole("button", { name: "LevelUpAPI 诊断", exact: true }).click();
      await page.getByText("余额 22", { exact: true }).waitFor();
      assert.match(await pill.innerText(), /22\.00/);

      const remove = page.getByRole("button", { name: "删除连接", exact: true });
      await picker.selectOption("last");
      await balance(44);
      await remove.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="当前连接"]').value === "middle");
      await balance(33);
      assert.equal(await page.evaluate(() => window.connectionTest.settings.activeProfileId), "middle");
      await remove.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="当前连接"]').value === "media");
      await balance(22);
      assert.equal(await page.evaluate(() => window.connectionTest.settings.activeProfileId), "first");
      await picker.selectOption("first");
      await page.evaluate(() => { window.connectionTest.failSave = true; });
      await remove.click();
      await page.getByText("Injected save failure", { exact: true }).waitFor();
      assert.equal(await picker.inputValue(), "first");
      assert.equal(await picker.locator("option").count(), 2);
      await page.evaluate(() => { window.connectionTest.failSave = false; });
      await remove.click();
      await page.waitForFunction(() => document.querySelector('[aria-label="当前连接"]').value === "media");
      await balance(22);
      assert.equal(await remove.isDisabled(), true);
      await remove.hover({ force: true });
      await picker.focus();
      await page.screenshot({ path: resolve(output, `${colorScheme}-armor-${armor}.png`) });
      await page.setViewportSize({ width: 720, height: 820 });
      await page.screenshot({ path: resolve(output, `${colorScheme}-armor-${armor}-720.png`) });

      // Removing a key also invalidates an in-flight balance refresh.
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.keyboard.press("Escape");
      await page.evaluate(() => { window.connectionTest.hold = "media"; });
      await pill.click();
      await page.waitForFunction(() => window.connectionTest.pending.length > 0);
      await page.locator(".account-button").click();
      await page.getByRole("button", { name: "移除密钥", exact: true }).click();
      await page.evaluate(() => window.connectionTest.pending.splice(0).forEach((release) => release()));
      await page.waitForFunction(() => document.querySelector(".balance-pill strong")?.textContent === "—");
      assert.equal(await pill.isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${colorScheme}, armor=${armor}: media balance, save, diagnostics, stale response, predecessor deletion, first/only item, failure, key removal`);
    } catch (error) {
      console.error("Page errors:", errors);
      await page.screenshot({ path: resolve(output, "failure.png") });
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

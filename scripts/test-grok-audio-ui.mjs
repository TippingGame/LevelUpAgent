// Run against a local Vite server; all IPC and credentials are synthetic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const local = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || (existsSync(local) ? local : import.meta.url));
const { chromium } = require("playwright");
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
const output = resolve("artifacts/grok-audio");
mkdirSync(output, { recursive: true });
const layout = JSON.parse(readFileSync(new URL("../layouts/default.layout.json", import.meta.url), "utf8"));

try {
  for (const colorScheme of ["light", "dark"]) for (const armor of [false, true]) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ armor, layout }) => {
      const profile = { id: "speech", name: "Speech test", baseUrl: "https://example.invalid", model: "text-model", protocol: "openai_chat", priority: 1, failoverEnabled: true };
      localStorage.setItem("levelup-agent-locale", "zh-CN");
      localStorage.setItem("levelup-agent.armor-mode.v1", String(armor));
      window.grokSpeechTest = { requests: [] };
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
          if (command === "get_default_workspace") return "C:/grok-speech-test";
          if (command === "list_thread_summaries") return { threads: [], nextCursor: null };
          if (command === "get_goal" || command === "get_thread") return null;
          if (command === "get_custom_instructions") return "";
          if (command === "get_pet_runtime") return { dashboard: { activePetId: "", pets: [] }, activities: [] };
          if (command === "get_media_catalog") return { models: ["gpt-4o-mini-tts", "grok-voice-tts"].map(id => ({ id, profileId: profile.id, profileName: profile.name, protocol: "openai_chat", kind: "audio", rank: 1, recommended: false })), errors: [] };
          if (command === "get_model_catalog") return { models: [], errors: [] };
          if (command === "list_media_assets") return { assets: [], total: 0 };
          if (command === "generate_media") { window.grokSpeechTest.requests.push(args.request); return { batchId: "test", assets: [], errors: [] }; }
          if (command.startsWith("list_") || command.startsWith("harness_list_")) return [];
          if (command.startsWith("plugin:")) return command.endsWith("listen") ? ++callbackId : false;
          if (command.startsWith("save_") || command.startsWith("log_")) return;
          throw new Error("Unmocked IPC: " + command);
        },
      };
    }, { armor, layout });
    try {
      await page.goto(process.argv[2] || "http://127.0.0.1:1449");
      await page.getByRole("button", { name: "打开创作空间", exact: true }).click();
      await page.locator(".media-kind-tabs").getByRole("tab", { name: "语音", exact: true }).click();
      const studio = page.locator(".media-studio");
      const model = studio.locator(".media-model-row select");
      const format = studio.locator("label").filter({ hasText: /^格式/ }).locator("select");
      const voice = studio.getByLabel("声音", { exact: true });
      await model.selectOption("speech::gpt-4o-mini-tts");
      await format.selectOption("flac");
      await voice.fill("alloy");
      await studio.getByLabel("演绎要求", { exact: true }).fill("Warm voice");
      await model.selectOption("speech::grok-voice-tts");
      await page.waitForFunction(() => document.querySelector('.media-studio input[placeholder="eve"]')?.value === "");
      assert.equal(await format.inputValue(), "mp3");
      assert.deepEqual(await format.locator("option").allTextContents(), ["mp3", "wav"]);
      assert.equal(await studio.getByLabel("演绎要求", { exact: true }).count(), 0);
      await format.selectOption("wav");
      await voice.fill("ara");
      await studio.locator(".media-prompt-list textarea").fill("Hello Grok");
      await studio.locator(".media-generate-button").hover();
      await studio.screenshot({ path: resolve(output, colorScheme + "-armor-" + armor + ".png") });
      await studio.locator(".media-generate-button").click();
      await page.waitForFunction(() => window.grokSpeechTest.requests.length === 1);
      const submitted = await page.evaluate(() => window.grokSpeechTest.requests[0]);
      assert.equal(submitted.model, "grok-voice-tts");
      assert.equal(submitted.outputFormat, "wav");
      assert.equal(submitted.voice, "ara");
      assert.equal(submitted.instructions, undefined);
      await page.setViewportSize({ width: 720, height: 800 });
      await studio.screenshot({ path: resolve(output, colorScheme + "-armor-" + armor + "-720.png") });
      await model.selectOption("speech::gpt-4o-mini-tts");
      assert.ok((await format.locator("option").allTextContents()).includes("flac"));
      assert.equal(await studio.getByLabel("演绎要求", { exact: true }).count(), 1);
      await model.selectOption("speech::grok-voice-tts");
      await page.reload();
      await page.getByRole("button", { name: "打开创作空间", exact: true }).click();
      await page.locator(".media-kind-tabs").getByRole("tab", { name: "语音", exact: true }).click();
      assert.equal(await model.inputValue(), "speech::grok-voice-tts");
      assert.deepEqual(await format.locator("option").allTextContents(), ["mp3", "wav"]);
      assert.deepEqual(errors, []);
      console.log("PASS Grok speech controls: " + colorScheme + ", armor=" + armor + ", 1200/720px, switch/reload/submit");
    } catch (error) {
      await page.screenshot({ path: resolve(output, "failure.png") });
      console.error((await page.locator("body").innerText()).slice(0, 2000));
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

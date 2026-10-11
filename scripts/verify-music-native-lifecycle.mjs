// Opt-in test against an isolated Tauri app; never connect to the user's app ID.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const require = createRequire(process.env.MUSIC_PLAYWRIGHT_PACKAGE || new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url));
const { chromium } = require("playwright");
const engine = process.env.MUSIC_TEST_ENGINE || "yue2";
const directory = resolve(process.env.MUSIC_UI_OUTPUT || "artifacts/music-workbench/multi-engine/lifecycle");
await mkdir(directory, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9451");
const page = browser.contexts()[0].pages().find(p => p.url().includes("localhost") && new URL(p.url()).pathname === "/");
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
try {
  assert.equal(await invoke("plugin:app|identifier"), process.env.MUSIC_QA_IDENTIFIER || "com.levelup.agent.songqa20261011");
  if (process.argv.includes("--install-cache")) {
    const before = await invoke("music_status");
    const works = before.jobs.filter(j => j.status === "succeeded");
    assert.ok(works.length > 0);
    assert.equal(before.engines.musicgen.runtimeReady, false, "Use the song-only isolated QA app");
    await invoke("music_install", { engine: "musicgen", offlineDirectory: resolve(process.env.MUSIC_CACHED_INSTALL_ASSETS || "artifacts/music-workbench/release") });
    let during, reloaded;
    try {
      during = await invoke("music_status");
      assert.equal(during.operation.status, "running");
      for (const work of works) assert.ok(during.jobs.some(j => j.id === work.id));
      await page.reload();
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
      reloaded = await invoke("music_status");
      assert.equal(reloaded.operation.status, "running");
      for (const work of works) assert.ok(reloaded.jobs.some(j => j.id === work.id));
      await invoke("music_artifact", { id: works[0].id });
      await invoke("music_export", { id: works[0].id, destination: resolve(directory, "install-cache-export.wav") });
    } finally { await invoke("music_cancel_install"); }
    const deadline = Date.now() + 60000;
    let after;
    do {
      after = await invoke("music_status");
      assert.ok(Date.now() < deadline, "Install cancellation timeout");
      if (after.operation.status === "running") await new Promise(resolve => setTimeout(resolve, 250));
    } while (after.operation.status === "running");
    assert.equal(after.operation.status, "cancelled");
    assert.equal(after.engines.acestep.ready, true);
    assert.equal(after.engines.yue2.ready, true);
    await writeFile(resolve(directory, "install-cache.json"), JSON.stringify({ before, during, reloaded, after }, null, 2));
  } else if (process.argv.includes("--after-restart")) {
    const previous = JSON.parse(await readFile(resolve(directory, `${engine}-before-exit.json`), "utf8"));
    const status = await invoke("music_status");
    assert.ok(!status.jobs.some(j => ["running", "queued"].includes(j.status)));
    assert.equal(status.jobs.find(j => j.id === previous.active.id).status, "cancelled");
    assert.equal(status.jobs.find(j => j.id === previous.generated.id).status, "succeeded");
    await writeFile(resolve(directory, `${engine}-after-restart.json`), JSON.stringify(status, null, 2));
  } else {
    const body = { engine, mode: "instrumental", title: `${engine} instrumental acceptance`, prompt: "Soft warm piano, acoustic guitar, calm and spacious, instrumental, no vocals", duration: 10, seed: 20261011 };
    const created = await invoke("music_request", { action: "generate", request: body });
    const deadline = Date.now() + 600000;
    let generated;
    while (true) {
      const status = await invoke("music_status");
      generated = status.jobs.find(j => j.id === created.id);
      if (!["queued", "running"].includes(generated.status)) break;
      assert.ok(Date.now() < deadline, "Generation timeout");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(generated.status, "succeeded", generated.error);
    assert.ok(generated.audio.duration > 5);
    assert.equal(generated.params.lyrics, "");
    const active = await invoke("music_request", { action: "generate", request: { ...body, title: "Close during inference", duration: 120 } });
    await new Promise(resolve => setTimeout(resolve, 5000));
    const before = await invoke("music_status");
    assert.equal(before.jobs.find(j => j.id === active.id).status, "running");
    await writeFile(resolve(directory, `${engine}-before-exit.json`), JSON.stringify({ generated, active, before }, null, 2));
    // This exercises RunEvent::ExitRequested and the real host-owned pipe close.
    await invoke("plugin:window|close", { label: "main" }).catch(error => {
      if (!/closed|destroyed|Target/i.test(String(error))) throw error;
    });
  }
  console.log(`Passed ${engine}: ${process.argv.includes("--install-cache") ? "preserved works during installation, reload, export and cancellation" : process.argv.includes("--after-restart") ? "restart and preserved works" : "instrumental generation and native exit"}`);
} finally { await browser.close(); }

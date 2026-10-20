// pnpm build; node scripts/verify-armor-conversation.mjs --prepare
// pnpm tauri build --debug --no-bundle --config artifacts/armor-conversation-review/tauri.json
// LEVELUP_PLAYWRIGHT_MODULE may point to a bundled playwright/index.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve('artifacts/armor-conversation-review');
const identifier = 'com.levelup.agent.armorqa';
await mkdir(output, { recursive: true });
if (process.argv.includes('--prepare')) {
  const frontend = resolve(output, 'dist');
  await cp(resolve('dist'), frontend, { recursive: true });
  await writeFile(resolve(frontend, 'review.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="review-init.js"></script></body></html>');
  await writeFile(resolve(frontend, 'review-init.js'), 'localStorage.setItem("levelup-agent-locale","en-US");location.replace("index.html");');
  await writeFile(resolve(output, 'tauri.json'), JSON.stringify({ productName: 'LevelUpAgent Armor QA', identifier, build: { beforeBuildCommand: '', frontendDist: '../artifacts/armor-conversation-review/dist' }, app: { windows: [{ label: 'main', title: 'LevelUpAgent Armor QA', url: 'review.html', visible: false, width: 1440, height: 920 }] }, bundle: { active: false } }, null, 2));
  process.exit(0);
}
const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : 'playwright');
const models = ['gpt-image-2', 'gpt-image-2.5'];
const requests = [], errors = [], captures = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const mock = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') { res.end(JSON.stringify({ data: models.map(id => ({ id, object: 'model', owned_by: 'openai' })) })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (req.url?.includes('/images/generations')) { requests.push(body); res.end(JSON.stringify({ data: [{ b64_json: png }] })); return; }
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Local QA reply' }, finish_reason: 'stop' }] }));
});
await new Promise(done => mock.listen(0, '127.0.0.1', done));
let child, browser, page, verified = false;
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 100)); } throw new Error('Armor native QA timed out'); }
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const visibleStudio = () => page.locator('.creative-studio:visible');
async function capture(name) { await page.screenshot({ path: resolve(output, name + '.png') }); captures.push(name); }
try {
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
  child = spawn(resolve('src-tauri/target/debug/levelup-agent.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  await until(() => fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).then(tabs => tabs.some(t => t.url.includes('index.html'))).catch(() => false));
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = browser.contexts()[0].pages().find(p => p.url().includes('index.html'));
  assert.equal(await invoke('plugin:app|identifier'), identifier); verified = true;
  page.on('pageerror', e => errors.push(e.message));
  await invoke('save_provider_settings', { settings: { profiles: [{ id: 'armor-qa', name: 'Local Armor QA', baseUrl: 'http://127.0.0.1:' + mock.address().port, model: models[0], protocol: 'openai_chat', allowUnauthenticated: true, priority: 0, failoverEnabled: false }], activeProfileId: 'armor-qa' } });
  await page.reload(); await page.locator('.composer textarea').waitFor();
  console.log('Verified isolated native profile and local mock provider.');
  for (const scheme of ['light', 'dark']) for (const armor of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload(); await page.locator('.composer textarea').waitFor();
    const toggle = page.locator('.armor-toggle');
    if ((await toggle.getAttribute('aria-pressed') === 'true') !== armor) await toggle.click();
    assert.equal(await page.locator('.app-shell').evaluate(el => el.classList.contains('armor-mode')), armor);
    await toggle.hover();
    if (armor) {
      await page.locator('.armor-level-button').click();
      assert.equal(await page.locator('.armor-level-menu [role="menuitemradio"]').count(), 5);
      assert.equal(await page.getByText('Open console', { exact: true }).count(), 0);
      await capture(scheme + '-armor-' + armor + '-chat');
      await page.keyboard.press('Escape');
    }
    await page.locator('.media-nav-button').click();
    if (!await page.locator('.media-studio:visible').count()) await visibleStudio().locator('[role="tab"][data-creative-mode="media"]').click();
    const studio = page.locator('.media-studio:visible');
    await studio.locator('.media-model-row select').waitFor();
    await until(() => studio.locator('.media-model-row select option').count().then(n => n >= 2));
    if (armor) assert.equal(await studio.evaluate(el => getComputedStyle(el).getPropertyValue('--studio-accent').trim()), '#22d3ee');
    assert.equal(await page.locator('.armor-studio-dialog').count(), 0);
    for (const model of models) {
      await studio.locator('.media-model-row select').selectOption('armor-qa::' + model);
      await studio.locator('.media-options-grid label').filter({ hasText: /^Size \/ ratio/ }).locator('select').selectOption('auto');
      await studio.locator('.media-options-grid label').filter({ hasText: /^Quality/ }).locator('select').selectOption('auto');
      const prompt = '两只杯子，左红右蓝；上方文字 ABC，保留白边。';
      await studio.locator('.media-prompt-card textarea').first().fill(prompt);
      const before = requests.length;
      await studio.locator('.media-generate-button').click();
      await until(() => requests.length === before + 1);
      assert.equal(requests.at(-1).prompt, prompt);
      assert.equal(requests.at(-1).model, model);
      assert.equal(requests.at(-1).size, undefined);
      assert.equal(requests.at(-1).quality, undefined);
      assert.equal(requests.at(-1).instructions, undefined);
      await until(() => studio.locator('.media-preview-trigger').count().then(n => n > 0));
    }
    await studio.locator('.media-generate-button').hover();
    await capture(scheme + '-armor-' + armor + '-media');
    await studio.locator('.media-preview-trigger').first().click();
    const lightbox = page.locator('.media-image-lightbox'); await lightbox.waitFor();
    if (armor) assert.equal(await lightbox.evaluate(el => getComputedStyle(el).getPropertyValue('--studio-accent').trim()), '#22d3ee');
    await capture(scheme + '-armor-' + armor + '-preview');
    await page.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 720, height: 920 });
    await capture(scheme + '-armor-' + armor + '-compact');
    await page.setViewportSize({ width: 1440, height: 920 });
    for (const mode of ['writing', 'constellation', 'media']) {
      await visibleStudio().locator('[role="tab"][data-creative-mode="' + mode + '"]').click();
      await page.locator('.' + mode + '-studio:visible').waitFor();
    }
    await page.reload(); await page.locator('.composer textarea').waitFor();
    assert.equal(await page.locator('.armor-toggle').getAttribute('aria-pressed'), String(armor));
    console.log('Passed ' + scheme + ' / Armor ' + armor + ': both models clean, skin, preview, compact layout and reload.');
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ identifier, requests, captures, errors, realUpstreamRequests: 0, passed: true }, null, 2));
} catch (error) {
  if (page) { await capture('failure').catch(() => {}); await writeFile(resolve(output, 'failure.txt'), (await page.locator('body').innerText().catch(() => '')) + String(error)); }
  throw error;
} finally {
  if (verified && page && !page.isClosed()) await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  if (browser) await browser.close();
  if (child && child.exitCode === null) child.kill();
  await new Promise(done => mock.close(done));
}

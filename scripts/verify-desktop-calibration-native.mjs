// Run the dedicated calibrationqa build only. Never connects a chat account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.LEVELUP_PLAYWRIGHT_MODULE)).href : 'playwright');
const output = resolve('artifacts/desktop-calibration-review');
await mkdir(output, { recursive: true });
const identifier = 'com.levelup.agent.calibrationqa';
let child, browser, page, verified = false;
const errors = [];
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 100)); } throw new Error('Native calibration check timed out'); }
async function launch() {
  verified = false;
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise(done => probe.close(done));
  let log = '', tabs = [];
  child = spawn(resolve('src-tauri/target/debug/levelup-agent.exe'), [], { windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });
  try { await until(() => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then(value => { tabs=value; return tabs.some(t => t.type === 'page'); }).catch(() => false)); }
  catch(error) { throw new Error(JSON.stringify({exitCode:child.exitCode,log,tabs}),{cause:error}); }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages().find(p => !p.url().includes('pet.html'));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  assert.equal(await invoke('plugin:app|identifier'), identifier, 'Refuse to mutate any other app profile');
  verified = true; page.on('pageerror', e => errors.push(e.message));
  await page.evaluate(() => localStorage.setItem('levelup-agent-locale', 'zh-CN'));
  await page.reload(); await page.locator('.composer textarea').waitFor();
}
async function close() {
  if (verified && page && !page.isClosed()) await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await browser?.close();
  if (child?.exitCode === null) { await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 3000))]); if (child.exitCode === null) child.kill(); }
}
try {
  await launch();
  await invoke('open_pet_workspace', { petId: 'yui', view: 'life' });
  await page.getByRole('button', { name: '自动机器人', exact: true }).click();
  await page.getByRole('button', { name: '平台账号', exact: true }).click();
  assert.equal(await page.getByLabel('平台', { exact: true }).inputValue(), 'dingtalk_desktop');
  const initialDesktop=(await invoke('chat_dashboard')).accounts.find(a=>a.platform==='dingtalk_desktop');
  assert.equal(await page.getByLabel('桌面应用', { exact: true }).inputValue(), initialDesktop?.desktop?.application ?? 'dingtalk');
  // A previous disconnected controller is automatically reopened on later runs.
  if (!(await invoke('chat_dashboard')).accounts.some(a=>a.platform==='dingtalk_desktop')) assert.equal(await page.getByRole('button', { name: '保存账号', exact: true }).isDisabled(), true);
  await page.screenshot({ path: resolve(output, 'native-default.png') });
  const desktop = { version: 2, windowTitle: 'Synthetic app', application: 'custom', processName: 'example.exe', windowHandle: 123, referenceSize: [1000, 800], selfNames: [], inputMode: 'foreground', editorPlaceholder: '',
    layout: { notification: [0, 0, .1, .1], sidebar: [.1, .1, .35, .85], title: [.35, 0, 1, .1], messages: [.35, .1, 1, .7], editor: [.35, .7, 1, .9], sendButton: [.9, .9, 1, 1], send: [.95, .95] } };
  desktop.calibrationImage = await page.evaluate(() => { const c=document.createElement('canvas');c.width=1000;c.height=800;const ctx=c.getContext('2d');ctx.fillStyle='#ddeeff';ctx.fillRect(0,0,1000,800);return c.toDataURL('image/png'); });
  desktop.layout.notification[2]=0.09488272921108742;
  const data = await invoke('chat_dashboard');
  const previous = data.accounts.find(a => a.appId === 'calibration-fixture');
  const account = { id: previous?.id ?? '', name: 'Calibration fixture', platform: 'dingtalk_desktop', appId: 'calibration-fixture', tenantId: '', endpoint: '', enabled: false, desktop };
  const saved = await invoke('chat_save_account', { account });
  assert.deepEqual(saved.desktop, desktop);
  await assert.rejects(() => invoke('chat_save_account', { account: { ...saved, desktop: { ...desktop, layout: { ...desktop.layout, notification: [0, 0, 0, 0] } } } }));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('article.chatbot-card').filter({ hasText: 'Calibration fixture' }).getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.getByLabel('桌面应用', { exact: true }).inputValue(), 'custom');
  assert.match(await page.getByTestId('desktop-setup').innerText(), /已框选 6 \/ 6/);
  assert.equal(await page.locator('.chatbot-calibration-box').count(),6);
  assert.equal(await page.locator('.chatbot-calibration img').getAttribute('src'),desktop.calibrationImage);
  await page.getByText('收发设置与精确坐标', { exact: true }).click();
  const aliases = page.getByLabel('我的 @ 显示名', { exact: false });
  await aliases.fill('测试甲, 测试乙');
  assert.equal(await aliases.inputValue(), '测试甲, 测试乙');
  await page.getByRole('button', { name: '保存账号', exact: true }).click();
  await until(async () => (await invoke('chat_dashboard')).accounts.find(a => a.id === saved.id)?.desktop.selfNames.length === 2);
  await close();
  await launch();
  const restored = (await invoke('chat_dashboard')).accounts.find(a => a.id === saved.id);
  assert.deepEqual(restored.desktop, { ...desktop, selfNames: ['测试甲', '测试乙'] });
  assert.equal(restored.enabled, false);
  await invoke('open_pet_workspace', {petId:'yui', view:'life'});
  await page.getByRole('button',{name:'自动机器人',exact:true}).click();
  await page.getByRole('button',{name:'平台账号',exact:true}).click();
  await page.locator('.chatbot-calibration img').waitFor();
  assert.equal(await page.locator('.chatbot-calibration-box').count(),6);
  assert.equal(await page.locator('.chatbot-calibration img').getAttribute('src'),desktop.calibrationImage);
  await page.getByRole('button',{name:'保存账号',exact:true}).click();
  await page.getByText('账号已保存。',{exact:true}).waitFor();
  assert.equal((await invoke('chat_dashboard')).accounts.filter(a=>a.platform==='dingtalk_desktop').length,1);
  await page.screenshot({path:resolve(output,'native-restored.png')});
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'native-report.json'), JSON.stringify({ passed: true, identifier, realMessagesSent: 0, cases: ['default desktop platform', 'incomplete save disabled', 'v2 Rust persistence', 'invalid region refused', 'custom account edit', 'comma separated mentions', 'close and restart screenshot/region persistence', 'disconnected controller reused without duplicate', 'fractional coordinates submit'] }, null, 2));
  console.log('Native calibration save, validation and restart passed.');
} finally { await close(); }

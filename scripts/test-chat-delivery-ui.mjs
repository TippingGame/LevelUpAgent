// Synthetic delivery records only. --native requires the isolated calibrationqa build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.LEVELUP_PLAYWRIGHT_MODULE)).href : 'playwright');
const output = resolve('artifacts/desktop-delivery-review');
await mkdir(output, { recursive: true });
const snapshot = {
  bots: [], routes: [], knowledge: [], memories: [], usage: [], runtimeReady: true, desktopRuntimeReady: true,
  accounts: [{ id: 'fixture', name: '测试桌面', platform: 'dingtalk_desktop', enabled: true }],
  connections: [{ accountId: 'fixture', status: 'waiting', detail: '正在观察消息红点；没有可唯一匹配的已绑定未读会话' }],
  messages: [{ id: 'reply', botId: '', accountId: 'fixture', routeId: '', chatId: '测试会话', chatType: 'direct', topicId: '',
    senderId: '测试联系人', text: '这是一条合成收到消息。', reply: '这是一条合成回复，不会实际发出。',
    status: 'generated', delivery: 'pending', error: null, createdAt: 1794009600000 }],
};
const errors = [];
let browser, server, child, nativePage, verified = false;
const invoke = (page, command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function freePort() {
  const probe = createHttpServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  return port;
}

async function installFixture(page) {
  await page.evaluate(data => {
    window.deliveryFixture = data;
    const original = window.fetch;
    const dashboardUrl = window.__TAURI_INTERNALS__.convertFileSrc('chat_dashboard', 'ipc');
    const chatPrefix = window.__TAURI_INTERNALS__.convertFileSrc('chat_', 'ipc');
    window.fetch = async (request, options) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url === dashboardUrl) return new Response(JSON.stringify(window.deliveryFixture), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
      });
      // This test must not write real accounts, routes, deliveries or credentials.
      if (url.startsWith(chatPrefix)) return new Response('Unexpected chat mutation', {
        headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
      });
      return original(request, options);
    };
  }, structuredClone(snapshot));
  assert.equal((await invoke(page, 'chat_dashboard')).messages[0]?.id, 'reply', 'Fixture IPC is active');
}

async function verifyStates(page, name) {
  await page.getByRole('button', { name: '收发记录', exact: true }).click();
  const detail = page.getByTestId('chat-delivery-detail');
  const refresh = page.getByRole('button', { name: '刷新', exact: true });
  const change = async (delivery, error = null, enabled = true) => {
    await page.evaluate(({ delivery, error, enabled }) => {
      deliveryFixture.messages[0].delivery = delivery;
      deliveryFixture.messages[0].error = error;
      deliveryFixture.messages[0].status = delivery === 'sent' ? 'sent' : 'generated';
      deliveryFixture.accounts[0].enabled = enabled;
    }, { delivery, error, enabled });
    await refresh.click();
    await page.waitForFunction(expected => document.querySelector('.chatbot-card > span')?.textContent.includes(expected),
      { pending: '等待发送', sending: '发送中', delivery_unknown: '送达待确认', sent: '本地已发出' }[delivery]);
  };
  await detail.waitFor();
  assert.match(await detail.innerText(), /正在观察消息红点/);
  await change('pending', null, false);
  await page.getByText(/账号未连接，回复已保留/).waitFor();
  const deferred = '发送前标题或空草稿未通过核对，等待人工处理';
  await change('pending', deferred);
  await page.getByText(deferred, { exact: true }).waitFor();
  assert.match(await detail.getAttribute('class'), /chatbot-notice/);
  await page.screenshot({ path: resolve(output, name + '-pending.png') });
  const progress = '正在核对发送前标题与回复文字';
  await change('sending', progress);
  await page.getByText(progress, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '已在平台确认送达', exact: true }).count(), 0);
  await refresh.hover(); await refresh.focus();
  await page.screenshot({ path: resolve(output, name + '-sending.png') });
  await change('delivery_unknown', '后台写入结果未通过画面核对，保留草稿且不发送');
  await page.getByRole('button', { name: '已在平台确认送达', exact: true }).waitFor();
  assert.match(await detail.getAttribute('class'), /chatbot-error/);
  await page.getByRole('button', { name: '放弃此条回复', exact: true }).hover();
  await page.screenshot({ path: resolve(output, name + '-unknown.png') });
  await change('sent');
  assert.equal(await detail.count(), 0, 'Confirmed delivery clears stale progress');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}

try {
  if (process.argv.includes('--native')) {
    const port = await freePort();
    child = spawn(resolve('src-tauri/target/debug/levelup-agent.exe'), [], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
    const deadline = Date.now() + 30000;
    while (true) {
      if (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then(tabs => tabs.some(t => t.type === 'page')).catch(() => false)) break;
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Native QA startup failed');
      await new Promise(done => setTimeout(done, 100));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    nativePage = browser.contexts()[0].pages().find(p => !p.url().includes('pet.html'));
    await nativePage.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
    assert.equal(await invoke(nativePage, 'plugin:app|identifier'), 'com.levelup.agent.calibrationqa');
    verified = true;
    assert.equal((await invoke(nativePage, 'chat_dashboard')).accounts.some(a => a.enabled), false, 'QA accounts must be disconnected');
    await nativePage.evaluate(() => localStorage.setItem('levelup-agent-locale', 'zh-CN'));
    await nativePage.reload(); await nativePage.locator('.composer textarea').waitFor();
    nativePage.on('pageerror', e => errors.push(e.message));
    await installFixture(nativePage);
    await invoke(nativePage, 'open_pet_workspace', { petId: 'yui', view: 'life' });
    await nativePage.getByRole('button', { name: '自动机器人', exact: true }).click();
    await verifyStates(nativePage, 'native');
  } else {
    await writeFile(resolve(output, 'delivery-fixture.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatBotWorkspace } from '/src/components/ChatBotWorkspace.tsx';
import '/src/App.css';
window.__TAURI_INTERNALS__={invoke:async command=>{if(command==='chat_dashboard')return structuredClone(window.deliveryFixture);if(command==='get_provider_settings')return {profiles:[]};throw new Error(command);}};
window.deliveryFixture=${JSON.stringify(snapshot)};
createRoot(document.getElementById('root')).render(<div className={'app-shell'+(location.search?' armor-mode':'')} style={{display:'block',height:'100vh'}}><ChatBotWorkspace pets={[]} initialPetId="fixture" locale="zh-CN" onBack={()=>{}}/></div>);
`);
    await writeFile(resolve(output, 'delivery.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="./delivery-fixture.tsx"></script></body></html>');
    server = await createServer({ server: { host: '127.0.0.1', port: await freePort(), strictPort: true } }); await server.listen();
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
    for (const colorScheme of ['light', 'dark']) for (const armor of [false, true]) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 720, height: 1000 } });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/artifacts/desktop-delivery-review/delivery.html${armor ? '?armor' : ''}`);
      await verifyStates(page, `${colorScheme}-armor-${armor}`);
      await page.emulateMedia({ colorScheme: colorScheme === 'light' ? 'dark' : 'light' });
      await page.emulateMedia({ colorScheme });
      await page.reload(); await page.getByRole('button', { name: '收发记录', exact: true }).click();
      await page.getByTestId('chat-delivery-detail').waitFor();
      assert.match(await page.getByTestId('chat-delivery-detail').innerText(), /正在观察消息红点/);
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, process.argv.includes('--native') ? 'native-ui-report.json' : 'ui-report.json'), JSON.stringify({ passed: true,
    syntheticRecords: true, realMessagesSent: 0, cases: ['disconnected queue explanation', 'pre-input deferral reason', 'sending progress', 'uncertain delivery controls', 'confirmed delivery clears progress', 'no horizontal overflow'] }, null, 2));
  console.log('Delivery record UI passed' + (process.argv.includes('--native') ? ' in isolated Tauri.' : ' at 720px in all four appearances.'));
} finally {
  if (verified && nativePage && !nativePage.isClosed()) await invoke(nativePage, 'plugin:window|close', { label: 'main' }).catch(() => {});
  await browser?.close(); await server?.close();
  if (child?.exitCode === null) {
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 3000))]);
    if (child.exitCode === null) child.kill();
  }
}

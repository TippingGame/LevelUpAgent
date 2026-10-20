// Native isolated QA. Prepare after pnpm build, build with the generated config,
// then run this script. It refuses all production application identifiers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const output = resolve('artifacts/chatbots-review');
const identifier = 'com.levelup.agent.chatbotsqa';
const python = process.env.LEVELUP_QA_PYTHON || resolve(output, 'venv/Scripts/python.exe');
const freshPython = process.argv.includes('--fresh-python');
const runtimeBackups = [];
let detectedSystemPython;
await mkdir(output, { recursive: true });
if (process.argv.includes('--prepare')) {
  const frontend = resolve(output, 'dist');
  await cp(resolve('dist'), frontend, { recursive: true });
  await writeFile(resolve(frontend, 'review.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="review-init.js"></script></body></html>');
  await writeFile(resolve(frontend, 'review-init.js'), 'localStorage.setItem("levelup-agent-locale","en-US");location.replace("index.html");');
  await writeFile(resolve(output, 'tauri.json'), JSON.stringify({ productName: 'LevelUpAgent Chat Bots QA', identifier, build: { beforeBuildCommand: '', frontendDist: '../artifacts/chatbots-review/dist' }, app: { windows: [{ label: 'main', title: 'LevelUpAgent Chat Bots QA', url: 'review.html', visible: false, width: 1440, height: 920 }] }, bundle: { active: false } }, null, 2));
  const pet = resolve(output, 'pet'); await mkdir(pet, { recursive: true });
  const manifest = JSON.parse(await readFile('src-tauri/resources/pets/yui/pet.json', 'utf8'));
  await cp('src-tauri/resources/pets/yui/spritesheet.webp', resolve(pet, 'spritesheet.webp'));
  await writeFile(resolve(pet, 'pet.json'), JSON.stringify({ ...manifest, id: 'chatbot-qa-echo', displayName: 'QA Echo' }));
  console.log('Prepared isolated chatbot review configuration.'); process.exit(0);
}
const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : 'playwright');
const requests = [];
const model = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.end('{"data":[]}'); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const serialized = JSON.stringify(body);
  const content = serialized.includes('BOT_ALPHA') ? 'ALPHA_REPLY' : 'BETA_REPLY';
  const respond = () => { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 21, completion_tokens: 7 } })); } };
  if (serialized.includes('SLOW_TURN')) setTimeout(respond, 6000); else respond();
});
await new Promise(done => model.listen(0, '127.0.0.1', done));
const peer = spawn(python, [resolve('scripts/chatbots-mock-platform.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const control = new Map(); let serial = 0;
let readyResolve; const ready = new Promise(done => readyResolve = done);
createInterface({ input: peer.stdout }).on('line', line => { const value = JSON.parse(line); if (value.port) readyResolve(value.port); else { const item = control.get(value.id); control.delete(value.id); if (value.error) item?.reject(new Error(value.error)); else item?.resolve(value.result); } });
const peerPort = await ready;
function peerCall(action, fields = {}) { return new Promise((resolve, reject) => { const id = ++serial; control.set(id, { resolve, reject }); peer.stdin.write(JSON.stringify({ id, action, ...fields }) + '\n'); }); }
let child, browser, page, verified = false;
const errors = [];
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 100)); } throw new Error('Native chatbot QA timed out'); }
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
async function launch() {
  verified = false;
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
  let launchOutput = '', launchTabs = [];
  const environment = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port };
  if (freshPython) environment.PATH = resolve(process.env.SystemRoot, 'System32');
  child = spawn(resolve('src-tauri/target/debug/levelup-agent.exe'), [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: environment });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { launchOutput = (launchOutput + chunk).slice(-12000); });
  try {
    await until(() => fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).then(tabs => { launchTabs = tabs.map(t => ({ url: t.url, type: t.type })); return tabs.some(t => t.url.includes('index.html')); }).catch(() => false));
  } catch (error) {
    const diagnostic = { pid: child.pid, exitCode: child.exitCode, tabs: launchTabs, output: launchOutput };
    await writeFile(resolve(output, 'launch-failure.json'), JSON.stringify(diagnostic, null, 2));
    throw new Error('Native launch failed: ' + JSON.stringify(diagnostic), { cause: error });
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = browser.contexts()[0].pages().find(p => p.url().includes('index.html'));
  assert.equal(await invoke('plugin:app|identifier'), identifier); verified = true;
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('.composer textarea').waitFor();
}
async function close() {
  if (verified && page && !page.isClosed()) { await invoke('plugin:window|close', { label: 'main' }).catch(() => {}); }
  if (browser) await browser.close();
  if (child && child.exitCode === null) { await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 5000))]); if (child.exitCode === null) child.kill(); }
}
const event = (id, chat, text, self = 42) => ({ post_type: 'message', self_id: self, message_type: 'private', message_id: id, user_id: chat, message: [{ type: 'text', data: { text } }] });
const send = async (id, chat, text, self = 42) => { await until(async () => (await peerCall('snapshot')).peers.includes(String(self))); return peerCall('event', { account: String(self), event: event(id, chat, text, self) }); };
const dashboard = () => invoke('chat_dashboard');
const find = (d, text) => d.messages.find(m => m.text === text);
try {
  await launch();
  console.log('Verified isolated native application.');
  await invoke('install_pet', { sourcePath: resolve(output, 'pet/pet.json') });
  // This verified QA profile also has a desktop-pet life scheduler. Keep its
  // unrelated autonomous learning out of chatbot request-count assertions.
  for (const petId of ['yui', 'chatbot-qa-echo']) {
    await invoke('update_pet_life_settings', { petId, settings: { autonomyEnabled:false, learningEnabled:false, movementEnabled:false, launchAtLogin:false } });
  }
  const settings = { profiles: [{ id: 'chatbot-qa-model', name: 'QA model', baseUrl: 'http://127.0.0.1:' + model.address().port, model: 'qa', protocol: 'openai_chat', allowUnauthenticated: true, priority: 0, failoverEnabled: false }], activeProfileId: 'chatbot-qa-model' };
  await invoke('save_provider_settings', { settings });
  let d = await dashboard();
  // Only the verified dedicated QA profile is changed; prior runs can be rerun.
  for (const a of d.accounts) await invoke('chat_save_account', { account: { ...a, enabled: false } });
  for (const r of d.routes) await invoke('chat_delete', { kind: 'route', id: r.id });
  for (const b of d.bots) await invoke('chat_delete', { kind: 'history', id: b.id });
  for (const a of d.accounts) await invoke('chat_delete', { kind: 'account', id: a.id });
  if (freshPython) {
    const appData = await invoke('plugin:path|resolve_directory', { directory: 14 });
    assert.equal(resolve(appData), resolve(process.env.APPDATA, identifier));
    for (const folder of ['chatbot-runtime-v1', 'chatbot-desktop-runtime-v1']) {
      const target = resolve(appData, folder);
      const backup = target + '.python-auto-qa-' + Date.now();
      if (await stat(target).catch(() => null)) {
        await rename(target, backup);
        runtimeBackups.push({ target, backup, parent: resolve(appData) });
      } else runtimeBackups.push({ target, parent: resolve(appData) });
    }
    d = await dashboard(); assert.equal(d.runtimeReady, false); assert.equal(d.desktopRuntimeReady, false);
    detectedSystemPython = await invoke('chat_detect_python', { desktop: true });
    assert.ok(detectedSystemPython?.executable);
    assert.match(detectedSystemPython.version, /^3\.(10|11|12)\./);
    assert.equal(detectedSystemPython.bits, 64);
    assert.ok(!detectedSystemPython.executable.includes(identifier), 'Must find a system install without a managed runtime or Python on PATH');
    await writeFile(resolve(output, 'build3-python-detection.json'), JSON.stringify({ noPythonOnPath: true, managedRuntimesAbsent: true, detectedSystemPython }, null, 2));
  }
  assert.ok((await invoke('chat_detect_python', { desktop: false }))?.executable);
  if (!d.runtimeReady) await invoke('chat_install_runtime', {});
  d = await dashboard(); assert.equal(d.runtimeReady, true);
  console.log('Gateway runtime ready.');
  const needsCredential = await invoke('chat_save_account', { account: { id: '', name: 'Missing credential QA', platform: 'onebot', appId: '44', tenantId: '', endpoint: 'ws://127.0.0.1:' + peerPort + '/44', enabled: true } });
  assert.ok(needsCredential.id, 'An offline save returns its stable account ID');
  const credentialState = (await dashboard()).connections.find(s => s.accountId === needsCredential.id);
  assert.equal(credentialState.status, 'credential_required');
  await invoke('chat_save_account', { account: { ...needsCredential, enabled: false } });
  await invoke('chat_delete', { kind: 'account', id: needsCredential.id });
  // History cleanup intentionally retains budgets. Allow repeated isolated QA
  // runs without exhausting the normal production default of 100 replies/day.
  const makeBot = (petId, persona) => ({ id: d.bots.find(b => b.petId === petId)?.id || '', petId, name: petId, profileId: settings.activeProfileId, persona, enabled: true, revision: 0, dailyReplyLimit: 10000, cooldownSeconds: 0 });
  const alpha = await invoke('chat_save_bot', { bot: makeBot('yui', 'BOT_ALPHA warm') });
  const beta = await invoke('chat_save_bot', { bot: makeBot('chatbot-qa-echo', 'BOT_BETA precise') });
  const accounts = [];
  for (const id of ['42', '43']) accounts.push(await invoke('chat_save_account', { account: { id: d.accounts.find(a => a.appId === id)?.id || '', name: 'OneBot QA ' + id, platform: 'onebot', appId: id, tenantId: '', endpoint: 'ws://127.0.0.1:' + peerPort + '/' + id, enabled: true }, secret: 'local-qa-token' }));
  await until(async () => (await peerCall('snapshot')).peers.length === 2);
  const addRoute = (bot, account, chat) => invoke('chat_save_route', { route: { id: '', botId: bot.id, accountId: account.id, chatType: 'direct', chatId: String(chat), topicId: '', mode: 'mention', paused: false } });
  let ra = await addRoute(alpha, accounts[0], 101); await addRoute(beta, accounts[0], 102); await addRoute(beta, accounts[1], 101);
  await assert.rejects(() => addRoute(beta, accounts[0], 101));
  await invoke('chat_save_knowledge', { item: { id: '', botId: alpha.id, routeId: ra.id, title: 'Alpha reference', content: 'ALPHA_PRIVATE_KNOWLEDGE' } });
  await invoke('chat_save_memory', { item: { id: '', botId: alpha.id, routeId: ra.id, senderId: '101', content: 'ALPHA_RELATION_MEMORY' } });
  // Exclude stale startup work from the previous isolated QA run.
  requests.length = 0;
  const stamp = Date.now();
  await send(stamp, 101, 'ALPHA_FIRST'); await send(stamp, 101, 'ALPHA_FIRST');
  await send(stamp + 1, 102, 'BETA_FIRST'); await send(stamp, 101, 'BETA_ACCOUNT', 43);
  await until(async () => (await peerCall('snapshot')).sends.length === 3);
  console.log('Dual bot and account routing delivered.');
  await writeFile(resolve(output, 'model-requests-diagnostic.json'), JSON.stringify(requests, null, 2));
  assert.equal(requests.length, 3); assert.ok(requests.every(r => !r.tools || r.tools.length === 0));
  for (const request of requests) { const s = JSON.stringify(request); assert.ok(!s.includes('local development agent')); assert.equal(request.max_completion_tokens,4096); if (s.includes('BOT_BETA')) {assert.ok(!s.includes('ALPHA_PRIVATE_KNOWLEDGE'));assert.ok(!s.includes('ALPHA_RELATION_MEMORY'));} else assert.ok(s.includes('ALPHA_RELATION_MEMORY')); }
  const replies = (await peerCall('snapshot')).sends; assert.equal(replies.filter(s => s.params.message[0].data.text === 'ALPHA_REPLY').length, 1);
  await invoke('select_pet', { petId: 'chatbot-qa-echo' });
  await send(stamp + 2, 101, 'ALPHA_AFTER_PET_SWITCH'); await until(async () => (await peerCall('snapshot')).sends.length === 4);
  assert.equal((await peerCall('snapshot')).sends[3].params.message[0].data.text, 'ALPHA_REPLY');
  await send(stamp + 3, 101, 'SLOW_TURN'); await until(async () => find(await dashboard(), 'SLOW_TURN')?.status === 'generating');
  ra = await invoke('chat_save_route', { route: { ...ra, paused: true } });
  await until(async () => find(await dashboard(), 'SLOW_TURN')?.status === 'cancelled');
  await send(stamp + 4, 101, 'HUMAN_TAKEOVER'); await until(async () => find(await dashboard(), 'HUMAN_TAKEOVER')?.status === 'paused');
  ra = await invoke('chat_save_route', { route: { ...ra, paused: false } });
  await peerCall('drop_next'); await send(stamp + 5, 101, 'UNCERTAIN_SEND');
  await until(async () => find(await dashboard(), 'UNCERTAIN_SEND')?.delivery === 'delivery_unknown', 60000);
  console.log('Pause and uncertain delivery verified.');
  const sentCount = (await peerCall('snapshot')).sends.length;
  await send(stamp + 6, 101, 'AFTER_UNKNOWN'); await until(async () => find(await dashboard(), 'AFTER_UNKNOWN')?.status === 'queued');
  assert.equal((await peerCall('snapshot')).sends.length, sentCount);
  const uncertain = find(await dashboard(), 'UNCERTAIN_SEND'); await invoke('chat_resolve_delivery', { inboxId: uncertain.id, sent: true });
  await until(async () => (await peerCall('snapshot')).sends.length === sentCount + 1);
  await peerCall('reject_account', { account: '43' });
  await until(async () => !(await peerCall('snapshot')).peers.includes('43'));
  const independentSends = (await peerCall('snapshot')).sends.length;
  await send(stamp + 8, 101, 'HEALTHY_ACCOUNT_DURING_PEER_FAILURE');
  await until(async () => (await peerCall('snapshot')).sends.length === independentSends + 1);
  assert.equal((await peerCall('snapshot')).sends.at(-1).account, '42');
  await peerCall('allow_account', { account: '43' });
  await until(async () => (await peerCall('snapshot')).peers.includes('43'));
  await send(stamp + 9, 101, 'RECOVERED_ACCOUNT', 43);
  await until(async () => (await peerCall('snapshot')).sends.length === independentSends + 2);
  console.log('Independent account failure and reconnect verified.');
  const beforeCrash = (await peerCall('snapshot')).sends.length;
  await peerCall('hold_next');
  await send(stamp + 10, 101, 'CRASH_DURING_SEND');
  await until(async () => (await peerCall('snapshot')).sends.length === beforeCrash + 1);
  const crashAccountSends = (await peerCall('snapshot')).sends.filter(s => s.account === '42').length;
  assert.equal(find(await dashboard(), 'CRASH_DURING_SEND')?.delivery, 'sending');
  await send(stamp + 11, 101, 'SLOW_TURN_CRASH', 43);
  await until(() => requests.some(r => JSON.stringify(r).includes('SLOW_TURN_CRASH')));
  assert.equal(find(await dashboard(), 'SLOW_TURN_CRASH')?.status, 'generating');
  const crashExit = new Promise(done => child.once('exit', done));
  child.kill(); await crashExit;
  verified = false;
  await browser.close();
  await until(async () => (await peerCall('snapshot')).peers.length === 0);
  const crashRequestCount = requests.length;
  await launch();
  await until(async () => (await peerCall('snapshot')).peers.length === 2);
  assert.equal(find(await dashboard(), 'CRASH_DURING_SEND')?.delivery, 'delivery_unknown');
  assert.equal(find(await dashboard(), 'SLOW_TURN_CRASH')?.status, 'interrupted');
  await send(stamp + 12, 101, 'AFTER_CRASH_ON_HEALTHY_SESSION', 43);
  await until(async () => (await peerCall('snapshot')).sends.length === beforeCrash + 2);
  assert.equal(requests.length, crashRequestCount + 1, 'Crashed turns must not regenerate');
  assert.equal((await peerCall('snapshot')).sends.filter(s => s.account === '42').length, crashAccountSends, 'An unconfirmed send must not repeat after process exit');
  const crashUnknown = find(await dashboard(), 'CRASH_DURING_SEND');
  await invoke('chat_resolve_delivery', { inboxId: crashUnknown.id, sent: false });
  console.log('Forced process exit preserves generation and delivery boundaries.');
  await invoke('open_pet_workspace', { petId: 'yui', view: 'life' });
  await page.getByRole('button', { name: 'Chat bots', exact: true }).click();
  await page.getByTestId('chatbot-workspace').waitFor();
  await page.getByLabel('Name',{exact:true}).fill('Yui QA saved through UI');
  await page.getByRole('button',{name:'Save identity',exact:true}).click();
  await until(async()=> (await dashboard()).bots.find(b=>b.id===alpha.id)?.name==='Yui QA saved through UI');
  console.log('Inspecting native UI appearance.');
  await page.setViewportSize({ width: 720, height: 920 });
  for (const scheme of ['light', 'dark']) for (const armor of [false, true]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.getByRole('button',{name:'Close Starlight Echoes',exact:true}).click();
    const toggle=page.locator('.armor-toggle');
    if((await toggle.getAttribute('aria-pressed')==='true')!==armor) await toggle.click();
    await invoke('open_pet_workspace',{petId:'yui',view:'life'});
    await page.getByRole('button',{name:'Chat bots',exact:true}).click();
    for (const tab of ['Identity', 'Accounts', 'Routes', 'Knowledge', 'Messages']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      const button = page.getByRole('button', { name: tab, exact: true }); await button.hover(); await button.focus();
      await page.screenshot({ path: resolve(output, scheme + '-armor-' + armor + '-' + tab.toLowerCase() + '.png'), fullPage: true });
      assert.equal(await page.locator('.chatbot-main').evaluate(el => el.scrollWidth > el.clientWidth + 2), false, 'No horizontal overflow in ' + tab);
      if(tab==='Routes'){
        await page.getByRole('button',{name:'Add chat',exact:true}).click();
        await page.getByLabel('Exact chat ID',{exact:true}).fill('101');
        await page.getByRole('button',{name:'Save route',exact:true}).click();
        await page.getByRole('alert').waitFor();
        await until(() => page.getByRole('alert').evaluate(el => { const r=el.getBoundingClientRect(); const main=el.closest('.chatbot-main').getBoundingClientRect(); return r.top>=main.top && r.bottom<=main.bottom; }));
        await page.screenshot({path:resolve(output,scheme+'-armor-'+armor+'-error.png'),fullPage:true});
      }
    }
  }
  await page.getByRole('button',{name:'Routes',exact:true}).click();
  await page.getByLabel('Scope account',{exact:true}).selectOption(accounts[0].id);
  await page.getByLabel('All private chats, including future chats',{exact:true}).check();
  await page.getByRole('button',{name:'Save all-chat scope',exact:true}).click();
  await until(async()=> (await dashboard()).routes.some(r=>r.accountId===accounts[0].id && r.scope==='all' && r.chatType==='direct' && !r.paused));
  await send(stamp+40,999,'NEW_PRIVATE_VIA_ALL_SCOPE');
  await until(async()=>find(await dashboard(),'NEW_PRIVATE_VIA_ALL_SCOPE')?.delivery==='sent');
  const excluded = await addRoute(alpha,accounts[0],998);
  await invoke('chat_save_route',{route:{...excluded,paused:true}});
  await send(stamp+41,998,'EXACT_PAUSE_OVERRIDES_ALL_SCOPE');
  await until(async()=>find(await dashboard(),'EXACT_PAUSE_OVERRIDES_ALL_SCOPE')?.status==='paused');
  await page.getByLabel('Scope chat type',{exact:true}).selectOption('group');
  await page.getByLabel('All group chats, including future groups',{exact:true}).check();
  await page.getByRole('button',{name:'Save all-chat scope',exact:true}).click();
  await until(async()=> (await dashboard()).routes.some(r=>r.accountId===accounts[0].id && r.scope==='all' && r.chatType==='group' && !r.paused));
  const groupEvent=(id,text,mentioned)=>({post_type:'message',self_id:42,message_type:'group',message_id:id,group_id:997,user_id:996,message:[...(mentioned?[{type:'at',data:{qq:'42'}}]:[]),{type:'text',data:{text}}]});
  await peerCall('event',{account:'42',event:groupEvent(stamp+42,'GROUP_ALL_SCOPE_PLAIN',false)});
  await until(async()=>find(await dashboard(),'GROUP_ALL_SCOPE_PLAIN')?.status==='ignored_trigger');
  await peerCall('event',{account:'42',event:groupEvent(stamp+43,'GROUP_ALL_SCOPE_AT',true)});
  await until(async()=> (await dashboard()).messages.some(m=>m.text.includes('GROUP_ALL_SCOPE_AT') && m.delivery==='sent'));
  await page.getByRole('button',{name:'Knowledge',exact:true}).click();
  await page.getByRole('button',{name:'Add knowledge',exact:true}).click();
  const visibilityLabels=await page.getByLabel('Visibility',{exact:false}).locator('option').allTextContents();
  assert.ok(visibilityLabels.some(label=>label.includes('All private chats')));
  assert.ok(visibilityLabels.some(label=>label.includes('All group chats')));
  const allRules=(await dashboard()).routes.filter(r=>r.scope==='all');
  await invoke('chat_save_routes',{routes:allRules.map(r=>({...r,paused:true}))});
  await page.reload(); await page.locator('.composer textarea').waitFor();
  const beforeRestart = (await peerCall('snapshot')).sends.length;
  await close(); await until(async () => (await peerCall('snapshot')).peers.length === 0);
  await launch(); await until(async () => (await peerCall('snapshot')).peers.length === 2);
  await send(stamp, 101, 'ALPHA_FIRST'); await send(stamp + 7, 101, 'AFTER_RESTART');
  await until(async () => (await peerCall('snapshot')).sends.length === beforeRestart + 1);
  assert.equal((await dashboard()).bots.length, 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  const cleanup=await dashboard();
  for(const a of cleanup.accounts) await invoke('chat_save_account',{account:{...a,enabled:false}});
  for(const a of cleanup.accounts) await invoke('chat_delete',{kind:'account',id:a.id});
  assert.equal((await dashboard()).accounts.length,0);
  // Desktop channel uses the actual local Python/Win32 probe; no DingTalk is
  // impersonated here. A missing real chat is explicitly an unverified case.
  console.log('Verifying no-credential desktop setup and local window probe.');
  if (!(await dashboard()).desktopRuntimeReady) await invoke('chat_install_runtime', { desktop: true });
  assert.equal((await dashboard()).desktopRuntimeReady, true);
  const appData = await invoke('plugin:path|resolve_directory', { directory: 14 });
  assert.equal(resolve(appData), resolve(process.env.APPDATA, identifier));
  const desktopRoot = resolve(appData, 'chatbot-desktop-runtime-v1');
  const configBefore = (await stat(resolve(desktopRoot, 'pyvenv.cfg'))).mtimeMs;
  const markerBefore = (await stat(resolve(desktopRoot, 'ready-v1'))).mtimeMs;
  await assert.rejects(() => invoke('chat_install_runtime', { python: resolve(output, 'missing Python/python.exe'), desktop: true }));
  assert.equal((await stat(resolve(desktopRoot, 'ready-v1'))).mtimeMs, markerBefore, 'Invalid selection must not invalidate a working runtime');
  const manualPython = process.env.LEVELUP_QA_MANUAL_PYTHON;
  await invoke('chat_install_runtime', { ...(manualPython ? { python: manualPython } : {}), desktop: true });
  assert.equal((await stat(resolve(desktopRoot, 'pyvenv.cfg'))).mtimeMs, configBefore, 'Recheck must reuse the existing venv');
  const desktopWindows = await invoke('chat_desktop_probe', { request: {} });
  assert.ok(Array.isArray(desktopWindows.windows));
  const desktopConfig = { version: 1, windowTitle: 'LevelUp QA nonexistent DingTalk window', selfNames: ['QA Echo'], layout: { title: [.33,.045,.81,.10], messages:[.30,.12,.985,.64],editor:[.31,.70,.97,.88],sidebar:[.105,.15,.285,.97],send:[.93,.94] } };
  const desktop = await invoke('chat_save_account', { account: { id:'',name:'Desktop QA',platform:'dingtalk_desktop',appId:'local-dingtalk-desktop',tenantId:'',endpoint:'',enabled:true,desktop:desktopConfig } });
  await until(async () => (await dashboard()).connections.some(c => c.accountId === desktop.id && c.status === 'waiting'));
  assert.ok(!(await dashboard()).connections.some(c => c.accountId===desktop.id && c.status==='credential_required'));
  const desktopDirect = await addRoute(alpha,desktop,'Desktop QA private');
  await invoke('chat_save_route', { route:{...desktopDirect,id:'',chatId:'Desktop QA group',chatType:'group',mode:'mention'} });
  await invoke('chat_save_route', { route:{...desktopDirect,id:'',chatId:'Desktop QA all',chatType:'group',mode:'all'} });
  await assert.rejects(() => invoke('chat_save_route', { route:{...desktopDirect,id:'',scope:'all',chatId:'*'} }));
  await until(async () => (await dashboard()).connections.some(c => c.accountId===desktop.id && c.status==='waiting' && c.detail.includes('钉钉窗口')));
  await invoke('chat_save_account', { account:{...desktop,enabled:false} });
  await invoke('open_pet_workspace',{petId:'yui',view:'life'});
  await page.getByRole('button',{name:'Chat bots',exact:true}).click();
  await page.getByRole('button',{name:'Routes',exact:true}).click();
  await page.setViewportSize({width:720,height:920});
  await page.getByLabel('Scope account',{exact:true}).selectOption(desktop.id);
  await page.getByLabel('Register full chat titles (one per line)',{exact:true}).fill('QA selected A\nQA selected B');
  await page.getByRole('button',{name:'Add to selection list',exact:true}).click();
  await page.getByRole('button',{name:'Select all listed',exact:true}).click();
  await page.getByRole('button',{name:'Apply list selection',exact:true}).click();
  await until(async()=> (await dashboard()).routes.filter(r=>r.accountId===desktop.id && r.chatId.startsWith('QA selected') && !r.paused).length===2);
  await page.getByLabel('QA selected A',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Apply list selection',exact:true}).click();
  await until(async()=> (await dashboard()).routes.find(r=>r.accountId===desktop.id && r.chatId==='QA selected A')?.paused);
  assert.equal((await dashboard()).routes.find(r=>r.accountId===desktop.id && r.chatId==='QA selected B').paused,false);
  await page.getByLabel('Scope chat type',{exact:true}).selectOption('group');
  assert.equal(await page.getByLabel('All group chats, including future groups',{exact:true}).isDisabled(),true);
  await page.getByLabel('Register full chat titles (one per line)',{exact:true}).fill('QA selected group A\nQA selected group B');
  await page.getByRole('button',{name:'Add to selection list',exact:true}).click();
  await page.getByRole('button',{name:'Select all listed',exact:true}).click();
  await page.getByLabel('Batch group trigger',{exact:true}).selectOption('all');
  await page.getByRole('button',{name:'Apply list selection',exact:true}).click();
  await until(async()=> (await dashboard()).routes.filter(r=>r.accountId===desktop.id && r.chatId.startsWith('QA selected group') && r.mode==='all' && !r.paused).length===2);
  await page.getByRole('button',{name:'Deselect all listed',exact:true}).click();
  await page.getByRole('button',{name:'Apply list selection',exact:true}).click();
  await until(async()=> (await dashboard()).routes.filter(r=>r.accountId===desktop.id && r.chatType==='group').every(r=>r.paused));
  for (const scheme of ['light', 'dark']) for (const armor of [false, true]) {
    await page.emulateMedia({colorScheme:scheme});
    await page.getByRole('button',{name:'Close Starlight Echoes',exact:true}).click();
    const toggle=page.locator('.armor-toggle');
    if((await toggle.getAttribute('aria-pressed')==='true')!==armor) await toggle.click();
    await invoke('open_pet_workspace',{petId:'yui',view:'life'});
    await page.getByRole('button',{name:'Chat bots',exact:true}).click();
    await page.getByRole('button',{name:'Routes',exact:true}).click();
    await page.getByLabel('Scope account',{exact:true}).selectOption(desktop.id);
    await page.getByLabel('Scope chat type',{exact:true}).selectOption('group');
    await page.getByRole('button',{name:'Select all listed',exact:true}).click();
    await page.getByRole('button',{name:'Select all listed',exact:true}).hover();
    await page.getByLabel('Filter chats',{exact:true}).focus();
    await page.screenshot({path:resolve(output,'build6-'+scheme+'-armor-'+armor+'-selection.png'),fullPage:true});
    await page.getByLabel('Batch group trigger',{exact:true}).selectOption('all');
    await page.getByLabel('Batch group trigger',{exact:true}).focus();
    await page.getByLabel('Batch group trigger',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,'build6-'+scheme+'-armor-'+armor+'-selection-controls.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>innerWidth),720);
    assert.equal(await page.locator('.chatbot-main').evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
  }
  await page.setViewportSize({width:720,height:920});
  await invoke('open_pet_workspace',{petId:'yui',view:'life'});
  await page.getByRole('button',{name:'Chat bots',exact:true}).click();
  await page.getByRole('button',{name:'Accounts',exact:true}).click();
  await page.getByLabel('Platform',{exact:true}).selectOption('dingtalk_desktop');
  await until(() => page.getByTestId('chat-python-detection').innerText().then(text => text.startsWith('Detected Python')));
  await page.getByRole('button',{name:'Check existing environment',exact:true}).click();
  await until(() => page.getByRole('button',{name:'Check existing environment',exact:true}).isEnabled());
  assert.equal((await stat(resolve(desktopRoot, 'pyvenv.cfg'))).mtimeMs, configBefore);
  await page.getByLabel('My exact @ names (comma separated)',{exact:true}).fill('QA Echo, Second Name');
  assert.equal(await page.getByLabel('My exact @ names (comma separated)',{exact:true}).inputValue(),'QA Echo, Second Name');
  assert.equal(await page.getByLabel('App ID / Client ID',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('App secret / Client secret',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Detect DingTalk windows',exact:true}).click();
  await until(() => page.getByRole('button',{name:'Detect DingTalk windows',exact:true}).isEnabled());
  let calibratedDesktop = false;
  if (desktopWindows.windows.filter(w => w.title === '钉钉' && !w.minimized).length === 1) {
    await page.getByLabel('DingTalk window',{exact:false}).selectOption('钉钉');
    const automatic = page.getByRole('button',{name:'Detect regions and preview (no sending)',exact:true});
    await automatic.click();
    await until(() => page.getByTestId('desktop-editor-diagnostic').isVisible(),90000);
    assert.ok(await page.getByAltText('DingTalk calibration screenshot').isVisible());
    assert.ok((await page.getByTestId('desktop-editor-diagnostic').innerText()).includes('UIA 与画面对照'));
    calibratedDesktop = true;
  }
  for (const scheme of ['light','dark']) for (const armor of [false,true]) {
    await page.emulateMedia({colorScheme:scheme});
    await page.getByRole('button',{name:'Close Starlight Echoes',exact:true}).click();
    const toggle=page.locator('.armor-toggle');
    if ((await toggle.getAttribute('aria-pressed')==='true')!==armor) await toggle.click();
    await invoke('open_pet_workspace',{petId:'yui',view:'life'});
    await page.getByRole('button',{name:'Chat bots',exact:true}).click();
    await page.getByRole('button',{name:'Accounts',exact:true}).click();
    await page.getByLabel('Platform',{exact:true}).selectOption('dingtalk_desktop');
    await until(() => page.getByTestId('chat-python-detection').innerText().then(text => text.startsWith('Detected Python')));
    const setup=page.getByTestId('desktop-runtime'); await setup.scrollIntoViewIfNeeded();
    await page.getByText('Choose Python manually (custom installation)',{exact:true}).click();
    await page.getByRole('button',{name:'Choose installed python.exe',exact:true}).hover();
    await page.getByRole('button',{name:'Choose installed python.exe',exact:true}).focus();
    await page.screenshot({path:resolve(output,scheme+'-armor-'+armor+'-desktop.png'),fullPage:true});
    const automatic = page.getByRole('button',{name:'Detect regions and preview (no sending)',exact:true});
    await automatic.scrollIntoViewIfNeeded();
    assert.equal(await automatic.isDisabled(),true);
    await page.getByRole('button',{name:'Detect DingTalk windows',exact:true}).hover();
    await page.screenshot({path:resolve(output,scheme+'-armor-'+armor+'-calibration.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>innerWidth),720);
    assert.equal(await page.locator('.chatbot-main').evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
  }
  await invoke('chat_delete',{kind:'account',id:desktop.id});
  assert.equal((await dashboard()).accounts.length,0);
  const report = { verifiedAt: new Date().toISOString(), identifier, modelRequests: requests.length, sends: (await peerCall('snapshot')).sends.length, cases: ['two bots / two accounts', 'route collision', 'deduplication', 'persona isolation', 'knowledge ACL', 'relation memory isolation', 'pet selection independence', 'pause cancels generation', 'human takeover', 'delivery unknown blocks ordered session', 'owner resolution', 'restart + dedup', 'gateway children stop', 'identity saved through UI', 'four appearance combinations at 720px', 'all five UI panels', 'form errors visible without manual scrolling', 'account removal and credential cleanup', 'saved account without credential remains editable', 'one account failure leaves the other operational', 'failed account reconnects and resumes'], livePlatforms: 'not tested: user app credentials required', errors };
  report.cases.push('forced process exit during generation and sending', 'crash orphan gateways exit on stdin EOF', 'no resend or regeneration after forced exit');
  report.cases.push('all private scope saved through UI delivers new private chat','paused exact override blocks all scope','all group scope preserves mention trigger','knowledge visibility names account and private/group scope');
  report.cases.push('private selection and individual exclusion through UI','group select all and batch pause through UI','desktop all-new-text opt-in','desktop wildcard disabled and rejected','selection in four appearance combinations');
  report.cases.push('desktop runtime installed separately','desktop account connects without credentials','real local window enumeration','missing DingTalk waits without sending','desktop direct and mention routing validation','desktop setup UI in four appearance combinations');
  report.desktop = { windowsFound:desktopWindows.windows.length, calibratedDesktop, liveMessaging:'separate scoped live transport test; this native QA does not send to DingTalk', version:await invoke('plugin:app|version') };
  if (calibratedDesktop) report.cases.push('real DingTalk automatic layout and editor preview through native UI');
  report.cases.push('auto-detect installed Python', 'auto setup without manual interpreter path', 'invalid Python preserves working runtime marker', 'existing venv reused without recreation', 'automatic check through native UI');
  if (freshPython) report.cases.push('system Python found without Python on PATH or managed runtime');
  if (manualPython) report.cases.push('manual interpreter path containing Chinese characters and spaces');
  report.pythonDetection = { freshPython, detectedSystemPython, manualPython, existingRuntimeReused: true };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await close(); peer.stdin.end(); peer.kill(); model.closeAllConnections(); await new Promise(done => model.close(done));
  for (const { target, backup, parent } of runtimeBackups) {
    assert.equal(resolve(target, '..'), parent);
    assert.ok(parent.endsWith(identifier));
    await rm(target, { recursive: true, force: true });
    if (backup) await rename(backup, target);
  }
}

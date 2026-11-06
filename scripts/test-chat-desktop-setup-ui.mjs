// Isolated UI regression: generated screenshots and fake IPC, no real chats.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.LEVELUP_PLAYWRIGHT_MODULE)).href : 'playwright');
const output = resolve('artifacts/desktop-calibration-review');
await mkdir(output, { recursive: true });
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatDesktopSetup, defaultDesktopConfig } from '/src/components/ChatDesktopSetup.tsx';
import '/src/App.css';
import '/src/components/ChatBotWorkspace.css';
const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=800;
const ctx=canvas.getContext('2d');ctx.fillStyle='#eef1f6';ctx.fillRect(0,0,1000,800);
ctx.fillStyle='#dbe8fa';ctx.fillRect(100,80,250,600);ctx.fillStyle='#ffffff';ctx.fillRect(350,80,650,480);ctx.fillRect(350,580,650,140);
ctx.fillStyle='#29466b';ctx.font='24px sans-serif';ctx.fillText('Alice · Design team',390,50);ctx.fillText('Alice',180,150);ctx.fillText('A readable incoming message',400,240);ctx.fillText('Send',910,770);
ctx.fillStyle='#ef5232';ctx.beginPath();ctx.arc(70,45,8,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(140,125,8,0,Math.PI*2);ctx.fill();
window.desktopTest={image:canvas.toDataURL('image/png'),windows:[{handle:1,title:'钉钉',processName:'dingtalk.exe',width:1000,height:800,minimized:false}],calls:[],fail:false};
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
  desktopTest.calls.push({command,args});
  if(command==='chat_detect_python') return {executable:'C:/test/python.exe',version:'3.12.10',bits:64};
  if(command==='chat_desktop_probe') {
    if(desktopTest.fail) throw new Error('Synthetic failure');
    const result={windows:desktopTest.windows,diagnostics:[]};
    if(args.request.windowTitle) return {...result,image:desktopTest.image,width:1000,height:800,titleLines:[{text:'Alice · Design team'}],messages:[{text:'A readable incoming message',direction:'incoming'}],unread:{notification:true,rows:1},editor:{readable:true,draftEmpty:true,detail:'当前草稿为空'}};
    return result;
  }
  throw new Error('Unexpected IPC: '+command);
}};
function Fixture(){
  const [account,setAccount]=useState(()=>JSON.parse(localStorage.getItem('calibration-saved')||'null')||{id:'',platform:'dingtalk_desktop',enabled:false,desktop:defaultDesktopConfig()});
  const [connected,setConnected]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  desktopTest.account=account;desktopTest.setConnected=setConnected;
  const action=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className={'app-shell'+(new URLSearchParams(location.search).has('armor')?' armor-mode':'')} style={{display:'block',height:'auto',minHeight:'100vh'}}><main className="chatbot-workspace" style={{maxWidth:1000,margin:'auto',padding:20}}>{error&&<p role="alert">{error}</p>}<form onSubmit={e=>{e.preventDefault();const saved={...account,id:'saved-desktop'};localStorage.setItem('calibration-saved',JSON.stringify(saved));setAccount(saved);desktopTest.saved=true;}}><ChatDesktopSetup key={account.id||'new'} account={account} onChange={setAccount} connectedAccount={connected?account:undefined} onPause={async()=>setConnected(false)} ready busy={busy} action={action} t={(zh,en)=>zh}/><button type="submit">保存测试账号</button></form></main></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await writeFile(resolve(output, 'fixture.tsx'), fixture);
await writeFile(resolve(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
const errors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) });
  for (const colorScheme of ['light', 'dark']) for (const armor of [false, true]) {
    const context = await browser.newContext({ colorScheme, viewport: { width: 720, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/artifacts/desktop-calibration-review/index.html${armor ? '?armor' : ''}`);
    const detect = page.getByRole('button', { name: '检测应用窗口', exact: true });
    const capture = page.getByRole('button', { name: '自动截图', exact: true });
    const preview = page.getByRole('button', { name: '检查实时识别（不发送）', exact: true });
    assert.equal(await page.getByLabel('桌面应用', { exact: true }).inputValue(), 'dingtalk');
    assert.equal(await preview.isDisabled(), true);
    await detect.click(); await capture.click();
    const image = page.getByRole('img', { name: '拖动截图框选区域', exact: true });
    await image.waitFor();
    const draw = async box => {
      await image.scrollIntoViewIfNeeded();
      const bounds = await image.boundingBox();
      box = box.map(v => Math.max(.002, Math.min(.998, v)));
      await page.mouse.move(bounds.x + box[0] * bounds.width, bounds.y + box[1] * bounds.height);
      await page.mouse.down();
      await page.mouse.move(bounds.x + box[2] * bounds.width, bounds.y + box[3] * bounds.height, { steps: 6 });
      await page.mouse.up();
    };
    const regions = { notification: [.01, .01, .1, .1], sidebar: [.1, .1, .35, .85], title: [.35, 0, 1, .1], messages: [.35, .1, 1, .7], editor: [.35, .7, 1, .9], sendButton: [.9, .9, 1, 1] };
    for (const box of Object.values(regions)) await draw(box);
    assert.equal(await preview.isEnabled(), true);
    const config = await page.evaluate(() => desktopTest.account.desktop);
    assert.equal(config.version, 2); assert.equal(config.inputMode, 'background');
    for (const [key, box] of Object.entries(regions)) for (let i = 0; i < 4; i++) assert.ok(Math.abs(config.layout[key][i] - box[i]) < .005, key);
    assert.ok(Math.abs(config.layout.send[0] - .95) < .005);
    await page.getByText('收发设置与精确坐标', {exact:true}).click();
    await page.locator('fieldset input[type=number]').nth(2).fill('0.09488272921108742');
    assert.equal(await page.locator('form').evaluate(form=>form.checkValidity()), true, 'Fractional pointer coordinates must not block form submission');
    await page.getByRole('button',{name:'保存测试账号'}).click();
    await page.waitForFunction(()=>desktopTest.saved===true);
    assert.equal(await page.locator('.chatbot-calibration-box').count(),6,'Saving and remounting preserves all overlays');
    const savedConfig=await page.evaluate(()=>desktopTest.account.desktop);
    await page.reload();
    await image.waitFor();
    assert.deepEqual(await page.evaluate(()=>desktopTest.account.desktop),savedConfig);
    assert.equal(await page.locator('.chatbot-calibration-box').count(),6);
    assert.equal(await page.locator('.chatbot-calibration img').getAttribute('src'),savedConfig.calibrationImage);
    await preview.click();
    await page.getByTestId('desktop-recognition-result').waitFor();
    assert.match(await page.getByTestId('desktop-recognition-result').innerText(), /Alice · Design team/);
    await page.getByRole('button', { name: /✓ · 标题栏/ }).click();
    await draw([.36, .005, .95, .09]);
    assert.equal(await page.getByTestId('desktop-recognition-result').count(), 0, 'Changed regions invalidate OCR');
    await image.scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: /✓ · 标题栏/ }).hover();
    await page.screenshot({ path: resolve(output, `${colorScheme}-armor-${armor}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Zoom does not change coordinate interpretation; drag in the visible half.
    await page.getByLabel('截图缩放').selectOption('2');
    await page.getByRole('button', { name: /✓ · 消息栏/ }).click();
    await draw([.02, .02, .09, .09]);
    const zoomed = await page.evaluate(() => desktopTest.account.desktop.layout.notification);
    assert.ok(Math.abs(zoomed[0] - .02) < .005);
    await page.getByLabel('截图缩放').selectOption('1');
    // A new upload resets all old boxes and requires cropping confirmation.
    const png = await page.evaluate(() => desktopTest.image.split(',')[1]);
    await page.locator('input[type=file]').setInputFiles({ name: 'interface.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.getByRole('button', { name: '这张图就是完整应用窗口' }).waitFor();
    assert.equal(await preview.isDisabled(), true);
    await draw([.1, .1, .9, .9]);
    await page.waitForFunction(() => desktopTest.account.desktop.referenceSize[0] < 900);
    const cropped = await page.evaluate(() => desktopTest.account.desktop);
    assert.ok(Math.abs(cropped.referenceSize[0] - 800) <= 2);
    assert.deepEqual(cropped.layout.title, [0, 0, 0, 0]);
    // Running connection locks mutations; pause restores them.
    await page.evaluate(() => desktopTest.setConnected(true));
    await page.waitForFunction(() => document.querySelector('input[type=file]').disabled);
    assert.equal(await capture.isDisabled(), true);
    await page.getByRole('button', { name: '暂停连接并校准' }).click();
    await page.getByLabel('桌面应用', { exact: true }).selectOption('custom');
    await detect.click();
    assert.equal(await page.evaluate(() => desktopTest.calls.at(-1).args.request.application), 'custom');
    assert.equal(await page.evaluate(()=>desktopTest.account.desktop.inputMode),'foreground');
    await page.emulateMedia({ colorScheme: colorScheme === 'light' ? 'dark' : 'light' });
    await page.emulateMedia({ colorScheme });
    await page.reload();
    assert.equal(await page.getByLabel('桌面应用', { exact: true }).inputValue(), 'dingtalk');
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'ui-report.json'), JSON.stringify({ passed: true, appearanceCases: 4, viewport: 720,
    cases: ['default background DingTalk', 'fractional form submit', 'save/remount/reload screenshot and six regions', 'capture without OCR', 'six pointer regions', 'button center', 'live preview invalidation', 'zoom coordinates', 'upload and crop', 'active lock and pause', 'custom applications', 'appearance switch/reload'], realMessagesSent: 0 }, null, 2));
  console.log('Desktop calibration UI passed in light/dark with Armor off/on.');
} finally { await browser?.close(); await server.close(); }

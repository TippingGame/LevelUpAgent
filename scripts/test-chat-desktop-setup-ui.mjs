// Isolated component regression. All IPC is synthetic; no real chat or account.
// Install Playwright separately and optionally set LEVELUP_PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.LEVELUP_PLAYWRIGHT_MODULE)).href : 'playwright');
const output = resolve('artifacts/dingtalk-detection-review');
await mkdir(output, { recursive: true });
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatDesktopSetup, defaultDesktopConfig } from '/src/components/ChatDesktopSetup.tsx';
import '/src/App.css';
import '/src/components/ChatBotWorkspace.css';
const saved = {id:'saved',name:'Test',platform:'dingtalk_desktop',enabled:true,
  desktop:{...defaultDesktopConfig(),windowTitle:'钉钉',selfNames:['Test']}};
window.desktopTest = {windows:[{handle:1,title:'钉钉',width:1385,height:866,minimized:false}],diagnostics:[],calls:[],fail:false};
window.__TAURI_INTERNALS__ = {invoke:async (command,args) => {
  desktopTest.calls.push({command,args});
  if(command==='chat_detect_python') return {executable:'C:/test/python.exe',version:'3.12.10',bits:64};
  if(command==='chat_desktop_probe') {
    if(desktopTest.fail) throw new Error('Synthetic probe failure');
    return {windows:structuredClone(desktopTest.windows),diagnostics:structuredClone(desktopTest.diagnostics)};
  }
  throw new Error('Unexpected IPC: '+command);
}};
function Fixture() {
  const [account,setAccount]=useState({...saved,id:'',enabled:false,desktop:defaultDesktopConfig()});
  const [connected,setConnected]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  desktopTest.account=account;
  desktopTest.setAccount=setAccount;
  const action=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const armor=new URLSearchParams(location.search).has('armor');
  return <div className={'app-shell'+(armor?' armor-mode':'')} style={{display:'block',height:'auto',minHeight:'100vh'}}>
    <main className="chatbot-workspace" style={{maxWidth:680,margin:'auto',padding:20}}>
      <h1>钉钉窗口检测</h1>{error&&<p role="alert">{error}</p>}
      <ChatDesktopSetup key={account.id||'new'} account={account} onChange={setAccount}
        connectedAccount={connected?saved:undefined} onPause={async()=>{setConnected(false);setAccount({...saved,enabled:false});}}
        ready busy={busy} action={action} t={(zh,en)=>zh}/>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
// Let Vite resolve bare React imports and transform the TSX fixture itself.
const fixturePath = resolve(output, 'fixture.tsx');
await writeFile(fixturePath, fixture);
await writeFile(resolve(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
const server = await createServer({server:{host:'127.0.0.1',port:0,strictPort:false}});
let browser;
const errors = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await chromium.launch({headless:true,...(existsSync(edge)?{executablePath:edge}:{})});
  for(const colorScheme of ['light','dark']) for(const armor of [false,true]) {
    const context = await browser.newContext({colorScheme,viewport:{width:720,height:920}});
    const page = await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/artifacts/dingtalk-detection-review/index.html${armor?'?armor':''}`, {waitUntil:'domcontentloaded',timeout:60000});
    const detect = page.getByRole('button',{name:'检测钉钉窗口',exact:true});
    const selection = page.getByLabel('钉钉窗口',{exact:false});
    const result = page.getByTestId('desktop-window-result');
    const preview = page.getByRole('button',{name:'自动识别区域并预览（不发消息）',exact:true});
    const inputMode = page.getByTestId('desktop-input-mode');
    assert.equal(await inputMode.inputValue(),'background');
    assert.equal(await inputMode.isDisabled(),true);
    await detect.click();
    await result.waitFor();
    assert.match(await result.innerText(),/已检测到 1 个钉钉窗口/);
    assert.match(await result.innerText(),/钉钉 · 1385 × 866/);
    assert.match(await result.innerText(),/检测成功.*暂停连接并校准/);
    assert.equal(await selection.isDisabled(),true);
    assert.equal(await selection.inputValue(),'');
    assert.equal(await preview.isDisabled(),true);
    assert.equal(await page.evaluate(()=>desktopTest.account.desktop.windowTitle),'');
    await result.scrollIntoViewIfNeeded();
    await detect.hover(); await detect.focus();
    await page.screenshot({path:resolve(output,`${colorScheme}-armor-${armor}.png`),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

    // A minimized window must still be visible and explain the next action.
    await page.evaluate(()=>{desktopTest.windows[0].minimized=true;});
    await detect.click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="desktop-window-result"]')?.textContent.includes('请还原'));
    assert.match(await result.innerText(),/已最小化.*请还原/);

    // Failed/empty rescans must not leave the previous successful list behind.
    await page.evaluate(()=>{desktopTest.fail=true;});
    await detect.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await result.count(),0);
    await page.evaluate(()=>{desktopTest.fail=false;desktopTest.windows=[];});
    await detect.click();
    await result.waitFor();
    assert.match(await result.innerText(),/未检测到可用.*托盘/);
    await page.evaluate(()=>{desktopTest.diagnostics=[{code:'process_unverified',detail:'发现标题为钉钉的窗口，但无法核验所属进程。请以同一 Windows 用户正常启动钉钉和本应用后重试。'}];});
    await detect.click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="desktop-window-result"]')?.textContent.includes('无法核验所属进程'));
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,`${colorScheme}-armor-${armor}-diagnostic.png`),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

    // Pause recovers the saved account. Detection may now repair a stale title.
    await page.getByRole('button',{name:'暂停连接并校准',exact:true}).click();
    await page.waitForFunction(()=>desktopTest.account.id==='saved');
    await page.evaluate(()=>{desktopTest.diagnostics=[];desktopTest.windows=[{handle:2,title:'DingTalk',width:1200,height:800,minimized:false}];});
    await detect.click();
    await page.waitForFunction(()=>desktopTest.account.desktop.windowTitle==='DingTalk');
    assert.equal(await selection.isEnabled(),true);
    assert.equal(await preview.isEnabled(),true);
    assert.equal(await selection.inputValue(),'DingTalk');
    assert.equal(await inputMode.isEnabled(),true);
    await inputMode.selectOption('foreground');
    assert.equal(await page.evaluate(()=>desktopTest.account.desktop.inputMode),'foreground');
    assert.match(await page.getByTestId('desktop-execution-mode').innerText(),/发送时会激活钉钉.*鼠标或键盘/);
    assert.match(await page.getByTestId('desktop-execution-mode').innerText(),/空闲 5 秒/);
    await inputMode.hover(); await inputMode.focus();
    await page.screenshot({path:resolve(output,`${colorScheme}-armor-${armor}-foreground-mode.png`),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await inputMode.selectOption('background');
    assert.equal(await page.evaluate(()=>desktopTest.account.desktop.inputMode),'background');
    assert.match(await page.getByTestId('desktop-execution-mode').innerText(),/后台窗口定向收发/);
    const calls = await page.evaluate(()=>desktopTest.calls);
    assert.ok(calls.every(c=>c.command==='chat_detect_python'||(c.command==='chat_desktop_probe'&&Object.keys(c.args.request).length===0)));
    // Also exercise switching appearance in the mounted component and reload.
    await page.emulateMedia({colorScheme:colorScheme==='light'?'dark':'light'});
    await page.emulateMedia({colorScheme});
    await page.reload(); await detect.click(); await result.waitFor();
    assert.match(await result.innerText(),/检测成功/);
    await context.close();
  }
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({passed:true,appearanceCases:4,
    cases:['active connection with empty form','visible success and window dimensions','calibration remains locked',
      'minimized restore hint','failed rescan clears stale result','empty rescan','empty-result diagnostic','pause recovers account',
      'offline detection repairs stale title','foreground mode requires explicit selection and explains focus','720px layout','appearance switches and reload'],
    nativeTauriBuild:false,realMessagesSent:0},null,2));
  console.log('DingTalk setup UI: all cases passed in light/dark with Armor off/on.');
} finally {
  await browser?.close();
  await server.close();
}

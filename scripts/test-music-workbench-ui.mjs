import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require=createRequire(process.env.MUSIC_PLAYWRIGHT_PACKAGE || new URL('../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json', import.meta.url));
const {chromium}=require('playwright');
const native=process.argv.includes('--native');
const output=resolve('artifacts/music-workbench/ui'); await mkdir(output,{recursive:true});
const browser=native?await chromium.connectOverCDP('http://127.0.0.1:9451'):await chromium.launch({channel:'msedge',headless:true});
const context=native?browser.contexts()[0]:await browser.newContext({viewport:{width:1440,height:920}});
const page=native?context.pages().find(p=>p.url().includes('localhost')||p.url().includes('127.0.0.1')):await context.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const button=name=>page.getByRole('button',{name,exact:true});
async function setupDialog(){if(!await button('环境与下载').isVisible())await button('更多操作').click();await button('环境与下载').click();}
async function enter(){await page.locator('.media-nav-button').click(); await page.locator('.music-workbench:not([hidden])').waitFor();}
try {
 if(!native) await page.goto('http://127.0.0.1:1420');
 if(native) assert.equal(await invoke('plugin:app|identifier'),'com.levelup.agent.musicqa20261010');
 await page.evaluate(()=>{localStorage.setItem('levelup-agent-locale','zh-CN');localStorage.setItem('levelup-agent.creative-studio-view.v1','music');});
 await page.reload(); await enter();
 const report={native,appearances:[],navigation:[],errors};
 for(const mode of ['light','dark']) for(const armor of [false,true]) {
  await page.emulateMedia({colorScheme:mode});
  await page.evaluate(armor=>localStorage.setItem('levelup-agent.armor-mode.v1',String(armor)),armor);
  await page.reload(); await enter();
  await button('温暖钢琴').click();
  assert.match(await page.getByLabel('音乐描述',{exact:true}).inputValue(),/Soft piano/);
  await page.getByText('更多参数',{exact:true}).click();
  await page.getByLabel('种子',{exact:true}).fill('20261009');
  await button('生成音乐').hover();
  await page.screenshot({path:resolve(output,`${native?'native':'browser'}-${mode}-${armor?'armor':'plain'}.png`)});
  await setupDialog(); await page.getByRole('dialog').waitFor();
  await button('导入离线资源').focus();
  await page.screenshot({path:resolve(output,`${native?'native':'browser'}-${mode}-${armor?'armor':'plain'}-dialog.png`)});
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  report.appearances.push({mode,armor});
 }
 // Exercise the actual shared navigation in both directions, including remembered view.
 for(const label of ['图片 · 视频 · 语音','写作','星图','Spine','3D']) {
  await page.locator('.music-workbench').getByRole('tab',{name:label,exact:true}).click();
  const back=page.locator('.creative-studio:not([hidden])').getByRole('tab',{name:'音频',exact:true});
  await back.click(); await page.locator('.music-workbench:not([hidden])').waitFor(); report.navigation.push(label);
 }
 for(const width of [720,1100,1440]) {
  if(native) await page.setViewportSize({width,height:900});
  else await page.setViewportSize({width,height:900});
  await setupDialog();
  assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true,`Overflow at ${width}`);
  await page.screenshot({path:resolve(output,`${native?'native':'browser'}-${width}-dialog.png`)});
  await page.keyboard.press('Escape');
 }
 await page.reload(); await enter();
 await page.getByText('更多参数',{exact:true}).click();
 assert.equal(await page.getByLabel('种子',{exact:true}).inputValue(),'20261009');
 if(native) {
  report.initial=await invoke('music_status'); report.hardware=await invoke('music_hardware');
  if(!report.initial.ready) {
   await invoke('music_install',{offlineDirectory:resolve('artifacts/music-workbench/release')});
   const deadline=Date.now()+600000;
   while(true){const s=await invoke('music_status');if(s.operation?.status==='failed')throw new Error(s.operation.detail);if(s.ready)break;assert.ok(Date.now()<deadline,'Resource installation timeout');await new Promise(resolve=>setTimeout(resolve,1500));}
  }
  await page.getByLabel('时长（秒）',{exact:true}).fill('4');
  await button('生成音乐').click();
  await page.locator('.music-player audio').waitFor({timeout:180000});
  await page.waitForFunction(()=>document.querySelector('.music-player audio')?.readyState>=1);
  await page.locator('audio').evaluate(a=>a.play());
  await page.waitForFunction(()=>document.querySelector('.music-player audio')?.currentTime>.1);
  report.playback=await page.locator('audio').evaluate(a=>({duration:a.duration,currentTime:a.currentTime,error:a.error?.message}));
  await button('收藏').click(); await button('已收藏').waitFor();
  await page.getByText('裁剪与淡入淡出',{exact:true}).click();
  await page.getByLabel('开始（秒）',{exact:true}).fill('0.5'); await page.getByLabel('结束（秒）',{exact:true}).fill('2.5');
  await button('另存为新版本').click();
  await page.locator('.music-player-title strong').filter({hasText:'剪辑'}).waitFor();
  report.finished=await invoke('music_status');
  const edited=report.finished.jobs.find(j=>j.parent_id); assert.equal(edited.audio.duration,2);
  await invoke('music_export',{id:edited.id,destination:resolve(output,'desktop-export.wav')});
  await page.screenshot({path:resolve(output,'native-generated.png')});
 }
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,`${native?'native':'browser'}-result.json`),JSON.stringify(report,null,2)); console.log(JSON.stringify({status:'passed',native,appearances:report.appearances,navigation:report.navigation,playback:report.playback,errors},null,2));
} catch(error){await page.screenshot({path:resolve(output,`${native?'native':'browser'}-failure.png`)});throw error;}
finally {if(native)await browser.close();else {await context.close();await browser.close();}}

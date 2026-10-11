import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require=createRequire(process.env.MUSIC_PLAYWRIGHT_PACKAGE || new URL('../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json', import.meta.url));
const {chromium}=require('playwright');
const native=process.argv.includes('--native');
const engine=process.env.MUSIC_TEST_ENGINE || 'musicgen';
const output=resolve(process.env.MUSIC_UI_OUTPUT || 'artifacts/music-workbench/ui'); await mkdir(output,{recursive:true});
const browser=native?await chromium.connectOverCDP('http://127.0.0.1:9451'):await chromium.launch({channel:'msedge',headless:true});
const context=native?browser.contexts()[0]:await browser.newContext({viewport:{width:1440,height:920}});
let page=native?context.pages().find(p=>(p.url().includes('localhost')||p.url().includes('127.0.0.1')) && new URL(p.url()).pathname==='/'):await context.newPage();
if(native)for(let attempt=0;!page && attempt<40;attempt++){await new Promise(resolve=>setTimeout(resolve,250));page=context.pages().find(p=>(p.url().includes('localhost')||p.url().includes('127.0.0.1')) && new URL(p.url()).pathname==='/');}
assert.ok(page,'The isolated Tauri webview did not become ready');
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const button=name=>page.getByRole('button',{name,exact:true});
async function setupDialog(){if(!await button('环境与下载').isVisible())await button('更多操作').click();await button('环境与下载').click();}
async function enter(){await page.locator('.media-nav-button').click(); await page.locator('.music-workbench:not([hidden])').waitFor();}
try {
 if(!native) await page.goto('http://127.0.0.1:1420');
 if(native) assert.equal(await invoke('plugin:app|identifier'),process.env.MUSIC_QA_IDENTIFIER || 'com.levelup.agent.musicqa20261010');
 await page.evaluate(()=>{localStorage.setItem('levelup-agent-locale','zh-CN');localStorage.setItem('levelup-agent.creative-studio-view.v1','music');});
 await page.reload(); await enter();
 const report={native,appearances:[],navigation:[],errors};
 for(const mode of ['light','dark']) for(const armor of [false,true]) {
  await page.emulateMedia({colorScheme:mode});
  await page.evaluate(armor=>localStorage.setItem('levelup-agent.armor-mode.v1',String(armor)),armor);
  await page.reload(); await enter();
  await page.locator('.music-compose').getByLabel('生成模型',{exact:true}).selectOption('yue2');
  if(!await button('选择参考音频').isVisible())await page.getByText('参考音频（选填）',{exact:true}).click();
  assert.equal(await button('选择参考音频').isVisible(),true);
  await button('带歌词歌曲').click();
  await page.getByLabel('歌词',{exact:true}).fill('[Verse]\n晨光落在窗前\n我们迎着风向前');
  await page.getByLabel('演唱语言',{exact:true}).selectOption('zh');
  await page.getByLabel('时长（秒）',{exact:true}).fill('45');
  await button('温暖钢琴').click();
  assert.match(await page.getByLabel('音乐描述',{exact:true}).inputValue(),/Soft piano/);
  await page.getByText('更多参数',{exact:true}).click();
  await page.getByLabel('种子',{exact:true}).fill('20261009');
  await page.getByText('参考音频（选填）',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,`${native?'native':'browser'}-${mode}-${armor?'armor':'plain'}-reference.png`)});
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
 assert.equal(await page.getByLabel('歌词',{exact:true}).inputValue(),'[Verse]\n晨光落在窗前\n我们迎着风向前');
 await page.locator('.music-compose').getByLabel('生成模型',{exact:true}).selectOption('yue2');
 assert.equal(await page.getByLabel('时长（秒）',{exact:true}).getAttribute('max'),'600');
 await page.locator('.music-compose').getByLabel('生成模型',{exact:true}).selectOption('musicgen');
 assert.equal(await button('带歌词歌曲').isDisabled(),true);
 assert.equal(await page.getByLabel('歌词',{exact:true}).count(),0);
 assert.equal(await page.getByLabel('时长（秒）',{exact:true}).getAttribute('max'),'30');
 await page.getByText('更多参数',{exact:true}).click();
 assert.equal(await page.getByLabel('种子',{exact:true}).inputValue(),'20261009');
 if(native && !process.argv.includes('--appearance-only')) {
  await page.locator('.music-compose').getByLabel('生成模型',{exact:true}).selectOption(engine);
  if(engine!=='musicgen')await button('带歌词歌曲').click();
  report.initial=await invoke('music_status'); report.hardware=await invoke('music_hardware');
  if(!report.initial.engines[engine].ready) {
   await invoke('music_install',{engine,offlineDirectory:resolve(process.env.MUSIC_TEST_ASSETS || 'artifacts/music-workbench/release')});
   const deadline=Date.now()+1800000; // Debug Rust hashes multi-GB archives much slower than a release build.
   while(true){const s=await invoke('music_status');if(s.operation?.status==='failed')throw new Error(s.operation.detail);if(s.engines[engine].ready)break;assert.ok(Date.now()<deadline,'Resource installation timeout');await new Promise(resolve=>setTimeout(resolve,1500));}
  }
  await page.getByLabel('时长（秒）',{exact:true}).fill(engine==='musicgen'?'4':'12');
  const nativeTitle=`Native ${engine} ${Date.now()}`;
  await page.getByLabel('作品名（选填）',{exact:true}).fill(nativeTitle);
  await button('生成音乐').click();
  await page.locator('.music-player-title strong').filter({hasText:nativeTitle}).waitFor();
  await page.locator('.music-player audio').waitFor({timeout:600000});
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
  const generated=report.finished.jobs.find(j=>j.params.title===nativeTitle);
  assert.equal(generated.status,'succeeded');assert.equal(generated.params.engine,engine);
  assert.equal(generated.params.mode,engine==='musicgen'?'instrumental':'song');
  const edited=report.finished.jobs.find(j=>j.parent_id===generated.id); assert.equal(edited.audio.duration,2);
  await invoke('music_export',{id:edited.id,destination:resolve(output,'desktop-export.wav')});
  await page.screenshot({path:resolve(output,'native-generated.png')});
 }
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,`${native?'native':'browser'}-result.json`),JSON.stringify(report,null,2)); console.log(JSON.stringify({status:'passed',native,appearances:report.appearances,navigation:report.navigation,playback:report.playback,errors},null,2));
} catch(error){await page.screenshot({path:resolve(output,`${native?'native':'browser'}-failure.png`)});throw error;}
finally {if(native)await browser.close();else {await context.close();await browser.close();}}

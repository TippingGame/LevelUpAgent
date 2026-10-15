// Opt-in acceptance against the isolated Windows QA app, never the user's app ID.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const require = createRequire(new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url));
const { chromium } = require("playwright");
const output = resolve("artifacts/model-workbench/windows-native/acceptance");
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9451");
const page = browser.contexts()[0].pages().find(p => p.url().includes("localhost") && new URL(p.url()).pathname === "/");
assert.ok(page, "Isolated Tauri page must be open");
const invoke = (command, args = {}) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const report = process.argv.includes("--continue")
  ? JSON.parse(await readFile(resolve(output,"native.json"),"utf8"))
  : { errors: [], appearances: [], stages: {} };
delete report.failure; report.status="running";
page.on("pageerror", error => report.errors.push(error.message));
const button = name => page.getByRole("button", {name,exact:true});
async function save() { await writeFile(resolve(output,"native.json"),JSON.stringify(report,null,2)); }
async function enter() { await page.locator(".media-nav-button").click(); await page.locator(".model-workbench:not([hidden])").waitFor(); }
async function waitOperation(kind, stage, timeout = 1200000) {
  const deadline=Date.now()+timeout; let phase;
  while (Date.now()<deadline) {
    const state=await invoke("model3d_status"), op=state.operation;
    if (op?.kind===kind && (!stage || op.stage===stage)) {
      if (op.status!=="running") { assert.equal(op.status,"completed",JSON.stringify(op)); return state; }
      if (op.phase!==phase) { phase=op.phase; console.log(kind,stage??"",phase,op.detail??""); }
    }
    await new Promise(r=>setTimeout(r,1500));
  }
  throw Error("Native operation timed out");
}
async function preview(stage) {
  const run = report.stages[stage].record.directory.split("/").pop();
  await page.waitForFunction(run => { const el=document.querySelector("model-viewer");
    return el?.loaded && decodeURIComponent(el.src).includes(run); }, run, {timeout:60000});
  const value=await page.locator("model-viewer").evaluate(el => ({loaded:el.loaded,src:el.src,
    textured:el.model.materials.some(m=>!!m.pbrMetallicRoughness.baseColorTexture?.texture),animations:el.availableAnimations}));
  if (stage!=="shape") assert.equal(value.textured,true,"Embedded texture must actually load");
  if (stage==="rig") {
    assert.ok(value.animations.length>=3);
    await button("播放动作").click();
    await page.waitForFunction(()=>document.querySelector("model-viewer")?.currentTime>.1);
    value.animationAdvanced=await page.locator("model-viewer").evaluate(el=>el.currentTime);
    await button("暂停动作").click();
  }
  await page.screenshot({path:resolve(output,`generated-${stage}.png`)});
  return value;
}
try {
  assert.equal(await invoke("plugin:app|identifier"),"com.levelup.agent.modelnative20261015");
  await page.evaluate(()=>{localStorage.setItem("levelup-agent-locale","zh-CN");localStorage.setItem("levelup-agent.creative-studio-view.v1","model3d");});
  await page.reload(); await enter();
  report.before ??= await invoke("model3d_status");
  assert.equal(report.before.system.platform,"windows-x64-cu118");
  if (!process.argv.includes("--continue")) assert.ok(Object.values(report.before.components).every(v=>!v));
  for (const mode of process.argv.includes("--continue")?[]:["light","dark"]) for (const armor of [false,true]) {
    await page.emulateMedia({colorScheme:mode});
    await page.evaluate(a=>localStorage.setItem("levelup-agent.armor-mode.v1",String(a)),armor);
    await page.reload(); await enter();
    await button("环境与下载").hover(); await button("环境与下载").click();
    const dialog=page.getByRole("dialog"); await dialog.waitFor();
    assert.match(await dialog.innerText(),/Windows x64 原生运行，无需 WSL/);
    await button("离线导入").focus();
    await page.screenshot({path:resolve(output,`${mode}-${armor?"armor":"plain"}-dialog.png`)});
    report.appearances.push({mode,armor,style:await dialog.evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}))});
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({width:720,height:900});
  if (!await button("环境与下载").isVisible()) await button("更多操作").click();
  await button("环境与下载").click();
  assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(output,"720-dialog.png")});
  await page.keyboard.press("Escape"); await page.setViewportSize({width:1440,height:920});
  await page.emulateMedia({colorScheme:"light"});
  await page.evaluate(()=>localStorage.setItem("levelup-agent.armor-mode.v1","false"));
  await page.reload(); await enter(); await save();
  if (!Object.values((await invoke("model3d_status")).components).every(Boolean)) {
    await invoke("model3d_start",{action:"install",request:{components:["runtime","triposg","texture","blender"],offlineDirectory:resolve("artifacts/model-workbench/windows-native/release")}});
    report.installed=await waitOperation("install");
    assert.ok(Object.values(report.installed.components).every(Boolean));
    console.log("Native offline install passed",report.installed.runtimeRoot); await save();
  }
  if (process.argv.includes("--install-only")) { console.log("Install and appearance acceptance passed"); }
  else {
    report.project ??= await invoke("model3d_import",{source:resolve("../LevelUpGaussian/experiments/chibi-20261003/view_1_front.png")});
    await page.reload(); await enter();
    await page.locator(".model-sidebar > label select").selectOption(report.project.id);
    for (const [stage,label] of [["shape","生成形状"],["texture","独立贴图"],["rig","蒙皮与动画"]]) {
      if(stage!=="shape") await page.locator(".model-stagebar button").filter({hasText:label}).click();
      if(report.stages[stage]?.preview) continue;
      if(stage==="rig") await page.getByLabel("骨架起点").selectOption("chibi");
      const started=Date.now();
      await page.locator(".model-sidebar").getByRole("button",{name:label,exact:true}).click();
      const state=await waitOperation("generate",stage);
      report.stages[stage]={seconds:(Date.now()-started)/1000,record:state.projects.find(p=>p.id===report.project.id).stages[stage]};
      // The UI refreshes independently of the IPC polling above.
      await page.locator(".model-sidebar").getByRole("button",{name:"重新生成本阶段",exact:true}).waitFor({timeout:15000});
      report.stages[stage].preview=await preview(stage);
      for(const name of stage==="rig"?["model.glb","character.fbx","character.blend","delivery.zip"]:["model.glb"]) {
        await invoke("model3d_export",{projectId:report.project.id,stage,name,destination:resolve(output,`${stage}-${name}`)});
      }
      await save(); console.log("Native generation and preview passed",stage);
    }
    await page.reload(); await enter();
    const after=await invoke("model3d_status");
    assert.equal(Object.keys(after.projects.find(p=>p.id===report.project.id).stages).length,3);
    report.afterReload=after; report.status="passed"; await save();
    console.log("Native install, shape, texture, rig, preview, export and reload passed");
  }
  assert.deepEqual(report.errors,[]);
} catch (error) {
  report.status="failed"; report.failure=String(error); await save();
  await page.screenshot({path:resolve(output,"failure.png")}); throw error;
} finally { await browser.close(); }

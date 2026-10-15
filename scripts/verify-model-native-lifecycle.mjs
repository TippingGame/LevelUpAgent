// Cancellation and actual desktop shutdown against only our isolated acceptance app.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
const require=createRequire(new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json",import.meta.url));
const {chromium}=require("playwright");
const root=resolve("artifacts/model-workbench/windows-native");
const identity="com.levelup.agent.modelnative20261015";
const acceptance=JSON.parse(await readFile(resolve(root,"acceptance/native.json"),"utf8"));
assert.equal(acceptance.status,"passed","Complete real generation first");
let browser,page;
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
async function until(check,timeout=30000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,300));}
  throw Error("Native lifecycle timeout");
}
async function connect(){
  browser=await chromium.connectOverCDP("http://127.0.0.1:9451");
  page=await until(()=>browser.contexts()[0].pages().find(p=>p.url().includes("localhost")&&["/","/index.html"].includes(new URL(p.url()).pathname)));
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
  assert.equal(await invoke("plugin:app|identifier"),identity);
}
function processes(){
  const json=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*artifacts\\model-workbench\\windows-native\\*' } | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress"],{encoding:"utf8",windowsHide:true}).trim();
  const value=json?JSON.parse(json):[]; return Array.isArray(value)?value:[value];
}
async function running(){
  await invoke("model3d_start",{action:"generate",request:{projectId:acceptance.project.id,stage:"shape",settings:{preset:"draft",steps:10}}});
  await assert.rejects(invoke("model3d_start",{action:"generate",request:{projectId:acceptance.project.id,stage:"shape"}}));
  await until(async()=>{const s=await invoke("model3d_status");assert.notEqual(s.operation.status,"failed",s.operation.detail);return s.operation.phase==="shape"&&processes().length>=3;});
  return processes();
}
async function noChildren(before){
  const workers=before.filter(p=>p.ExecutablePath.endsWith("python.exe")).map(p=>p.ProcessId);
  assert.ok(workers.length>=2,"Actual launcher and worker must have started");
  await until(()=>{const ids=processes().map(p=>p.ProcessId);return workers.every(pid=>!ids.includes(pid));},15000);
  return workers;
}
async function preserved(){
  const s=await invoke("model3d_status");
  assert.deepEqual(s.projects.find(p=>p.id===acceptance.project.id).stages,acceptance.afterReload.projects.find(p=>p.id===acceptance.project.id).stages);
  assert.ok(Object.values(s.components).every(Boolean));
  assert.equal(s.operation.status,"cancelled");return s;
}
async function restart(){
  const env={...process.env,PATH:"C:\\Windows\\System32;C:\\Windows",WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port=9451"};
  for(const key of ["PYTHONHOME","PYTHONPATH","CUDA_HOME","CUDA_PATH","TORCH_EXTENSIONS_DIR","LEVELUP_3D_BUILD_EXTENSIONS","INCLUDE","LIB"])delete env[key];
  const child=spawn(resolve(root,"client/levelup-agent.exe"),[],{cwd:resolve(root,"client"),env,windowsHide:true,detached:true,stdio:"ignore"});child.unref();
  await until(async()=>{try{return(await fetch("http://127.0.0.1:9451/json/list").then(r=>r.json())).some(p=>p.url.includes("localhost"));}catch{return false;}});
  await connect(); return child.pid;
}
const report={status:"running",cases:[]};
try{
  await connect();
  let before=await running(); await invoke("model3d_cancel");
  await until(async()=>{const s=await invoke("model3d_status");return s.operation.status!=="running";});
  report.cases.push({action:"cancel",stopped:await noChildren(before),after:await preserved()});
  for(const mode of ["close","terminate"]){
    before=await running();
    const app=before.find(p=>p.ExecutablePath===resolve(root,"client/levelup-agent.exe")); assert.ok(app);
    if(mode==="close") await invoke("plugin:window|close",{label:"main"}).catch(e=>{if(!/closed|destroyed|Target/i.test(String(e)))throw e;});
    else process.kill(app.ProcessId);
    await noChildren(before);
    await until(()=>!processes().some(p=>p.ProcessId===app.ProcessId),15000);
    await browser.close().catch(()=>{});
    const pid=await restart();
    await until(async()=>{const s=await invoke("model3d_status");return s.operation.status!=="running";});
    report.cases.push({action:mode,stopped:before.map(p=>p.ProcessId),restartedPid:pid,after:await preserved()});
    console.log("Native lifecycle passed",mode);
  }
  report.status="passed";
  console.log("Cancel, graceful exit, forced exit, restart and preserved outputs passed");
}catch(error){report.status="failed";report.error=String(error);throw error;}
finally{await writeFile(resolve(root,"acceptance/lifecycle.json"),JSON.stringify(report,null,2));await browser?.close().catch(()=>{});}

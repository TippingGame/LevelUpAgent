// Browser integration with deferred local RIFE IPC responses; no GPU or remote model.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const local = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.SPINE_PLAYWRIGHT_PACKAGE || (existsSync(local) ? local : import.meta.url));
const { chromium } = require("playwright");
const output = resolve(process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v5");
mkdirSync(output, {recursive:true});
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({headless:true, ...(existsSync(edge) ? {executablePath:edge} : {})});
const context = await browser.newContext({viewport:{width:1100,height:900}});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const harness = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root" class="spine-studio"></div><script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import("/node_modules/.vite/deps/react.js")).default;
const ReactDOM=(await import("/node_modules/.vite/deps/react-dom_client.js")).default;
const {SpineMotionStudyPanel}=await import("/src/components/SpineMotionStudyPanel.tsx");
const spine=await import("/src/lib/spine.ts"), motion=await import("/src/lib/spineMotion.ts");
const pixel=await import("/src/lib/spinePixelInterpolation.ts");
await import("/src/components/SpineStudio.css");
const canvas=document.createElement("canvas");canvas.width=1024;canvas.height=512;
const ctx=canvas.getContext("2d");ctx.fillStyle="red";ctx.fillRect(400,100,100,200);
const png=canvas.toDataURL();
const part=spine.createSpinePart("Wing",png,1024,512,"other");
const base=spine.addSpineParts(spine.newSpineProject("RIFE test"),[part]);
base.clips=[spine.generateSpineClip(base.parts,"idle","Wing idle")];
const study=motion.createSpineMotionStudy(base.clips[0]);
study.frames=[0,1].map(time=>({...motion.captureSpinePose(base.clips[0],base.parts,time,"Endpoint "+time,"upload",{image:png,imageWidth:1024,imageHeight:512}),targets:{[part.id]:{rotation:time*40,bend:0,x:time*10,y:0}}}));
study.frames.push(motion.captureSpinePose(base.clips[0],base.parts,0.1,"Keep this capture"));
base.motionStudies=[study];
const api=window.pixelTest={calls:[],pending:[],base,partId:part.id,pixel};
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
 if(command!=="spine_rife_frame")throw new Error("Unexpected IPC "+command);
 api.calls.push(args.request);
 return new Promise((resolve,reject)=>api.pending.push({resolve:()=>resolve(args.request.first),reject:()=>reject(new Error("GPU test failure"))}));
}};
api.finish=()=>api.pending.shift().resolve();api.fail=()=>api.pending.shift().reject();
function Host(){
 const [project,setProject]=React.useState(structuredClone(base));api.project=project;
 api.reset=()=>setProject(structuredClone(base));
 api.edit=fn=>setProject(current=>fn(current));
 return React.createElement(SpineMotionStudyPanel,{open:true,project,clip:project.clips[0],time:0,selectedPart:part.id,busy:false,modelAvailable:false,
 onClose:()=>{},onGenerateImage:async()=>{throw new Error("Unexpected remote generation")},
 onUpdate:next=>setProject(current=>({...current,motionStudies:[next]})),onApply:next=>{api.applied=motion.applySpineStudy(project,next);}});
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Host));
</script></body></html>`;
try {
  await page.route("**/spine-v5-harness.html", route=>route.fulfill({status:200,contentType:"text/html",body:harness}));
  await page.goto((process.argv[2] || "http://127.0.0.1:1433")+"/spine-v5-harness.html");
  await page.getByText("本地像素补帧（RIFE）",{exact:true}).click();
  await page.getByLabel("关键姿态时间 (秒)",{exact:true}).fill("0.5");
  await page.getByLabel("RIFE 程序路径",{exact:true}).fill("C:\\Tools\\rife-ncnn-vulkan.exe");
  await page.getByLabel("rife-v4.6 模型目录",{exact:true}).fill("C:\\Tools\\rife-v4.6");
  const generate=page.getByRole("button",{name:"本地生成参考帧",exact:true});
  const pending=()=>page.waitForFunction(()=>window.pixelTest.pending.length===1);
  const frames=()=>page.evaluate(()=>window.pixelTest.project.motionStudies[0].frames);
  const reset=async()=>{await page.evaluate(()=>window.pixelTest.reset());await page.waitForFunction(()=>window.pixelTest.project.motionStudies[0].frames.length===3);};
  await generate.click();
  await pending();
  // Unrelated edits survive; interpolated targets retain endpoint rotations/translations.
  await page.evaluate(()=>window.pixelTest.edit(p=>({...p,motionStudies:[{...p.motionStudies[0],fps:12,frames:p.motionStudies[0].frames.map(f=>f.time===0.1?{...f,name:"Edited capture"}:f)}]})));
  for(let i=0;i<3;i++){await pending();await page.evaluate(()=>window.pixelTest.finish());}
  await page.getByRole("status").getByText(/已添加 3 张/).waitFor();
  const result=await page.evaluate(()=>({project:window.pixelTest.project,calls:window.pixelTest.calls,id:window.pixelTest.partId}));
  const refs=result.project.motionStudies[0].frames.filter(f=>f.source==="reference");
  assert.deepEqual(refs.map(f=>f.time),[0.25,0.5,0.75]);
  assert.deepEqual(refs.map(f=>f.targets[result.id].rotation),[10,20,30]);
  assert.deepEqual(refs.map(f=>f.targets[result.id].x),[2.5,5,7.5]);
  assert.ok(refs.every(f=>f.fitStatus==="review" && f.imageWidth===512 && f.imageHeight===256));
  assert.equal(result.project.motionStudies[0].fps,12);
  assert.equal(result.project.motionStudies[0].frames.find(f=>f.time===0.1).name,"Edited capture");
  assert.deepEqual(result.project.clips,await page.evaluate(()=>window.pixelTest.base.clips),"Reference generation does not change animations");
  assert.deepEqual(result.calls.map(call=>call.fraction),[0.25,0.5,0.75]);
  const background=await page.evaluate(async()=>{
    const image=new Image();image.src=window.pixelTest.calls[0].first;await image.decode();
    const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);return [...ctx.getImageData(0,0,1,1).data];
  });
  assert.deepEqual(background,[238,242,248,255],"Transparency is composited before RIFE");
  await page.getByRole("button",{name:"插帧为新动作",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.pixelTest.applied.tracks[window.pixelTest.partId].find(k=>k.time===0.5).rotation),20);
  await page.screenshot({path:resolve(output,"rife-ui-1100.png")});
  await page.setViewportSize({width:720,height:850});
  await generate.scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,"rife-ui-720.png")});
  // A partial batch failure commits no frames.
  await reset();await generate.click();await pending();await page.evaluate(()=>window.pixelTest.finish());
  await pending();await page.evaluate(()=>window.pixelTest.fail());
  await page.getByRole("alert").getByText(/GPU test failure/).waitFor();
  assert.equal((await frames()).length,3);
  // Stop finishes only the current frame and retains it.
  await generate.click();await pending();
  await page.getByRole("button",{name:"停止后续补帧",exact:true}).click();
  await page.evaluate(()=>window.pixelTest.finish());
  await page.getByRole("status").getByText(/已停止；已添加 1 张/).waitFor();
  assert.equal((await frames()).length,4);
  // A changed endpoint target cannot be overwritten by a late frame.
  await reset();await generate.click();await pending();
  await page.evaluate(()=>window.pixelTest.edit(p=>({...p,motionStudies:[{...p.motionStudies[0],frames:p.motionStudies[0].frames.map(f=>f.time===0?{...f,targets:{[window.pixelTest.partId]:{rotation:17,bend:0,x:0,y:0}}}:f)}]})));
  await page.evaluate(()=>window.pixelTest.finish());
  await page.getByRole("alert").getByText(/端点或区间已改变/).waitFor();
  assert.equal((await frames()).length,3);
  assert.equal((await frames())[0].targets[result.id].rotation,17);
  // Context switches discard a late successful result.
  await reset();await generate.click();await pending();
  await page.evaluate(()=>window.pixelTest.edit(p=>({...p,id:"project_changed"})));
  await page.waitForFunction(()=>window.pixelTest.project.id==="project_changed");
  await page.evaluate(()=>window.pixelTest.finish());
  await page.waitForFunction(()=>!document.querySelector('[role="status"]'));
  assert.equal((await frames()).length,3);
  // Reject incompatible canvases before invoking a local process.
  const aspect=await page.evaluate(async()=>{
    const study=structuredClone(window.pixelTest.base.motionStudies[0]);
    const canvas=document.createElement("canvas");canvas.width=canvas.height=20;
    study.frames[1].image=canvas.toDataURL();
    try {await window.pixelTest.pixel.prepareSpinePixelInputs(window.pixelTest.pixel.planSpinePixelFrames(study,0.5,1));return "unexpected";}
    catch(error){return error.message;}
  });
  assert.match(aspect,/aspect ratio/);
  assert.deepEqual(errors,[]);
  const report={status:"passed",referenceTimes:refs.map(f=>f.time),background,failuresAtomic:true,stopRetainsCurrent:true,staleResultDiscarded:true,pageErrors:errors};
  writeFileSync(resolve(output,"rife-ui-result.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await context.close();await browser.close();}

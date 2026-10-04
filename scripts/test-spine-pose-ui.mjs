import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const localPlaywright = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.SPINE_PLAYWRIGHT_PACKAGE || (existsSync(localPlaywright) ? localPlaywright : import.meta.url));
const { chromium } = require("playwright");
const output = resolve(process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v4");
mkdirSync(output, { recursive: true });
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" && existsSync(edge) ? { executablePath: edge } : {}) });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const harness = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root" class="spine-studio"></div><script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
  const React = (await import("/node_modules/.vite/deps/react.js")).default;
  const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
  const { SpineMotionStudyPanel } = await import("/src/components/SpineMotionStudyPanel.tsx");
  const spine = await import("/src/lib/spine.ts");
  const motion = await import("/src/lib/spineMotion.ts");
  const comparison = await import("/src/lib/spinePoseComparison.ts");
  const fitting = await import("/src/lib/spinePoseFit.ts");
  await import("/src/components/SpineStudio.css");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const body = spine.createSpinePart("Clock body", png, 1, 1, "other");
  const arm = {...spine.createSpinePart("Pendulum", png, 1, 1, "other"), parent: body.id, x: 32};
  const base = spine.addSpineParts(spine.newSpineProject("Clock"), [body, arm]);
  base.sourceImage = {id:"source_clock",name:"Clock",image:png,originalImage:png,width:1,height:1};
  base.clips = [spine.generateSpineClip(base.parts, "idle", "Clock idle")];
  const study = motion.createSpineMotionStudy(base.clips[0]);
  study.frames = [motion.captureSpinePose(base.clips[0], base.parts, 0, "First", "upload", {image:png,imageWidth:1,imageHeight:1}), motion.captureSpinePose(base.clips[0], base.parts, 1, "Second", "generated", {image:png,imageWidth:1,imageHeight:1})];
  base.motionStudies = [study];
  const calls = {agent:0, images:[], repairs:0, poseRequests:[]};
  window.poseTest = {calls, ids:[body.id,arm.id], getProject:()=>window.poseProject, applied:null, comparison, fitting};
  window.__TAURI_INTERNALS__ = {invoke: async (command,args) => {
    if (command === "get_provider_settings") return {activeProfileId:"mock",profiles:[{id:"mock",name:"Mock",model:"gpt-5",protocol:"openai_responses",baseUrl:"https://example.invalid",allowUnauthenticated:false,priority:0,failoverEnabled:false}]};
    if (command === "get_model_catalog") return {models:[{id:"gpt-5",profileId:"mock",profileName:"Mock",protocol:"openai_responses",outputModalities:["text"]}],errors:[]};
    if (command === "import_clipboard_images") {calls.images = args.images.map((image)=>image.name);return args.images.map((image,index)=>({id:"ref_"+index,name:image.name,mimeType:"image/png",kind:"image",sizeBytes:100}));}
    if (command === "agent_turn") {
      calls.agent++;
      if (calls.agent === 1) return {content: JSON.stringify({summary:"Incomplete", targets:{[body.id]:{rotation:0,bend:0,x:0,y:0}}, uncertain:[]}),toolCalls:[]};
      if (calls.agent === 2) calls.repairs++;
      if (calls.agent >= 3) await new Promise((resolve)=>setTimeout(resolve,800));
      return {content: JSON.stringify({summary:"Pendulum swings to the left",targets:{[body.id]:{rotation:0,bend:0,x:0,y:0},[arm.id]:{rotation:45,bend:0,x:0,y:0}},uncertain:[arm.id]}),toolCalls:[]};
    }
    throw new Error("Unexpected command: "+command);
  }};
  function Host() {
    const [project,setProject] = React.useState(base);
    window.poseProject = project;
    window.poseTest.replaceProject = (next) => setProject(next);
    window.poseTest.switchProject = () => setProject((current)=>({...current,id:crypto.randomUUID()}));
    window.poseTest.setFrameImage = (image) => setProject((current)=>({...current,motionStudies:current.motionStudies.map((item)=>({...item,frames:item.frames.map((frame,index)=>index===0?{...frame,image,imageWidth:256,imageHeight:256}:frame)}))}));
    window.poseTest.setFrameImageAt = (index,image) => setProject((current)=>({...current,motionStudies:current.motionStudies.map((item)=>({...item,frames:item.frames.map((frame,i)=>i===index?{...frame,image}:frame)}))}));
    window.poseTest.resetImageStudy = () => setProject((current)=>({...current,motionStudies:[{...current.motionStudies[0],frames:[0,1].map((time)=>motion.captureSpinePose(current.clips[0],current.parts,time,"Endpoint "+time,"upload",{image:png,imageWidth:1,imageHeight:1}))}]}));
    return React.createElement(SpineMotionStudyPanel, {open:true,project,clip:project.clips[0],time:0,selectedPart:body.id,modelAvailable:true,busy:false,onClose:()=>{},
      onUpdate:(next)=>setProject((current)=>({...current,motionStudies:[next]})),onGenerateImage:(request)=>new Promise((resolve)=>{calls.poseRequests.push(request);window.poseTest.finishImage=()=>resolve({image:png,width:1,height:1});}),
      onApply:(next)=>{window.poseTest.applied=motion.applySpineStudy(project,next);}});
  }
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Host));
</script></body></html>`;
try {
  await page.route("**/spine-pose-harness.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: harness }));
  await page.goto((process.argv[2] || "http://127.0.0.1:1433") + "/spine-pose-harness.html");
  await page.getByRole("button", { name: "AI 识别姿态" }).first().click();
  await page.getByLabel("姿态识别模型").waitFor();
  await page.getByRole("button", { name: "从图片识别姿态" }).click();
  await page.getByText("Pendulum swings to the left").waitFor();
  const before = await page.evaluate(() => ({value:window.poseTest.getProject().motionStudies[0].frames[0].targets[window.poseTest.ids[1]].rotation,calls:window.poseTest.calls}));
  assert.equal(before.value, 0, "Vision proposal must not silently write editable targets");
  assert.equal(before.calls.repairs, 1, "Incomplete pose gets one repair request");
  assert.ok(before.calls.images.includes("spine-target-pose.png"));
  assert.ok(before.calls.images.includes("spine-setup-assembly.png"));
  assert.ok(before.calls.images.includes("spine-parts-1.png"));
  assert.ok(before.calls.images.includes("spine-source.png"));
  assert.ok(before.calls.images.includes("spine-current-pose.png"), "Chat reviews the actual current pose, not only its setup");
  assert.ok(before.calls.images.some((name) => name.startsWith("spine-neighbor-")));
  await page.getByRole("button", { name: "采纳姿态目标" }).click();
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames[0].targets[window.poseTest.ids[1]].rotation === 45);
  await page.getByRole("button", { name: "插帧为新动作" }).click();
  assert.equal(await page.evaluate(() => window.poseTest.applied.tracks[window.poseTest.ids[1]].some((key) => key.rotation === 45)), true);
  await page.getByRole("button", { name: "从图片识别姿态" }).click();
  await page.getByRole("button", { name: "识别中…" }).waitFor();
  await page.locator(".spine-pose-card").first().locator('.spine-number input[type="number"]').first().fill("12");
  await page.waitForTimeout(1100);
  assert.equal(await page.getByText("Pendulum swings to the left").count(), 0, "Late result is discarded after user edits");
  assert.equal(await page.evaluate(() => window.poseTest.getProject().motionStudies[0].frames[0].targets[window.poseTest.ids[0]].rotation), 12);
  // A slow real image request must append to the latest study, preserving edits made while it runs.
  await page.evaluate(async () => {
    const motion = await import("/src/lib/spineMotion.ts");
    const project = window.poseTest.getProject(), study = project.motionStudies[0];
    window.poseTest.replaceProject({...project,motionStudies:[{...study,frames:[...study.frames,motion.captureSpinePose(project.clips[0],project.parts,1.5,"Temporary capture")]}]});
  });
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames.length === 3);
  await page.getByLabel("关键姿态描述", { exact: true }).fill("Clock pendulum swings right");
  await page.getByRole("button", { name: "生图关键姿态", exact: true }).click();
  await page.waitForFunction(() => !!window.poseTest.finishImage);
  await page.getByRole("dialog", { name: "多图关键姿态与插帧" }).locator("select").nth(1).selectOption("12");
  await page.locator(".spine-pose-card").first().locator('.spine-number input[type="number"]').first().fill("23");
  await page.locator(".spine-pose-card").last().getByRole("button", { name: "删除姿态", exact: true }).click();
  await page.evaluate(() => window.poseTest.finishImage());
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames.some((frame) => frame.notes === "Clock pendulum swings right"));
  const afterGeneration = await page.evaluate(() => window.poseTest.getProject().motionStudies[0]);
  assert.equal(afterGeneration.fps, 12, "Finishing an image must preserve current study settings");
  assert.equal(afterGeneration.frames.length, 3, "Finishing an image must not resurrect a deleted frame");
  const bodyId = await page.evaluate(() => window.poseTest.ids[0]);
  assert.equal(afterGeneration.frames[0].targets[bodyId].rotation, 23);
  assert.equal(afterGeneration.frames[1].imageWidth, 1);
  // A late result from another project must be discarded, even if both projects share a study ID.
  await page.getByRole("button", { name: "生图关键姿态", exact: true }).click();
  const previousProject = await page.evaluate(() => window.poseTest.getProject().id);
  await page.evaluate(() => window.poseTest.switchProject());
  await page.waitForFunction((id) => window.poseTest.getProject().id !== id, previousProject);
  await page.evaluate(() => window.poseTest.finishImage());
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.poseTest.getProject().motionStudies[0].frames.length), 3);
  await page.evaluate(() => window.poseTest.resetImageStudy());
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames[1]?.time === 1);
  await page.getByLabel("关键姿态时间 (秒)", {exact:true}).fill("0.5");
  const intermediate = page.getByRole("button", {name:"生成中间姿态图", exact:true});
  assert.equal(await intermediate.isEnabled(), true);
  await intermediate.click();
  const request = await page.evaluate(() => window.poseTest.calls.poseRequests.at(-1));
  assert.equal(request.time, 0.5);
  assert.deepEqual(request.neighbors.map((item)=>item.time), [0,1]);
  await page.locator(".spine-pose-card").first().locator('.spine-number input[type="number"]').first().fill("18");
  await page.evaluate(() => window.poseTest.finishImage());
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames.length === 3);
  const middle = await page.evaluate(() => window.poseTest.getProject().motionStudies[0].frames);
  assert.deepEqual(middle.map((item)=>item.time),[0,0.5,1]);
  assert.equal(middle[0].targets[bodyId].rotation,18);
  assert.equal(middle[1].fitStatus,"review");
  assert.equal(middle[1].imageWidth,1);
  await page.getByLabel("关键姿态时间 (秒)", {exact:true}).fill("0.75");
  await intermediate.click();
  await page.evaluate(() => {const canvas=document.createElement("canvas");canvas.width=canvas.height=2;window.poseTest.setFrameImageAt(1,canvas.toDataURL());});
  await page.evaluate(() => window.poseTest.finishImage());
  await page.getByRole("alert").getByText(/参考姿态已改变/).waitFor();
  assert.equal(await page.evaluate(() => window.poseTest.getProject().motionStudies[0].frames.length),3);
  const fullCanvas = await page.evaluate(() => {
    const canvas=document.createElement("canvas");canvas.width=100;canvas.height=80;
    const ctx=canvas.getContext("2d");ctx.fillStyle="red";ctx.fillRect(30,20,20,40);return canvas.toDataURL();
  });
  await page.locator('input[type="file"]').setInputFiles({name:"full-canvas.png",mimeType:"image/png",buffer:Buffer.from(fullCanvas.split(",")[1],"base64")});
  await page.waitForFunction(() => window.poseTest.getProject().motionStudies[0].frames.length === 4);
  const imported = await page.evaluate(() => window.poseTest.getProject().motionStudies[0].frames.find(frame=>frame.name==="full-canvas"));
  assert.deepEqual([imported.time,imported.imageWidth,imported.imageHeight],[0.75,100,80]);
  assert.equal(imported.image,fullCanvas,"Import must retain transparent margins and exact framing");
  const silhouette = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width=32; canvas.height=96;
    const ctx=canvas.getContext("2d"); ctx.fillStyle="#c33333"; ctx.fillRect(0,0,32,96);
    const spine=await import("/src/lib/spine.ts");
    const part=spine.createSpinePart("Test bar",canvas.toDataURL("image/png"),32,96,"other");
    part.width=48; part.height=144; part.flexibility=0;
    const make=(rotation)=>({[part.id]:{rotation,bend:0,x:0,y:0}});
    const reference=await window.poseTest.comparison.renderSpinePoseImage([part],make(35));
    const matching=await window.poseTest.comparison.compareSpinePose([part],make(35),reference.image);
    const different=await window.poseTest.comparison.compareSpinePose([part],make(-35),reference.image);
    return {matching:matching.overlap,different:different.overlap};
  });
  assert.ok(silhouette.matching > 0.9, JSON.stringify(silhouette));
  assert.ok(silhouette.different < silhouette.matching - 0.15, JSON.stringify(silhouette));
  const localFit = await page.evaluate(async () => {
    const {refineSpinePose} = window.poseTest.fitting;
    const {renderSpinePoseImage} = window.poseTest.comparison;
    const spine = await import("/src/lib/spine.ts");
    const motion = await import("/src/lib/spineMotion.ts");
    const canvas=document.createElement("canvas"); canvas.width=40; canvas.height=120;
    const ctx=canvas.getContext("2d"); ctx.fillStyle="#c33"; ctx.fillRect(0,0,40,120);
    ctx.fillStyle="#ecb72d"; ctx.fillRect(0,80,40,40);
    const part={...spine.createSpinePart("Fit bar",canvas.toDataURL(),40,120,"other"),width:40,height:120,flexibility:0};
    const make=(rotation)=>({[part.id]:{rotation,bend:0,x:3,y:4}});
    const initial=make(10), source=JSON.stringify(initial);
    const image=(await renderSpinePoseImage([part],make(35))).image;
    const fit=await refineSpinePose([part],initial,image,{partIds:[part.id],maxAngle:30,bend:true});
    const bounded=await refineSpinePose([part],initial,image,{partIds:[part.id],maxAngle:5,bend:true});
    const flexible={...part,flexibility:1};
    const bentTarget=make(0); bentTarget[part.id].bend=35;
    const bentImage=(await renderSpinePoseImage([flexible],bentTarget)).image;
    const rigidOnly=await refineSpinePose([flexible],make(0),bentImage,{partIds:[part.id],maxAngle:60,bend:false});
    const flexibleFit=await refineSpinePose([flexible],make(0),bentImage,{partIds:[part.id],maxAngle:60,bend:true});
    let cancelled=false;
    const abort=new AbortController();
    try { await refineSpinePose([part],initial,image,{partIds:[part.id],maxAngle:30,bend:true,signal:abort.signal,onProgress:()=>abort.abort()}); }
    catch(error) {cancelled=error.name==="AbortError";}
    const project=spine.addSpineParts(spine.newSpineProject("Image fit test"),[part]);
    project.clips=[spine.generateSpineClip(project.parts,"idle")];
    const study=motion.createSpineMotionStudy(project.clips[0]);
    study.frames=[motion.captureSpinePose(project.clips[0],project.parts,0,"Fit target","upload",{image,imageWidth:256,imageHeight:256}),motion.captureSpinePose(project.clips[0],project.parts,1,"End")];
    study.frames[0].targets=initial; project.motionStudies=[study];
    window.poseTest.fitProject=project;
    return {fit,bounded,rotation:fit.targets[part.id].rotation,boundedRotation:bounded.targets[part.id].rotation,
      preserved:JSON.stringify(initial)===source,cancelled,translation:[fit.targets[part.id].x,fit.targets[part.id].y],bend:fit.targets[part.id].bend,
      flexible:{rigidLoss:rigidOnly.after.loss,flexibleLoss:flexibleFit.after.loss,bend:flexibleFit.targets[part.id].bend}};
  });
  assert.ok(Math.abs(localFit.rotation - 35) < 1, JSON.stringify(localFit));
  assert.ok(localFit.fit.after.loss < localFit.fit.before.loss * 0.1, JSON.stringify(localFit));
  assert.ok(Math.abs(localFit.boundedRotation - 10) <= 5);
  assert.equal(localFit.preserved, true); assert.equal(localFit.cancelled, true);
  assert.deepEqual(localFit.translation,[3,4]); assert.equal(localFit.bend,0,"Rigid objects never acquire bend");
  assert.ok(localFit.flexible.flexibleLoss<localFit.flexible.rigidLoss*0.5,JSON.stringify(localFit.flexible));
  assert.ok(Math.abs(localFit.flexible.bend)>1);
  const reference = await page.evaluate(async () => window.poseTest.comparison.renderSpinePoseImage(
    window.poseTest.getProject().parts, window.poseTest.getProject().motionStudies[0].frames[0].targets));
  await page.evaluate((image) => window.poseTest.setFrameImage(image), reference.image);
  await page.getByRole("button", {name:"AI 识别姿态"}).first().click();
  await page.locator(".spine-pose-comparison-head span").waitFor();
  await page.getByLabel("骨骼叠图透明度").fill("80");
  await page.setViewportSize({ width: 720, height: 850 });
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  await page.locator(".spine-pose-comparison").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "pose-inference-review.png") });
  await page.evaluate(() => window.poseTest.replaceProject(window.poseTest.fitProject));
  await page.getByRole("button", {name:"AI 识别姿态"}).first().click();
  await page.waitForFunction(() => !document.querySelector('.spine-pose-fit button').disabled);
  await page.getByRole("button", {name:"按目标图微调",exact:true}).click();
  await page.locator(".spine-pose-fit-result").waitFor();
  assert.equal(await page.evaluate(() => Object.values(window.poseTest.getProject().motionStudies[0].frames[0].targets)[0].rotation),10,"Fit remains a review proposal");
  await page.getByRole("button",{name:"恢复微调前姿态"}).click();
  assert.equal(await page.getByRole("button",{name:"采纳姿态目标"}).isDisabled(),true);
  await page.getByRole("button", {name:"按目标图微调",exact:true}).click();
  await page.locator(".spine-pose-fit-result").waitFor();
  await page.locator(".spine-pose-fit-result").scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(output,"pose-local-fit-review.png")});
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth),true);
  await page.getByRole("button",{name:"采纳姿态目标"}).click();
  const acceptedAngle=await page.evaluate(() => Object.values(window.poseTest.getProject().motionStudies[0].frames[0].targets)[0].rotation);
  assert.ok(Math.abs(acceptedAngle-35)<1);
  await page.getByRole("button",{name:"插帧为新动作"}).click();
  assert.equal(await page.evaluate(() => Object.values(window.poseTest.applied.tracks)[0][0].rotation),acceptedAngle);
  // Editing the project while the optimizer yields discards its in-flight proposal.
  await page.evaluate(() => {
    document.querySelector('.spine-pose-fit button').click();
    setTimeout(() => window.poseTest.switchProject(),0);
  });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".spine-pose-fit-result").count(),0);
  const realProject = process.env.SPINE_COMPARISON_PROJECT;
  const realComparisons = [];
  if (realProject) {
    const data = JSON.parse(readFileSync(realProject,"utf8"));
    const comparisons = await page.evaluate(async (project) => {
      const results=[];
      for (const frame of project.motionStudies[0].frames.filter((item)=>item.image)) {
        const original=JSON.stringify(frame.targets);
        const fit=await window.poseTest.fitting.refineSpinePose(project.parts,frame.targets,frame.image,{partIds:project.parts.filter((part)=>part.parent).map((part)=>part.id),maxAngle:30,bend:false});
        const locked=project.parts.filter((part)=>!part.parent).every((part)=>JSON.stringify(fit.targets[part.id])===JSON.stringify(frame.targets[part.id]));
        results.push({name:frame.name,fit,locked,originalPreserved:JSON.stringify(frame.targets)===original,
          before:await window.poseTest.comparison.compareSpinePose(project.parts,frame.targets,frame.image),
          ...await window.poseTest.comparison.compareSpinePose(project.parts,fit.targets,frame.image)});
      }
      return results;
    },data);
    for (let i=0;i<comparisons.length;i++) {
      const {name,overlap,target,rig,fit,locked,originalPreserved,before}=comparisons[i];
      assert.ok(fit.after.loss<=fit.before.loss); assert.equal(locked,true); assert.equal(originalPreserved,true);
      realComparisons.push({name,overlap,fit,locked,originalPreserved});
      writeFileSync(resolve(output,`real-pose-${i}-target.png`),Buffer.from(target.split(",")[1],"base64"));
      writeFileSync(resolve(output,`real-pose-${i}-rig.png`),Buffer.from(rig.split(",")[1],"base64"));
      writeFileSync(resolve(output,`real-pose-${i}-before.png`),Buffer.from(before.rig.split(",")[1],"base64"));
    }
  }
  assert.deepEqual(pageErrors, []);
  const result = { status:"passed", before, silhouette, localFit, realComparisons, pageErrors };
  writeFileSync(resolve(output, "pose-inference-ui-result.json"), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { await context.close(); await browser.close(); }

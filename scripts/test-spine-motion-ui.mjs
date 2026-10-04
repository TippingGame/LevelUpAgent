// Production animation rendering and chat context lifecycle; provider replies are mocked.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const localPlaywright = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.SPINE_PLAYWRIGHT_PACKAGE || (existsSync(localPlaywright) ? localPlaywright : import.meta.url));
const { chromium } = require("playwright");
const output = resolve(process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v4/motion-chat");
mkdirSync(output, { recursive: true });
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" && existsSync(edge) ? { executablePath: edge } : {}) });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const harness = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root" class="spine-studio" style="display:block;width:360px;height:auto"></div><script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
  const React = (await import("/node_modules/.vite/deps/react.js")).default;
  const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
  const { SpineAssistantPanel } = await import("/src/components/SpineAssistantPanel.tsx");
  const spine = await import("/src/lib/spine.ts");
  await import("/src/components/SpineStudio.css");
  const canvas = document.createElement("canvas"); canvas.width=canvas.height=32;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#ff0000";ctx.fillRect(0,0,32,32);
  const part = {...spine.createSpinePart("Moving object",canvas.toDataURL(),32,32,"other"),width:40,height:40,x:0,y:0,pivotX:0.5,pivotY:0.5,flexibility:0};
  const key = (time,x) => ({time,x,y:0,rotation:0,bend:0,curve:"linear"});
  const clip = {id:"motion",name:"Travel",duration:2,tracks:{[part.id]:[key(0,0),key(0.13,10),key(2,200)]}};
  const second = {...clip,id:"second",name:"Other action",tracks:{[part.id]:[key(0,0),key(2,0)]}};
  window.testProject={...spine.addSpineParts(spine.newSpineProject("Motion fixture"),[part]),clips:[clip,second]};
  window.imported=[];window.requests=[];window.delay=false;window.applied=0;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
    if(command==="get_provider_settings")return {activeProfileId:"mock",profiles:[{id:"mock",name:"Mock",baseUrl:"https://example.invalid",model:"gpt-5",protocol:"openai_responses"}]};
    if(command==="get_model_catalog")return {models:[{id:"gpt-5",profileId:"mock",profileName:"Mock",protocol:"openai_responses",outputModalities:["text"]}],errors:[]};
    if(command==="import_clipboard_images")return args.images.map((image)=>{window.imported.push(image);return {id:"ref_"+window.imported.length,name:image.name,mimeType:"image/png",kind:"image",sizeBytes:1024};});
    if(command==="agent_turn") {
      window.requests.push(args.request);
      if(window.delay)await new Promise(resolve=>window.release=resolve);
      return {content:JSON.stringify({reply:"Reviewed sampled times",parts:[{id:part.id,x:5}]}),toolCalls:[]};
    }
    throw new Error(command);
  }};
  function Harness(){
    const [project,setProject]=React.useState(window.testProject);
    const [clipId,setClipId]=React.useState("motion");
    const [time,setTime]=React.useState(0.73);
    const ref=React.useRef(project);ref.current=project;
    window.editProject=(fn)=>{ref.current=fn(ref.current);setProject(ref.current);window.testProject=ref.current;};
    window.selectClip=setClipId;window.setTime=setTime;
    return React.createElement(SpineAssistantPanel,{project,clip:project.clips.find(c=>c.id===clipId),time,
      onUpdate:window.editProject,onApply:()=>window.applied++,onGenerate:async()=>{},canGenerate:false});
  }
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Harness));
</script></body></html>`;
const send = async (text = "根据当前动作的采样修正接缝") => {
  await page.getByRole("textbox", { name: "部件、骨骼或动作需求" }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};
const waitReply = () => page.getByRole("button", { name: "应用骨骼与动作", exact: true }).waitFor();
try {
  await page.route("**/spine-motion-harness.html", route => route.fulfill({status:200,contentType:"text/html",body:harness}));
  await page.goto((process.argv[2] || "http://127.0.0.1:1433") + "/spine-motion-harness.html");
  await page.getByText("gpt-5 · Mock", { exact: true }).waitFor({state:"attached"});
  const rendered = await page.evaluate(async () => {
    const {createSpineMotionImage,spineMotionSampleTimes}=await import("/src/lib/spineAssistantImages.ts");
    const {parts,clips}=window.testProject;
    const result=await createSpineMotionImage(parts,clips[0],0.73);
    const image=new Image();image.src=result.image;await image.decode();
    const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);
    const boxes=[];
    for(let i=0;i<9;i++){
      const data=ctx.getImageData(i%3*400,52+Math.floor(i/3)*432+32,400,400).data;
      let left=400,right=-1,top=400,bottom=-1;
      for(let y=0;y<400;y++)for(let x=0;x<400;x++){
        const k=(y*400+x)*4;
        if(data[k]>240&&data[k+1]<20&&data[k+2]<20){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      }
      boxes.push({left,right,top,bottom});
    }
    const times=spineMotionSampleTimes(clips[0],0.73);
    const dense={...clips[0],tracks:{[parts[0].id]:Array.from({length:1001},(_,i)=>({...clips[0].tracks[parts[0].id][0],time:i/500}))}};
    return {result,boxes,times,denseTimes:spineMotionSampleTimes(dense,0.731)};
  });
  assert.equal(rendered.times.length,9);
  assert.ok(rendered.times.includes(0.13),"Include short off-grid key pose");
  assert.ok(rendered.times.includes(0.73),"Include exact focus time");
  assert.equal(rendered.times[0],0);assert.equal(rendered.times.at(-1),2);
  assert.equal(rendered.denseTimes.length,9);assert.ok(rendered.denseTimes.includes(0.731));
  const first=rendered.boxes[0],last=rendered.boxes.at(-1);
  assert.ok(last.left-first.left>250,"Root translation must not be erased by per-frame centering or endpoint wrapping");
  for(const box of rendered.boxes){
    assert.ok(box.left>=19&&box.right<381,"Frame remains within camera padding");
    assert.ok(Math.abs((box.right-box.left)-(first.right-first.left))<=1,"Same scale in every frame");
    assert.equal(box.top,first.top);assert.equal(box.bottom,first.bottom);
  }
  writeFileSync(resolve(output,"translation-samples.png"),Buffer.from(rendered.result.image.split(",")[1],"base64"));
  await send();await waitReply();
  await page.getByText("本次会话的动作采样",{exact:true}).click();
  await page.screenshot({path:resolve(output,"motion-chat-review.png"),fullPage:true});
  const firstRequest=await page.evaluate(()=>({request:window.requests[0],motion:window.imported.find(i=>i.name==="spine-current-motion.png").dataBase64}));
  const message=firstRequest.request.messages.at(-1);
  assert.deepEqual(message.attachments.map(i=>i.name),["spine-setup-assembly.png","spine-parts-1.png","spine-current-motion.png"]);
  assert.match(message.content,/"focusTime":0.73/);assert.match(message.content,/#9=2s/);
  await page.evaluate(()=>window.setTime(1.2));
  assert.ok(await page.getByRole("button",{name:"应用骨骼与动作",exact:true}).isVisible(),"Timeline movement alone preserves proposal");
  await page.evaluate(()=>window.editProject(p=>({...p,parts:p.parts.map(part=>({...part,x:3}))})));
  await page.getByRole("button",{name:"应用骨骼与动作",exact:true}).waitFor({state:"hidden"});
  assert.equal(await page.evaluate(()=>window.applied),0,"Editing must not auto-apply proposal");
  await page.evaluate(()=>{window.delay=true;});
  await send();await page.waitForFunction(()=>window.requests.length===2&&window.release);
  await page.evaluate(()=>window.selectClip("second"));
  await page.evaluate(()=>{window.release();window.release=undefined;});
  await page.getByRole("alert").filter({hasText:"工程或当前动作已改变"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"应用骨骼与动作",exact:true}).count(),0);
  await page.evaluate(()=>{window.delay=false;});
  await send();await waitReply();
  const secondRequest=await page.evaluate(()=>({message:window.requests.at(-1).messages.at(-1),motion:window.imported.findLast(i=>i.name==="spine-current-motion.png").dataBase64}));
  assert.match(secondRequest.message.content,/ACTUAL SAMPLED ANIMATION: clip "Other action"/);
  assert.notEqual(firstRequest.motion,secondRequest.motion,"New selected action requires freshly rendered evidence");
  await page.evaluate(()=>{window.delay=true;});
  await send();await page.waitForFunction(()=>window.requests.length===4&&window.release);
  await page.evaluate(()=>window.editProject(p=>({...p,id:"different_project",rigConversation:[]})));
  await page.evaluate(()=>{window.release();window.release=undefined;});
  await page.getByRole("button",{name:"发送",exact:true}).waitFor();
  assert.equal(await page.getByRole("alert").count(),0,"Old reply must not show an error on a new project");
  assert.equal(await page.getByRole("button",{name:"应用骨骼与动作",exact:true}).count(),0);
  // Render real user-generated assets through this same production entry point.
  const fixtures=[
    ["character","../research/spine-animation-2026-10-03/verification-v4/native/project.levelup-spine.json"],
    ["clock","../research/spine-animation-2026-10-03/verification-v4/local-fit/native-reload/project.levelup-spine.json"],
  ];
  const real=[];
  for(const [name,path] of fixtures)if(existsSync(resolve(path))){
    const project=JSON.parse(readFileSync(resolve(path),"utf8"));
    const visual=await page.evaluate(async(project)=>{
      const {createSpineMotionImage}=await import("/src/lib/spineAssistantImages.ts");
      return createSpineMotionImage(project.parts,project.clips.at(-1),0.5);
    },project);
    writeFileSync(resolve(output,`${name}-motion.png`),Buffer.from(visual.image.split(",")[1],"base64"));
    real.push({name,description:visual.description});
  }
  assert.deepEqual(errors,[]);
  writeFileSync(resolve(output,"motion-chat-result.json"),JSON.stringify({times:rendered.times,denseTimes:rendered.denseTimes,boxes:rendered.boxes,real,errors},null,2));
  console.log(JSON.stringify({passed:true,real:real.map(r=>r.name),times:rendered.times,errors}));
}catch(error){await page.screenshot({path:resolve(output,"motion-chat-failure.png"),fullPage:true});throw error;}
finally{await browser.close();}

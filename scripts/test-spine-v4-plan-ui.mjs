// Browser integration with mocked model responses; no remote inference is called.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const localPlaywright = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.SPINE_PLAYWRIGHT_PACKAGE || (existsSync(localPlaywright) ? localPlaywright : import.meta.url));
const { chromium } = require("playwright");
const output = resolve(process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v4");
const source = resolve(process.env.SPINE_SOURCE_IMAGE || "../杂项文件/Q版单人.png");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" && existsSync(edge) ? { executablePath: edge } : {}) });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const harness = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
  const React = (await import("/node_modules/.vite/deps/react.js")).default;
  const ReactDOM = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
  const { SpineStudio } = await import("/src/components/SpineStudio.tsx");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#ff0000"; ctx.fillRect(12, 12, 40, 40);
  const generatedImage = canvas.toDataURL("image/png");
  const calls = { agent: 0, images: 0, references: 0, requests: [], repairs: 0, visualRequests: [], attachments: {} };
  window.spineTestCalls = calls;
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: () => generatedImage,
    invoke: async (command, args) => {
      if (command === "get_media_catalog") return { models: [{ id: "gpt-image-2", profileId: "mock", profileName: "Mock", protocol: "openai_responses", kind: "image", rank: 1, recommended: true }], errors: [] };
      if (command === "get_provider_settings") return { activeProfileId: "mock", profiles: [{ id: "mock", name: "Mock", baseUrl: "https://example.invalid", model: "gpt-5", protocol: "openai_responses", allowUnauthenticated: false, priority: 0, failoverEnabled: false }] };
      if (command === "get_model_catalog") return { models: [{ id: "gpt-5", profileId: "mock", profileName: "Mock", protocol: "openai_responses", outputModalities: ["text"] }], errors: [] };
      if (command === "plugin:dialog|open") return ["user-design.png"];
      if (command === "import_image_attachments") {calls.attachments.user_reference="user-design.png";return [{id:"user_reference",name:"user-design.png",mimeType:"image/png",kind:"image",sizeBytes:1024}];}
      if (command === "import_clipboard_images") { calls.references++; return args.images.map((image,index) => {const id="ref_"+calls.references+"_"+index;calls.attachments[id]=image.name;return { id, name: image.name, mimeType: "image/png", kind: "image", sizeBytes: 1024 };}); }
      const motionContext = command === "agent_turn" ? args.request.messages.findLast((message) => message.content.includes("Current request: 摆动"))?.content : undefined;
      if (motionContext) {
        const message = args.request.messages.findLast((message) => message.content.includes("Current request: 摆动"));
        calls.visualRequests.push({names:message.attachments.map((image)=>image.name),context:motionContext});
        const geometry = JSON.parse(motionContext.split("Parts back-to-front: ")[1].split("\\n")[0]);
        const part = geometry.find((part) => part.name === "Swinging part");
        const revision = motionContext.includes("减小") ? 5 : 20;
        if (revision === 20 && !args.request.messages.at(-1).content.includes("proposal was rejected"))
          return {content: JSON.stringify({reply:"Malformed key", clips:[{name:"Object swing",duration:2,tracks:{[part.id]:[{time:0,curve:"linear"}]}}]}),toolCalls:[]};
        if (args.request.messages.at(-1).content.includes("proposal was rejected")) calls.repairs++;
        return {content: JSON.stringify({ reply: "Swing motion proposed " + revision,
          drawOrder: [...geometry].reverse().map((part) => part.id),
          clips: [{name: "Object swing", duration: 2, tracks: {[part.id]: [
            {time: 0, rotation: 0, bend: 0, x: 0, y: 0, curve: "linear"},
            {time: 1, rotation: revision, bend: 0, x: 0, y: 0, curve: "linear"},
            {time: 2, rotation: 0, bend: 0, x: 0, y: 0, curve: "linear"}
          ]}}
        ]}),toolCalls: []};
      }
      if (command === "agent_turn") { calls.agent++; return { content: JSON.stringify({ reply: "Two editable object parts", newParts: [
        { key: "case", name: "Outer case", description: "enclosing body", role: "other", parent: null, left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, pivotX: 0.5, pivotY: 0.5, flexibility: 0 },
        { key: "swing", name: "Swinging part", description: "hinged inset", role: "other", parent: "case", left: 0.4, top: 0.3, right: 0.6, bottom: 0.8, pivotX: 0.5, pivotY: 0.05, flexibility: 0.2 }
      ] }), toolCalls: [] }; }
      if (command === "generate_media") {
        calls.images++; calls.requests.push(args.request);
        if (args.request.prompt.includes("replacement sprite layer")) {
          if (args.request.prompt.includes("fail-redraw")) return { assets: [], errors: ["Redraw request failed"] };
          ctx.fillStyle = "#0000ff"; ctx.fillRect(12, 12, 40, 40);
          window.__TAURI_INTERNALS__.convertFileSrc = () => canvas.toDataURL("image/png");
        }
        if (calls.images === 2 && !sessionStorage.getItem("spine-plan-injected-failure")) {
          sessionStorage.setItem("spine-plan-injected-failure", "1");
          return { assets: [], errors: ["Injected second-part failure"] };
        }
        return { assets: [{ id: "asset_" + calls.images, kind: "image", status: "completed", filePath: "mock.png" }], errors: [] };
      }
      throw new Error("Unexpected Tauri command: " + command);
    },
  };
  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(SpineStudio, {
    active: true, locale: "zh-CN", mediaCatalogRevision: 0,
    onMedia: () => {}, onWriting: () => {}, onConstellation: () => {},
    onConfigureConnection: () => {}, onPendingCountChange: () => {},
  }));
</script></body></html>`;

try {
  await page.route("**/spine-plan-harness.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: harness }));
  await page.goto((process.argv[2] || "http://127.0.0.1:1432") + "/spine-plan-harness.html");
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').first().setInputFiles(source);
  await page.locator(".spine-source-preview").waitFor();
  await page.getByLabel("骨骼会话模型").waitFor();
  await page.getByRole("textbox", { name: "部件、骨骼或动作需求" }).fill("将物体拆为外壳和可摆动组件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("Two editable object parts").waitFor();
  assert.equal(await page.locator(".spine-assistant-drafts > div").count(), 2);
  await page.getByRole("button", { name: "生成草案部件" }).click();
  await page.getByText("Injected second-part failure").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".spine-part").length === 1);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const interrupted = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    const project = await storage.loadSpineProject(id);
    return { parts: project.parts.map((part) => part.id), sourceId: project.sourceImage?.id, plan: project.rigPartPlan, calls: window.spineTestCalls };
  });
  assert.ok(interrupted.plan.id?.startsWith("plan_"));
  assert.deepEqual(interrupted.parts, [interrupted.plan.id + "_case"]);
  assert.equal(interrupted.plan.sourceId, interrupted.sourceId);
  assert.deepEqual(interrupted.plan.drafts.map((draft) => draft.key), ["case", "swing"]);
  assert.equal(interrupted.calls.images, 2);
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(await page.locator(".spine-assistant-drafts > div").count(), 2);
  await page.getByRole("button", { name: "生成草案部件" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".spine-part").length === 2);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const result = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    const project = await storage.loadSpineProject(id);
    const image = new Image(); image.src = project.parts[0].image; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const alpha = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let green = 0;
    for (let i = 0; i < alpha.length; i += 4)
      if (alpha[i] < 16 && alpha[i + 1] > 240 && alpha[i + 2] < 16 && alpha[i + 3] > 0) green++;
    return { parts: project.parts.map(({ id, name, parent, role, x, y }) => ({ id, name, parent, role, x, y })), imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, green, plan: project.rigPartPlan, calls: window.spineTestCalls };
  });
  assert.deepEqual(result.parts.map((part) => part.id), [interrupted.plan.id + "_case", interrupted.plan.id + "_swing"]);
  assert.equal(result.parts[1].parent, result.parts[0].id);
  assert.ok(result.imageWidth < 64 && result.imageHeight < 64);
  assert.equal(result.green, 0);
  assert.deepEqual(result.plan.drafts.map((draft) => draft.key), ["case", "swing"]);
  assert.equal(result.calls.agent, 0);
  assert.equal(result.calls.images, 1);
  assert.ok(result.calls.references >= 2);
  assert.ok(result.calls.requests.every((request) => request.referenceAttachmentIds.length === 2));
  assert.ok(result.calls.requests.every((request) => request.prompt.includes("pure green (#00FF00)")));
  assert.ok(result.calls.requests.every((request) => request.prompt.includes("Center the single part")));
  assert.ok(result.calls.requests.every((request) => !request.prompt.includes("transparent background")));
  await page.getByRole("textbox", { name: "部件、骨骼或动作需求" }).fill("摆动：为现有组件创建动作并调整层级");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("Swing motion proposed 20").waitFor();
  await page.getByRole("button", { name: "应用骨骼与动作", exact: true }).click();
  assert.ok(await page.getByRole("button", { name: "播放", exact: true }).isEnabled());
  const firstClipId = await page.getByLabel("当前动作", {exact: true}).inputValue();
  assert.ok(firstClipId.startsWith("clip_"));
  await page.getByRole("textbox", { name: "部件、骨骼或动作需求" }).fill("摆动：减小幅度");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("Swing motion proposed 5").waitFor();
  await page.getByRole("button", { name: "应用骨骼与动作", exact: true }).click();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const motion = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const project = await storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
    return {clips: project.clips, parts: project.parts.map(({id,parent})=>({id,parent}))};
  });
  assert.equal(motion.clips.length, 1);
  assert.equal(motion.clips[0].id, firstClipId);
  assert.equal(Object.values(motion.clips[0].tracks)[0][1].rotation, 5);
  assert.equal(await page.evaluate(()=>window.spineTestCalls.repairs), 1);
  assert.equal(motion.parts[1].parent, motion.parts[0].id);
  const visualRequests = await page.evaluate(() => window.spineTestCalls.visualRequests);
  assert.equal(visualRequests.length, 3, "Motion proposal, automatic repair, then refinement");
  for (const [index, request] of visualRequests.entries()) {
    assert.deepEqual(request.names, ["spine-source.png", "spine-setup-assembly.png", "spine-parts-1.png", ...(index === 2 ? ["spine-current-motion.png"] : [])]);
    assert.match(request.context, /CURRENT SETUP POSE, not an animation frame/);
  }
  assert.match(visualRequests[2].context, /ACTUAL SAMPLED ANIMATION/);
  assert.match(visualRequests[2].context, /"name":"Object swing"/);
  assert.match(visualRequests[2].context, /#9=2s/);
  assert.match(visualRequests[0].context, new RegExp("#1=" + motion.parts[0].id));
  assert.match(visualRequests[2].context, new RegExp("#1=" + motion.parts[1].id), "New visual references follow updated layer order");
  await page.getByRole("button",{name:"参考图 (0/3)",exact:true}).click();
  await page.getByText("1. user-design.png",{exact:true}).waitFor();
  await page.getByRole("button", {name: "姿态研究", exact: true}).click();
  const poseDialog = page.getByRole("dialog", {name: "多图关键姿态与插帧"});
  const poseButton = poseDialog.getByRole("button", {name: "生图关键姿态", exact: true});
  assert.equal(await poseButton.isEnabled(), false, "Pose needs an explicit description");
  await poseDialog.getByLabel("关键姿态描述", {exact: true}).fill("铰链向左展开，保留外壳造型");
  await poseButton.click();
  await page.locator(".spine-pose-card img").waitFor();
  await page.getByText("已保存到本机", {exact: true}).waitFor();
  const generatedPose = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const project = await storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
    return {frame: project.motionStudies[0].frames[0],request: window.spineTestCalls.requests.at(-1)};
  });
  assert.equal(generatedPose.frame.source, "generated");
  assert.ok(generatedPose.frame.imageWidth > 0 && generatedPose.frame.imageHeight > 0, "Generated pose persists valid dimensions");
  assert.equal(generatedPose.frame.notes, "铰链向左展开，保留外壳造型");
  assert.equal(generatedPose.request.referenceAttachmentIds.length, 2, "Source automatically anchors pose generation before user references");
  assert.equal(generatedPose.request.referenceAttachmentIds[1],"user_reference");
  assert.match(generatedPose.request.prompt, /Required pose: 铰链向左展开/);
  assert.match(generatedPose.request.prompt, /Reference Image 1 is the complete source subject/);
  assert.deepEqual([generatedPose.frame.imageWidth,generatedPose.frame.imageHeight],[64,64],"Generated pose retains the full canvas");
  await poseDialog.getByLabel("关键姿态时间 (秒)",{exact:true}).fill("2");
  await poseDialog.getByLabel("关键姿态描述",{exact:true}).fill("铰链向右展开");
  await poseButton.click();
  await page.waitForFunction(()=>document.querySelectorAll(".spine-pose-card").length===2);
  await poseDialog.getByLabel("关键姿态时间 (秒)",{exact:true}).fill("1");
  await poseDialog.getByLabel("关键姿态描述",{exact:true}).fill("");
  await poseDialog.getByRole("button",{name:"生成中间姿态图",exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll(".spine-pose-card").length===3);
  await page.getByText("已保存到本机", {exact:true}).waitFor();
  const inbetween = await page.evaluate(async()=>{
    const storage=await import("/src/lib/spineStorage.ts");
    const project=await storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
    const request=window.spineTestCalls.requests.at(-1);
    return {frames:project.motionStudies[0].frames.map(({time,fitStatus,imageWidth,imageHeight})=>({time,fitStatus,imageWidth,imageHeight})),request,names:request.referenceAttachmentIds.map(id=>window.spineTestCalls.attachments[id])};
  });
  assert.deepEqual(inbetween.frames.map(frame=>frame.time),[0,1,2]);
  assert.deepEqual(inbetween.names,["spine-source.png","spine-pose-previous-0s.png","spine-pose-next-2s.png","user-design.png"]);
  assert.match(inbetween.request.prompt,/ONE intermediate pose at 1s, 50.00%/);
  assert.equal(inbetween.frames[1].fitStatus,"review");
  assert.equal(await poseDialog.getByRole("button",{name:"生成中间姿态图",exact:true}).isEnabled(),false,"Existing times cannot be generated twice as intermediates");
  await page.screenshot({path:resolve(output,"pose-inbetween.png")});
  await poseDialog.getByRole("button", {name: "关闭", exact: true}).click();
  const beforeRedraw = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    return storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
  });
  await page.getByLabel("单件重绘要求", {exact: true}).fill("fail-redraw");
  await page.getByRole("button", {name: "重绘当前部件", exact: true}).click();
  await page.getByText("Redraw request failed", {exact: true}).waitFor();
  const failedRedraw = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    return storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
  });
  assert.deepEqual(failedRedraw.parts, beforeRedraw.parts);
  await page.getByLabel("单件重绘要求", {exact: true}).fill("Keep only the hinged inset, no case");
  await page.getByRole("button", {name: "重绘当前部件", exact: true}).click();
  const redrawDialog = page.getByRole("dialog", {name: "重绘结果审阅", exact: true});
  await redrawDialog.waitFor();
  const stagedRedraw = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    return {project: await storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value), request:window.spineTestCalls.requests.at(-1)};
  });
  assert.deepEqual(stagedRedraw.project.parts, beforeRedraw.parts, "Candidate must not replace saved textures before acceptance");
  assert.equal(stagedRedraw.request.referenceAttachmentIds.length,3,"Redraw includes source, crop and current texture");
  assert.match(stagedRedraw.request.prompt,/Reference Image 3 is the CURRENT isolated texture/);
  await redrawDialog.getByRole("button",{name:"动作对照",exact:true}).click();
  await redrawDialog.getByRole("button",{name:"播放对照",exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="重绘对照时间"]').value)>0.1);
  await redrawDialog.getByRole("button",{name:"暂停对照",exact:true}).click();
  await redrawDialog.getByLabel("重绘对照时间",{exact:true}).fill("2");
  assert.equal(await redrawDialog.getByLabel("重绘对照时间").inputValue(),"2","Comparison exposes exact endpoint without looping");
  await page.screenshot({path:resolve(output,"redraw-review-motion.png")});
  await page.setViewportSize({width:720,height:800});
  await redrawDialog.getByRole("button",{name:"贴图对照",exact:true}).click();
  await page.screenshot({path:resolve(output,"redraw-review-narrow.png")});
  assert.equal(await redrawDialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,"Narrow review has no horizontal overflow");
  await redrawDialog.getByRole("button",{name:"放弃结果",exact:true}).click();
  await redrawDialog.waitFor({state:"hidden"});
  await page.setViewportSize({width:1200,height:900});
  await page.getByRole("button",{name:"重绘当前部件",exact:true}).click();
  await redrawDialog.waitFor();
  await redrawDialog.getByRole("button",{name:"采纳重绘贴图",exact:true}).click();
  await page.getByText(/已替换 Swinging part 的贴图/).waitFor();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const redrawn = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    return storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
  });
  assert.notEqual(redrawn.parts[1].image, beforeRedraw.parts[1].image);
  const geometryOnly = ({image,imageWidth,imageHeight,...part}) => part;
  assert.deepEqual(redrawn.parts.map(geometryOnly), beforeRedraw.parts.map(geometryOnly));
  assert.deepEqual(redrawn.clips, beforeRedraw.clips);
  await page.getByRole("button", {name: "撤销编辑", exact: true}).click();
  await page.getByRole("button", {name: "保存", exact: true}).click();
  await page.getByText("已保存到本机", {exact: true}).waitFor();
  const restoredRedraw = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    return storage.loadSpineProject(document.querySelector('select[aria-label="本地工程"]').value);
  });
  assert.deepEqual(restoredRedraw.parts, beforeRedraw.parts);
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').first().setInputFiles(source);
  await page.waitForFunction(() => document.querySelectorAll(".spine-assistant-drafts > div").length === 0);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const replaced = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    const project = await storage.loadSpineProject(id);
    return { sourceId: project.sourceImage?.id, plan: project.rigPartPlan };
  });
  assert.notEqual(replaced.sourceId, interrupted.sourceId);
  assert.equal(replaced.plan, undefined);
  await page.getByRole("textbox", { name: "部件、骨骼或动作需求" }).fill("重新为这张图规划两个部件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".spine-assistant-drafts > div").length === 2);
  await page.getByRole("button", { name: "生成草案部件" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".spine-part").length === 4);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const replanned = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    const project = await storage.loadSpineProject(id);
    return { planId: project.rigPartPlan?.id, sourceId: project.rigPartPlan?.sourceId, parts: project.parts.map(({ id, parent }) => ({ id, parent })) };
  });
  assert.notEqual(replanned.planId, interrupted.plan.id);
  assert.equal(replanned.sourceId, replaced.sourceId);
  assert.deepEqual(replanned.parts.slice(2).map((part) => part.id), [replanned.planId + "_case", replanned.planId + "_swing"]);
  assert.equal(replanned.parts[3].parent, replanned.parts[2].id);
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "v4-plan-ui-result.json"), JSON.stringify({ interrupted, resumed: result, motion, inbetween, replaced, replanned }, null, 2));
  console.log(JSON.stringify({ interrupted, resumed: result, replaced, replanned }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, "v4-plan-ui-failure.png") });
  console.error({ errors, url: page.url(), body: await page.locator("body").innerText() });
  throw error;
} finally {
  await context.close();
  await browser.close();
}

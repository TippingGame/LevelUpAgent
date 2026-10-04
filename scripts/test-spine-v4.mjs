import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { addSpineParts, createSpinePart, newSpineProject, validateSpineProject } from "../src/lib/spine.ts";

const source = readFileSync(new URL("../src/lib/spineAssistant.ts", import.meta.url), "utf8")
  .replace('from "./spine"', `from "${new URL("../src/lib/spine.ts", import.meta.url).href}"`);
const url = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString("base64")}`;
const { applySpineAssistantProposal, createSpinePlannedPart, orderSpinePlannedParts, parseSpineAssistantProposal, plannedSpinePartId, validateSpinePartPlan } = await import(url);
const matteSource = readFileSync(new URL("../src/lib/spineMatting.ts", import.meta.url), "utf8");
const matteUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(matteSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString("base64")}`;
const { matteSpineSolidBackground } = await import(matteUrl);
const generationSource = readFileSync(new URL("../src/lib/spineGeneration.ts", import.meta.url), "utf8")
  .replace('from "./spine"', `from "${new URL("../src/lib/spine.ts", import.meta.url).href}"`);
const generationUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(generationSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString("base64")}`;
const { spineImageBackgroundPrompt } = await import(generationUrl);
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function fixture() {
  const project = newSpineProject("source rig");
  return addSpineParts(project, [
    createSpinePart("body", png, 1, 1, "body"),
    createSpinePart("head", png, 1, 1, "head"),
  ]);
}

test("rig proposal parses JSON fences and applies editable bones and tracks", () => {
  const project = fixture();
  const [body, head] = project.parts;
  const proposal = parseSpineAssistantProposal(`\`\`\`json\n${JSON.stringify({
    reply: "Parent head and animate a nod.",
    parts: [{ id: head.id, parent: body.id, pivotY: 0.9, y: 155 }],
    clips: [{ name: "nod", duration: 1, tracks: {
      [head.id]: [
        { time: 0, rotation: 0, bend: 0, x: 0, y: 0, curve: "linear" },
        { time: 1, rotation: 15, bend: 0, x: 0, y: 0, curve: "linear" },
      ],
    } }],
  })}\n\`\`\``);
  const result = applySpineAssistantProposal(project, proposal);
  assert.equal(result.parts[1].parent, body.id);
  assert.equal(result.parts[1].pivotY, 0.9);
  assert.equal(result.clips[0].tracks[head.id][1].rotation, 15);
  assert.equal(project.clips.length, 0);
  assert.equal(project.parts[1].pivotY, 0.88);
});

test("rig proposal rejects unknown parts, cycles, and invalid animation tracks", () => {
  const project = fixture();
  const [body, head] = project.parts;
  assert.throws(() => parseSpineAssistantProposal("not JSON"), /valid JSON/);
  assert.throws(() => applySpineAssistantProposal(project, { reply: "", parts: [{ id: "missing", x: 3 }] }), /unknown/);
  assert.throws(() => applySpineAssistantProposal(project, { reply: "", parts: [
    { id: body.id, parent: head.id }, { id: head.id, parent: body.id },
  ] }), /cycle/);
  assert.throws(() => applySpineAssistantProposal(project, { reply: "", clips: [{
    name: "bad", duration: 1, tracks: { missing: [] },
  }] }), /unknown part/);
  assert.throws(() => applySpineAssistantProposal(project, { reply: "", clips: [{
    name: "bad", duration: 1, tracks: { [head.id]: [
      { time: 2, rotation: 0, bend: 0, x: 0, y: 0, curve: "linear" },
    ] },
  }] }), /key timing/);
});

test("source image and rig conversation validate as durable project data", () => {
  const project = fixture();
  project.sourceImage = { name: "source.png", image: png, originalImage: png, width: 1, height: 1 };
  project.rigConversation = [{ id: "msg_one", role: "user", content: "Make a nod", createdAt: 1 }];
  assert.equal(validateSpineProject(JSON.parse(JSON.stringify(project))).sourceImage.name, "source.png");
  assert.throws(() => validateSpineProject({ ...project, sourceImage: { ...project.sourceImage, image: "data:image/jpeg;base64,AAAA" } }), /source image/);
  assert.throws(() => validateSpineProject({ ...project, rigConversation: [{ ...project.rigConversation[0], role: "system" }] }), /rig conversation/);
});

test("chat reorders all layers without changing bone parents, and rejects lost or duplicate layers", () => {
  const project = fixture();
  const [body, head] = project.parts;
  const reordered = applySpineAssistantProposal(project, { reply: "Behind", drawOrder: [head.id, body.id] });
  assert.deepEqual(reordered.parts.map((part) => part.id), [head.id, body.id]);
  assert.equal(reordered.parts[0].parent, body.id);
  for (const drawOrder of [[head.id], [head.id, head.id], [head.id, "missing"]])
    assert.throws(() => applySpineAssistantProposal(project, { reply: "Invalid", drawOrder }), /every existing part/);
});

test("parent-first generation keeps back layers behind their parent across partial checkpoints", () => {
  const draft = { key: "body", name: "Body", description: "body", role: "body", parent: null,
    left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, pivotX: 0.5, pivotY: 0.5, flexibility: 0, drawOrder: 2 };
  const drafts = [draft, { ...draft, key: "tail", name: "Tail", parent: "body", drawOrder: 0 },
    { ...draft, key: "ear", name: "Ear", parent: "body", drawOrder: 1 }];
  let project = { ...newSpineProject(), sourceImage: {name: "source.png",image: png,originalImage: png,width: 100,height: 100} };
  validateSpinePartPlan(project, drafts);
  for (const draft of drafts) {
    const part = createSpinePlannedPart(project, draft, png, 1, 1);
    project = validateSpineProject({ ...project, parts: orderSpinePlannedParts([...project.parts, part], drafts) });
  }
  assert.deepEqual(project.parts.map((part) => part.id), ["plan_tail", "plan_ear", "plan_body"]);
  assert.equal(project.parts[0].parent, "plan_body");
  assert.throws(() => validateSpinePartPlan(project, [{ ...draft, drawOrder: 24 }]), /Invalid planned part/);
});

test("arbitrary object plan creates placed, parented editable parts and can resume", () => {
  const project = { ...newSpineProject("clock"), sourceImage: {
    name: "clock.png", image: png, originalImage: png, width: 200, height: 100,
  } };
  const drafts = [{ key: "case", name: "Clock case", description: "outer brass case", role: "other", parent: null,
    left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, pivotX: 0.5, pivotY: 0.5, flexibility: 0 },
  { key: "pendulum", name: "Pendulum", description: "swinging bob and rod", role: "other", parent: "case",
    left: 0.4, top: 0.3, right: 0.6, bottom: 0.8, pivotX: 0.5, pivotY: 0.05, flexibility: 0.2 }];
  assert.equal(validateSpinePartPlan(project, drafts).length, 2);
  const body = createSpinePlannedPart(project, drafts[0], png, 1, 1);
  const child = createSpinePlannedPart({ ...project, parts: [body] }, drafts[1], png, 1, 1);
  assert.equal(body.id, plannedSpinePartId("case"));
  assert.equal(body.parent, null);
  assert.equal(body.x, 0);
  assert.equal(body.y, 120);
  assert.equal(body.width, 384);
  assert.equal(child.parent, body.id);
  assert.equal(child.x, 0);
  assert.equal(child.y, 162);
  assert.equal(validateSpineProject({ ...project, parts: [body, child] }).parts.length, 2);
  assert.equal(validateSpinePartPlan({ ...project, parts: [body] }, drafts).length, 2);
  assert.equal(applySpineAssistantProposal(project, { reply: "Plan", newParts: drafts }).parts.length, 0);
});

test("part plans reject invalid bounds, unknown parents, duplicate keys and overflow", () => {
  const project = { ...newSpineProject("object"), sourceImage: {
    name: "object.png", image: png, originalImage: png, width: 200, height: 100,
  } };
  const draft = { key: "base", name: "Base", description: "solid base", role: "other", parent: null,
    left: 0.1, top: 0.2, right: 0.9, bottom: 0.8, pivotX: 0.5, pivotY: 0.5, flexibility: 0 };
  assert.throws(() => validateSpinePartPlan(newSpineProject(), [draft]), /source image/);
  assert.throws(() => validateSpinePartPlan(project, [{ ...draft, right: 1.2 }]), /Invalid planned part/);
  assert.throws(() => validateSpinePartPlan(project, [{ ...draft, parent: "missing" }]), /Invalid planned part/);
  assert.throws(() => validateSpinePartPlan(project, [draft, draft]), /Invalid planned part/);
  assert.throws(() => validateSpinePartPlan(project, [{ ...draft, parent: "child" }, { ...draft, key: "child", parent: "base" }]), /Invalid planned part/);
  assert.throws(() => validateSpinePartPlan({ ...project, parts: Array(24).fill(0).map((_, i) => ({ ...createSpinePart(`p${i}`, png, 1, 1), id: `p${i}` })) }, [draft]), /24-part/);
});

test("saved legacy plans remain readable while new plans use distinct part identities", () => {
  const draft = { key: "case", name: "Case", description: "outer case", role: "other", parent: null,
    left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, pivotX: 0.5, pivotY: 0.5, flexibility: 0 };
  const sourceImage = { id: "source_one", name: "source.png", image: png, originalImage: png, width: 200, height: 100 };
  const legacy = { ...newSpineProject("legacy"), sourceImage, rigPartPlan: { sourceId: sourceImage.id, drafts: [draft] } };
  assert.equal(createSpinePlannedPart(validateSpineProject(legacy), draft, png, 1, 1).id, "plan_case");
  const modern = { ...legacy, rigPartPlan: { id: "plan_one", sourceId: sourceImage.id, drafts: [draft] } };
  assert.equal(createSpinePlannedPart(validateSpineProject(modern), draft, png, 1, 1).id, "plan_one_case");
  assert.notEqual(plannedSpinePartId("case", "plan_two"), plannedSpinePartId("case", modern.rigPartPlan.id));
  assert.throws(() => validateSpineProject({ ...modern, rigPartPlan: { ...modern.rigPartPlan, sourceId: "source_other" } }), /rig part plan source/);
});

function matteFixture(background = [0, 255, 0, 255]) {
  const width = 15, height = 15, pixels = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, color) => pixels.set(color, (y * width + x) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, background);
  for (let y = 4; y <= 10; y++) for (let x = 4; x <= 10; x++) set(x, y, [220, 40, 40, 255]);
  const at = (buffer, x, y) => Array.from(buffer.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
  return { width, height, pixels, set, at };
}

test("green screen unmixing recovers coverage and color without altering enclosed green paint", () => {
  const { width, height, pixels, set, at } = matteFixture();
  // Known 50% coverage of red paint composited over the green screen.
  set(3, 7, [110, 148, 20, 255]);
  set(7, 7, [0, 255, 0, 255]);
  const original = pixels.slice();
  const result = matteSpineSolidBackground(pixels, width, height, 24);
  assert.ok(result.removed > 100);
  assert.ok(result.feathered > 0);
  assert.equal(result.pixels[3], 0);
  assert.deepEqual(at(result.pixels, 7, 7), [0, 255, 0, 255]);
  assert.deepEqual(at(result.pixels, 6, 7), [220, 40, 40, 255]);
  const recovered = at(result.pixels, 3, 7);
  [220, 40, 40, 128].forEach((value, i) => assert.ok(Math.abs(recovered[i] - value) <= 2, `${recovered}`));
  assert.deepEqual(pixels, original);
});

test("matting preserves real green details at the edge and non-green backgrounds skip green unmixing", () => {
  const green = matteFixture();
  green.set(3, 7, [40, 160, 100, 255]);
  assert.deepEqual(green.at(matteSpineSolidBackground(green.pixels, green.width, green.height, 24).pixels, 3, 7), [40, 160, 100, 255]);
  const white = matteFixture([255, 255, 255, 255]);
  white.set(3, 7, [40, 160, 100, 255]);
  const result = matteSpineSolidBackground(white.pixels, white.width, white.height, 24);
  assert.equal(result.feathered, 0);
  assert.deepEqual(white.at(result.pixels, 3, 7), [40, 160, 100, 255]);
});

test("matting rejects mismatched image dimensions, invalid tolerance and nonuniform corners", () => {
  const { pixels, width, height, set } = matteFixture();
  assert.throws(() => matteSpineSolidBackground(pixels, width + 1, height, 24), /Invalid/);
  assert.throws(() => matteSpineSolidBackground(pixels, width, height, NaN), /Invalid/);
  set(0, 0, [255, 0, 0, 255]);
  assert.throws(() => matteSpineSolidBackground(pixels, width, height, 24), /Corner colors/);
});

test("gpt-image-2 requests a removable screen while transparency-capable models request alpha", () => {
  for (const id of ["gpt-image-2", "gpt-image-2.5-sunburst", "models/gpt-image-2"]) {
    const prompt = spineImageBackgroundPrompt(id);
    assert.match(prompt, /pure green \(#00FF00\)/);
    assert.doesNotMatch(prompt, /transparent/);
  }
  assert.match(spineImageBackgroundPrompt("gpt-image-1.5"), /transparent RGBA/);
});

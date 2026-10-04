import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  addSpineParts,
  createSpinePart,
  generateSpineClip,
  newSpineProject,
  validateSpineProject,
} from "../src/lib/spine.ts";

function moduleUrl(path, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(`from "${from}"`, `from "${to}"`);
  return `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`;
}
const spineUrl = new URL("../src/lib/spine.ts", import.meta.url).href;
const motion = await import(moduleUrl("../src/lib/spineMotion.ts", { "./spine": spineUrl }));
const poseImages = await import(moduleUrl("../src/lib/spinePoseGeneration.ts"));
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function fixture() {
  const project = newSpineProject("motion");
  const next = addSpineParts(project, [
    createSpinePart("body", png, 1, 1, "body"),
    createSpinePart("arm", png, 1, 1, "arm-right"),
  ]);
  next.clips = [generateSpineClip(next.parts, "idle", "idle")];
  return next;
}

test("pose generation uses nearest pictured endpoints and rejects occupied or unbounded times", () => {
  const project = fixture(), clip = project.clips[0], study = motion.createSpineMotionStudy(clip);
  const frame = (time, name, image = png) => motion.captureSpinePose(clip, project.parts, time, name, "upload", image ? {image, imageWidth: 1, imageHeight: 1} : undefined);
  const a = frame(0, "start"), b = frame(2, "end"), near = frame(0.5, "near"), duplicate = frame(0.5, "latest"), capture = frame(0.75, "capture", null);
  study.frames = [b, a, near, duplicate, capture];
  const request = poseImages.createSpinePoseImageRequest(study, clip.duration, 1, "", true);
  assert.deepEqual(request.neighbors.map(item => item.id), [duplicate.id, b.id]);
  const prompt = poseImages.spinePoseImagePrompt({...project, sourceImage: {image: png}}, request);
  assert.match(prompt, /Reference Image 1 is the complete source subject/);
  assert.match(prompt, /Reference Image 2 is the PREVIOUS key pose at 0.5s/);
  assert.match(prompt, /Reference Image 3 is the NEXT key pose at 2s/);
  assert.match(prompt, /33.33%/);
  assert.match(prompt, /Do not crossfade/);
  const withoutSource = poseImages.spinePoseImagePrompt(project, request);
  assert.match(withoutSource, /Reference Image 1 is the PREVIOUS/);
  for (const time of [0, 0.5, 0.5001, 0.75, 2, -1, 3, NaN, Infinity])
    assert.throws(() => poseImages.createSpinePoseImageRequest(study, clip.duration, time, "", true));
  assert.throws(() => poseImages.createSpinePoseImageRequest(study, clip.duration, 1, "  "));
  assert.equal(poseImages.createSpinePoseImageRequest(study, clip.duration, 1, " raise arm ").description, "raise arm");
});

test("in-flight image references reject changed neighbors but preserve unrelated edits", () => {
  const project = fixture(), clip = project.clips[0], study = motion.createSpineMotionStudy(clip);
  study.frames = [0, 2].map(time => motion.captureSpinePose(clip, project.parts, time, "pose", "upload", {image: png, imageWidth: 1, imageHeight: 1}));
  const request = poseImages.createSpinePoseImageRequest(study, clip.duration, 1, "", true);
  const matches = changed => poseImages.spinePoseImageReferencesMatch(request, changed);
  const edited = structuredClone(study);
  edited.frames[0].targets[project.parts[0].id].rotation = 22;
  edited.frames[0].name = "renamed";
  edited.fps = 30;
  assert.equal(matches(edited), true);
  for (const key of ["image", "time", "id"]) {
    const changed = structuredClone(study);
    changed.frames[0][key] = key === "time" ? 0.2 : "changed";
    assert.equal(matches(changed), false, key);
  }
  assert.equal(matches({...study, id: "changed"}), false);
  assert.equal(matches({...study, clipId: "changed"}), false);
  assert.equal(matches({...study, frames: study.frames.slice(1)}), false);
  assert.equal(matches({...study, frames: [...study.frames, {...study.frames[0], id: "nearer", time: 0.7}]}), false);
  assert.equal(matches({...study, frames: [...study.frames, {...study.frames[0], id: "new_duplicate"}]}), false);
  const empty = {...study, frames: []}, emptyRequest = poseImages.createSpinePoseImageRequest(empty, 2, 1, "raise arm");
  assert.equal(poseImages.spinePoseImageReferencesMatch(emptyRequest, study), false);
});

test("capture and fit preserve editable targets and report missing parts", () => {
  const project = fixture();
  const clip = project.clips[0];
  const study = motion.createSpineMotionStudy(clip);
  const captured = motion.captureSpinePose(clip, project.parts, 0.5, "key");
  study.frames = [{ ...captured, targets: { [project.parts[0].id]: { rotation: 12, bend: 3, x: 4, y: 5 } } }];
  const fitted = motion.fitSpinePose(project, study, study.frames[0]);
  assert.equal(fitted.fitStatus, "review");
  assert.equal(fitted.fitError, 0.5);
  assert.equal(fitted.targets[project.parts[0].id].rotation, 12);
  assert.equal(typeof fitted.targets[project.parts[1].id].rotation, "number");
});

test("interpolation uses shortest angle and creates bounded editable tracks", () => {
  const project = fixture();
  const clip = project.clips[0];
  const study = motion.createSpineMotionStudy(clip);
  const a = motion.captureSpinePose(clip, project.parts, 0, "a");
  const b = motion.captureSpinePose(clip, project.parts, 1, "b");
  b.targets[project.parts[0].id].rotation = 350;
  a.targets[project.parts[0].id].rotation = 10;
  study.frames = [a, b];
  study.fps = 12;
  const tracks = motion.interpolateSpineStudy(project, study);
  assert.ok(tracks[project.parts[0].id].length >= 12);
  assert.ok(tracks[project.parts[0].id].length <= 300);
  const middle = tracks[project.parts[0].id].find((key) => Math.abs(key.time - 0.5) < 0.001);
  assert.ok(middle);
  assert.ok(Math.abs(Math.abs(middle.rotation) - 0) < 1e-6 || Math.abs(Math.abs(middle.rotation) - 360) < 1e-6);
  const applied = motion.applySpineStudy(project, study, "fitted");
  assert.equal(applied.name, "fitted");
  assert.equal(applied.tracks[project.parts[1].id].length, tracks[project.parts[1].id].length);
  assert.throws(() => motion.interpolateSpineStudy(project, { ...study, frames: [a] }), /two key poses/);
  assert.throws(() => motion.interpolateSpineStudy(project, { ...study, frames: [a, { ...b, time: a.time }] }), /two key poses/);
});

test("motion studies are persisted and hostile pose data is rejected", () => {
  const project = fixture();
  const study = motion.createSpineMotionStudy(project.clips[0]);
  study.frames = [motion.captureSpinePose(project.clips[0], project.parts, 0, "pose")];
  project.motionStudies = [study];
  assert.equal(validateSpineProject(JSON.parse(JSON.stringify(project))).motionStudies.length, 1);
  const bad = JSON.parse(JSON.stringify(project));
  bad.motionStudies[0].frames[0].targets.missing = { rotation: 0, bend: 0, x: 0, y: 0 };
  assert.throws(() => validateSpineProject(bad), /pose target/);
});

test("vision pose inference requires complete bounded targets for the actual rig", () => {
  const project = fixture();
  const frame = motion.captureSpinePose(project.clips[0], project.parts, 0.7, "target", "generated", { image: png, imageWidth: 1, imageHeight: 1 });
  const proposal = { summary: "Arm raised; body remains fixed", targets: structuredClone(frame.targets), uncertain: [project.parts[1].id] };
  proposal.targets[project.parts[1].id].rotation = 64;
  assert.deepEqual(motion.parseSpinePoseInference('```json\n' + JSON.stringify(proposal) + '\n```', project.parts), proposal);
  const missing = structuredClone(proposal); delete missing.targets[project.parts[0].id];
  assert.throws(() => motion.parseSpinePoseInference(JSON.stringify(missing), project.parts), /every current part/);
  const unknown = structuredClone(proposal); unknown.targets.unknown = { rotation: 0, bend: 0, x: 0, y: 0 };
  assert.throws(() => motion.parseSpinePoseInference(JSON.stringify(unknown), project.parts), /every current part/);
  for (const invalid of ["90", 361, null]) {
    const wrong = structuredClone(proposal); wrong.targets[project.parts[1].id].rotation = invalid;
    assert.throws(() => motion.parseSpinePoseInference(JSON.stringify(wrong), project.parts), /bounded/);
  }
  const badUncertainty = { ...proposal, uncertain: ["unknown"] };
  assert.throws(() => motion.parseSpinePoseInference(JSON.stringify(badUncertainty), project.parts), /uncertain parts/);
  const incomplete = structuredClone(proposal); delete incomplete.targets[project.parts[1].id].bend;
  assert.throws(() => motion.parseSpinePoseInference(JSON.stringify(incomplete), project.parts), /bounded/);
});

test("accepting vision targets preserves the image and timeline and remains editable through interpolation", () => {
  const project = fixture();
  const clip = project.clips[0], study = motion.createSpineMotionStudy(clip);
  const frame = motion.captureSpinePose(clip, project.parts, 1, "target", "generated", { image: png, imageWidth: 1, imageHeight: 1 });
  frame.notes = "Raise the arm";
  const original = structuredClone(frame);
  const proposal = { summary: "Estimated arm rotation", targets: structuredClone(frame.targets), uncertain: [] };
  proposal.targets[project.parts[1].id].rotation = 80;
  const accepted = motion.acceptSpinePoseInference(frame, proposal);
  assert.deepEqual(frame, original, "Original pose stays unchanged before replacement");
  for (const field of ["id", "name", "source", "time", "image", "imageWidth", "imageHeight"]) assert.equal(accepted[field], frame[field]);
  assert.equal(accepted.fitStatus, "review");
  assert.equal(accepted.fitError, undefined, "Do not invent a pixel-fit score");
  assert.match(accepted.notes, /Raise the arm/);
  study.frames = [motion.captureSpinePose(clip, project.parts, 0, "start"), accepted];
  project.motionStudies = [study];
  assert.equal(validateSpineProject(JSON.parse(JSON.stringify(project))).motionStudies[0].frames[1].targets[project.parts[1].id].rotation, 80);
  const compiled = motion.applySpineStudy(project, study);
  assert.equal(compiled.tracks[project.parts[1].id].at(-1).rotation, 80);
});

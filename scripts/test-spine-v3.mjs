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

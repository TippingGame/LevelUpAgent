import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const urls = new Map();
function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText.replace(/from "\.\/(\w+)"/g, (_, dependency) => `from "${moduleUrl(dependency)}"`);
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  urls.set(name, url);
  return url;
}
const { planSpinePixelFrames: plan, spinePixelPlanMatches: matches } = await import(moduleUrl("spinePixelInterpolation"));
const target = { rotation: 10, bend: 0, x: 0, y: 0 };
function fixture() {
  return { id: "study", clipId: "clip", frames: [0, 2].map((time, i) => ({
    id: `pose_${i}`, time, image: `image_${i}`, targets: { arm: { ...target } },
  })) };
}

test("RIFE plans evenly spaced 1/3/7 frames within nearest pictured endpoints", () => {
  const study = fixture();
  for (const count of [1, 3, 7]) {
    const result = plan(study, 0.8, count);
    assert.deepEqual(result.times, Array.from({length: count}, (_, i) => 2 * (i + 1) / (count + 1)));
    assert.equal(matches(result, study), true);
  }
  study.frames.push({ ...study.frames[0], id: "closer", time: 0.5 });
  assert.deepEqual(plan(study, 0.8, 3).times, [0.875, 1.25, 1.625]);
});

test("RIFE rejects invalid counts, unbounded times, occupied times and study overflow", () => {
  const study = fixture();
  for (const count of [0, 2, 4, 8, -1, 1.5, NaN]) assert.throws(() => plan(study, 1, count));
  for (const time of [-1, 0, 2, 3, NaN, Infinity]) assert.throws(() => plan(study, time, 1));
  const occupied = { ...study, frames: [...study.frames, { id: "capture", time: 1, targets: {} }] };
  assert.throws(() => plan(occupied, 0.8, 3), /occupied/);
  assert.throws(() => plan({ ...study, frames: Array(32).fill(study.frames).flat() }, 1, 1), /64/);
  assert.throws(() => plan({ ...study, frames: [study.frames[0], {...study.frames[1],time:0.001}] }, 0.0005, 7), /too close/);
});

test("pending RIFE rejects changed endpoint images, targets and nearest neighbors", () => {
  const study = fixture(), result = plan(study, 0.8, 3);
  for (const property of ["id", "image", "time", "targets"]) {
    const changed = structuredClone(study);
    changed.frames[0][property] = property === "time" ? 0.1 : property === "targets" ? {arm:{...target,rotation:20}} : "changed";
    assert.equal(matches(result, changed), false, property);
  }
  assert.equal(matches(result, { ...study, id: "other" }), false);
  assert.equal(matches(result, { ...study, clipId: "other" }), false);
  assert.equal(matches(result, { ...study, frames: study.frames.slice(1) }), false);
  assert.equal(matches(result, { ...study, frames: [...study.frames, {...study.frames[0],id:"nearer",time:0.7}] }), false);
  assert.equal(matches(result, { ...study, frames: [...study.frames, {...study.frames[0],id:"duplicate"}] }), false);
  const atSelection = { ...study, frames: [...study.frames, {...study.frames[0],id:"at_selection",time:0.8}] };
  assert.equal(matches(result, atSelection), false, "A new pictured key at the selection cannot be skipped");
  assert.throws(() => plan(atSelection, 0.8, 3), /Choose a time between/);
  study.frames[0].targets.arm.rotation = 25;
  assert.equal(matches(result, study), false, "Plan owns an immutable endpoint snapshot");
});

test("pending RIFE retains unrelated captures/settings but never overwrites generated times", () => {
  const study = fixture();
  study.frames.push({id:"capture",time:0.7,targets:{arm:{...target}}});
  const result = plan(study, 0.8, 3);
  assert.equal(matches(result, study), true);
  const changed = structuredClone(study);
  changed.fps = 12;
  changed.frames[0].name = "renamed";
  changed.frames[2].targets.arm.rotation = 30;
  assert.equal(matches(result, changed), true);
  changed.frames[2].time = 0.5001;
  assert.equal(matches(result, changed), false);
});

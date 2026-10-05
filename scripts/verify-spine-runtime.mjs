// Optional compatibility test. The official runtime is supplied by the developer,
// compiled in a disposable folder, and is never included in the application bundle.
// Usage: node scripts/verify-spine-runtime.mjs <spine-runtimes/spine-ts/spine-core/src> [project.json] [export-directory]
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import * as studio from "../src/lib/spine.ts";

if (!process.argv[2])
  throw new Error(
    "Pass the official Spine 4.2 spine-core/src directory; missing compatibility tests are not treated as passing.",
  );
const source = resolve(process.argv[2]),
  output = mkdtempSync(join(tmpdir(), "levelup-spine-compat-"));
try {
  const compile = (dir, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory())
        compile(join(dir, entry.name), join(dest, entry.name));
      else if (entry.name.endsWith(".ts"))
        writeFileSync(
          join(dest, entry.name.replace(/\.ts$/, ".js")),
          ts.transpileModule(readFileSync(join(dir, entry.name), "utf8"), {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ES2022,
            },
          }).outputText,
        );
    }
  };
  compile(source, output);
  writeFileSync(
    join(output, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  const runtime = await import(pathToFileURL(join(output, "index.js")).href);
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  let project = studio.addSpineParts(
    studio.newSpineProject("compatibility"),
    ["arm-right", "head", "leg-left", "body", "arm-left", "leg-right"].map(
      (role) => studio.createSpinePart(role, png, 1, 1, role),
    ),
  );
  project.parts = project.parts.map((part, i) => ({ ...part, flexibility: 0.8, skinDirection: ["down", "up", "left", "right"][i % 4] }));
  project.clips = ["idle", "wave", "walk", "breathe", "spring", "ripple"].map((name) =>
    studio.generateSpineClip(project.parts, name),
  );
  const head = project.parts.find((p) => p.role === "head"),
    body = project.parts.find((p) => p.role === "body");
  project.clips.push({
    id: "custom",
    name: "custom",
    duration: 2,
    tracks: {
      [head.id]: [
        { ...studio.ZERO_POSE, time: 0.125, rotation: 230, scaleX: 1.3, scaleY: 0.7, tipX: 17, tipY: -9, curve: "stepped" },
        { ...studio.ZERO_POSE, time: 1, rotation: -230, scaleX: 0.6, scaleY: 1.7, tipX: -21, tipY: 15 },
      ],
      [body.id]: [
        { ...studio.ZERO_POSE, rotation: 90, x: 16, y: 22 },
        { ...studio.ZERO_POSE, time: 2, rotation: -70, x: -10, y: 60 },
      ],
    },
  });
  if (process.argv[3]) project = studio.validateSpineProject(JSON.parse(readFileSync(resolve(process.argv[3]), "utf8")));
  let atlasText = studio.spineAtlasText(studio.packSpineAtlas(project.parts));
  let skeletonJson = studio.compileSpineProject(project);
  if (process.argv[4]) {
    const exported = resolve(process.argv[4]);
    const actualJson = JSON.parse(readFileSync(join(exported, "skeleton.json"), "utf8"));
    const actualAtlas = readFileSync(join(exported, "skeleton.atlas"), "utf8");
    assert.deepEqual(actualJson, skeletonJson, "Exported skeleton matches the saved editable project");
    assert.equal(actualAtlas, atlasText, "Exported atlas matches project packing");
    skeletonJson = actualJson;
    atlasText = actualAtlas;
  }
  const atlas = new runtime.TextureAtlas(atlasText);
  for (const page of atlas.pages)
    page.setTexture(
      new runtime.FakeTexture({ width: page.width, height: page.height }),
    );
  const data = new runtime.SkeletonJson(
    new runtime.AtlasAttachmentLoader(atlas),
  ).readSkeletonData(skeletonJson);
  assert.equal(data.bones.length, 1 + project.parts.length * 2);
  assert.equal(data.animations.length, project.clips.length);
  assert.equal(data.slots.length, project.parts.length);
  assert.deepEqual(data.slots.map((slot) => slot.name), project.parts.map((part) => part.id));
  const skeleton = new runtime.Skeleton(data);
  let maximumError = 0,
    samples = 0;
  for (const clip of project.clips)
    for (const time of [0, 0.05, 0.125, 0.231, 0.5, 0.777, 1, 1.735, 2].filter(
      (t) => t <= clip.duration,
    )) {
      skeleton.setToSetupPose();
      data
        .findAnimation(clip.name)
        .apply(
          skeleton,
          0,
          time,
          false,
          [],
          1,
          runtime.MixBlend.replace,
          runtime.MixDirection.mixIn,
        );
      skeleton.updateWorldTransform(runtime.Physics.none);
      const pose = studio.spineWorldPose(project.parts, clip, time);
      for (const [index, slot] of skeleton.slots.entries()) {
        const attachment = slot.getAttachment(),
          actual = new Float32Array(attachment.worldVerticesLength);
        attachment.computeWorldVertices(
          slot,
          0,
          attachment.worldVerticesLength,
          actual,
          0,
          2,
        );
        const expected = studio.spineWorldVertices(project.parts[index], pose);
        assert.equal(actual.length, expected.length);
        for (let i = 0; i < actual.length; i++) {
          const error = Math.abs(actual[i] - expected[i]);
          maximumError = Math.max(error, maximumError);
          assert.ok(
            error < 0.001,
            `${clip.name} at ${time}: vertex ${i} differs by ${error}`,
          );
          samples++;
        }
      }
    }
  console.log(
    JSON.stringify(
      {
        runtime: "Spine 4.2",
        bones: data.bones.length,
        meshes: data.slots.length,
        animations: data.animations.length,
        coordinateSamples: samples,
        maximumError,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(output, { recursive: true, force: true });
}

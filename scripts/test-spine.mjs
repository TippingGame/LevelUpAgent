import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createSpineZip } from "../src/lib/spineArchive.ts";
import ts from "typescript";
import { readFileSync } from "node:fs";
import {
  addSpineParts,
  compileSpineProject,
  createSpinePart,
  generateSpineClip,
  newSpineProject,
  orderedSpineParts,
  packSpineAtlas,
  sampleSpineKeys,
  spineAtlasText,
  spinePartMesh,
  spineWorldPose,
  spineWorldVertices,
  upsertSpineKey,
  validateSpineProject,
  ZERO_POSE,
} from "../src/lib/spine.ts";

const generationSource = readFileSync(
  new URL("../src/lib/spineGeneration.ts", import.meta.url),
  "utf8",
).replace(
  'from "./spine"',
  'from "' + new URL("../src/lib/spine.ts", import.meta.url).href + '"',
);
const { runSpinePartGeneration } = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(generationSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`
);

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function fixture() {
  const p = newSpineProject("Robot");
  const body = createSpinePart("body", png, 1, 1, "body"),
    arm = createSpinePart("arm", png, 1, 1, "arm-right"),
    head = createSpinePart("head", png, 1, 1, "head");
  // Draw order is independent of the topological bone order.
  const next = addSpineParts(p, [arm, body, head]);
  next.clips = [
    generateSpineClip(next.parts, "idle"),
    generateSpineClip(next.parts, "wave"),
    generateSpineClip(next.parts, "walk"),
  ];
  return next;
}
test("weighted meshes compile into Spine 4.2 with topological bones and independent draw order", () => {
  const p = fixture(),
    json = compileSpineProject(p);
  assert.equal(json.skeleton.spine, "4.2.00");
  assert.equal(json.bones.length, 7);
  assert.equal(json.bones[1].name, p.parts[1].id);
  assert.equal(json.slots[0].bone, p.parts[0].id);
  assert.equal(json.skins[0].name, "default");
  for (const part of p.parts) {
    const m = json.skins[0].attachments[part.id][part.id];
    assert.equal(m.type, "mesh");
    assert.equal(m.uvs.length, 50);
    assert.equal(m.triangles.length, 96);
    assert.equal(m.hull, 16);
    let at = 0,
      vertices = 0;
    while (at < m.vertices.length) {
      const count = m.vertices[at++];
      let weights = 0;
      for (let i = 0; i < count; i++) {
        assert.ok(m.vertices[at] >= 0 && m.vertices[at] < json.bones.length);
        weights += m.vertices[at + 3];
        at += 4;
      }
      assert.ok(Math.abs(weights - 1) < 1e-9);
      vertices++;
    }
    assert.equal(vertices, 25);
  }
  for (const animation of Object.values(json.animations)) {
    for (const timelines of Object.values(animation.bones))
      for (const key of timelines.rotate) {
        assert.ok("value" in key);
        assert.equal("angle" in key, false);
      }
  }
});
test("setup mesh and inherited parent animation preserve editable geometry", () => {
  const p = fixture(),
    body = p.parts[1],
    arm = p.parts[0];
  const setup = spineWorldPose(p.parts),
    m = spinePartMesh(arm),
    vertices = spineWorldVertices(arm, setup, m);
  for (let i = 0; i < vertices.length; i++)
    assert.ok(
      Math.abs(vertices[i] - (m.positions[i] + (i % 2 ? arm.y : arm.x))) < 1e-8,
    );
  const clip = {
    id: "custom",
    name: "custom",
    duration: 1,
    tracks: { [body.id]: [{ ...ZERO_POSE, rotation: 90, x: 10, y: 20 }] },
  };
  const pose = spineWorldPose(p.parts, clip, 0),
    t = pose.get(arm.id);
  assert.ok(Math.abs(t.x - (body.x + 10 - (arm.y - body.y))) < 1e-9);
  assert.ok(Math.abs(t.y - (body.y + 20 + (arm.x - body.x))) < 1e-9);
  assert.equal(t.rotation, 90);
});
test("key editing replaces nearby times and matches linear/stepped interpolation", () => {
  let clip = { id: "motion", name: "motion", duration: 2, tracks: {} };
  clip = upsertSpineKey(clip, "arm", { ...ZERO_POSE, rotation: 10 });
  clip = upsertSpineKey(clip, "arm", {
    ...ZERO_POSE,
    time: 2,
    rotation: 30,
    bend: 20,
  });
  assert.equal(sampleSpineKeys(clip.tracks.arm, 1).rotation, 20);
  assert.equal(sampleSpineKeys(clip.tracks.arm, 1).bend, 10);
  clip = upsertSpineKey(clip, "arm", {
    ...ZERO_POSE,
    time: 0.0001,
    rotation: 12,
    curve: "stepped",
  });
  assert.equal(clip.tracks.arm.length, 2);
  assert.equal(sampleSpineKeys(clip.tracks.arm, 1).rotation, 12);
  assert.equal(sampleSpineKeys(clip.tracks.arm, 2).rotation, 30);
  assert.equal(
    sampleSpineKeys([{ ...ZERO_POSE, time: 1, rotation: 90 }], 0.5).rotation,
    0,
  );
});
test("all preset curves close the loop and target semantic roles", () => {
  const p = fixture();
  for (const c of p.clips) {
    for (const keys of Object.values(c.tracks))
      assert.deepEqual({ ...keys.at(-1), time: 0 }, keys[0]);
  }
  assert.ok(
    p.clips[1].tracks[p.parts[0].id].some(
      (k) => k.rotation > 100 && k.bend !== 0,
    ),
  );
});
test("hostile, cyclic, oversized and ambiguous project input is rejected", () => {
  const cases = [
    (p) => {
      p.parts[0].parent = p.parts[0].id;
    },
    (p) => {
      p.parts[1].parent = p.parts[0].id;
    },
    (p) => {
      p.parts[0].parent = "missing";
    },
    (p) => {
      p.parts[0].id = "../escape";
    },
    (p) => {
      p.parts[0].image = "https://example.com/image.png";
    },
    (p) => {
      p.parts[0].x = Infinity;
    },
    (p) => {
      p.parts[0].imageWidth = 10000;
    },
    (p) => {
      p.parts[2].id = p.parts[0].id + "_bend";
    },
    (p) => {
      p.parts[0].flexibility = 1.1;
    },
    (p) => {
      p.clips[0].name = "__proto__";
    },
    (p) => {
      p.clips[0].tracks[p.parts[0].id][1].time = 0;
    },
    (p) => {
      p.clips[0].tracks["missing"] = [ZERO_POSE];
    },
    (p) => {
      p.clips[0].tracks[p.parts[0].id][0].curve = "bezier";
    },
    (p) => {
      p.clips[0].duration = 0;
    },
  ];
  for (const mutate of cases) {
    const p = fixture();
    mutate(p);
    assert.throws(() => validateSpineProject(p));
  }
  assert.throws(() =>
    orderedSpineParts([
      { id: "a", parent: "b" },
      { id: "b", parent: "a" },
    ]),
  );
  assert.throws(() => compileSpineProject(newSpineProject()));
  assert.deepEqual(
    validateSpineProject(JSON.parse(JSON.stringify(fixture()))).format,
    "levelup-spine",
  );
});
test("atlas packing reserves padding and never overlaps or crosses pages", () => {
  const parts = Array.from({ length: 24 }, (_, i) =>
    createSpinePart(`part-${i}`, png, i % 2 ? 1024 : 333, i % 3 ? 1024 : 280),
  );
  const pages = packSpineAtlas(parts);
  assert.equal(pages.flatMap((p) => p.regions).length, 24);
  for (const page of pages) {
    assert.ok(page.width <= 2048 && page.height <= 2048);
    for (const a of page.regions) {
      assert.ok(
        a.x >= 2 &&
          a.y >= 2 &&
          a.x + a.width + 2 <= page.width &&
          a.y + a.height + 2 <= page.height,
      );
      for (const b of page.regions)
        if (a.id !== b.id)
          assert.ok(
            a.x + a.width + 4 <= b.x ||
              b.x + b.width + 4 <= a.x ||
              a.y + a.height + 4 <= b.y ||
              b.y + b.height + 4 <= a.y,
          );
    }
  }
  assert.equal(
    (spineAtlasText(pages).match(/pma: false/g) ?? []).length,
    pages.length,
  );
});
test("ZIP exports use portable filenames, UTF-8 contents and valid CRCs", () => {
  const text = new TextEncoder().encode("角色 Spine"),
    zip = createSpineZip([
      { name: "skeleton.json", data: text },
      { name: "images/a.png", data: Uint8Array.of(1, 2, 3) },
    ]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
  const length = view.getUint32(18, true),
    nameLength = view.getUint16(26, true);
  assert.deepEqual(zip.slice(30 + nameLength, 30 + nameLength + length), text);
  // Independent zlib CRC verification via a gzip wrapper around a stored block.
  const block = Buffer.alloc(5 + text.length);
  block[0] = 1;
  block.writeUInt16LE(text.length, 1);
  block.writeUInt16LE(~text.length & 65535, 3);
  block.set(text, 5);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(view.getUint32(14, true), 0);
  footer.writeUInt32LE(text.length, 4);
  assert.deepEqual(
    gunzipSync(
      Buffer.concat([
        Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 3]),
        block,
        footer,
      ]),
    ),
    Buffer.from(text),
  );
  assert.throws(() => createSpineZip([{ name: "../outside", data: text }]));
  assert.throws(() => createSpineZip([{ name: "C:/outside", data: text }]));
  assert.throws(() =>
    createSpineZip([
      { name: "x", data: text },
      { name: "x", data: text },
    ]),
  );
});

test("part generation stops after retaining the in-flight image and never starts another", async () => {
  const project = newSpineProject(),
    calls = [],
    saved = [];
  let stopped = false;
  const result = await runSpinePartGeneration({
    project,
    roles: ["body", "head"],
    shouldStop: () => stopped,
    onProgress: () => {},
    generate: async (role) => {
      calls.push(role);
      stopped = true;
      return { part: createSpinePart(role, png, 1, 1, role), opaque: true };
    },
    checkpoint: async (part) => {
      saved.push(part.role);
    },
  });
  assert.deepEqual(calls, ["body"]);
  assert.deepEqual(saved, ["body"]);
  assert.deepEqual(result, { completed: 1, opaque: true, stopped: true });
});
test("generation checkpoints serially and preserves completed parts when a later provider fails", async () => {
  const calls = [],
    saved = [];
  await assert.rejects(
    runSpinePartGeneration({
      project: newSpineProject(),
      roles: ["body", "head", "arm-left"],
      shouldStop: () => false,
      onProgress: () => {},
      generate: async (role) => {
        calls.push(role);
        if (role === "head") throw new Error("provider unavailable");
        return { part: createSpinePart(role, png, 1, 1, role), opaque: false };
      },
      checkpoint: async (part) => {
        await Promise.resolve();
        saved.push(part.role);
      },
    }),
    /provider unavailable/,
  );
  assert.deepEqual(calls, ["body", "head"]);
  assert.deepEqual(saved, ["body"]);
  let requested = false;
  await assert.rejects(
    runSpinePartGeneration({
      project: { ...newSpineProject(), parts: Array(24).fill({}) },
      roles: ["head"],
      shouldStop: () => false,
      onProgress: () => {},
      generate: async () => {
        requested = true;
      },
      checkpoint: async () => {},
    }),
    /24 parts/,
  );
  assert.equal(requested, false);
});
test("a failed checkpoint prevents further billable requests", async () => {
  const calls = [];
  await assert.rejects(
    runSpinePartGeneration({
      project: newSpineProject(),
      roles: ["body", "head"],
      shouldStop: () => false,
      onProgress: () => {},
      generate: async (role) => {
        calls.push(role);
        return { part: createSpinePart(role, png, 1, 1, role), opaque: false };
      },
      checkpoint: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.deepEqual(calls, ["body"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  compileSpineProject,
  newSpineProject,
  spinePartMesh,
  spineWorldPose,
  spineWorldVertices,
  validateSpineProject,
} from "../src/lib/spine.ts";

function moduleUrl(path, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(`from "${from}"`, `from "${to}"`);
  return `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`;
}
const layersUrl = moduleUrl("../src/lib/spineLayers.ts", {
  "./spine": new URL("../src/lib/spine.ts", import.meta.url).href,
});
const {
  parseSpineLayerManifest,
  proposeSpineLayerRoles,
  layerWorldPlacement,
  createSpineProjectFromLayers,
} = await import(layersUrl);
const {
  SPINE_COMFY_NODES,
  validateSpineComfyEndpoint,
  inspectSpineComfy,
  buildSpineComfyGraph,
  reduceSpineComfyHistory,
  submitSpineComfyJob,
  refreshSpineComfyJob,
} = await import(
  moduleUrl("../src/lib/spineComfy.ts", { "./spineLayers": layersUrl })
);
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const layer = (name, filename, left, top, right, bottom) => ({
  name,
  filename,
  left,
  top,
  right,
  bottom,
});
const manifest = {
  width: 1000,
  height: 800,
  layers: [
    layer("arm-l", "arm.png", 120, 180, 210, 490),
    layer("body", "body.png", 300, 300, 650, 650),
    layer("face", "head.png", 310, 60, 630, 340),
    layer("hairf", "hair.png", 270, 20, 660, 300),
  ],
};
function prepared() {
  const m = parseSpineLayerManifest(manifest),
    proposals = proposeSpineLayerRoles(m);
  return {
    sourceName: "fixture.json",
    manifest: m,
    layers: m.layers.map((entry, i) => ({
      entry,
      originalImage: png,
      image: png,
      imageWidth: 1,
      imageHeight: 1,
      included: true,
      ...proposals[i],
    })),
  };
}
test("layer setup preserves crop offsets, common scale, Y flip and draw order independently of bone order", () => {
  const p = createSpineProjectFromLayers(prepared(), "layers"),
    pose = spineWorldPose(p.parts);
  assert.deepEqual(
    p.parts.map((p) => p.name),
    ["arm-l", "body", "face", "hairf"],
  );
  assert.equal(p.parts[0].parent, p.parts[1].id);
  assert.equal(p.parts[3].parent, p.parts[2].id);
  for (const part of p.parts) {
    const src = part.layerSource,
      vertices = spineWorldVertices(part, pose, spinePartMesh(part)),
      xs = vertices.filter((_, i) => i % 2 === 0),
      ys = vertices.filter((_, i) => i % 2 === 1);
    for (const [actual, expected] of [
      [Math.min(...xs), (src.left - 500) * 0.48],
      [Math.max(...xs), (src.right - 500) * 0.48],
      [Math.min(...ys), (800 - src.bottom) * 0.48],
      [Math.max(...ys), (800 - src.top) * 0.48],
    ])
      assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
  }
  const compiled = compileSpineProject(p);
  assert.equal(compiled.slots[0].bone, p.parts[0].id);
  assert.equal(compiled.bones[1].name, p.parts[1].id);
  assert.equal(p.layerImport.worldScale, 0.48);
  assert.equal(p.parts[0].layerSource.originalImage, png);
  assert.equal(
    validateSpineProject(JSON.parse(JSON.stringify(p))).parts.length,
    4,
  );
  assert.equal(validateSpineProject(newSpineProject()).version, 1);
});
test("moving a pivot changes setup coordinates while retaining the same image rectangle", () => {
  const m = parseSpineLayerManifest(manifest),
    a = layerWorldPlacement(m, m.layers[0], 0, 0),
    b = layerWorldPlacement(m, m.layers[0], 1, 1);
  assert.ok(Math.abs(b.x - a.x - a.width) < 1e-9);
  assert.ok(Math.abs(b.y - a.y + a.height) < 1e-9);
});
test("manifest rejects invalid dimensions, paths, duplicate files, NaN depth and out of canvas layers", () => {
  const cases = [
    { ...manifest, width: 0 },
    { ...manifest, width: 8193 },
    { ...manifest, width: 8192, height: 8192 },
    { ...manifest, layers: [] },
    ...["../a.png", "/a.png", "C:/a.png", "a\\b.png", "a.svg"].map(
      (filename) => ({
        ...manifest,
        layers: [{ ...manifest.layers[0], filename }],
      }),
    ),
    {
      ...manifest,
      layers: [
        manifest.layers[0],
        { ...manifest.layers[0], filename: "ARM.PNG" },
      ],
    },
    { ...manifest, layers: [{ ...manifest.layers[0], right: 1001 }] },
    { ...manifest, layers: [{ ...manifest.layers[0], left: 1.5 }] },
    { ...manifest, layers: [{ ...manifest.layers[0], depth_median: NaN }] },
  ];
  for (const value of cases)
    assert.throws(() => parseSpineLayerManifest(value));
});
test("selection rejects parent cycles, excluded parents and more than 24 parts", () => {
  const p = prepared();
  p.layers[1].parentIndex = 0;
  assert.throws(() => createSpineProjectFromLayers(p, "cycle"), /cycle/);
  p.layers[1].parentIndex = null;
  p.layers[1].included = false;
  assert.throws(
    () => createSpineProjectFromLayers(p, "excluded"),
    /Parent layer/,
  );
  p.layers = p.layers.flatMap((l) =>
    Array.from({ length: 7 }, () => ({
      ...l,
      included: true,
      parentIndex: null,
    })),
  );
  assert.throws(() => createSpineProjectFromLayers(p, "too many"), /24/);
});
const id = "0123456789abcdef0123456789abcdef";
const config = {
  endpoint: "http://127.0.0.1:8188",
  layerModel: "layer.safetensors",
  depthModel: "depth.safetensors",
  resolution: 768,
  steps: 30,
  seed: 42,
  quant: "nf4",
  groupOffload: true,
};
const job = () => ({
  id,
  sourceName: "source.png",
  config,
  createdAt: 1,
  updatedAt: 1,
  state: "preparing",
});
const output = {
  width: 100,
  height: 100,
  layers: [layer("body", `levelup_spine_${id}_000.png`, 10, 20, 80, 90)],
};
const history = (
  status = { completed: true, status_str: "success" },
  manifest = output,
) => ({ receipt: { status, outputs: { 7: { levelup_spine: [manifest] } } } });
test("only local service endpoints and supported settings build a graph without model downloads", () => {
  for (const address of [
    "https://localhost:8188",
    "http://example.com",
    "http://127.0.0.1/foo",
    "http://user@localhost",
    "http://127.0.0.1?x=1",
  ])
    assert.throws(() => validateSpineComfyEndpoint(address));
  assert.equal(
    validateSpineComfyEndpoint("http://[::1]:8188"),
    "http://[::1]:8188",
  );
  const graph = buildSpineComfyGraph(
    id,
    `levelup_spine_input_${id}.png`,
    config,
  );
  assert.equal(Object.keys(graph).length, 7);
  assert.equal(graph["2"].inputs.auto_download, false);
  assert.equal(graph["4"].inputs.auto_download, false);
  assert.equal(graph["6"].inputs.use_lama, false);
  for (const patch of [
    { resolution: 2048 },
    { seed: -1 },
    { steps: 0 },
    { quant: "bad" },
    { layerModel: "" },
  ])
    assert.throws(() =>
      buildSpineComfyGraph(id, "image", { ...config, ...patch }),
    );
});
test("node inspection detects incompatible model loader instead of assuming auto-download control", () => {
  const info = Object.fromEntries(
    SPINE_COMFY_NODES.map((name) => [
      name,
      {
        input: {
          required: { model: [["available"]] },
          optional: { auto_download: ["BOOLEAN"] },
        },
      },
    ]),
  );
  assert.deepEqual(inspectSpineComfy(info).missing, []);
  assert.deepEqual(inspectSpineComfy(info).layerModels, ["available"]);
  delete info.SeeThrough_LoadLayerDiffModel.input.optional.auto_download;
  assert.ok(
    inspectSpineComfy(info).missing.includes(
      "SeeThrough_LoadLayerDiffModel.auto_download",
    ),
  );
});
test("history maps running/error/completed states and refuses outputs from another job", () => {
  const running = { ...job(), state: "running", promptId: "receipt" };
  assert.equal(reduceSpineComfyHistory(running, {}).state, "running");
  assert.equal(reduceSpineComfyHistory(running, history()).state, "complete");
  assert.equal(
    reduceSpineComfyHistory(
      running,
      history({
        completed: false,
        status_str: "error",
        messages: [["execution_error", { exception_message: "out of memory" }]],
      }),
    ).error,
    "out of memory",
  );
  assert.throws(
    () =>
      reduceSpineComfyHistory(
        running,
        history(undefined, {
          ...output,
          layers: [{ ...output.layers[0], filename: "another.png" }],
        }),
      ),
    /another job/,
  );
  assert.throws(
    () =>
      reduceSpineComfyHistory(running, {
        receipt: { status: { completed: true }, outputs: {} },
      }),
    /manifest/,
  );
});
test("submission persists checkpoints before network effects and retains prompt receipt", async () => {
  const events = [];
  const result = await submitSpineComfyJob(
    job(),
    png,
    async (_endpoint, op, payload) => {
      events.push(op);
      if (op === "upload")
        return {
          name: `levelup_spine_input_${id}.png`,
          type: "input",
          subfolder: "",
        };
      assert.deepEqual(payload.config, config);
      assert.equal(payload.prompt, undefined);
      return { prompt_id: "receipt" };
    },
    async (j) => events.push(j.state),
  );
  assert.deepEqual(events, [
    "preparing",
    "upload",
    "submitting",
    "submit",
    "running",
  ]);
  assert.equal(result.promptId, "receipt");
});
test("failed initial checkpoint prevents any upload or submit", async () => {
  await assert.rejects(
    () =>
      submitSpineComfyJob(
        job(),
        png,
        async () => assert.fail("must not send"),
        async () => {
          throw Error("disk full");
        },
      ),
    /disk full/,
  );
});
test("lost submission response becomes uncertain and cannot be submitted again", async () => {
  const ops = [];
  const transport = async (_e, op) => {
    ops.push(op);
    if (op === "upload") return { name: `levelup_spine_input_${id}.png` };
    throw Error("connection lost");
  };
  const result = await submitSpineComfyJob(
    job(),
    png,
    transport,
    async () => {},
  );
  assert.equal(result.state, "uncertain");
  assert.deepEqual(ops, ["upload", "submit"]);
  await assert.rejects(
    () => submitSpineComfyJob(result, png, transport, async () => {}),
    /Only a new job/,
  );
});
test("bad upload receipt fails before prompt submission", async () => {
  const result = await submitSpineComfyJob(
    job(),
    png,
    async (_e, op) => {
      assert.equal(op, "upload");
      return { name: "other.png" };
    },
    async () => {},
  );
  assert.equal(result.state, "failed");
});
test("failed checkpoints before submission release the preparing state without sending inference", async () => {
  for (const failure of ["preparing", "submitting"]) {
    const events = [];
    const result = await submitSpineComfyJob(
      job(),
      png,
      async (_e, op) => {
        events.push(op);
        assert.equal(op, "upload");
        return { name: `levelup_spine_input_${id}.png` };
      },
      async (j) => {
        events.push(j.state);
        if (j.state === failure) throw Error("storage failure");
      },
    );
    assert.equal(result.state, "failed");
    assert.equal(events.at(-1), "failed");
    assert.equal(events.includes("submit"), false);
  }
});
test("completed output stays in memory if saving its checkpoint fails", async () => {
  let last;
  await assert.rejects(
    () =>
      refreshSpineComfyJob(
        { ...job(), state: "running", promptId: "receipt" },
        async () => history(),
        async (j) => {
          last = j;
          throw Error("storage failure");
        },
      ),
    /storage failure/,
  );
  assert.equal(last.state, "complete");
  assert.equal(last.manifest.layers[0].filename, output.layers[0].filename);
});
test("receipt is retained if persistence fails after successful submit", async () => {
  let fail = true;
  const saved = [];
  const result = await submitSpineComfyJob(
    job(),
    png,
    async (_e, op) =>
      op === "upload"
        ? { name: `levelup_spine_input_${id}.png` }
        : { prompt_id: "receipt" },
    async (j) => {
      saved.push(j);
      if (j.state === "running" && fail) {
        fail = false;
        throw Error("disk full");
      }
    },
  );
  assert.equal(result.promptId, "receipt");
  assert.equal(result.state, "running");
  assert.match(result.error, /disk full/);
  assert.equal(saved.at(-1).promptId, "receipt");
});
test("uncertain job recovers a receipt then reads only that history without re-upload or resubmit", async () => {
  const events = [];
  const result = await refreshSpineComfyJob(
    { ...job(), state: "uncertain" },
    async (_e, op, payload) => {
      events.push(op);
      if (op === "recover") {
        assert.equal(payload.jobId, id);
        return { promptId: "receipt" };
      }
      assert.equal(op, "history");
      assert.equal(payload.promptId, "receipt");
      return history();
    },
    async (j) => events.push(j.state),
  );
  assert.equal(result.state, "complete");
  assert.deepEqual(events, ["recover", "running", "history", "complete"]);
});
test("missing recovery receipt and temporary history failure never launch another job", async () => {
  await assert.rejects(
    () =>
      refreshSpineComfyJob(
        { ...job(), state: "uncertain" },
        async (_e, op) => {
          assert.equal(op, "recover");
          return { promptId: null };
        },
        async () => {},
      ),
    /No automatic resubmission/,
  );
  let last;
  await assert.rejects(
    () =>
      refreshSpineComfyJob(
        { ...job(), state: "running", promptId: "receipt" },
        async (_e, op) => {
          assert.equal(op, "history");
          throw Error("offline");
        },
        async (j) => {
          last = j;
        },
      ),
    /offline/,
  );
  assert.equal(last.promptId, "receipt");
  assert.equal(last.state, "running");
});

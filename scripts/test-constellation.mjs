import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/lib/constellation.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const studioSource = readFileSync(new URL("../src/components/ConstellationStudio.tsx", import.meta.url), "utf8");
const nodeSource = readFileSync(new URL("../src/components/ConstellationNodes.tsx", import.meta.url), "utf8");
const studioCss = readFileSync(new URL("../src/components/ConstellationStudio.css", import.meta.url), "utf8");
const mediaSource = readFileSync(new URL("../src/components/MediaStudio.tsx", import.meta.url), "utf8");
const canvasSource = readFileSync(new URL("../src/components/ConstellationCanvasEditor.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "constellation.ts",
}).outputText;
const constellation = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("typed ports reject incompatible, duplicate, and cyclic connections", () => {
  const prompt = constellation.createConstellationNode("prompt", { x: 0, y: 0 });
  const image = constellation.createConstellationNode("image", { x: 300, y: 0 });
  const canvas = constellation.createConstellationNode("canvas", { x: 600, y: 0 });
  const valid = constellation.validateConstellationConnection([prompt, image, canvas], [], {
    source: prompt.id,
    sourceHandle: "text",
    target: image.id,
    targetHandle: "prompt",
  });
  assert.equal(valid.valid, true);
  const edge = constellation.createConstellationEdge(prompt.id, "text", image.id, "prompt", "text");
  assert.equal(constellation.validateConstellationConnection([prompt, image, canvas], [edge], {
    source: prompt.id,
    sourceHandle: "text",
    target: image.id,
    targetHandle: "prompt",
  }).valid, false);
  assert.equal(constellation.validateConstellationConnection([prompt, image, canvas], [edge], {
    source: image.id,
    sourceHandle: "image",
    target: canvas.id,
    targetHandle: "image",
  }).valid, true);
  const second = constellation.createConstellationEdge(image.id, "image", canvas.id, "image", "image");
  assert.equal(constellation.validateConstellationConnection([prompt, image, canvas], [edge, second], {
    source: canvas.id,
    sourceHandle: "image",
    target: image.id,
    targetHandle: "image",
  }).valid, false);
  assert.equal(constellation.validateConstellationConnection([prompt, image], [], {
    source: prompt.id,
    sourceHandle: "text",
    target: image.id,
    targetHandle: "image",
  }).valid, false);
});

test("selected nodes round-trip as a portable blueprint with only internal edges", () => {
  const graph = constellation.createDefaultConstellationGraph();
  graph.nodes[0].selected = true;
  graph.nodes[1].selected = true;
  graph.nodes[1].data.outputs = {
    image: { type: "image", createdAt: Date.now(), asset: { id: "private-result" } },
  };
  graph.nodes[1].data.references = [{ id: "private-reference", name: "secret.png", mimeType: "image/png", sizeBytes: 1, kind: "image" }];

  const blueprint = constellation.createConstellationBlueprint(
    "Reusable pair",
    "Prompt to image",
    ["image", "image", "starter"],
    graph.nodes.filter((node) => node.selected),
    graph.edges,
  );

  assert.equal(blueprint.nodes.length, 2);
  assert.equal(blueprint.edges.length, 1);
  assert.deepEqual(blueprint.tags, ["image", "starter"]);
  assert.equal(blueprint.nodes.some((node) => node.data.outputs), false);
  assert.equal(blueprint.nodes.some((node) => node.data.references), false);

  const instance = constellation.instantiateConstellationBlueprint(blueprint, { x: 900, y: 500 });
  assert.equal(instance.nodes.length, 2);
  assert.equal(instance.edges.length, 1);
  assert.equal(instance.nodes.every((node) => node.selected), true);
  assert.equal(instance.nodes.some((node) => blueprint.nodes.some((saved) => saved.id === node.id)), false);
  assert.equal(instance.edges[0].source, instance.nodes[0].id);
  assert.equal(instance.edges[0].target, instance.nodes[1].id);
});

test("execution layers include dependencies in deterministic DAG waves", () => {
  const graph = constellation.createDefaultConstellationGraph();
  const closure = constellation.constellationDependencyClosure([graph.nodes[2].id], graph.edges);
  assert.deepEqual([...closure].sort(), graph.nodes.map((node) => node.id).sort());
  const layers = constellation.constellationExecutionLayers(graph.nodes, graph.edges, closure);
  assert.deepEqual(layers.map((layer) => layer.map((node) => node.data.kind)), [["prompt"], ["image"], ["output"]]);
});

test("all built-in blueprints use valid typed, acyclic connections", () => {
  for (const blueprint of constellation.BUILT_IN_CONSTELLATION_BLUEPRINTS) {
    const accepted = [];
    for (const edge of blueprint.edges) {
      const validation = constellation.validateConstellationConnection(blueprint.nodes, accepted, edge);
      assert.equal(validation.valid, true, `${blueprint.name}: ${validation.reason ?? "invalid edge"}`);
      accepted.push(edge);
    }
    assert.doesNotThrow(() => constellation.constellationExecutionLayers(blueprint.nodes, blueprint.edges));
  }
});

test("defensive graph import repairs IDs and drops dangling, incompatible, duplicate, and cyclic edges", () => {
  const graph = constellation.createDefaultConstellationGraph();
  const raw = constellation.serializeConstellationGraph(graph);
  raw.nodes[0].data.status = "running";
  raw.nodes[0].data.error = "stale";
  raw.nodes.push(structuredClone(raw.nodes[0]));
  raw.edges.push({
    id: "dangling",
    source: "missing",
    sourceHandle: "text",
    target: raw.nodes[0].id,
    targetHandle: "prompt",
    data: { valueType: "text" },
  });
  raw.edges.push({
    id: "incompatible",
    source: raw.nodes[0].id,
    sourceHandle: "text",
    target: raw.nodes[1].id,
    targetHandle: "image",
    data: { valueType: "text" },
  });
  raw.edges.push({ ...structuredClone(raw.edges[0]), id: "duplicate-connection" });
  const writingA = constellation.createConstellationNode("writing", { x: 0, y: 0 });
  const writingB = constellation.createConstellationNode("writing", { x: 100, y: 0 });
  raw.nodes.push(writingA, writingB);
  raw.edges.push(constellation.createConstellationEdge(writingA.id, "text", writingB.id, "context", "text"));
  raw.edges.push(constellation.createConstellationEdge(writingB.id, "text", writingA.id, "context", "text"));
  const restored = constellation.normalizeConstellationGraph(raw);

  assert.ok(restored);
  assert.equal(restored.nodes[0].data.status, "idle");
  assert.equal(restored.nodes[0].data.error, undefined);
  assert.equal(new Set(restored.nodes.map((node) => node.id)).size, restored.nodes.length);
  assert.equal(restored.edges.some((edge) => edge.id === "dangling"), false);
  assert.equal(restored.edges.some((edge) => edge.id === "incompatible"), false);
  assert.equal(restored.edges.some((edge) => edge.id === "duplicate-connection"), false);
  assert.doesNotThrow(() => constellation.constellationExecutionLayers(restored.nodes, restored.edges));
});

test("port hit targets stay separate from the visible port and preserve connection affordances", () => {
  const handleBlock = studioCss.match(/\.constellation-handle\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(handleBlock, /width:\s*10px\s*!important/);
  assert.match(handleBlock, /height:\s*10px\s*!important/);
  assert.doesNotMatch(handleBlock, /(?:width|height):\s*24px/);
  assert.match(studioCss, /\.constellation-handle::before[^\n]*inset:\s*-9px/);
  assert.match(studioCss, /\.constellation-handle::after[^\n]*width:\s*10px/);
  assert.match(nodeSource, /aria-label=.*labelEn/);
  assert.match(studioSource, /connectOnClick/);
  assert.match(studioSource, /connectionRadius=\{38\}/);
  assert.match(studioSource, /reconnectRadius=\{28\}/);
  assert.match(studioSource, /onReconnect=\{onReconnect\}/);
});

test("high-refresh-rate media and canvas gestures stay on the compositor during pointer moves", () => {
  assert.match(mediaSource, /dragFrameRef\.current\s*=\s*window\.requestAnimationFrame/);
  assert.match(mediaSource, /style\.transform\s*=\s*previewTransform/);
  const pointerMove = canvasSource.match(/const pointerMove\s*=.*?(?=\n\s*const pointerUp)/s)?.[0] ?? "";
  assert.match(pointerMove, /appendActiveStrokePoint/);
  assert.doesNotMatch(pointerMove, /setStrokes\s*\(/);
  assert.match(canvasSource, /window\.requestAnimationFrame/);
  assert.match(canvasSource, /style\.transform\s*=\s*canvasViewTransform/);
});

test("node dragging remains continuous instead of silently reintroducing grid snapping", () => {
  assert.doesNotMatch(studioSource, /snapToGrid/);
  assert.doesNotMatch(studioSource, /16px/);
});

test("compact side panels do not cover the fitted graph or remain keyboard-focusable while closed", () => {
  assert.match(studioSource, /new ResizeObserver/);
  assert.match(studioSource, /width <= 1_080/);
  assert.match(studioSource, /inert=\{!leftPanelOpen\}/);
  assert.match(studioSource, /inert=\{!rightPanelOpen\}/);
});

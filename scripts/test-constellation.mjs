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
const mediaCapabilitiesSource = readFileSync(new URL("../src/lib/mediaCapabilities.ts", import.meta.url), "utf8");
const canvasSource = readFileSync(new URL("../src/components/ConstellationCanvasEditor.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "constellation.ts",
}).outputText;
const constellation = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const mediaCapabilitiesCompiled = ts.transpileModule(mediaCapabilitiesSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "mediaCapabilities.ts",
}).outputText;
const mediaCapabilities = await import(`data:text/javascript;base64,${Buffer.from(mediaCapabilitiesCompiled).toString("base64")}`);

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

test("automatic connection resolution maps compatible ports without exposing port details", () => {
  const prompt = constellation.createConstellationNode("prompt", { x: 0, y: 0 });
  const image = constellation.createConstellationNode("image", { x: 300, y: 0 });
  const canvas = constellation.createConstellationNode("canvas", { x: 600, y: 0 });

  assert.deepEqual(
    constellation.resolveConstellationConnection([prompt, image], [], { source: prompt.id, target: image.id }),
    { valid: true, mappings: [{ sourceHandle: "text", targetHandle: "prompt", valueType: "text" }] },
  );

  const imageToCanvas = constellation.resolveConstellationConnection([image, canvas], [], {
    source: image.id,
    target: canvas.id,
  });
  assert.deepEqual(imageToCanvas, {
    valid: true,
    mappings: [{ sourceHandle: "image", targetHandle: "image", valueType: "image" }],
  });
});

test("automatic resolution complements existing mappings and preserves canvas mask semantics", () => {
  const canvas = constellation.createConstellationNode("canvas", { x: 0, y: 0 });
  const image = constellation.createConstellationNode("image", { x: 300, y: 0 });
  const imageEdge = constellation.createConstellationEdge(canvas.id, "image", image.id, "image", "image");
  const resolved = constellation.resolveConstellationConnection([canvas, image], [imageEdge], {
    source: canvas.id,
    target: image.id,
  });
  assert.deepEqual(resolved, {
    valid: true,
    mappings: [{ sourceHandle: "mask", targetHandle: "mask", valueType: "image" }],
  });

  const writing = constellation.createConstellationNode("writing", { x: 300, y: 0 });
  const firstText = constellation.createConstellationNode("prompt", { x: 0, y: 0 });
  const secondText = constellation.createConstellationNode("prompt", { x: 0, y: 100 });
  const firstEdge = constellation.createConstellationEdge(firstText.id, "text", writing.id, "prompt", "text");
  const second = constellation.resolveConstellationConnection([firstText, secondText, writing], [firstEdge], {
    source: secondText.id,
    target: writing.id,
  });
  assert.equal(second.valid, true);
  if (second.valid) assert.deepEqual(second.mappings, [{ sourceHandle: "text", targetHandle: "context", valueType: "text" }]);

  const repeated = constellation.resolveConstellationConnection([firstText, writing], [firstEdge], {
    source: firstText.id,
    target: writing.id,
  });
  assert.equal(repeated.valid, false);
});

test("automatic resolution rejects cycles and incompatible gestures", () => {
  const first = constellation.createConstellationNode("writing", { x: 0, y: 0 });
  const second = constellation.createConstellationNode("writing", { x: 300, y: 0 });
  const edge = constellation.createConstellationEdge(first.id, "text", second.id, "prompt", "text");
  const cycle = constellation.resolveConstellationConnection([first, second], [edge], {
    source: second.id,
    target: first.id,
  });
  assert.equal(cycle.valid, false);
  const prompt = constellation.createConstellationNode("prompt", { x: 0, y: 0 });
  const audio = constellation.createConstellationNode("audio", { x: 300, y: 0 });
  const incompatible = constellation.resolveConstellationConnection([prompt, audio], [], {
    source: prompt.id,
    target: audio.id,
    targetHandle: "missing",
  });
  assert.equal(incompatible.valid, false);
});

test("display groups retain exact mappings while exposing one universal edge", () => {
  const prompt = constellation.createConstellationNode("prompt", { x: 0, y: 0 });
  const writing = constellation.createConstellationNode("writing", { x: 300, y: 0 });
  const first = constellation.createConstellationEdge(prompt.id, "text", writing.id, "prompt", "text");
  const second = constellation.createConstellationEdge(prompt.id, "text", writing.id, "context", "text");
  const grouped = constellation.groupConstellationConnections([first, second]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sourceHandle, constellation.UNIVERSAL_OUTPUT_HANDLE);
  assert.equal(grouped[0].targetHandle, constellation.UNIVERSAL_INPUT_HANDLE);
  assert.deepEqual(constellation.constellationConnectionMembers([first, second], grouped[0].id), [first, second]);
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

test("ready values require usable text or completed media", () => {
  assert.equal(constellation.constellationValueReady(undefined), false);
  assert.equal(constellation.constellationValueReady({ type: "text", text: "   ", createdAt: 1 }), false);
  assert.equal(constellation.constellationValueReady({ type: "text", text: "ready", createdAt: 1 }), true);
  assert.equal(constellation.constellationValueReady({ type: "image", createdAt: 1, asset: { id: "queued", status: "queued" } }), false);
  assert.equal(constellation.constellationValueReady({ type: "image", createdAt: 1, asset: { id: "done", status: "completed" } }), true);
  assert.equal(constellation.constellationValueReady({ type: "image", createdAt: 1, attachment: { id: "local", name: "source.png", mimeType: "image/png", sizeBytes: 1, kind: "image" } }), true);
});

test("candidate output selection preserves an existing choice and waits on ambiguity", () => {
  const node = constellation.createConstellationNode("image", { x: 0, y: 0 });
  const first = { type: "image", createdAt: 1, asset: { id: "first", status: "completed" } };
  const second = { type: "image", createdAt: 2, asset: { id: "second", status: "completed" } };
  node.data.outputs = { image: second };
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [first, second] }), { image: second });
  node.data.outputs = {};
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [first, second] }), {});
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [first] }), { image: first });
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [{ ...first, asset: { id: "failed", status: "failed" } }] }), {});
});

test("stale propagation blocks candidate selection while retaining inspectable outputs", () => {
  const source = constellation.createConstellationNode("image", { x: 0, y: 0 });
  const downstream = constellation.createConstellationNode("output", { x: 300, y: 0 });
  const value = { type: "image", createdAt: 1, asset: { id: "saved", status: "completed" } };
  source.data.outputs = { image: value };
  source.data.outputCandidates = { image: [value] };
  assert.equal(constellation.constellationCandidateSelection(source.data, "image", 0), value);
  assert.equal(constellation.constellationCandidateSelection(source.data, "image", 1), undefined);
  const edge = constellation.createConstellationEdge(source.id, "image", downstream.id, "media", "image");
  const stale = constellation.staleConstellationNodes([source, downstream], [edge], [source.id]);
  assert.equal(stale.find((node) => node.id === source.id)?.data.outputCandidates?.image?.[0].asset?.id, "saved");
  assert.equal(stale.find((node) => node.id === downstream.id)?.data.status, "stale");
  assert.equal(constellation.constellationCandidateSelection(stale[0].data, "image", 0), undefined);
  assert.equal(constellation.constellationValueReady(stale.find((node) => node.id === source.id)?.data.outputCandidates?.image?.[0]), true);
});

test("candidate refresh retains the current choice even if other candidates fail", () => {
  const node = constellation.createConstellationNode("image", { x: 0, y: 0 });
  const selected = { type: "image", createdAt: 1, asset: { id: "selected", status: "completed" } };
  const pending = { type: "image", createdAt: 2, asset: { id: "pending", status: "queued" } };
  node.data.outputs = { image: selected };
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [selected, pending] }), { image: selected });
  const finished = { ...pending, asset: { ...pending.asset, status: "completed" } };
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [selected, finished] }), { image: selected });
  const failed = { ...pending, asset: { ...pending.asset, status: "failed" } };
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [selected, failed] }), { image: selected });
  node.data.outputs.image = finished;
  assert.deepEqual(constellation.constellationCandidateOutputs(node.data, { image: [selected, finished] }), { image: finished });
});

test("project refresh resolves stable node and port IDs without mutating retained snapshots", () => {
  const graph = constellation.createDefaultConstellationGraph();
  const value = { type: "text", text: "Version 1", createdAt: 1 };
  graph.nodes[0].data.status = "success";
  graph.nodes[0].data.outputs = { text: value };
  const record = { id: graph.id, title: "Source", payload: { graph }, createdAt: 1, updatedAt: 1 };
  const reference = { projectId: graph.id, nodeId: graph.nodes[0].id, outputHandle: "text", valueType: "text", capturedAt: 1 };
  const snapshot = constellation.constellationProjectReferenceValue([record], "destination", reference);
  assert.deepEqual(snapshot, value);
  assert.notEqual(snapshot, value);
  value.text = "Version 2";
  assert.equal(snapshot.text, "Version 1");
  assert.equal(constellation.constellationProjectReferenceValue([record], "destination", reference).text, "Version 2");
  assert.equal(constellation.constellationProjectReferenceValue([], "destination", reference), undefined);
  assert.equal(snapshot.text, "Version 1");
  assert.equal(constellation.constellationProjectReferenceValue([record], graph.id, reference), undefined);
  assert.equal(constellation.constellationProjectReferenceValue([record], "destination", { ...reference, outputHandle: "missing" }), undefined);
  assert.equal(constellation.constellationProjectReferenceValue([record], "destination", { ...reference, valueType: "image" }), undefined);
  graph.nodes[0].data.status = "stale";
  assert.equal(constellation.constellationProjectReferenceValue([record], "destination", reference), undefined);
});

test("selective reruns reuse ready ancestors and invalidate every affected included descendant", () => {
  const graph = constellation.createDefaultConstellationGraph();
  const [prompt, image, output] = graph.nodes;
  prompt.data = { ...prompt.data, status: "success", outputs: { text: { type: "text", text: "ready", createdAt: 1 } } };
  const value = { type: "image", createdAt: 1, asset: { id: "saved", status: "completed" } };
  image.data = { ...image.data, status: "success", outputs: { image: value } };
  output.data = { ...output.data, status: "success", outputs: { media: value } };
  assert.deepEqual([...constellation.constellationRunPlan(graph.nodes, graph.edges).execute], []);
  assert.deepEqual([...constellation.constellationRunPlan(graph.nodes, graph.edges, [output.id]).execute], [output.id]);
  assert.deepEqual([...constellation.constellationRunPlan(graph.nodes, graph.edges, [image.id]).execute], [image.id]);
  prompt.data.status = "stale";
  assert.deepEqual([...constellation.constellationRunPlan(graph.nodes, graph.edges, [output.id]).execute].sort(), graph.nodes.map(node => node.id).sort());
  prompt.data.status = "success";
  image.data.outputs = { image: { ...value, asset: { ...value.asset, status: "queued" } } };
  assert.deepEqual([...constellation.constellationRunPlan(graph.nodes, graph.edges, [output.id]).execute].sort(), [image.id, output.id].sort());
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
  assert.doesNotMatch(studioSource, /\bsnapToGrid(?:\s|=)/);
  assert.doesNotMatch(studioSource, /16px/);
});

test("compact side panels do not cover the fitted graph or remain keyboard-focusable while closed", () => {
  assert.match(studioSource, /new ResizeObserver/);
  assert.match(studioSource, /width <= 1_080/);
  assert.match(studioSource, /inert=\{!leftPanelOpen\}/);
  assert.match(studioSource, /inert=\{!rightPanelOpen\}/);
});

test("constellation topbar keeps the action group on the first row before the mobile collapse", () => {
  const mediumTopbar = studioCss.match(/@container \(max-width: 1080px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(mediumTopbar, /\.constellation-topbar \{ grid-template-columns: minmax\(148px, \.78fr\) minmax\(0, \.92fr\) auto minmax\(250px, 1fr\);/);
  assert.doesNotMatch(mediumTopbar, /\.constellation-mode-switch \{ display: none; \}/);
  const compactTopbar = studioCss.match(/@container \(max-width: 760px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(compactTopbar, /\.constellation-studio \.constellation-mode-switch \{ display: none; \}/);
});

test("constellation canvas toolbar stays on one row and scrolls instead of wrapping", () => {
  const toolbarBlock = studioCss.match(/\.constellation-canvas-toolbar \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(toolbarBlock, /flex-wrap:\s*nowrap;/);
  assert.match(toolbarBlock, /overflow-x:\s*auto;/);
  assert.match(toolbarBlock, /scrollbar-width:\s*none;/);
  assert.match(studioCss, /\.constellation-canvas-toolbar > button \{[\s\S]*?flex:\s*0 0 29px;/);
  const compactCanvas = studioCss.match(/@container \(max-width: 460px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(compactCanvas, /\.constellation-canvas-toolbar \{[\s\S]*?overflow-x:\s*auto;/);
});

test("image editing exposes an explicit history source and reusable output preview", () => {
  assert.match(studioSource, /listMediaAssets\("image", 100, 0\)/);
  assert.match(studioSource, /ConstellationImageSourcePicker/);
  assert.match(studioSource, /MediaImagePreview/);
  assert.match(studioSource, /exportMediaAsset\(value\.asset\)/);
  assert.match(nodeSource, /openImageSourcePicker\(id, "image"\)/);
  assert.match(nodeSource, /constellation-preview-download/);
  assert.match(studioSource, /node\.data\.size && node\.data\.size !== "auto"/);
  assert.match(studioSource, /runtimeValuesRef\.current\.delete\(nodeId\)/);
  assert.match(studioSource, /mediaModelSupportsExplicitImageMask/);
});

test("creative-space image editing submits a distinct source and PNG mask", () => {
  assert.match(mediaSource, /STUDIO_IMAGE_MODES/);
  assert.match(mediaSource, /selectImageReferences/);
  assert.match(mediaSource, /ConstellationCanvasEditor/);
  assert.match(mediaSource, /maskAttachmentId: task\.editInput\?\.maskAttachmentId/);
  assert.match(mediaSource, /task\.editInput\?\.referenceAttachmentIds \?\? \[\]/);
  assert.match(mediaSource, /editSourceImageNumber: task\.editInput\?\.editSourceImageNumber/);
  assert.match(mediaSource, /source=\{activeImageEditEntry\.originalSource \?\? activeImageEditEntry\.source\}/);
  assert.match(mediaSource, /initialState=\{activeImageEditEntry\.meta\?\.editorState\}/);
  assert.match(mediaSource, /size !== "auto" \? size : undefined/);
  assert.match(mediaSource, /onEdit=.*editImageAsset/);
  assert.match(mediaSource, /media-image-lightbox-edit/);
  assert.match(mediaSource, /mediaModelSupportsExplicitImageMask/);
  assert.match(canvasSource, /expanded: padding > 0/);
});

test("explicit PNG masks avoid native Gemini and Grok image routes", () => {
  const compatible = (id, protocol) => mediaCapabilities.mediaModelSupportsExplicitImageMask({ id, protocol });
  assert.equal(compatible("gemini-3-pro-image", "gemini_generate_content"), false);
  assert.equal(compatible("grok-imagine-edit", "openai_chat"), false);
  assert.equal(compatible("models/grok-imagine-image-quality", "openai_responses"), false);
  assert.equal(compatible("gpt-image-1", "openai_responses"), true);
});

test("Space panning is isolated from editable node controls", () => {
  assert.match(studioSource, /panActivationKeyCode=\{null\}/);
  assert.match(studioSource, /panOnDrag=\{spacePanActive \? true : \[1, 2\]\}/);
  assert.match(studioSource, /onFocusCapture=\{\(event\) =>/);
  assert.match(studioSource, /event\.code === "Space"/);
  assert.match(studioSource, /className="constellation-title-input nodrag nopan"/);
  assert.match(studioSource, /window\.addEventListener\("blur", resetSpacePan\)/);
  assert.match(studioSource, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("saved card heights never freeze content measurement after reopen or collapse", () => {
  const graph = constellation.createDefaultConstellationGraph();
  for (const height of [undefined, 0, 300]) {
    graph.nodes[0].height = height;
    graph.nodes[0].measured = { width: 292, height: 238 };
    const saved = constellation.serializeConstellationGraph(graph);
    assert.equal(saved.nodes[0].height, undefined);
    saved.nodes[0].height = height;
    const reopened = constellation.normalizeConstellationGraph(saved);
    assert.ok(reopened);
    assert.equal(reopened.nodes[0].height, undefined);
    assert.equal(reopened.nodes[0].data.prompt, graph.nodes[0].data.prompt);
  }
});

test("session and tool nodes expose executable context and reusable templates", () => {
  const session = constellation.createConstellationNode("conversation", { x: 0, y: 0 });
  assert.deepEqual(constellation.CONSTELLATION_NODE_DEFINITIONS.conversation.inputs.map((port) => port.id), ["context", "command"]);
  assert.equal(session.data.sessionContextMode, "upstream");
  const legacy = constellation.normalizeConstellationGraph({ nodes: [{ ...session, data: { kind: "localTool", title: "旧工具", status: "idle", toolName: "read_file", toolArguments: "{}" } }], edges: [] });
  assert.ok(legacy);
  assert.equal(legacy.nodes[0].data.toolTemplate?.id, "builtin-run-script");
  assert.equal(legacy.nodes[0].data.legacyToolName, "read_file");
  assert.equal(constellation.normalizeConstellationGraph(legacy).nodes[0].data.legacyToolName, "read_file");
  assert.equal(constellation.renderConstellationTemplate("run {{field:name}} {{input}} {{json}}", { name: "demo" }, "upstream"), "run demo upstream {\"name\":\"demo\"}");
});

test("tool templates expose schema ports and output source metadata", () => {
  const tool = constellation.createConstellationNode("localTool", { x: 0, y: 0 });
  tool.data.toolTemplate = {
    ...tool.data.toolTemplate,
    inputSchema: [{ id: "prompt", name: "Prompt", type: "text", required: true }],
    outputSchema: [{ id: "summary", name: "Summary", type: "text", source: "{{json:summary}}" }],
  };
  assert.deepEqual(constellation.constellationNodePorts(tool, "input").map((port) => port.id), ["prompt"]);
  assert.deepEqual(constellation.constellationNodePorts(tool, "output").map((port) => port.id), ["text", "summary"]);
  const source = constellation.createConstellationNode("input", { x: 0, y: 0 });
  const resolution = constellation.resolveConstellationConnection([source, tool], [], { source: source.id, target: tool.id });
  assert.equal(resolution.valid, true);
  assert.equal(resolution.valid && resolution.mappings[0].targetHandle, "prompt");
});

const storageSource = readFileSync(new URL("../src/lib/constellationStorage.ts", import.meta.url), "utf8");
const storageModule = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(storageSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);
test("empty projects reopen and retain their independent identity", () => {
  const graph = constellation.createDefaultConstellationGraph(); graph.nodes = []; graph.edges = [];
  assert.equal(constellation.normalizeConstellationGraph(graph).id, graph.id);
  assert.deepEqual(constellation.normalizeConstellationGraph(graph).nodes, []);
});
test("browser project storage serializes writes, preserves createdAt, and retains over 100 projects", async () => {
  const memory = new Map(); const adapter = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const store = storageModule.createConstellationBrowserStore(() => adapter);
  const record = index => ({ id: `p-${index}`, title: `Project ${index}`, payload: { graph: { nodes: [], edges: [] } }, createdAt: 10, updatedAt: 20 });
  await Promise.all(Array.from({ length: 105 }, (_, index) => store.save(record(index))));
  await Promise.all([store.save({ ...record(0), createdAt: 15, updatedAt: 30, title: "  Changed  " }), store.remove("p-1")]);
  const reopened = storageModule.createConstellationBrowserStore(() => adapter);
  const list = await reopened.list(); assert.equal(list.length, 104);
  assert.equal(list[0].createdAt, 10); assert.equal(list[0].title, "Changed");
  await Promise.all(list.map(item => reopened.remove(item.id))); assert.deepEqual(await store.list(), []);
});
test("corrupt storage and quota failures cannot silently discard projects; retries recover", async () => {
  let raw = "invalid json"; let fail = false;
  const store = storageModule.createConstellationBrowserStore(() => ({ getItem: () => raw, setItem: (_key, value) => { if (fail) throw new Error("quota"); raw = value; } }));
  const record = { id: "p", title: "😀".repeat(200), payload: {}, createdAt: 0, updatedAt: 1 };
  await assert.rejects(store.list()); await assert.rejects(store.save(record)); assert.equal(raw, "invalid json");
  raw = "[]"; fail = true; await assert.rejects(store.save(record), /quota/); assert.equal(raw, "[]");
  fail = false; await store.save(record); assert.equal((await store.list()).length, 1);
  for (const patch of [{ id: "../invalid" }, { title: "x".repeat(201) }, { createdAt: -1 }, { updatedAt: 0.5 }, { payload: [] }]) {
    assert.throws(() => store.save({ ...record, ...patch }));
  }
});

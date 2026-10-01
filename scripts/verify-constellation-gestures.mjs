import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compiled = ts.transpileModule(await readFile(new URL("../src/lib/constellation.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createConstellationNode, createDefaultConstellationGraph } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : "playwright");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
const output = resolve("artifacts/constellation-gestures");
await mkdir(output, { recursive: true });
page.on("pageerror", (error) => errors.push(error.message));

async function moveBurst(type, point, target, rounds = 45) {
  return page.evaluate(async ({ type, point, target, rounds }) => {
    const path = document.querySelector(".react-flow__connection-path");
    const marquee = document.querySelector(".constellation-marquee");
    let paints = 0;
    const observer = new MutationObserver((records) => { paints += records.length; });
    observer.observe(type === "mousemove" ? path : marquee, { attributes: true });
    const intervals = [];
    let last = performance.now();
    for (let round = 0; round < rounds; round++) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      for (let index = 0; index < 24; index++) {
        const fraction = ((round * 24 + index) % 120) / 119;
        const init = { bubbles: true, buttons: 1, clientX: point.x + (target.x - point.x) * fraction, clientY: point.y + (target.y - point.y) * fraction };
        if (type === "mousemove") document.dispatchEvent(new MouseEvent(type, init));
        else document.querySelector(".constellation-canvas-shell").dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true }));
      }
    }
    await new Promise(requestAnimationFrame);
    observer.disconnect();
    const sorted = intervals.slice(2).sort((a, b) => a - b);
    return { events: rounds * 24, paints, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: Math.max(...sorted) };
  }, { type, point, target, rounds });
}

async function center(locator) {
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(from, to, steps = 1) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function enterStudio() {
  await page.locator(".media-nav-button").click();
  await page.locator(".media-studio").getByRole("tab", { name: /星图|Constellation/ }).click();
}

async function verifyCommitAndSelection() {
  const graph = createDefaultConstellationGraph();
  graph.title = "Gesture regression";
  graph.nodes = [
    createConstellationNode("prompt", { x: 100, y: 130 }),
    createConstellationNode("writing", { x: 620, y: 130 }),
    createConstellationNode("writing", { x: 620, y: 500 }),
    createConstellationNode("writing", { x: 100, y: 500 }),
  ];
  graph.edges = [];
  const record = { id: graph.id, title: graph.title, createdAt: graph.createdAt, updatedAt: graph.updatedAt,
    payload: { schemaVersion: 1, graph, viewport: { x: 0, y: 0, zoom: 1 }, overviewLayoutVersion: 2, overviewPosition: { x: 100, y: 100 } } };
  await page.getByRole("button", { name: /总览|Overview/, exact: true }).click();
  await page.evaluate((record) => localStorage.setItem("levelup-agent.constellation-projects.v1", JSON.stringify([record])), record);
  await page.reload();
  await enterStudio();
  const project = page.locator(".constellation-project-open").filter({ hasText: graph.title });
  await project.click();
  const shell = page.locator(".constellation-canvas-shell");
  const node = (index) => shell.locator(`.react-flow__node[data-id="${graph.nodes[index].id}"]`);
  const edgeCount = () => shell.locator(".react-flow__edge").count();
  const handle = (index, direction) => node(index).locator(`.constellation-universal-${direction}`);
  await node(2).waitFor();

  await drag(await center(handle(0, "output")), await center(handle(1, "input")));
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 1);
  await drag(await center(handle(2, "input")), await center(handle(0, "output")));
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
  await drag(await center(handle(0, "output")), await center(handle(1, "input")));
  assert.equal(await edgeCount(), 2, "repeated connection must not duplicate edges");

  const source = await center(handle(0, "output"));
  await drag(source, { x: source.x + 80, y: source.y + 330 });
  await page.waitForTimeout(40);
  assert.equal(await edgeCount(), 2, "dropping on empty canvas must cancel");
  assert.equal(await shell.locator(".react-flow__connectionline").count(), 0);

  // Each partial rectangle selects only its intended node; Shift adds to the first.
  for (const index of [0, 1]) {
    const box = await node(index).boundingBox();
    const from = { x: box.x - 26, y: box.y - 24 };
    const to = { x: box.x + 55, y: box.y + 65 };
    if (index === 1) await page.keyboard.down("Shift");
    await drag(from, to, 5);
    if (index === 1) await page.keyboard.up("Shift");
    assert.equal(await shell.locator(".react-flow__node.selected").count(), index + 1);
  }
  const before = await Promise.all([node(0).boundingBox(), node(1).boundingBox()]);
  const grip = await center(node(0).locator(".constellation-node-icon").first());
  await drag(grip, { x: grip.x + 60, y: grip.y + 45 }, 8);
  const after = await Promise.all([node(0).boundingBox(), node(1).boundingBox()]);
  const delta = { x: after[0].x - before[0].x, y: after[0].y - before[0].y };
  assert.ok(delta.x > 40 && delta.y > 30, JSON.stringify({ before, after }));
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.abs(after[index].x - before[index].x - delta.x) < 2, JSON.stringify({ index, before, after }));
    assert.ok(Math.abs(after[index].y - before[index].y - delta.y) < 2, JSON.stringify({ index, before, after }));
  }

  // Existing saved edges must remain reconnectable beneath the visible handle.
  const edge = shell.locator(`.react-flow__edge[aria-label="Edge from ${graph.nodes[0].id} to ${graph.nodes[1].id}"]`);
  const updater = edge.locator(".react-flow__edgeupdater-target");
  const updaterPoint = await center(updater);
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("react-flow__edgeupdater-target"), updaterPoint), true);
  await drag(updaterPoint, await center(handle(3, "input")), 8);
  assert.equal(await edgeCount(), 2);

  await page.screenshot({ path: resolve(output, "committed-edges.png") });
  const inputBox = await handle(3, "input").boundingBox();
  await page.screenshot({ path: resolve(output, "handle-detail.png"), clip: { x: inputBox.x - 24, y: inputBox.y - 16, width: 110, height: 64 }, scale: "css" });

  await page.getByRole("button", { name: /总览|Overview/, exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("levelup-agent.constellation-projects.v1"))[0]);
  assert.equal(saved.payload.graph.edges.length, 2);
  assert.ok(saved.payload.graph.edges.some((edge) => edge.source === graph.nodes[0].id && edge.target === graph.nodes[3].id), "reconnect must update the target");
  await project.click();
  await node(1).waitFor();
  const reopenSource = await center(handle(0, "output"));
  await page.mouse.move(reopenSource.x, reopenSource.y);
  await page.mouse.down();
  await page.mouse.move(reopenSource.x + 60, reopenSource.y + 80);
  const reopenTiming = await moveBurst("mousemove", { x: reopenSource.x + 20, y: reopenSource.y + 30 }, { x: reopenSource.x + 160, y: reopenSource.y + 150 });
  assert.ok(reopenTiming.paints > 0 && reopenTiming.paints <= 48, JSON.stringify(reopenTiming));
  await page.mouse.up();
  await page.setViewportSize({ width: 900, height: 700 });
  await shell.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: resolve(output, "narrow.png") });
  return { forward: true, reverse: true, duplicateRejected: true, canceled: true, additiveSelection: true, groupDrag: true, reconnect: true, persisted: true, reopenTiming };
}

try {
  await page.goto(process.env.LEVELUP_TEST_URL ?? "http://127.0.0.1:1420/");
  await enterStudio();
  const overview = page.locator(".constellation-overview");
  await overview.getByRole("button", { name: /新建项目|New project/ }).waitFor();
  await overview.getByRole("combobox", { name: /选择模板|Choose template/ }).selectOption("builtin-story-film");
  await overview.getByRole("button", { name: /从模板|From template/ }).click();

  const shell = page.locator(".constellation-canvas-shell");
  const nodes = shell.locator(".react-flow__node");
  await nodes.first().waitFor();
  assert.ok(await nodes.count() >= 3);
  assert.ok(await shell.locator(".react-flow__edge").count() >= 2);
  const layers = await shell.evaluate((element) => {
    const edges = element.querySelector(".react-flow__edges");
    const nodesLayer = element.querySelector(".react-flow__nodes");
    const line = element.querySelector(".react-flow__connectionline");
    return [getComputedStyle(edges).zIndex, getComputedStyle(nodesLayer).zIndex, line && getComputedStyle(line).zIndex];
  });
  assert.deepEqual(layers.slice(0, 2), ["0", "1"]);

  const first = await nodes.first().boundingBox();
  const canvas = await shell.boundingBox();
  assert.ok(first && canvas);
  const start = { x: Math.max(canvas.x + 15, first.x - 22), y: Math.max(canvas.y + 15, first.y - 22) };
  const target = { x: first.x + first.width * 0.6, y: first.y + first.height * 0.6 };
  assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane"), start));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 25 });
  const marquee = shell.locator(".constellation-marquee");
  assert.equal(await marquee.isVisible(), true);
  assert.ok((await marquee.boundingBox()).width > 20);
  const selectionTiming = await moveBurst("pointermove", start, target);
  assert.ok(selectionTiming.paints > 0 && selectionTiming.paints <= 45 * 3 + 6, JSON.stringify(selectionTiming));
  await page.mouse.move(target.x, target.y);
  await page.screenshot({ path: resolve(output, "selection.png") });
  await page.mouse.up();
  assert.equal(await marquee.isVisible(), false);
  assert.ok(await shell.locator(".react-flow__node.selected").count() >= 1);

  const sourceHandle = shell.locator(".constellation-universal-output").first();
  const handle = await sourceHandle.boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 180, handle.y + handle.height / 2 + 90, { steps: 30 });
  assert.equal(await shell.locator(".react-flow__connectionline").isVisible(), true);
  assert.equal(await shell.locator(".react-flow__connectionline").evaluate((element) => getComputedStyle(element).zIndex), "0");
  const connectionTiming = await moveBurst("mousemove", { x: handle.x + handle.width / 2 + 30, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 240, y: handle.y + handle.height / 2 + 100 });
  assert.ok(connectionTiming.paints > 0 && connectionTiming.paints <= 48, JSON.stringify(connectionTiming));
  await page.screenshot({ path: resolve(output, "connection.png") });
  await page.mouse.up();
  await page.waitForTimeout(40);
  assert.equal(await shell.locator(".react-flow__connectionline").count(), 0);
  await page.screenshot({ path: resolve(output, "endpoints.png") });

  await page.mouse.click(start.x, start.y);
  await nodes.first().locator(".constellation-node-header").click();
  const transform = await shell.locator(".react-flow__viewport").getAttribute("style");
  await page.keyboard.down("Space");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 70, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  assert.notEqual(await shell.locator(".react-flow__viewport").getAttribute("style"), transform);
  assert.equal(await marquee.isVisible(), false);

  const behavior = await verifyCommitAndSelection();
  assert.deepEqual(errors, []);
  const result = { layers, connectionTiming, selectionTiming, behavior, errors };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
}

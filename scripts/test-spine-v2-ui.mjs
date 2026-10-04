// Isolated UI verification. Local inference is simulated; no provider or GPU calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const require = createRequire(
  process.env.SPINE_PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const output = resolve(
  process.env.SPINE_UI_OUTPUT || "../research/spine-studio-v2-ui-validation",
);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SPINE_BROWSER_EXECUTABLE
    ? { executablePath: process.env.SPINE_BROWSER_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
const selectedProject = () =>
  page.evaluate(async () => {
    const s = await import("/src/lib/spineStorage.ts");
    return s.loadSpineProject(
      document.querySelector('select[aria-label="本地工程"]').value,
    );
  });
try {
  await page.goto(process.argv[2] || "http://127.0.0.1:1432");
  await button("打开创作空间").click();
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  await saved();
  const initial = await selectedProject();
  const fixture = await page.evaluate(() => {
    const layers = [
      {
        name: "body",
        filename: "body.png",
        left: 70,
        top: 90,
        right: 150,
        bottom: 250,
      },
      {
        name: "face",
        filename: "face.png",
        left: 55,
        top: 20,
        right: 165,
        bottom: 120,
      },
      {
        name: "arm-l",
        filename: "arm.png",
        left: 30,
        top: 95,
        right: 70,
        bottom: 235,
      },
    ];
    const images = layers.map((l, i) => {
      const c = document.createElement("canvas");
      c.width = l.right - l.left;
      c.height = l.bottom - l.top;
      const ctx = c.getContext("2d");
      ctx.fillStyle = ["#0284c7", "#f7c875", "#7dd3fc"][i];
      ctx.beginPath();
      ctx.roundRect(2, 2, c.width - 4, c.height - 4, 12);
      ctx.fill();
      if (i === 1) {
        ctx.fillStyle = "#123456";
        ctx.fillRect(30, 30, 9, 10);
        ctx.fillRect(70, 30, 9, 10);
      }
      return c.toDataURL("image/png");
    });
    return { manifest: { width: 200, height: 280, layers }, images };
  });
  const files = [
    {
      name: "layers.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture.manifest)),
    },
    ...fixture.manifest.layers.map((l, i) => ({
      name: l.filename,
      mimeType: "image/png",
      buffer: Buffer.from(fixture.images[i].split(",")[1], "base64"),
    })),
  ];
  for (const file of files) writeFileSync(join(output, file.name), file.buffer);
  await button("导入图层清单").click();
  await page.getByLabel("图层清单及 PNG", { exact: true }).setInputFiles(files);
  await page.getByRole("img", { name: "图层重组预览" }).waitFor();
  assert.equal(
    await page
      .locator(".spine-layer-composite svg image")
      .nth(1)
      .getAttribute("x"),
    "55",
  );
  await page
    .getByLabel("导入后的工程名称", { exact: true })
    .fill("V2 蓝色图层角色");
  // Reject a hierarchy cycle without damaging the current project.
  await page.getByLabel("body 父骨骼", { exact: true }).selectOption("1");
  await button("创建可编辑骨骼工程").click();
  await page.getByRole("alert").filter({ hasText: "cycle" }).waitFor();
  assert.equal((await selectedProject()).id, initial.id);
  await page.getByLabel("body 父骨骼", { exact: true }).selectOption("");
  await page.screenshot({ path: join(output, "layer-review.png") });
  for (const width of [720, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: join(output, `layer-review-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await button("创建可编辑骨骼工程").click();
  await saved();
  await page.waitForFunction(
    () => document.querySelectorAll(".spine-part").length === 3,
  );
  const imported = await selectedProject();
  assert.notEqual(imported.id, initial.id);
  assert.equal(imported.layerImport.canvasWidth, 200);
  assert.equal(imported.parts[1].layerSource.top, 20);
  assert.equal(imported.parts[1].parent, imported.parts[0].id);
  assert.ok(Math.abs(imported.parts[0].width - (80 * 480) / 280) < 1e-8);
  assert.equal(
    await page
      .locator(".spine-studio")
      .evaluate((e) =>
        getComputedStyle(e).getPropertyValue("--spine-accent").trim(),
      ),
    "#0284c7",
  );
  await page.screenshot({ path: join(output, "sky-blue-studio.png") });
  await page.reload();
  await button("打开创作空间").click();
  await saved();
  assert.equal((await selectedProject()).id, imported.id);
  const downloadEvent = page.waitForEvent("download");
  await button("导出 Spine").click();
  await (await downloadEvent).saveAs(join(output, "layers-spine.zip"));
  const zip = readFileSync(join(output, "layers-spine.zip")),
    entries = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18),
      nameLength = zip.readUInt16LE(offset + 26),
      extra = zip.readUInt16LE(offset + 28),
      name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    entries.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  const sourceManifest = JSON.parse(
    entries.get("sources/layers.json").toString(),
  );
  assert.equal(sourceManifest.layers[1].top, 20);
  assert.equal(
    entries.get(`sources/${imported.parts[1].id}.png`).toString("base64"),
    fixture.images[1].split(",")[1],
  );
  assert.ok(entries.has("skeleton.json"));
  assert.equal(
    JSON.parse(entries.get("project.levelup-spine.json")).parts[0].layerSource
      .originalImage,
    fixture.images[0],
  );
  // Exercise desktop-facing UI with a mock IPC transport. Rust has separate HTTP tests.
  const mock = async (jobId = null) =>
    page.evaluate(
      ({ fixture, jobId }) => {
        window.__spineMock = { operations: [], jobId };
        window.__TAURI_INTERNALS__ = {
          invoke: async (command, args) => {
            if (command !== "spine_comfy_request")
              throw Error(`Unexpected mock IPC: ${command}`);
            const { operation, payload } = args,
              m = window.__spineMock;
            m.operations.push(operation);
            if (operation === "info") {
              const c = [
                "LoadImage",
                "SeeThrough_LoadLayerDiffModel",
                "SeeThrough_LoadDepthModel",
                "SeeThrough_GenerateLayers",
                "SeeThrough_GenerateDepth",
                "SeeThrough_PostProcess",
                "LevelUpSpineExport",
              ];
              return Object.fromEntries(
                c.map((name) => [
                  name,
                  {
                    input: {
                      required: { model: [["fixture-model"]] },
                      optional: { auto_download: ["BOOLEAN"] },
                    },
                  },
                ]),
              );
            }
            if (operation === "upload") {
              m.jobId = payload.jobId;
              return {
                name: `levelup_spine_input_${payload.jobId}.png`,
                type: "input",
                subfolder: "",
              };
            }
            if (operation === "submit")
              throw Error("Simulated lost submission receipt");
            if (operation === "recover") {
              m.jobId = payload.jobId;
              return { promptId: "mock-receipt" };
            }
            if (operation === "history")
              return {
                "mock-receipt": {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    7: {
                      levelup_spine: [
                        {
                          ...fixture.manifest,
                          layers: fixture.manifest.layers.map((l, i) => ({
                            ...l,
                            filename: `levelup_spine_${m.jobId}_${String(i).padStart(3, "0")}.png`,
                          })),
                        },
                      ],
                    },
                  },
                },
              };
            if (operation === "image") {
              const index = Number(payload.filename.match(/_(\d{3})\.png$/)[1]);
              return { image: fixture.images[index] };
            }
            throw Error(`Unexpected mock operation: ${operation}`);
          },
        };
      },
      { fixture, jobId },
    );
  await mock();
  await button("本地 AI 拆层").click();
  await button("检查连接与模型").click();
  await page.getByText(/节点接口可用/).waitFor();
  await page.getByLabel("拆层原图", { exact: true }).setInputFiles(files[1]);
  await button("开始本地拆层").click();
  await page.getByText(/body.png · 提交状态待确认/).waitFor();
  const submitted = await page.evaluate(() => window.__spineMock);
  assert.deepEqual(submitted.operations, ["info", "upload", "submit"]);
  // Emulate an app crash at the submitting checkpoint, then recover through the visible UI.
  await page.evaluate(async () => {
    const s = await import("/src/lib/spineComfyStorage.ts");
    const jobs = await s.listSpineComfyJobs();
    await s.saveSpineComfyJob({
      ...jobs[0],
      state: "submitting",
      error: undefined,
    });
  });
  await page.reload();
  await button("打开创作空间").click();
  await mock(submitted.jobId);
  await button("本地 AI 拆层").click();
  await page.getByText(/body.png · 提交状态待确认/).waitFor();
  await button("找回提交回执").click();
  await page.getByText(/body.png · 拆层完成/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__spineMock.operations), [
    "recover",
    "history",
  ]);
  await page.screenshot({ path: join(output, "comfy-recovered-mock.png") });
  await button("检查图层并创建骨骼").click();
  await page.getByRole("img", { name: "图层重组预览" }).waitFor();
  await button("创建可编辑骨骼工程").click();
  await saved();
  assert.equal((await selectedProject()).parts.length, 3);
  assert.notEqual((await selectedProject()).id, imported.id);
  assert.deepEqual(await page.evaluate(() => window.__spineMock.operations), [
    "recover",
    "history",
    "image",
    "image",
    "image",
  ]);
  await page.evaluate(() => {
    delete window.__TAURI_INTERNALS__;
  });
  // Bad crop metadata must be refused before changing the current project.
  const before = (await selectedProject()).id;
  await button("导入图层清单").click();
  const invalid = structuredClone(fixture.manifest);
  invalid.layers[0].right++;
  await page
    .getByLabel("图层清单及 PNG", { exact: true })
    .setInputFiles([
      { ...files[0], buffer: Buffer.from(JSON.stringify(invalid)) },
      ...files.slice(1),
    ]);
  await page
    .getByRole("alert")
    .filter({ hasText: "Invalid PNG dimensions" })
    .waitFor();
  assert.equal((await selectedProject()).id, before);
  await button("关闭图层导入").click();
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    checks: [
      "sky blue palette",
      "composite crop geometry",
      "hierarchy cycle rejection",
      "new editable project",
      "autosave/reload",
      "original sources in ZIP",
      "720/1100px layer dialog",
      "mock ComfyUI submit loss",
      "submitting checkpoint recovery after reload",
      "per-job layer download and review",
      "invalid crop PNG rejected",
    ],
    inference: "mock only; no real GPU inference",
    pageErrors: errors,
  };
  writeFileSync(
    join(output, "v2-ui-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "v2-failure.png") });
  throw error;
} finally {
  await context.close();
  await browser.close();
}

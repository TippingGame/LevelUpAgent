// Isolated UI verification with a real local source image; no inference service is called.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const localPlaywright = new URL("../../research/spine-animation-2026-10-03/verification-v4/node_modules/playwright/package.json", import.meta.url);
const require = createRequire(process.env.SPINE_PLAYWRIGHT_PACKAGE || (existsSync(localPlaywright) ? localPlaywright : import.meta.url));
const { chromium } = require("playwright");
const output = resolve(process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v4");
const source = resolve(process.env.SPINE_SOURCE_IMAGE || "../杂项文件/Q版单人.png");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const executablePath = process.env.SPINE_BROWSER_EXECUTABLE || (process.platform === "win32" && existsSync(edge) ? edge : undefined);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
const project = () => page.evaluate(async () => {
  const storage = await import("/src/lib/spineStorage.ts");
  const id = document.querySelector('select[aria-label="本地工程"]')?.value;
  return id ? storage.loadSpineProject(id) : undefined;
});

try {
  await page.goto(process.argv[2] || "http://127.0.0.1:1432");
  await button("打开创作空间").click();
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  await saved();
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').first().setInputFiles(source);
  await page.locator(".spine-source-preview").waitFor();
  await saved();
  const uploaded = await project();
  assert.equal(uploaded.sourceImage.name, "Q版单人.png");
  assert.ok(uploaded.sourceImage.originalImage.startsWith("data:image/png;base64,"));
  assert.equal(uploaded.sourceImage.image, uploaded.sourceImage.originalImage);

  await button("去纯色背景").click();
  await saved();
  const cutout = await project();
  assert.notEqual(cutout.sourceImage.image, cutout.sourceImage.originalImage);
  const pixels = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = data;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0, visible = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] === 0) clear++;
      if (rgba[i] > 0) visible++;
    }
    return { clear, visible, width: canvas.width, height: canvas.height };
  }, cutout.sourceImage.image);
  assert.ok(pixels.clear > 0 && pixels.visible > 0);

  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').nth(1).setInputFiles(source);
  await page.waitForFunction(() => document.querySelectorAll(".spine-part").length > 0);
  await saved();
  const entries = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const assets = await import("/src/lib/spineAssets.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    const bytes = await assets.exportSpineArchive(await storage.loadSpineProject(id));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const names = [];
    for (let offset = 0; offset + 30 < bytes.length && view.getUint32(offset, true) === 0x04034b50;) {
      const length = view.getUint16(offset + 26, true);
      const extra = view.getUint16(offset + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length)));
      offset += 30 + length + extra + view.getUint32(offset + 18, true);
    }
    return names;
  });
  for (const name of ["skeleton.json", "project.levelup-spine.json", "sources/source.png", "sources/source-cutout.png"])
    assert.ok(entries.includes(name), `${name} missing from export`);

  await page.reload();
  await button("打开创作空间").click();
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  await saved();
  const restored = await project();
  assert.equal(restored.sourceImage.image, cutout.sourceImage.image);
  for (const width of [720, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true, `window ${width} overflows`);
    await page.screenshot({ path: join(output, `source-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  const result = { status: "passed", source, pixels, archiveEntries: entries, pageErrors: errors };
  writeFileSync(join(output, "v4-ui-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "v4-failure.png") });
  throw error;
} finally {
  await context.close();
  await browser.close();
}

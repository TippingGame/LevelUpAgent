// Isolated V3 UI verification. Local inference is simulated; no provider or GPU calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(
  process.env.SPINE_PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const output = resolve(
  process.env.SPINE_UI_OUTPUT || "../research/spine-animation-2026-10-03/verification-v3",
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
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
const selectedProject = () =>
  page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const id = document.querySelector('select[aria-label="本地工程"]')?.value;
    return id ? storage.loadSpineProject(id) : undefined;
  });
const openSpine = async () => {
  await button("打开创作空间").click();
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  await saved();
};

try {
  await page.goto(process.argv[2] || "http://127.0.0.1:1432");
  await openSpine();
  await button("体验机器人示例").click();
  await page.waitForFunction(() => document.querySelectorAll(".spine-part").length === 6);
  await saved();

  await button("姿态研究").click();
  await page.getByRole("dialog", { name: "多图关键姿态与插帧" }).waitFor();
  await page.getByRole("button", { name: /记录时间轴姿态/ }).click();
  await page.getByLabel("动画时间", { exact: true }).fill("1");
  await page.getByRole("button", { name: /记录时间轴姿态/ }).click();
  assert.equal(await page.locator(".spine-pose-card").count(), 2);

  const firstCard = page.locator(".spine-pose-card").first();
  const targetInputs = firstCard.locator('.spine-number input[type="number"]');
  await targetInputs.nth(0).fill("95");
  await targetInputs.nth(1).fill("12");
  await firstCard.getByRole("button", { name: "确认目标" }).click();
  assert.match(await firstCard.locator(".spine-pose-meta").innerText(), /applied|拟合/);

  const posePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByLabel("动画时间", { exact: true }).fill("1.5");
  await page
    .getByRole("dialog", { name: "多图关键姿态与插帧" })
    .locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({ name: "reference-pose.png", mimeType: "image/png", buffer: posePng });
  await page.locator(".spine-pose-card").nth(2).waitFor();
  assert.equal(await page.locator(".spine-pose-card img").count(), 1);

  const motionDialog = page.getByRole("dialog", { name: "多图关键姿态与插帧" });
  await motionDialog.locator("select").nth(1).selectOption("12");
  for (const width of [720, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      true,
      `window ${width} should not overflow`,
    );
    await page.screenshot({ path: join(output, `motion-study-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  const before = await selectedProject();
  const sourceClipId = before.clips.find((clip) => clip.name === "idle")?.id;
  assert.ok(sourceClipId);
  await button("插帧为新动作").click();
  await saved();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="多图关键姿态与插帧"]'));
  const afterNew = await selectedProject();
  assert.equal(afterNew.clips.length, before.clips.length + 1);
  const fitted = afterNew.clips.find((clip) => clip.id !== sourceClipId && clip.name.includes("fitted"));
  assert.ok(fitted);
  assert.ok(fitted.tracks[afterNew.parts[0].id].length >= 12);
  assert.ok(afterNew.motionStudies?.some((study) => study.clipId === sourceClipId && study.frames.length === 3));

  await page.reload();
  await openSpine();
  const restored = await selectedProject();
  assert.ok(restored.motionStudies?.some((study) => study.frames.some((frame) => frame.image)));
  await button("姿态研究").click();
  await page.getByRole("dialog", { name: "多图关键姿态与插帧" }).waitFor();
  await page.getByLabel("动画时间", { exact: true }).fill("0");
  await page.getByRole("button", { name: /记录时间轴姿态/ }).click();
  await page.getByLabel("动画时间", { exact: true }).fill("0.75");
  await page.getByRole("button", { name: /记录时间轴姿态/ }).click();
  await button("覆盖当前动作").click();
  await saved();
  const replaced = await selectedProject();
  assert.ok(replaced.clips.some((clip) => clip.id === fitted.id));
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    checks: [
      "timeline-time pose capture",
      "manual R/B target editing",
      "single-frame fit status",
      "pose image import and preview",
      "12 FPS interpolation",
      "new editable action",
      "replace current action",
      "motion study persistence after reload",
      "720/1100/1440px modal layouts",
    ],
    inference: "mock only; no real image model or GPU inference",
    pageErrors: errors,
  };
  writeFileSync(join(output, "v3-ui-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "v3-failure.png") });
  throw error;
} finally {
  await context.close();
  await browser.close();
}

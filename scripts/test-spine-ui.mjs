// Run against a local development server using a separate, disposable browser context.
// SPINE_PLAYWRIGHT_PACKAGE: absolute path to playwright/package.json (if not installed locally).
// SPINE_BROWSER_EXECUTABLE: optional Chromium/Edge executable.
// SPINE_UI_OUTPUT: optional directory for verification artifacts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const require = createRequire(
  process.env.SPINE_PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const output = resolve(
  process.env.SPINE_UI_OUTPUT || "../research/spine-studio-ui-validation",
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
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
const waitParts = (count) =>
  page.waitForFunction(
    (n) => document.querySelectorAll(".spine-part").length === n,
    count,
  );
const waitSaved = () =>
  page.getByText("已保存到本机", { exact: true }).waitFor();
try {
  await page.goto(process.argv[2] || "http://127.0.0.1:1432");
  await button("打开创作空间").click();
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  await button("体验机器人示例").click();
  await waitParts(6);
  await button("暂停").click();
  await page
    .getByLabel("当前动作", { exact: true })
    .selectOption({ label: "wave" });
  await page.getByLabel("动画时间", { exact: true }).fill("0.5");
  await button("arm-right 画面右臂 04").click();
  await page.getByLabel("旋转 °", { exact: true }).fill("95");
  await button("保存").click();
  await waitSaved();
  await page
    .getByRole("tab", { name: "图片 · 视频 · 语音", exact: true })
    .click();
  assert.equal(await page.locator(".spine-studio").isHidden(), true);
  await page.getByRole("tab", { name: "Spine", exact: true }).click();
  assert.equal(
    await page.getByLabel("旋转 °", { exact: true }).inputValue(),
    "95",
  );
  await page.reload();
  await button("打开创作空间").click();
  await page
    .getByLabel("当前动作", { exact: true })
    .selectOption({ label: "wave" });
  await page.getByLabel("动画时间", { exact: true }).fill("0.5");
  await button("arm-right 画面右臂 04").click();
  assert.equal(
    await page.getByLabel("旋转 °", { exact: true }).inputValue(),
    "95",
  );
  const snapshot = await page.evaluate(async () => {
    const storage = await import("/src/lib/spineStorage.ts");
    const projects = await storage.listSpineProjects();
    return storage.loadSpineProject(projects[0].id);
  });
  const importedPath = join(output, "orbit.levelup-spine.json");
  writeFileSync(importedPath, JSON.stringify(snapshot));
  const pngPath = join(output, "arm-right.png");
  writeFileSync(
    pngPath,
    Buffer.from(snapshot.parts[3].image.split(",")[1], "base64"),
  );
  const input = page.locator('input[type="file"][accept=".json"]');
  await input.setInputFiles(importedPath);
  await page.waitForFunction(
    (id) =>
      document.querySelector('select[aria-label="本地工程"]')?.value !== id,
    snapshot.id,
  );
  await waitSaved();
  const newId = await page.getByLabel("本地工程", { exact: true }).inputValue();
  assert.notEqual(
    newId,
    snapshot.id,
    "Import must create a copy, preserving the original project",
  );
  const malicious = JSON.parse(JSON.stringify(snapshot));
  malicious.parts[0].parent = malicious.parts[0].id;
  const invalidPath = join(output, "invalid-project.json");
  writeFileSync(invalidPath, JSON.stringify(malicious));
  await input.setInputFiles(invalidPath);
  await page.getByRole("alert").filter({ hasText: "cycle" }).waitFor();
  assert.equal(
    await page.getByLabel("本地工程", { exact: true }).inputValue(),
    newId,
  );
  await button("关闭提示").click();
  await page.locator('input[type="file"][multiple]').setInputFiles(pngPath);
  await waitParts(7);
  await button("删除部件（可撤销）").click();
  await waitParts(6);
  await button("撤销编辑").click();
  await waitParts(7);
  // Restore the original six-part project for the exported reference asset.
  await page.getByLabel("本地工程", { exact: true }).selectOption(snapshot.id);
  await waitParts(6);
  await page
    .getByLabel("当前动作", { exact: true })
    .selectOption({ label: "wave" });
  await page.getByLabel("动画时间", { exact: true }).fill("0.5");
  await button("arm-right 画面右臂 04").click();
  await button("显示选中网格").click();
  await page.screenshot({ path: join(output, "spine-studio.png") });
  const downloadEvent = page.waitForEvent("download");
  await button("导出 Spine").click();
  const download = await downloadEvent;
  await download.saveAs(join(output, "orbit-spine.zip"));
  await button("新会话").first().click();
  assert.equal(await page.locator(".spine-studio").count(), 1);
  assert.equal(await page.locator(".spine-studio").isHidden(), true);
  await button("打开创作空间").click();
  for (const width of [1100, 800, 720]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: join(output, `spine-studio-${width}.png`) });
    assert.equal(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
      true,
      `window ${width} should not overflow`,
    );
  }
  assert.deepEqual(errors, []);
  const result = {
    status: "passed",
    checks: [
      "demo",
      "weighted mesh WebGL preview",
      "keyframe edits",
      "autosave/reload",
      "workspace switching",
      "portable project import",
      "invalid hierarchy rejected",
      "PNG import",
      "delete/undo",
      "Spine ZIP export",
      "720/800/1100px layouts",
    ],
    pageErrors: errors,
  };
  writeFileSync(
    join(output, "ui-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  await browser.close();
}

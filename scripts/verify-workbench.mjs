import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.LEVELUP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LEVELUP_PLAYWRIGHT_MODULE).href : "playwright");
const url = process.env.LEVELUP_TEST_URL ?? "http://127.0.0.1:1430";
const output = resolve("artifacts/workbench-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
page.on("request", (request) => requests.push(request.url()));
const messages = Array.from({ length: 240 }, (_, index) => ({
  id: `message-${index}`, role: index % 2 ? "assistant" : "user",
  content: index % 2 ? `Verified result ${index}.\n\n\`\`\`ts\nconst result = ${index};\n\`\`\`` : `Review request ${index}`,
  createdAt: Date.now() - (240 - index) * 1000, attachments: [], toolCalls: [],
}));
const threads = [
  { id: "review-long", title: "Long conversation", messages, updatedAt: Date.now() },
  { id: "review-other", title: "Independent draft", messages: [{ ...messages[0], id: "unique-other", content: "searchable-history-token" }], updatedAt: 1 },
];
await page.addInitScript(({ threads }) => {
  if (localStorage.getItem("review-fixture")) return;
  localStorage.setItem("review-fixture", "1");
  localStorage.setItem("levelup-agent-locale", "en-US");
  localStorage.setItem("levelup-agent.threads.v1", JSON.stringify(threads));
  localStorage.setItem("levelup-agent.active-thread.v1", threads[0].id);
}, { threads });

async function switchTo(query) {
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Search conversations and commands" });
  await input.fill(query);
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor({ state: "hidden" });
}

async function resources() {
  return page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\.(js|css)(\?|$)/.test(entry.name))
    .map((entry) => ({ name: new URL(entry.name).pathname, bytes: entry.decodedBodySize })));
}

try {
  const started = performance.now();
  await page.goto(url);
  const composer = page.locator(".composer textarea");
  await composer.waitFor();
  await page.locator(".assistant-message-content").getByText("Verified result 239.", { exact: false }).waitFor();
  await page.locator(".assistant-message-content pre").last().waitFor();
  const initialMs = performance.now() - started;
  const initialUserMessages = await page.locator(".message.user").count();
  assert.equal(initialUserMessages, 20);
  assert.equal(await page.getByText("Review request 0", { exact: true }).count(), 0);
  assert.equal(requests.some((item) => /\/(MediaStudio|WritingStudio|ConstellationStudio)[.-]/.test(item)), false);
  const initialResources = await resources();
  await page.screenshot({ path: resolve(output, "desktop.png") });

  await composer.fill("Draft A survives switches");
  await switchTo("searchable-history-token");
  const editedText = threads[1].messages[0].content;
  await page.locator(".message.user .message-body").hover();
  await page.getByTitle("Edit this message", { exact: true }).click();
  assert.equal(await composer.inputValue(), editedText);
  await page.waitForFunction(() => document.activeElement === document.querySelector(".composer textarea"));
  assert.deepEqual(await composer.evaluate((element) => [element.selectionStart, element.selectionEnd]), [editedText.length, editedText.length]);
  await switchTo("Long conversation");
  assert.equal(await composer.inputValue(), "Draft A survives switches");
  await switchTo("Independent draft");
  assert.equal(await composer.inputValue(), "searchable-history-token");
  await composer.fill("Draft B survives restart");
  await switchTo("Long conversation");
  assert.equal(await composer.inputValue(), "Draft A survives switches");
  await page.reload();
  await composer.waitFor();
  await page.waitForFunction(() => document.querySelector(".composer textarea")?.value === "Draft A survives switches");
  await switchTo("Independent draft");
  assert.equal(await composer.inputValue(), "Draft B survives restart");
  await switchTo("Long conversation");

  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await earlier.click();
  await page.waitForFunction((count) => document.querySelectorAll(".message.user").length > count, initialUserMessages);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await palette.getByRole("combobox").fill("");
  await page.keyboard.press("ArrowDown");
  assert.equal(await palette.getByRole("option", { selected: true }).count(), 1);
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });

  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.keyboard.press("Control+k");
    await palette.waitFor();
    await palette.getByRole("combobox").fill("Independent draft");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const box = await palette.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
    await page.screenshot({ path: resolve(output, `palette-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await switchTo("Creative Studio");
  await page.locator(".media-studio").waitFor();
  assert.equal(await page.locator(".project-threads .thread-row").count(), 2);
  assert.equal(await page.locator(".media-studio .creation-mode-switch button").first().evaluate((element) => getComputedStyle(element).display), "flex");
  assert.ok(requests.some((item) => /MediaStudio/.test(item)));
  await page.screenshot({ path: resolve(output, "creative-studio.png") });
  const mediaPrompt = page.locator(".media-prompt-card textarea").first();
  await mediaPrompt.fill("Unsent media prompt survives workspace switches");
  await mediaPrompt.evaluate((element) => { element.dataset.qaRetained = "yes"; });
  await page.locator(".media-studio").getByRole("tab", { name: "Writing", exact: true }).click();
  const manuscript = page.locator(".manuscript-input-shell textarea");
  await manuscript.fill("Writing content survives workspace switches");
  await page.screenshot({ path: resolve(output, "writing-studio.png") });
  await page.locator(".writing-studio").getByRole("tab", { name: "Constellation", exact: true }).click();
  const constellation = page.locator(".constellation-studio");
  await constellation.waitFor();
  await constellation.getByRole("textbox", { name: "Constellation name" }).fill("Retained QA graph");
  await page.screenshot({ path: resolve(output, "constellation-studio.png") });
  await constellation.getByRole("tab", { name: "Writing", exact: true }).click();
  assert.equal(await manuscript.inputValue(), "Writing content survives workspace switches");
  await page.locator(".writing-studio").getByRole("tab", { name: "Image · Video · Speech", exact: true }).click();
  assert.equal(await mediaPrompt.inputValue(), "Unsent media prompt survives workspace switches");
  assert.equal(await mediaPrompt.getAttribute("data-qa-retained"), "yes");
  await page.locator(".media-studio").getByRole("tab", { name: "Constellation", exact: true }).click();
  assert.equal(await constellation.getByRole("textbox", { name: "Constellation name" }).inputValue(), "Retained QA graph");
  assert.ok(requests.some((item) => /WritingStudio/.test(item)));
  assert.ok(requests.some((item) => /ConstellationStudio/.test(item)));
  assert.deepEqual(errors, []);
  const result = { url, initialMs: Math.round(initialMs), initialUserMessages, passed: ["progressive history", "lazy workspaces", "history search", "edit targets the selected conversation and focuses the draft", "independent persistent drafts", "palette keyboard", "desktop and narrow layouts", "media/writing/constellation retain workspace state"], initialResources, resourcesAfterWorkspaces: await resources(), errors };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true });
  console.error({ errors, body: await page.locator("body").innerText() });
  throw error;
} finally {
  await browser.close();
}

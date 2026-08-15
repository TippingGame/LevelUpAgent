import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  THEME_GENERATION_BOOTSTRAP_MARKER,
  THEME_GENERATION_TARGET_MARKER,
  themeGenerationAttachmentIds,
  themeGenerationAttachments,
  themeGenerationBackgroundPrompt,
  themeGenerationBootstrap,
  themeGenerationPrompt,
  themeGenerationReadyForImport,
  themeGenerationThreadTitle,
} from "../src/lib/themeGeneration.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const rustSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

const request = {
  brief: "a calm blue theme",
  appearance: "dark",
  style: "glass",
  density: "compact",
  contrast: "high",
  corners: "rounded",
  accentColor: "#3366ff",
  surfaceStyle: "glass",
  controlStyle: "glow",
  messageStyle: "card",
  sidebarStyle: "gradient",
  composerStyle: "floating",
  decoration: "rich",
  backgroundMode: "css",
  backgroundArtStyle: "illustration",
  backgroundFit: "cover",
  backgroundFocus: "right",
  backgroundReadability: "strong",
  backgroundBrief: "quiet mountain skyline behind the conversation",
  references: [
    { id: "reference-one", name: "one.png", mimeType: "image/png", sizeBytes: 128, kind: "image" },
    { id: "reference-two", name: "two.webp", mimeType: "image/webp", sizeBytes: 256, kind: "image" },
  ],
};

const job = {
  threadId: "theme-thread",
  sourcePath: "C:/workspace/.levelup/generated-themes/theme.levelup-theme",
  phase: "running",
};

test("theme generation waits for Harness ownership before importing", () => {
  assert.equal(themeGenerationReadyForImport(
    { ...job, sourcePath: "", phase: "preparing" },
    { running: false, pendingApproval: false, ownsOperation: false },
  ), false);
  assert.equal(themeGenerationReadyForImport(
    { ...job, phase: "starting" },
    { running: false, pendingApproval: false, ownsOperation: false },
  ), false);
  assert.equal(themeGenerationReadyForImport(
    job,
    { running: true, pendingApproval: false, ownsOperation: true },
  ), false);
  assert.equal(themeGenerationReadyForImport(
    job,
    { running: false, pendingApproval: true, ownsOperation: true },
  ), false);
  assert.equal(themeGenerationReadyForImport(
    job,
    { running: false, pendingApproval: false, ownsOperation: false },
  ), true);
});

test("theme prompts use the application-owned bootstrap and write directly to the prepared target", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const prompt = themeGenerationPrompt(
      ".levelup/generated-themes/theme.levelup-theme",
      request,
      locale,
    );
    assert.doesNotMatch(prompt, /read_skill/);
    assert.match(prompt, /write_file/);
    assert.match(prompt, /\.levelup\/generated-themes\/theme\.levelup-theme/);
    assert.match(prompt, /"schemaVersion": 1/);
    for (const field of ["id", "name", "version", "author", "description", "css"]) {
      assert.match(prompt, new RegExp(`"${field}"`));
    }
    assert.match(prompt, locale === "zh-CN" ? /7 个字段全部必填/ : /All seven fields below are required/);
    assert.match(prompt, locale === "zh-CN" ? /绝不能在开始和结束双引号之间直接插入物理换行/ : /never place a physical line break/);
    assert.match(prompt, /\\n.*\\r.*\\t/s);
    assert.match(prompt, /http%3A\/\/www\.w3\.org\/2000\/svg/);
    assert.match(prompt, locale === "zh-CN" ? /不能出现字面量 http:/ : /literal http: or https:/);
    assert.match(prompt, /2 (?:张参考图|reference images)/);
    assert.match(prompt, locale === "zh-CN" ? /不得调用图片、视频或音频生成工具/ : /Do not call image, video, or audio generation tools/);
    assert.match(prompt, /#3366FF/);
    assert.match(prompt, locale === "zh-CN" ? /玻璃拟态/ : /style=glass/);
    assert.match(prompt, locale === "zh-CN" ? /界面密度=紧凑/ : /density=compact/);
    assert.match(prompt, locale === "zh-CN" ? /消息=卡片/ : /messages=card/);
    assert.match(prompt, locale === "zh-CN" ? /侧栏=渐变/ : /sidebar=gradient/);
    assert.match(prompt, /\.conversation-stage/);
    assert.match(prompt, /\.composer-wrap/);
    assert.match(prompt, /schemaVersion 1/);
    assert.match(prompt, locale === "zh-CN" ? /不重排 DOM/ : /DOM arrangement unchanged/);
    assert.doesNotMatch(prompt, /docs\/THEMES\.md|docs\/THEME_DEVELOPMENT\.md|docs\/THEME_AGENT_WORKFLOW\.md/);
  }
});

test("theme guidance is attached once and receives a dedicated conversation title", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const target = ".levelup/generated-themes/0123456789abcdef0123456789abcdef.levelup-theme";
    const bootstrap = themeGenerationBootstrap("# Packaged Skill\n\n# Layout reference", target, locale);
    assert.equal(bootstrap.split(THEME_GENERATION_BOOTSTRAP_MARKER).length - 1, 1);
    assert.ok(bootstrap.includes(`${THEME_GENERATION_TARGET_MARKER} ${target}`));
    assert.equal(bootstrap.match(/# Packaged Skill/g)?.length, 1);
    assert.match(bootstrap, locale === "zh-CN" ? /一次性加载/ : /exactly once/);
    assert.match(themeGenerationThreadTitle(request, locale), locale === "zh-CN" ? /^生成主题 · / : /^Generate theme · /);
  }
});

test("theme generation creates and activates a fresh temporary-workspace conversation", () => {
  const start = appSource.indexOf("  const generateTheme = async");
  const end = appSource.indexOf("\n  useEffect(() => {", start);
  const source = appSource.slice(start, end);
  assert.match(source, /const workspace = defaultWorkspace\?\.trim\(\)/);
  assert.match(source, /const created = createThread\(workspace\)/);
  assert.match(source, /messages: \[bootstrap, bootstrapAcknowledgement, user\]/);
  assert.match(source, /commitThread\(preparationThread\)/);
  assert.match(source, /setActiveThreadId\(preparationThread\.id\)/);
  assert.match(source, /phase: "preparing"/);
  assert.ok(source.indexOf("commitThread(preparationThread)") < source.indexOf("await generateMedia"));
  assert.match(source, /setThemeGeneration\(\(current\) => current\?\.threadId === preparationThread\.id \? null : current\)/);
  assert.doesNotMatch(source, /activeThread\.workspace|\.\.\.activeThread/);
  assert.doesNotMatch(source, /ensureThemeGenerationSkill/);
});

test("theme manager places theme items before import and generation controls", () => {
  const start = appSource.indexOf('<div className="themes-body">');
  const end = appSource.indexOf('<div className="dialog-footer themes-footer">', start);
  const source = appSource.slice(start, end);
  const defaultTheme = source.indexOf("default-theme-card");
  const installedThemes = source.indexOf("{themes.map((theme) => (");
  const importZone = source.indexOf("theme-import-zone");
  const generator = source.indexOf("theme-generator-card");
  assert.ok(defaultTheme >= 0);
  assert.ok(installedThemes > defaultTheme);
  assert.ok(importZone > installedThemes);
  assert.ok(generator > importZone);
});

test("theme generation forwards real, unique reference attachment ids to Harness", () => {
  assert.deepEqual(themeGenerationAttachmentIds({
    ...request,
    references: [...request.references, request.references[0], { ...request.references[1], id: " " }],
  }), ["reference-one", "reference-two"]);
});

test("a host-generated background is attached once and included after visual references", () => {
  const generatedBackground = {
    id: "generated-background",
    name: "background.webp",
    mimeType: "image/webp",
    sizeBytes: 1024,
    kind: "image",
  };
  const withBackground = { ...request, backgroundMode: "ai", generatedBackground };
  assert.deepEqual(themeGenerationAttachmentIds(withBackground), [
    "reference-one",
    "reference-two",
    "generated-background",
  ]);
  assert.equal(themeGenerationAttachments(withBackground).at(-1), generatedBackground);
  for (const locale of ["zh-CN", "en-US"]) {
    const prompt = themeGenerationPrompt(".levelup/generated-themes/theme.levelup-theme", withBackground, locale);
    assert.match(prompt, locale === "zh-CN" ? /单次生成了最终会话背景/ : /generated the final conversation background exactly once/);
    assert.match(prompt, locale === "zh-CN" ? /不要重新生成/ : /Do not regenerate/);
  }
});

test("background artwork requests one UI-free landscape composition", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const prompt = themeGenerationBackgroundPrompt({ ...request, backgroundMode: "ai" }, locale);
    assert.match(prompt, locale === "zh-CN" ? /只生成一个完整画面/ : /exactly one finished/);
    assert.match(prompt, /3:2/);
    assert.match(prompt, locale === "zh-CN" ? /不要绘制聊天气泡/ : /Do not draw chat bubbles/);
    assert.match(prompt, /quiet mountain skyline/);
  }
});

test("AI backgrounds are generated once by the host before Harness starts", () => {
  const start = appSource.indexOf("  const generateTheme = async");
  const end = appSource.indexOf("\n  useEffect(() => {", start);
  const source = appSource.slice(start, end);
  assert.match(source, /generationRequest\.backgroundMode === "ai"/);
  assert.match(source, /generateMedia\(\{/);
  assert.match(source, /count: 1/);
  assert.match(source, /prepareThemeGeneration\(workspace, backgroundAssetId/);
  assert.ok(source.indexOf("await generateMedia") < source.indexOf("harnessStart"));
});

test("theme Harness provider turns use streaming while retaining cancellable retries", () => {
  const start = rustSource.indexOf("let provider_future = run_agent_turn_with_failover_events_inner(");
  const end = rustSource.indexOf("let response = tokio::select!", start);
  const source = rustSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(
    source,
    /load_api_key,\s*theme_generation_mode,\s*turn_cancellation\.clone\(\)/,
  );
});

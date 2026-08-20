import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ARMOR_SKILLS,
  ARMOR_MODE_INSTRUCTIONS,
  ARMOR_MODE_LEVELS,
  ARMOR_MODE_PROFILES,
  DEFAULT_ARMOR_MODE_SKILLS,
  armorModeCoverage,
  armorModeHealthChecks,
  armorModeMediaInstructions,
  armorModeMediaPrompt,
  armorModeRunInstructions,
  armorModeWritingInstructions,
  normalizeArmorModeSkills,
} from "../src/lib/armorMode.ts";

const expectedLevels = ["standard", "deep", "execution", "reverse", "delivery"];

test("Armor Mode instructions are provider-neutral and action-first", () => {
  assert.equal(armorModeRunInstructions(false), undefined);
  assert.equal(armorModeRunInstructions(true), ARMOR_MODE_INSTRUCTIONS);
  assert.deepEqual(ARMOR_MODE_LEVELS, expectedLevels);
  assert.equal(ARMOR_MODE_PROFILES.standard.labelZh, "标准");
  assert.equal(ARMOR_MODE_PROFILES.deep.labelZh, "深度");
  assert.equal(ARMOR_MODE_PROFILES.execution.labelZh, "执行机器");
  assert.equal(ARMOR_MODE_PROFILES.reverse.labelZh, "逆向专用");
  assert.equal(ARMOR_MODE_PROFILES.delivery.labelZh, "工程交付");
  assert.match(ARMOR_MODE_INSTRUCTIONS, /OpenAI\/GPT/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /Claude\/Anthropic/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /Gemini/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /Grok\/xAI/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /LevelUpAgent native Armor Skill Pack/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /writing-studio/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /media-studio/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /Never claim a command, edit, build, search, or test succeeded until the tool result is returned/);
  assert.equal(ARMOR_SKILLS.length, 8);
  assert.deepEqual(Object.keys(DEFAULT_ARMOR_MODE_SKILLS), ARMOR_SKILLS.map((skill) => skill.id));
});

test("Armor Mode adapts direct media prompts and instructions", () => {
  assert.equal(armorModeMediaPrompt(false, "standard", "image", "cat"), "cat");
  assert.equal(armorModeMediaInstructions(false, "standard", "audio", "calm"), "calm");
  const imagePrompt = armorModeMediaPrompt(true, "deep", "image", "生成一只像素小猫");
  assert.match(imagePrompt, /^生成一只像素小猫/);
  assert.match(imagePrompt, /Crisp pixel-art illustration/);
  assert.match(imagePrompt, /foreground, middle ground, and background depth/);
  assert.match(imagePrompt, /No unrequested text, watermark/);
  assert.doesNotMatch(imagePrompt, /\[LevelUpAgent Armor Mode/);
  assert.doesNotMatch(imagePrompt, /Expand this into/);
  assert.doesNotMatch(imagePrompt, /Original prompt:/);
  assert.match(armorModeMediaPrompt(true, "execution", "video", "run"), /camera framing and movement, timing/);
  assert.doesNotMatch(armorModeMediaInstructions(true, "delivery", "audio", "calm"), /LevelUpAgent Armor Mode is ON/);
});

test("Armor Mode skill switches gate writing and media compilers", () => {
  const mediaDisabled = normalizeArmorModeSkills({ "media-studio": false });
  const writingDisabled = normalizeArmorModeSkills({ "writing-studio": false });
  const constellationDisabled = normalizeArmorModeSkills({ "constellation-flow": false });
  const sourcePrompt = "cat";
  const sourceInstructions = "keep the voice calm";

  assert.equal(
    armorModeMediaPrompt(true, "standard", "image", sourcePrompt, { skills: mediaDisabled }),
    sourcePrompt,
  );
  assert.equal(
    armorModeMediaInstructions(true, "standard", "audio", sourceInstructions, { skills: mediaDisabled }),
    sourceInstructions,
  );
  assert.doesNotMatch(
    armorModeWritingInstructions(true, "standard", "balanced", { skills: writingDisabled }),
    /Writing workspace contract/,
  );
  assert.equal(
    armorModeRunInstructions(true, "standard", { skills: constellationDisabled, surface: "constellation" }),
    undefined,
  );
  assert.equal(
    armorModeMediaPrompt(true, "standard", "image", sourcePrompt, { skills: constellationDisabled, surface: "constellation" }),
    sourcePrompt,
  );

  const balanced = armorModeWritingInstructions(true, "standard", "balanced");
  const immersive = armorModeWritingInstructions(true, "standard", "immersive");
  const precise = armorModeWritingInstructions(true, "standard", "precise");
  assert.notEqual(balanced, immersive);
  assert.notEqual(immersive, precise);
  assert.match(immersive, /sensory detail/);
  assert.match(precise, /every explicit constraint/i);
});

test("Armor Mode coverage and health checks reflect enabled skills", () => {
  const enabledCoverage = armorModeCoverage(true);
  assert.equal(enabledCoverage.length, 6);
  assert.ok(enabledCoverage.every((item) => item.active));
  assert.ok(enabledCoverage.every((item) => item.descriptionEn.length > 0));
  assert.ok(armorModeHealthChecks(true).every((check) => check.state === "ready"));

  const reducedSkills = normalizeArmorModeSkills({
    "media-studio": false,
    "writing-studio": false,
    "constellation-flow": false,
  });
  const reducedCoverage = armorModeCoverage(true, reducedSkills);
  assert.equal(reducedCoverage.find((item) => item.id === "image")?.active, false);
  assert.equal(reducedCoverage.find((item) => item.id === "writing")?.active, false);
  assert.equal(reducedCoverage.find((item) => item.id === "constellation")?.active, false);

  const checks = armorModeHealthChecks(true, "delivery", { skills: reducedSkills });
  assert.equal(checks.find((check) => check.id === "writing")?.state, "disabled");
  assert.equal(checks.find((check) => check.id === "media")?.state, "disabled");
  assert.equal(checks.find((check) => check.id === "coverage")?.state, "failed");
  assert.equal(armorModeHealthChecks(false).every((check) => check.state === "disabled"), true);
});

test("Armor Mode level profiles add focused execution contracts", () => {
  const standard = armorModeRunInstructions(true, "standard");
  const deep = armorModeRunInstructions(true, "deep");
  const execution = armorModeRunInstructions(true, "execution");
  const reverse = armorModeRunInstructions(true, "reverse");
  const delivery = armorModeRunInstructions(true, "delivery");
  assert.match(standard, /Armor level: Standard/);
  assert.match(deep, /hypothesis matrix/i);
  assert.match(execution, /Armor level: Execution Machine/);
  assert.match(reverse, /artifact intake/i);
  assert.match(delivery, /Engineering Delivery/);
  assert.match(armorModeRunInstructions(true, "standard", { model: "gpt-5.6-sol", protocol: "openai_responses" }), /GPT-5\.6 adapter/);
  assert.match(armorModeRunInstructions(true, "standard", { model: "claude-sonnet", protocol: "anthropic_messages" }), /Claude adapter/);
  assert.match(armorModeRunInstructions(true, "standard", { model: "gemini-2.5-pro", protocol: "gemini_generate_content" }), /Gemini adapter/);
  assert.match(armorModeRunInstructions(true, "standard", { model: "grok-4", protocol: "openai_chat" }), /Grok\/xAI adapter/);
});

test("Armor Mode UI, storage, and request wiring stay connected", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../src/lib/bridge.ts", import.meta.url), "utf8");
  const storage = readFileSync(new URL("../src/lib/storage.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const armorStudioCss = readFileSync(new URL("../src/ArmorStudio.css", import.meta.url), "utf8");

  assert.match(app, /loadArmorMode/);
  assert.match(app, /saveArmorMode/);
  assert.match(app, /loadArmorModeLevel/);
  assert.match(app, /saveArmorModeLevel/);
  assert.match(app, /armor-toggle/);
  assert.match(app, /armor-level-picker/);
  assert.match(app, /\{armorMode && \(/);
  assert.match(app, /armor-level-menu/);
  assert.match(app, /armor-hud/);
  assert.match(app, /customInstructions: armorModeRunInstructions\(armorMode, armorModeLevel, \{/);
  assert.match(app, /armorModeRunInstructions\(armorMode, armorModeLevel, \{/);
  assert.match(app, /ARMOR_MODE_LEVELS\.map/);
  assert.match(app, /data-armor-level=/);
  assert.match(app, /<MediaStudio[\s\S]*?armorMode=\{armorMode\}/);
  assert.match(app, /<MediaStudio[\s\S]*?armorModeLevel=\{armorModeLevel\}/);
  assert.match(app, /<WritingStudio[\s\S]*?armorMode=\{armorMode\}/);
  assert.match(app, /<ConstellationStudio[\s\S]*?armorMode=\{armorMode\}/);
  assert.match(app, /import "\.\/ArmorStudio\.css"/);
  assert.match(storage, /ARMOR_MODE_LEVEL_KEY/);
  assert.match(storage, /loadArmorModeLevel/);
  assert.match(storage, /saveArmorModeLevel/);
  assert.match(css, /\.armor-level-button/);
  assert.match(css, /\.armor-level-menu/);
  assert.match(css, /armor-level-reverse/);
  assert.doesNotMatch(css, /\.workspace-shell\.armor-mode \.topbar,\s*\.workspace-shell\.armor-mode \.armor-hud,\s*\.workspace-shell\.armor-mode \.conversation-stage/);
  assert.match(css, /\.workspace-shell\.armor-mode \.armor-hud \{\s*position: absolute;[\s\S]*?align-self: start;[\s\S]*?justify-self: start;/);
  assert.match(css, /\.armor-hud \{[\s\S]*?width: fit-content;[\s\S]*?transform: none;/);
  assert.match(css, /\.workspace-shell\.armor-mode \.empty-state \{\s*padding-top: clamp/);
  assert.match(css, /\.app-shell\.armor-mode \.brand \{/);
  assert.match(css, /\.app-shell\.armor-mode \.brand-copy strong/);
  assert.match(css, /\.app-shell\.armor-mode \.brand-copy small/);
  assert.match(css, /\.app-shell\.armor-mode \.brand-mark/);
  assert.match(css, /\.app-shell\.armor-mode \.account-button strong/);
  assert.match(css, /\.app-shell\.armor-mode \.connection-dialog/);
  assert.match(css, /\.app-shell\.armor-mode \.themes-dialog/);
  assert.match(css, /\.app-shell\.armor-mode \.pet-dialog/);
  assert.match(css, /\.app-shell\.armor-mode \.levelup-connection-card/);
  assert.match(css, /\.app-shell\.armor-mode \.theme-generator-card/);
  assert.match(css, /\.app-shell\.armor-mode \.pet-studio-header/);
  assert.match(css, /\.app-shell\.armor-mode \.pet-control-panel/);
  assert.match(css, /\.app-shell\.armor-mode \.protocol-switch/);
  assert.match(css, /\.app-shell\.armor-mode \.protocol-options \.protocol-option/);
  assert.match(css, /\.app-shell\.armor-mode \.protocol-option-heading em/);
  assert.match(armorStudioCss, /Creative Studio surface/);
  assert.match(armorStudioCss, /\.app-shell\.armor-mode :is\(\.media-studio, \.writing-studio, \.constellation-studio\)/);
  assert.match(armorStudioCss, /\.media-image-lightbox\.armor-mode/);
  assert.match(armorStudioCss, /\.writing-overlay/);
  assert.match(armorStudioCss, /\.constellation-preview-download/);
  assert.match(armorStudioCss, /\.constellation-canvas-modal/);
  assert.match(bridge, /customInstructions\?: string/);
  assert.match(bridge, /reasoningEffort: ReasoningEffort = "auto"/);
  assert.match(bridge, /customInstructions, reasoningEffort }/);

  const mediaStudio = readFileSync(new URL("../src/components/MediaStudio.tsx", import.meta.url), "utf8");
  const writingStudio = readFileSync(new URL("../src/components/WritingStudio.tsx", import.meta.url), "utf8");
  const constellationStudio = readFileSync(new URL("../src/components/ConstellationStudio.tsx", import.meta.url), "utf8");
  assert.match(mediaStudio, /className=\{`media-studio\$\{dropActive \? " file-drag-active" : ""\}\$\{armorClassName\}`\}/);
  assert.match(mediaStudio, /data-armor-level=\{armorMode \? armorModeLevel : undefined\}/);
  assert.match(mediaStudio, /armorMode=\{armorMode\}/);
  assert.match(mediaStudio, /armorModeLevel=\{armorModeLevel\}/);
  assert.match(writingStudio, /className=\{`writing-studio\$\{armorClassName\}`\}/);
  assert.match(writingStudio, /data-armor-level=\{armorDataLevel\}/);
  assert.match(constellationStudio, /className=\{`constellation-studio\$\{armorClassName\}`\}/);
  assert.match(constellationStudio, /data-armor-level=\{props\.armorMode \? props\.armorModeLevel : undefined\}/);
  assert.match(mediaStudio, /armorModeMediaPrompt\(armorMode, armorModeLevel, kind/);
  assert.match(mediaStudio, /armorModeMediaInstructions\(armorMode, armorModeLevel, kind/);
  assert.match(mediaStudio, /surface: kind/);
  assert.match(writingStudio, /armorModeWritingInstructions\(armorMode, armorModeLevel/);
  assert.match(writingStudio, /surface: "writing"/);
  assert.match(constellationStudio, /armorModeWritingInstructions\(armorMode, armorModeLevel/);
  assert.match(constellationStudio, /armorModeMediaPrompt\(armorMode, armorModeLevel, mediaKind/);
  assert.match(constellationStudio, /armorModeMediaInstructions\(/);
  assert.match(constellationStudio, /surface: "constellation"/);
  const armorStudio = readFileSync(new URL("../src/components/ArmorStudio.tsx", import.meta.url), "utf8");
  assert.match(armorStudio, /ARMOR_SKILLS\.map/);
  assert.match(armorStudio, /armorModeCoverage/);
  assert.match(armorStudio, /armorModeHealthChecks/);
  assert.match(armorStudio, /ARMOR_WRITING_INTENSITIES\.map/);
  assert.match(armorStudio, /armorModeMediaPrompt/);
});

test("Built-in prompt has no forced slogan greeting", () => {
  const agent = readFileSync(new URL("../src-tauri/src/agent.rs", import.meta.url), "utf8");
  const systemPrompt = agent.match(/const SYSTEM_PROMPT: &str = "([\s\S]*?)";/)?.[1] ?? "";

  assert.match(systemPrompt, /Do not force any fixed greeting/);
  assert.match(systemPrompt, /keep conversation clean/);
  assert.doesNotMatch(systemPrompt, /Greeting hard rule/);
  assert.doesNotMatch(systemPrompt, /reply exactly with/);
  assert.doesNotMatch(systemPrompt, /when the user message is only one of/);
});

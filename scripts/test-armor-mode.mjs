import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  ARMOR_SKILLS,
  ARMOR_MODE_INSTRUCTIONS,
  ARMOR_MODE_LEVELS,
  ARMOR_MODE_PROFILES,
  DEFAULT_ARMOR_MODE_SKILLS,
  armorModeRunInstructions,
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
  assert.doesNotMatch(ARMOR_MODE_INSTRUCTIONS, /writing-studio/);
  assert.doesNotMatch(ARMOR_MODE_INSTRUCTIONS, /media-studio/);
  assert.match(ARMOR_MODE_INSTRUCTIONS, /Never claim a command, edit, build, search, or test succeeded until the tool result is returned/);
  assert.equal(ARMOR_SKILLS.length, 5);
  assert.deepEqual(Object.keys(DEFAULT_ARMOR_MODE_SKILLS), ARMOR_SKILLS.map((skill) => skill.id));
});

test("Armor Mode is restricted to conversation requests at every level", () => {
  const legacySkills = normalizeArmorModeSkills({ "media-studio": true, "writing-studio": true, "constellation-flow": true });
  for (const level of expectedLevels) {
    for (const surface of ["writing", "image", "video", "audio", "constellation"]) {
      assert.equal(armorModeRunInstructions(true, level, { surface, skills: legacySkills }), undefined);
    }
    assert.match(armorModeRunInstructions(true, level, { surface: "chat" }), /LevelUpAgent Armor Mode is ON/);
    assert.equal(armorModeRunInstructions(false, level, { surface: "chat" }), undefined);
  }
  assert.ok(ARMOR_SKILLS.every((skill) => skill.surfaces.length === 1 && skill.surfaces[0] === "chat"));
  assert.doesNotMatch(armorModeRunInstructions(true), /media-studio|writing-studio|constellation-flow|Writing workspace contract/);
  const disabled = normalizeArmorModeSkills({ "provider-adapter": false });
  assert.doesNotMatch(armorModeRunInstructions(true, "standard", { skills: disabled, model: "claude-sonnet" }), /Claude adapter/);
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

test("conversation controls remain while the console and creative injections are removed", () => {
  const read = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
  const app = read("src/App.tsx");
  const storage = read("src/lib/storage.ts");
  for (const symbol of ["loadArmorMode", "saveArmorMode", "loadArmorModeLevel", "saveArmorModeLevel", "armor-toggle", "armor-level-picker", "ARMOR_MODE_LEVELS.map"]) assert.ok(app.includes(symbol));
  assert.equal(app.split("armorModeRunInstructions(").length - 1, 2);
  assert.match(app, /customInstructions: armorModeRunInstructions/);
  assert.ok(app.includes('armorMode ? `armor-mode armor-level-${armorModeLevel}` : undefined'));
  assert.match(storage, /ARMOR_MODE_LEVEL_KEY/);
  assert.doesNotMatch(app, /armorStudioOpen|onArmorStudioOpen|armorModeMedia|armorWritingIntensity/);
  assert.doesNotMatch(read("src/lib/armorMode.ts"), /armorModeMediaPrompt|armorModeMediaInstructions|armorModeWritingInstructions|armorModeHealthChecks/);
  for (const file of ["src/components/MediaStudio.tsx", "src/components/WritingStudio.tsx", "src/components/ConstellationStudio.tsx"]) {
    assert.doesNotMatch(read(file), /armorMode|armorWriting|armor-mode|data-armor-level/);
  }
  const media = read("src/components/MediaStudio.tsx");
  assert.match(media, /prompt: task.prompt,/);
  assert.ok(media.includes('instructions: kind === "audio" && instructions.trim() ? instructions.trim() : undefined'));
  const constellation = read("src/components/ConstellationStudio.tsx");
  assert.match(constellation, /prompt: effectivePrompt,/);
  assert.ok(constellation.includes('instructions: mediaKind === "audio" ? node.data.instruction?.trim() || undefined : undefined'));
  assert.ok(app.includes("prompt: themeGenerationBackgroundPrompt(generationRequest, locale),"));
  assert.equal(existsSync(new URL("../src/components/ArmorStudio.tsx", import.meta.url)), false);
  const skin = read("src/ArmorStudio.css");
  assert.ok(skin.includes(".app-shell.armor-mode .creative-studio"));
  assert.ok(skin.includes("html:has(.app-shell.armor-mode) body .media-image-lightbox"));
  assert.doesNotMatch(skin, /armor-studio-dialog|armor-media-compiler/);
  assert.doesNotMatch(read("capabilities/client-actions.json"), /dialog.armor/);
  assert.doesNotMatch(read("src/lib/clientCapabilities.ts"), /dialog.armor/);
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/lib/modelSelection.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../src/lib/bridge.ts", import.meta.url), "utf8");
const storageSource = readFileSync(new URL("../src/lib/storage.ts", import.meta.url), "utf8");
const writingStudioSource = readFileSync(new URL("../src/components/WritingStudio.tsx", import.meta.url), "utf8");
const constellationStudioSource = readFileSync(new URL("../src/components/ConstellationStudio.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "modelSelection.ts",
}).outputText;
const selection = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const geminiProfile = {
  id: "gemini",
  name: "Gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "",
  protocol: "gemini_generate_content",
};
const openCodeProfile = {
  id: "opencode-go",
  name: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  model: "",
  protocol: "opencode_go",
};
const grokProfile = {
  id: "grok",
  name: "Grok",
  baseUrl: "https://api.x.ai/v1",
  model: "",
  protocol: "openai_responses",
};
const models = (...ids) => ids.map((id) => ({ id }));

function protocolPlatforms(protocol) {
  const match = appSource.match(new RegExp(`value: "${protocol}",[\\s\\S]*?platforms: \\[([^\\]]+)\\]`));
  assert.ok(match, `${protocol} protocol option should exist`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function platformPillRule(platform) {
  const match = appCss.match(new RegExp(`(?:^|\\n)\\.platform-pill-${platform} \\{([^}]*)\\}`));
  assert.ok(match, `${platform} platform pill should have a base color rule`);
  return match[1];
}

test("Gemini discovery recommends 3.6 Flash over older general models", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-2.5-pro",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ));

  assert.equal(selected?.id, "gemini-3.6-flash");
});

test("Gemini Flash-Lite models remain ordered fallbacks", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
  ));

  assert.equal(selected?.id, "gemini-3.5-flash-lite");
});

test("Grok discovery recommends 4.6 and keeps 4.5 as a fallback", () => {
  assert.equal(selection.preferredDetectedModel(grokProfile, models(
    "grok-4",
    "grok-4.5",
    "grok-4.6",
  ))?.id, "grok-4.6");
  assert.equal(selection.preferredDetectedModel(grokProfile, models(
    "grok-4",
    "grok-4.5",
  ))?.id, "grok-4.5");
});

test("Nano Banana image models are never selected as the default text model", () => {
  const selected = selection.preferredDetectedModel(geminiProfile, models(
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-lite",
  ));

  assert.equal(selected?.id, "gemini-3.1-flash-lite");
  assert.equal(
    selection.preferredDetectedModel(geminiProfile, models("gemini-3.1-flash-lite-image")),
    undefined,
  );
  assert.equal(selection.isTextGenerationModel({ id: "gemini-3.1-flash-lite-image" }), false);
  assert.equal(selection.isTextGenerationModel({ id: "gemini-3.5-flash-lite" }), true);
  assert.equal(selection.isTextGenerationModel({ id: "provider-model", outputModalities: ["IMAGE"] }), false);
});

test("OpenCode Go strips config prefixes and routes every documented model family", () => {
  assert.equal(selection.normalizeOpenCodeModelId("models/OpenCode-Go/gpt-5.6-luna"), "gpt-5.6-luna");

  for (const model of [
    "grok-4.5",
    "grok-4.5-2026-07-09",
    "grok-4.5.preview",
    "gpt-5.6-luna",
    "gpt-5.6-luna-2026-07-09",
    "gpt-5.6-luna_preview",
    "muse-spark-1.2-contributor",
  ]) {
    assert.equal(selection.opencodeWireProtocol(model), "openai_responses", model);
  }
  for (const model of [
    "glm-5.3", "glm-5.2", "glm-5.1", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
    "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "hy3",
    // Models already exposed by LevelUpAPI but not individually listed on the
    // current public table stay on their documented family endpoint.
    "glm-5", "kimi-k2.5", "mimo-v2-pro", "mimo-v2-omni", "hy3-preview",
  ]) {
    assert.equal(selection.opencodeWireProtocol(model), "openai_chat", model);
  }
  for (const model of [
    "minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.8-max", "qwen3.7-max",
    "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
  ]) {
    assert.equal(selection.opencodeWireProtocol(model), "anthropic_messages", model);
  }
  assert.equal(selection.opencodeWireProtocol("future-model"), "openai_chat");
});

test("OpenCode Go recommends its current Luna coding model", () => {
  const selected = selection.preferredDetectedModel(openCodeProfile, models(
    "qwen3.8-max",
    "deepseek-v4-flash",
    "gpt-5.6-luna",
  ));
  assert.equal(selected?.id, "gpt-5.6-luna");
});

test("LevelUpAPI CN platforms are shown on every compatible inbound protocol", () => {
  const cnPlatforms = ["zhipu", "kimi", "deepseek"];
  for (const protocol of ["openai_responses", "openai_chat", "anthropic_messages"]) {
    const platforms = protocolPlatforms(protocol);
    for (const platform of cnPlatforms) assert.ok(platforms.includes(platform), `${protocol}: ${platform}`);
  }
  for (const protocol of ["gemini_generate_content", "opencode_go"]) {
    const platforms = protocolPlatforms(protocol);
    for (const platform of cnPlatforms) assert.ok(!platforms.includes(platform), `${protocol}: ${platform}`);
  }
  assert.match(appSource, /if \(platform === "zhipu"\) return "GLM";/);
});

test("protocol platform pills use the requested and official brand colors", () => {
  assert.match(platformPillRule("opencode"), /rgba\(14,165,233,/);
  assert.match(platformPillRule("zhipu"), /rgba\(18,110,246,/);
  assert.match(platformPillRule("kimi"), /rgba\(0,124,255,/);
  assert.match(platformPillRule("deepseek"), /rgba\(77,107,254,/);
});

test("reasoning levels follow the selected model instead of one global list", () => {
  const efforts = (model, protocol = "opencode_go") => selection.reasoningEffortsForProfile({
    ...openCodeProfile,
    model,
    protocol,
  });

  assert.deepEqual(efforts("gpt-5.6-luna"), ["auto", "none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("grok-4.6", "openai_responses"), ["auto", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("grok-4.5"), ["auto", "low", "medium", "high"]);
  assert.deepEqual(efforts("glm-5.3"), ["auto"]);
  assert.deepEqual(efforts("glm-5.2"), ["auto"]);
  assert.deepEqual(efforts("deepseek-v4-pro"), ["auto", "low", "high", "max"]);

  // These models expose reasoning output, but OpenCode Go does not publish a
  // configurable effort scale for them. The selector must not invent one.
  for (const model of ["kimi-k3", "minimax-m3", "qwen3.8-max", "mimo-v2.5", "hy3", "muse-spark-1.2-contributor"]) {
    assert.deepEqual(efforts(model), ["auto"], model);
  }

  assert.deepEqual(efforts("claude-opus-4-5", "anthropic_messages"), ["auto", "low", "medium", "high"]);
  assert.deepEqual(efforts("claude-opus-4-6", "anthropic_messages"), ["auto", "low", "medium", "high", "max"]);
  assert.deepEqual(efforts("claude-opus-4-7", "anthropic_messages"), ["auto", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("anthropic/claude-sonnet-5-20260815", "anthropic_messages"), ["auto", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("claude-sonnet-4-5", "anthropic_messages"), ["auto"]);
  assert.deepEqual(efforts("claude-haiku-4-5", "anthropic_messages"), ["auto"]);

  assert.deepEqual(efforts("gemini-3.6-flash", "gemini_generate_content"), ["auto", "minimal", "low", "medium", "high"]);
  assert.deepEqual(efforts("gemini-3.1-pro-preview", "gemini_generate_content"), ["auto", "low", "medium", "high"]);
  assert.deepEqual(efforts("gemini-2.5-pro", "gemini_generate_content"), ["auto", "low", "medium", "high"]);
  assert.deepEqual(efforts("gemini-2.5-flash-lite", "gemini_generate_content"), ["auto", "none", "low", "medium", "high"]);

  assert.deepEqual(efforts("gpt-5.6-sol", "openai_responses"), ["auto", "none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("gpt-5.6-20260901", "openai_responses"), ["auto", "none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("gpt-5.5", "openai_responses"), ["auto", "none", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.5-pro", "openai_responses"), ["auto", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.2", "openai_responses"), ["auto", "none", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.3-codex", "openai_responses"), ["auto", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.3-codex-20260831", "openai_responses"), ["auto", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.1", "openai_responses"), ["auto", "none", "low", "medium", "high"]);
  assert.deepEqual(efforts("gpt-5", "openai_responses"), ["auto", "minimal", "low", "medium", "high"]);
  assert.deepEqual(efforts("qwen3.8-max", "openai_chat"), ["auto", "none", "low", "medium", "xhigh"]);
  assert.deepEqual(efforts("qwen3.8-max", "openai_responses"), ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("qwen3.8-max", "anthropic_messages"), ["auto"]);
  assert.deepEqual(efforts("o4-mini", "openai_responses"), ["auto", "low", "medium", "high"]);
  assert.deepEqual(efforts("unknown-compatible-model", "openai_chat"), ["auto"]);
  assert.match(appSource, /if \(effort === "xhigh"\) return tr\("超高", "Extra"\);/);
  assert.doesNotMatch(source, /ultracode/i);
});

test("reasoning effort and provider-native blocks stay wired outside the main composer", () => {
  assert.equal([...writingStudioSource.matchAll(/reasoningEffortForProfile\(writingRunProfile, reasoningEffort\)/g)].length, 2);
  assert.match(constellationStudioSource, /reasoningEffortForProfile\(profile, reasoningEffort\)/);
  assert.match(appSource, /previewExternalConfigWrite\(profile, target, reasoningEffort\)/);
  assert.match(appSource, /applyExternalConfigWrite\(profile, target, preview\.confirmationToken, reasoningEffort\)/);
  assert.equal([...bridgeSource.matchAll(/providerReasoningBlocks/g)].length >= 4, true);
  assert.match(storageSource, /providerReasoningBlocks: Array\.isArray\(value\.providerReasoningBlocks\)/);
  assert.match(appSource, /providerReasoningBlocks: result\.providerReasoningBlocks/);
  assert.match(appSource, /providerReasoningBlocks: payload\.providerReasoningBlocks/);
});

test("unsupported persisted reasoning levels fall back to Auto on model switch", () => {
  const minimax = { ...openCodeProfile, model: "minimax-m3" };
  const luna = { ...openCodeProfile, model: "gpt-5.6-luna" };
  assert.equal(selection.reasoningEffortForProfile(minimax, "high"), "auto");
  assert.equal(selection.reasoningEffortForProfile(luna, "xhigh"), "xhigh");
  assert.equal(selection.reasoningEffortForProfile(luna, "minimal"), "auto");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/modelAvatars.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const avatars = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("model identities cover existing and new families, namespaces, case and variants", () => {
  const models = {
    "models/gpt-6-astra": "openai",
    "anthropic/claude-fable-5-1": "anthropic",
    "google/gemini-3.8-flash": "gemini",
    "xai/grok-4.6": "grok",
    "opencode/deepseek-v4-pro": "deepseek",
    "alibaba/qwen3.8-max": "qwen",
    "Qwen/QwQ-32B": "qwen",
    "zhipu/glm-5.3-flash": "glm",
    "moonshot/kimi-k3": "kimi",
    "moonshot-v1-128k": "kimi",
    "MiniMax-M3": "minimax",
    "mistralai/mistral-medium-3-5": "mistral",
    "codestral-latest": "mistral",
    "meta-llama/Llama-4-Maverick": "llama",
    "llama3.3:70b": "llama",
    "xiaomi/mimo-v2.5-pro": "mimo",
    "opencode/hy3": "hunyuan",
    "hunyuan-turbos-latest": "hunyuan",
    "muse-spark-1.2-contributor": "muse",
  };
  for (const [model, brand] of Object.entries(models)) {
    assert.equal(avatars.modelBrandFromModel(model), brand, model);
    assert.equal(avatars.modelAvatarSource(brand), `/avatars/${brand}.png`);
  }
});

test("actual model wins over gateway names, protocols and historical brands", () => {
  for (const protocol of ["openai_chat", "anthropic_messages", "opencode_go"]) {
    assert.equal(avatars.brandForProfile({
      name: "OpenAI / OpenCode", baseUrl: "https://gateway.test/v1", model: "qwen3.8-max", protocol,
    }), "qwen");
  }
  assert.equal(avatars.brandForMessage("deepseek-v4-pro", "openai"), "deepseek");
  assert.equal(avatars.brandForMessage("opencode/kimi-k3", "opencode"), "kimi");
  assert.equal(avatars.brandForMessage("glm-5.3", "levelup"), "glm");
  assert.equal(avatars.brandForMessage("", "antigravity"), "antigravity");
});

test("unknown models use provider hints or the application fallback", () => {
  assert.equal(avatars.brandForProfile({
    name: "Custom", baseUrl: "https://api.deepseek.com/v1", model: "custom-model", protocol: "openai_chat",
  }), "deepseek");
  assert.equal(avatars.brandForProfile({
    name: "Custom", baseUrl: "https://gateway.test", model: "custom-model", protocol: "opencode_go",
  }), "opencode");
  for (const model of ["", "custom-model", "notqwen3", "hy300unknown"]) {
    assert.equal(avatars.brandForMessage(model), "levelup", model);
  }
  assert.equal(avatars.modelAvatarSource("levelup"), "/logo.png");
  assert.equal(avatars.modelAvatarSource("unknown"), "/logo.png");
});

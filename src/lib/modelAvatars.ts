import type { ModelProviderBrand, ProviderProfile } from "./types";

export const MODEL_BRAND_LABELS: Record<ModelProviderBrand, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  antigravity: "Antigravity",
  grok: "Grok / xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen / 通义千问",
  glm: "GLM / 智谱",
  kimi: "Kimi / Moonshot",
  minimax: "MiniMax",
  mistral: "Mistral",
  llama: "Llama / Meta",
  mimo: "MiMo / 小米",
  hunyuan: "Hunyuan / 腾讯混元",
  muse: "Muse / Meta",
  opencode: "OpenCode Go",
  levelup: "LevelUpAgent",
};

const MODEL_PATTERNS: Array<[ModelProviderBrand, RegExp]> = [
  ["openai", /^(?:gpt(?:[._-]|$)|o[134](?:[._-]|$)|chatgpt(?:[._-]|$))/i],
  ["anthropic", /^(?:claude|opus|sonnet|haiku|fable|mythos)(?:[._-]|$)/i],
  ["gemini", /^gemini(?:[._-]|$)/i],
  ["grok", /^grok(?:[._-]|$)/i],
  ["deepseek", /^deepseek(?:[._-]|$)/i],
  ["qwen", /^(?:qwen|qwq)(?=\d|[._-]|$)/i],
  ["glm", /^glm(?=\d|[._-]|$)/i],
  ["kimi", /^(?:kimi|moonshot)(?:[._-]|$)/i],
  ["minimax", /^minimax(?:[._-]|$)/i],
  ["mistral", /^(?:mistral|mixtral|codestral|devstral|ministral|magistral)(?:[._-]|$)/i],
  ["llama", /^llama(?=\d|[._-]|$)/i],
  ["mimo", /^mimo(?:[._-]|$)/i],
  ["hunyuan", /^(?:hunyuan|hy\d+)(?:[._-]|$)/i],
  ["muse", /^muse(?:[._-]|$)/i],
];

/** Inspect the actual model before gateway names or API compatibility hints. */
export function modelBrandFromModel(model: string): ModelProviderBrand | undefined {
  const id = model.trim().split("/").filter(Boolean).pop() ?? "";
  // Colons can separate a provider prefix or an Ollama size/quantization tag.
  for (const segment of id.split(":")) {
    const brand = MODEL_PATTERNS.find(([, pattern]) => pattern.test(segment))?.[0];
    if (brand) return brand;
  }
  return undefined;
}

export function modelProviderBrandFromName(value: string): ModelProviderBrand {
  const modelBrand = modelBrandFromModel(value);
  if (modelBrand) return modelBrand;
  const hints: Array<[ModelProviderBrand, RegExp]> = [
    ["antigravity", /\bantigravity\b/i],
    ["opencode", /\bopencode\b/i],
    ["deepseek", /\bdeepseek\b/i],
    ["qwen", /\b(?:qwen\d*|dashscope|alibaba|aliyun)\b|通义|千问/i],
    ["glm", /\b(?:glm|zhipu|bigmodel)\b|智谱/i],
    ["kimi", /\b(?:kimi|moonshot)\b|月之暗面/i],
    ["minimax", /\b(?:minimax|minimaxi)\b/i],
    ["mistral", /\b(?:mistral|codestral|devstral)\b/i],
    ["llama", /\bllama\b/i],
    ["mimo", /\b(?:mimo|xiaomi)\b|小米/i],
    ["hunyuan", /\b(?:hunyuan|tencent)\b|混元/i],
    ["muse", /\bmuse\b/i],
    ["grok", /\b(?:grok|xai|x\.ai)\b/i],
    ["anthropic", /\b(?:claude|anthropic)\b/i],
    ["gemini", /\b(?:gemini|google|generativelanguage)\b/i],
    ["openai", /\b(?:gpt|openai|chatgpt|o1|o3|o4)\b/i],
  ];
  return hints.find(([, pattern]) => pattern.test(value))?.[0] ?? "levelup";
}

export function brandForProfile(profile: Pick<ProviderProfile, "model" | "name" | "baseUrl" | "protocol">): ModelProviderBrand {
  return modelBrandFromModel(profile.model)
    ?? (profile.protocol === "opencode_go" ? "opencode" : modelProviderBrandFromName(`${profile.name} ${profile.baseUrl}`));
}

/** Re-resolve old messages that saved a gateway or generic brand. */
export function brandForMessage(model: string, savedBrand?: ModelProviderBrand): ModelProviderBrand {
  return modelBrandFromModel(model) ?? savedBrand ?? modelProviderBrandFromName(model);
}

export function providerBrandLabel(brand: ModelProviderBrand): string {
  return MODEL_BRAND_LABELS[brand] ?? MODEL_BRAND_LABELS.levelup;
}

export function modelAvatarSource(brand: ModelProviderBrand): string {
  return brand === "levelup" || !(brand in MODEL_BRAND_LABELS) ? "/logo.png" : `/avatars/${brand}.png`;
}

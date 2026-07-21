import type { ModelInfo, ProviderProfile } from "./types";

type ModelFamily = "openai" | "grok" | "claude" | "gemini" | "deepseek" | "qwen" | "glm" | "kimi" | "mistral" | "llama" | "minimax";

const FAMILY_PATTERNS: Record<ModelFamily, RegExp> = {
  openai: /(?:^|[\/:._-])(?:gpt|o[134])(?:[\/:._-]|$)/i,
  grok: /(?:^|[\/:._-])grok(?:[\/:._-]|$)/i,
  claude: /(?:^|[\/:._-])claude(?:[\/:._-]|$)/i,
  gemini: /(?:^|[\/:._-])gemini(?:[\/:._-]|$)/i,
  deepseek: /(?:^|[\/:._-])deepseek(?:[\/:._-]|$)/i,
  qwen: /(?:^|[\/:._-])qwen(?:[\/:._-]|$)/i,
  glm: /(?:^|[\/:._-])glm(?:[\/:._-]|$)/i,
  kimi: /(?:^|[\/:._-])(?:kimi|moonshot)(?:[\/:._-]|$)/i,
  mistral: /(?:^|[\/:._-])(?:mistral|codestral)(?:[\/:._-]|$)/i,
  llama: /(?:^|[\/:._-])llama(?:[\/:._-]|$)/i,
  minimax: /(?:^|[\/:._-])minimax(?:[\/:._-]|$)/i,
};

const PROFILE_FAMILY_HINTS: Array<[ModelFamily, RegExp]> = [
  ["grok", /\b(?:grok|xai|x\.ai)\b/i],
  ["claude", /\b(?:claude|anthropic)\b/i],
  ["gemini", /\b(?:gemini|google|generativelanguage)\b/i],
  ["deepseek", /\bdeepseek\b/i],
  ["qwen", /\b(?:qwen|dashscope|alibaba)\b/i],
  ["glm", /\b(?:glm|zhipu|bigmodel)\b/i],
  ["kimi", /\b(?:kimi|moonshot)\b/i],
  ["mistral", /\b(?:mistral|codestral)\b/i],
  ["llama", /\b(?:llama|meta)\b/i],
  ["minimax", /\bminimax\b/i],
  ["openai", /\b(?:openai|chatgpt)\b/i],
];

// First entry in each family is the requested/default target. Later entries
// keep other providers on a recent general-purpose generation model when the
// exact target is not exposed by that endpoint.
const FAMILY_PREFERENCES: Record<ModelFamily, string[]> = {
  openai: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.3"],
  grok: ["grok-4.5", "grok-4.1", "grok-4"],
  claude: ["claude-fable-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5"],
  gemini: ["gemini-3.1-pro", "gemini-3-pro", "gemini-3.1-flash", "gemini-3-flash", "gemini-2.5-pro"],
  deepseek: ["deepseek-v3.2", "deepseek-v3.1", "deepseek-r1", "deepseek-v3"],
  qwen: ["qwen3.5-max", "qwen3-max", "qwen3.5-plus", "qwen3-plus", "qwen3-coder"],
  glm: ["glm-5", "glm-4.7", "glm-4.6", "glm-4.5"],
  kimi: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
  mistral: ["mistral-large-3", "mistral-large", "codestral-latest"],
  llama: ["llama-4-maverick", "llama-4-scout", "llama-3.3-70b"],
  minimax: ["minimax-m2.5", "minimax-m2.1", "minimax-m2"],
};

const NON_CHAT_MODEL = /(?:^|[\/:._-])(?:audio|embed|image|moderation|realtime|speech|stt|transcri|tts|video|vision-preview)(?:[\/:._-]|$)/i;
const LIGHTWEIGHT_MODEL = /(?:^|[\/:._-])(?:flash|haiku|mini|nano|small|lite)(?:[\/:._-]|$)/i;

function modelMatches(id: string, preferredId: string) {
  const normalized = id.toLocaleLowerCase();
  return normalized === preferredId || normalized.endsWith(`/${preferredId}`) || normalized.endsWith(`:${preferredId}`);
}

function modelFamily(model: ModelInfo): ModelFamily | null {
  const identity = `${model.ownedBy ?? ""}/${model.id}`;
  return (Object.entries(FAMILY_PATTERNS) as Array<[ModelFamily, RegExp]>)
    .find(([, pattern]) => pattern.test(identity))?.[0] ?? null;
}

function profileFamily(profile: ProviderProfile, models: ModelInfo[]): ModelFamily | null {
  const profileIdentity = `${profile.name} ${profile.baseUrl}`;
  const hinted = PROFILE_FAMILY_HINTS.find(([, pattern]) => pattern.test(profileIdentity))?.[0];
  if (hinted) return hinted;

  // Grok and other OpenAI-compatible providers may deliberately use the
  // Anthropic wire protocol, so provider identity takes precedence here.
  if (profile.protocol === "anthropic_messages") return "claude";
  if (profile.protocol === "gemini_generate_content") return "gemini";

  const families = new Set(models.map(modelFamily).filter((family): family is ModelFamily => family !== null));
  return families.size === 1 ? [...families][0] : null;
}

function newestGeneralModel(models: ModelInfo[]) {
  const generalModels = models.filter((model) => !NON_CHAT_MODEL.test(model.id));
  const candidates = generalModels.length > 0 ? generalModels : models;
  return [...candidates].sort((left, right) => {
    const qualityDifference = Number(LIGHTWEIGHT_MODEL.test(left.id)) - Number(LIGHTWEIGHT_MODEL.test(right.id));
    if (qualityDifference !== 0) return qualityDifference;
    return right.id.localeCompare(left.id, undefined, { numeric: true, sensitivity: "base" });
  })[0];
}

/** Select the preferred, recent chat model from a freshly detected model list. */
export function preferredDetectedModel(profile: ProviderProfile, models: ModelInfo[]): ModelInfo | undefined {
  if (models.length === 0) return undefined;

  const family = profileFamily(profile, models);
  const familyOrder = family
    ? [family]
    : (["openai", "grok", "claude", "gemini", "deepseek", "qwen", "glm", "kimi", "mistral", "llama", "minimax"] satisfies ModelFamily[]);

  for (const candidateFamily of familyOrder) {
    for (const preferredId of FAMILY_PREFERENCES[candidateFamily]) {
      const match = models.find((model) => modelMatches(model.id, preferredId));
      if (match) return match;
    }
  }

  const sameFamily = family ? models.filter((model) => modelFamily(model) === family) : models;
  return newestGeneralModel(sameFamily.length > 0 ? sameFamily : models);
}

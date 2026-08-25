import type { ModelInfo, ProviderProfile, ProviderProtocol, ReasoningEffort } from "./types";

type ModelFamily = "openai" | "grok" | "claude" | "gemini" | "deepseek" | "qwen" | "glm" | "kimi" | "mistral" | "llama" | "minimax" | "opencode";

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
  opencode: /(?:^|[\/:._-])opencode(?:[\/:._-]|$)/i,
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
  ["opencode", /\b(?:opencode|opencode\.ai|opencode-go)\b/i],
];

// First entry in each family is the requested/default target. Later entries
// keep other providers on a recent general-purpose generation model when the
// exact target is not exposed by that endpoint.
const FAMILY_PREFERENCES: Record<ModelFamily, string[]> = {
  openai: ["gpt-5.6-sol", "gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.3"],
  grok: ["grok-4.6", "grok-4.5", "grok-4.1", "grok-4"],
  claude: ["claude-fable-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5"],
  gemini: [
    "gemini-3.6-flash",
    "gemini-3.1-pro",
    "gemini-3.1-pro-preview",
    "gemini-3-pro",
    "gemini-3.5-flash",
    "gemini-3.1-flash",
    "gemini-3-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
  ],
  deepseek: ["deepseek-v3.2", "deepseek-v3.1", "deepseek-r1", "deepseek-v3"],
  qwen: ["qwen3.5-max", "qwen3-max", "qwen3.5-plus", "qwen3-plus", "qwen3-coder"],
  glm: ["glm-5", "glm-4.7", "glm-4.6", "glm-4.5"],
  kimi: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
  mistral: ["mistral-large-3", "mistral-large", "codestral-latest"],
  llama: ["llama-4-maverick", "llama-4-scout", "llama-3.3-70b"],
  minimax: ["minimax-m2.5", "minimax-m2.1", "minimax-m2"],
  opencode: ["gpt-5.6-luna", "grok-4.5", "glm-5.3", "kimi-k3", "qwen3.8-max", "deepseek-v4-pro", "minimax-m3"],
};

const OPENCODE_RESPONSES_MODELS = new Set([
  "grok-4.5",
  "gpt-5.6-luna",
  "muse-spark-1.2-contributor",
]);
const OPENCODE_MESSAGES_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.8-max",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);
const OPENCODE_CHAT_MODELS = new Set([
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "hy3",
]);

/** Strip OpenCode's config-only provider prefix before sending to the API. */
export function normalizeOpenCodeModelId(model: string) {
  return model
    .trim()
    .replace(/^models\//i, "")
    .replace(/^opencode(?:-go)?\//i, "");
}

/** OpenCode Go maps model IDs to three different technical interfaces. */
export function opencodeWireProtocol(model: string): Exclude<ProviderProtocol, "opencode_go"> {
  const id = normalizeOpenCodeModelId(model).toLocaleLowerCase();
  if (OPENCODE_RESPONSES_MODELS.has(id)
    || /^(?:grok-4\.5|gpt-5\.6-luna|muse-spark-1\.2-contributor)(?:[._-]|$)/i.test(id)) {
    return "openai_responses";
  }
  if (OPENCODE_MESSAGES_MODELS.has(id) || /^(?:minimax|qwen3[._-])/i.test(id)) return "anthropic_messages";
  if (OPENCODE_CHAT_MODELS.has(id) || /^(?:glm|kimi|deepseek-v4|mimo|hy3)(?:[._-]|$)/i.test(id)) return "openai_chat";
  // New OpenCode models default to the broadly compatible chat endpoint until
  // the upstream catalog publishes an explicit route.
  return "openai_chat";
}

const AUTO_REASONING = ["auto"] as const satisfies readonly ReasoningEffort[];
const OPENAI_REASONING = ["auto", "none", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ReasoningEffort[];
const GPT_56_REASONING = ["auto", "none", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningEffort[];
const THREE_LEVEL_REASONING = ["auto", "low", "medium", "high"] as const satisfies readonly ReasoningEffort[];
const GROK_46_REASONING = ["auto", "low", "medium", "high", "xhigh"] as const satisfies readonly ReasoningEffort[];
const HIGH_MAX_REASONING = ["auto", "high", "max"] as const satisfies readonly ReasoningEffort[];
const GOOGLE_REASONING = ["auto", "low", "high"] as const satisfies readonly ReasoningEffort[];

function bareModelId(model: string) {
  const segments = model
    .trim()
    .replace(/^models\//i, "")
    .split(/[/:]/);
  return segments[segments.length - 1]?.toLocaleLowerCase() ?? "";
}

function modelOrVariant(id: string, base: string) {
  return id === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[._-]|$)`, "i").test(id);
}

/**
 * Return only the reasoning levels the selected model is known to accept.
 * `auto` is always available and means that LevelUpAgent omits the field.
 * Unknown compatible models deliberately stay on Auto instead of receiving an
 * optimistic value that a strict upstream may reject.
 */
export function reasoningEffortsForProfile(
  profile: Pick<ProviderProfile, "model" | "protocol">,
): readonly ReasoningEffort[] {
  const id = profile.protocol === "opencode_go"
    ? normalizeOpenCodeModelId(profile.model).toLocaleLowerCase()
    : bareModelId(profile.model);

  if (modelOrVariant(id, "gpt-5.6-luna") || modelOrVariant(id, "gpt-5.6-sol") || modelOrVariant(id, "gpt-5.6-terra") || id === "gpt-5.6") {
    return GPT_56_REASONING;
  }
  if (modelOrVariant(id, "grok-4.6")) return GROK_46_REASONING;
  if (modelOrVariant(id, "grok-4.5")) return THREE_LEVEL_REASONING;
  if (/^glm-5(?:[._-]|$)/i.test(id) || /^deepseek-v4(?:[._-]|$)/i.test(id)) return HIGH_MAX_REASONING;

  // The remaining OpenCode Go models expose reasoning output, but the current
  // Go contract does not publish adjustable effort tiers for them. Keep their
  // provider default rather than pretending Anthropic/OpenAI levels transfer.
  if (profile.protocol === "opencode_go") return AUTO_REASONING;

  if (/^(?:claude|opus|sonnet|haiku)(?:[._-]|$)/i.test(id)) return HIGH_MAX_REASONING;
  if (profile.protocol === "gemini_generate_content" || /^gemini(?:[._-]|$)/i.test(id)) return GOOGLE_REASONING;
  if (/^gpt-5(?:[._-]|$)/i.test(id)) return OPENAI_REASONING;
  if (/^o(?:1|3|4)(?:[._-]|$)/i.test(id)) return THREE_LEVEL_REASONING;
  return AUTO_REASONING;
}

export function reasoningEffortForProfile(
  profile: Pick<ProviderProfile, "model" | "protocol">,
  effort: ReasoningEffort,
): ReasoningEffort {
  return reasoningEffortsForProfile(profile).includes(effort) ? effort : "auto";
}

const NON_CHAT_MODEL = /(?:^|[\/:._-])(?:audio|dall-e|embed(?:ding|dings)?|image|imagen|imagine|moderation|realtime|speech|sora|stt|transcri|tts|veo|video|vision-preview|whisper)(?:[\/:._-]|$)/i;
const LIGHTWEIGHT_MODEL = /(?:^|[\/:._-])(?:flash|haiku|mini|nano|small|lite)(?:[\/:._-]|$)/i;

/** Keep text selectors and automatic defaults aligned as new media model names appear. */
export function isTextGenerationModel(model: Pick<ModelInfo, "id" | "outputModalities">) {
  if (NON_CHAT_MODEL.test(model.id)) return false;
  const outputModalities = model.outputModalities ?? [];
  return outputModalities.length === 0
    || outputModalities.some((modality) => modality.toLocaleLowerCase() === "text");
}

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
  if (profile.protocol === "opencode_go") return "opencode";

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
  const candidates = models.filter(isTextGenerationModel);
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
    : (["opencode", "openai", "grok", "claude", "gemini", "deepseek", "qwen", "glm", "kimi", "mistral", "llama", "minimax"] satisfies ModelFamily[]);

  for (const candidateFamily of familyOrder) {
    for (const preferredId of FAMILY_PREFERENCES[candidateFamily]) {
      const match = models.find((model) => modelMatches(model.id, preferredId));
      if (match) return match;
    }
  }

  const sameFamily = family ? models.filter((model) => modelFamily(model) === family) : models;
  return newestGeneralModel(sameFamily.length > 0 ? sameFamily : models);
}

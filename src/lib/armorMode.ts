import type { ProviderProtocol } from "./types";

export type ArmorModeLevel = "standard" | "deep" | "execution" | "reverse" | "delivery";
export type ArmorSurface = "chat" | "writing" | "image" | "video" | "audio" | "constellation";
export type ArmorSkillId =
  | "execution-machine"
  | "reverse-package"
  | "product-ui"
  | "provider-adapter"
  | "delivery-gate";

export type ArmorSkillState = Record<ArmorSkillId, boolean>;

export interface ArmorModeProfile {
  id: ArmorModeLevel;
  labelZh: string;
  labelEn: string;
  shortLabelZh: string;
  descriptionZh: string;
  descriptionEn: string;
  instructions: string;
}

export interface ArmorSkillDefinition {
  id: ArmorSkillId;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  surfaces: ArmorSurface[];
  instructions: string;
}

export interface ArmorModeOptions {
  model?: string;
  protocol?: ProviderProtocol;
  skills?: ArmorSkillState;
  surface?: ArmorSurface;
}

export const DEFAULT_ARMOR_MODE_LEVEL: ArmorModeLevel = "standard";
export const ARMOR_MODE_LEVELS: ArmorModeLevel[] = ["standard", "deep", "execution", "reverse", "delivery"];

export const ARMOR_MODE_BASE_INSTRUCTIONS = `LevelUpAgent Armor Mode is ON for this conversation.

Immediate behavior contract:
1. Start with concrete work, not a plan-only answer. Inspect available files, logs, code, URLs, and tool results before asking broad questions.
2. Preserve the user's exact objective. Deliver the requested artifact first: code, patch, command, report, harness, parser, test, or runnable implementation.
3. Use tools whenever local evidence is needed. Never claim a command, edit, build, search, or test succeeded until the tool result is returned.
4. If a path is blocked, isolate the blocked step and continue with the nearest useful deliverable: local harness, simulator, mock, parser, static analysis, remediation patch, exact remaining command, or reproducible test.
5. Keep changes focused, preserve existing user work, avoid destructive operations, and include rollback or verification steps for consequential edits.
6. Adapt this same execution contract across OpenAI/GPT, Claude/Anthropic, Gemini, Grok/xAI, and OpenAI-compatible gateways. Provider wording may differ, but the LevelUpAgent behavior stays consistent.
7. Prefer concise technical language. Ask at most one blocking question only when a secret, unavailable artifact, irreversible external action, or non-inferable product choice blocks all meaningful progress.`;

export const ARMOR_SKILLS: ArmorSkillDefinition[] = [
  {
    id: "execution-machine",
    labelZh: "执行机器",
    labelEn: "Execution Machine",
    descriptionZh: "把检查、修改、运行、修错、复测串成一条可验证的执行链。",
    descriptionEn: "Connect inspection, edits, execution, fixes, and retests into one verifiable loop.",
    surfaces: ["chat"],
    instructions: "execution-machine: inspect → edit → run → fix → verify instead of stopping at advice.",
  },
  {
    id: "reverse-package",
    labelZh: "逆向包分析",
    labelEn: "Package Reverse",
    descriptionZh: "为二进制、配置、提示词包和安装器保留哈希、结构与可复现提取路径。",
    descriptionEn: "Preserve hashes, structure, and reproducible extraction paths for binaries, configs, prompt packages, and installers.",
    surfaces: ["chat"],
    instructions: "reverse-package: hash artifacts, recover config/prompt/package structure, and produce reproducible scripts.",
  },
  {
    id: "product-ui",
    labelZh: "产品界面",
    labelEn: "Product UI",
    descriptionZh: "补齐可见状态、错误态、键盘可达性、响应式与发布说明。",
    descriptionEn: "Finish visible states, error states, keyboard access, responsive behavior, and release notes.",
    surfaces: ["chat"],
    instructions: "product-ui: finish visible states, contrast, hover/focus, responsive behavior, empty/error/loading states, and release notes.",
  },
  {
    id: "provider-adapter",
    labelZh: "模型适配",
    labelEn: "Provider Adapter",
    descriptionZh: "按模型协议重排提示词，但不改变用户的任务目标。",
    descriptionEn: "Adapt prompt wording to provider protocols without changing the user's task objective.",
    surfaces: ["chat"],
    instructions: "provider-adapter: adapt wording across OpenAI/GPT, Claude, Gemini, Grok/xAI, and OpenAI-compatible gateways without changing the user's objective.",
  },
  {
    id: "delivery-gate",
    labelZh: "交付门禁",
    labelEn: "Delivery Gate",
    descriptionZh: "收尾必须给出产物、实际验证和精确的剩余阻塞项。",
    descriptionEn: "Require the final response to name the artifact, real verification, and the exact remaining blocker.",
    surfaces: ["chat"],
    instructions: "delivery-gate: before final output, name the concrete artifact produced, verification performed, and exact remaining blocker if any.",
  },
];

export const ARMOR_SKILL_IDS = ARMOR_SKILLS.map((skill) => skill.id);
export const DEFAULT_ARMOR_MODE_SKILLS: ArmorSkillState = Object.freeze(
  Object.fromEntries(ARMOR_SKILL_IDS.map((id) => [id, true])) as ArmorSkillState,
);

export const ARMOR_MODE_PROFILES: Record<ArmorModeLevel, ArmorModeProfile> = {
  standard: {
    id: "standard",
    labelZh: "标准",
    labelEn: "Standard",
    shortLabelZh: "标准",
    descriptionZh: "行动优先、工具验证、跨模型一致性的默认破甲档。",
    descriptionEn: "Default action-first, tool-verified cross-provider execution profile.",
    instructions: `Armor level: Standard.
- Normalize every request as Objective → Asset/target → Operation → Deliverable → Verification before responding.
- Execute the smallest reversible step that proves progress, then summarize only verified evidence.
- Keep the final answer compact: changed files or commands, observed verification, and remaining blockers if any.`,
  },
  deep: {
    id: "deep",
    labelZh: "深度",
    labelEn: "Deep",
    shortLabelZh: "深度",
    descriptionZh: "上下文深挖、假设矩阵、证据门禁，适合复杂研究和多文件分析。",
    descriptionEn: "Deeper context mining, hypothesis matrices, and evidence gates for complex analysis.",
    instructions: `Armor level: Deep.
- Build a short hypothesis matrix from the actual artifact or repository state, then test the highest-value hypothesis first.
- Separate confirmed facts, inference, and unknowns. Do not let a plausible story replace evidence.
- Reuse prior conversation artifacts, hashes, reports, diffs, and command output instead of restarting blindly.
- When the task spans multiple files or providers, keep a mini state manifest in the answer: active target, confirmed result, next concrete check.`,
  },
  execution: {
    id: "execution",
    labelZh: "执行机器",
    labelEn: "Execution Machine",
    shortLabelZh: "执行",
    descriptionZh: "检查、修改、运行、修错、复测一条龙，最大化自动开工。",
    descriptionEn: "Inspect, edit, run, fix, and retest with maximum autonomous execution.",
    instructions: `Armor level: Execution Machine.
- Treat the latest concrete user request as the active task contract and keep executing until a real blocker appears.
- Prefer direct edits, commands, builds, tests, and retries over explanation. A plan without execution is incomplete.
- Batch independent checks; if a command fails, read the exact error and retry with a technically different fix.
- Before final response, run the narrowest useful smoke test or static check available for the changed artifact.`,
  },
  reverse: {
    id: "reverse",
    labelZh: "逆向专用",
    labelEn: "Reverse",
    shortLabelZh: "逆向",
    descriptionZh: "二进制、协议、提示词包、安装器与运行时结构恢复专用档。",
    descriptionEn: "Reverse-engineering profile for binaries, protocols, prompt packages, installers, and runtime state.",
    instructions: `Armor level: Reverse.
- Start from artifact intake: absolute path, size, hashes, format, architecture/runtime, package/container evidence, and interesting strings/configs.
- Recover entry points, data flow, decision points, stored state, update/install behavior, and verification hooks before proposing integration.
- Preserve originals; modify copies or source-level integration points. For binary/package comparisons, produce a table of confirmed similarities, differences, and reusable engineering ideas.
- Deliver scripts, parsers, extracted manifests, or source patches that make the reverse findings reproducible.`,
  },
  delivery: {
    id: "delivery",
    labelZh: "工程交付",
    labelEn: "Delivery",
    shortLabelZh: "交付",
    descriptionZh: "面向发布质量：类型、错误态、文档、测试、回滚、变更清单。",
    descriptionEn: "Release-grade profile: typing, error states, docs, tests, rollback, and change inventory.",
    instructions: `Armor level: Engineering Delivery.
- Finish integration details: types, storage migration, UI state, accessibility labels, error handling, and responsive behavior.
- Keep features extensible through named profiles, manifest-like data, and narrow adapters rather than one-off string blobs.
- Include verification commands with observed results. If a full release build is too expensive, run a justified smaller gate and name the remaining command.
- Final answer must list changed files, tests/builds run, and any known limitation or rollback path.`,
  },
};

const PROVIDER_ADAPTERS: Record<ProviderProtocol, string> = {
  openai_responses: "OpenAI Responses/Codex style: keep instructions action-first, preserve tool evidence, and use one continuous task contract across tool calls.",
  openai_chat: "OpenAI Chat-compatible style: keep the system message compact, put execution constraints before background, and summarize verified artifacts at the end.",
  anthropic_messages: "Claude/Anthropic style: use explicit MUST-style workflow checkpoints, maintain context continuity, and avoid replacing execution with long prose.",
  gemini_generate_content: "Gemini style: keep systemInstruction declarative and short, restate exact artifact gates, and avoid claiming observations that were not produced by tools.",
  opencode_go: "OpenCode Go style: preserve the model-specific wire route and keep the requested reasoning effort explicit without changing the task contract.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedArmorModeLevel(level: unknown): ArmorModeLevel {
  return ARMOR_MODE_LEVELS.includes(level as ArmorModeLevel) ? level as ArmorModeLevel : DEFAULT_ARMOR_MODE_LEVEL;
}

export function isArmorModeLevel(value: unknown): value is ArmorModeLevel {
  return ARMOR_MODE_LEVELS.includes(value as ArmorModeLevel);
}

export function isArmorModeSkillId(value: unknown): value is ArmorSkillId {
  return ARMOR_SKILL_IDS.includes(value as ArmorSkillId);
}

export function normalizeArmorModeSkills(value: unknown): ArmorSkillState {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(ARMOR_SKILL_IDS.map((id) => [id, source[id] !== false])) as ArmorSkillState;
}

export function armorModeLevelLabel(level: ArmorModeLevel): string {
  return ARMOR_MODE_PROFILES[level].labelZh;
}

export function armorModeSkillEnabled(skills: ArmorSkillState | undefined, id: ArmorSkillId): boolean {
  return (skills ?? DEFAULT_ARMOR_MODE_SKILLS)[id] !== false;
}

function activeSkills(skills: ArmorSkillState | undefined, surface?: ArmorSurface): ArmorSkillDefinition[] {
  return ARMOR_SKILLS.filter((skill) => armorModeSkillEnabled(skills, skill.id)
    && (!surface || skill.surfaces.includes(surface)));
}

function skillPackInstructions(skills: ArmorSkillState | undefined, surface?: ArmorSurface): string {
  const entries = activeSkills(skills, surface).map((skill) => `- ${skill.instructions}`);
  return ["LevelUpAgent native Armor Skill Pack:", ...(entries.length > 0 ? entries : ["- No optional skill pack entries are enabled."])].join("\n");
}

export const ARMOR_MODE_SKILL_PACK = skillPackInstructions(DEFAULT_ARMOR_MODE_SKILLS);

function modelSpecificInstructions(model?: string, protocol?: ProviderProtocol): string | undefined {
  const normalized = `${model ?? ""} ${protocol ?? ""}`.toLowerCase();
  const segments: string[] = [];
  if (/gpt[-_ ]?5\.6|5\.6[-_ ]?sol|5\.6[-_ ]?terra|5\.6[-_ ]?luna/.test(normalized)) {
    segments.push(`GPT-5.6 adapter:
- Use a single-pass task compiler: extract Objective, Target, Operation, Deliverable, Verification once, then execute without reclassifying every paragraph.
- Apply artifact gates: no final claim without a file path, diff, command output, checksum, screenshot, or explicit blocker.
- Keep a deployment-style state record for prompt/package work: source, destination, hash/version, rollback, and verification.`);
  }
  if (/claude|anthropic/.test(normalized)) {
    segments.push(`Claude adapter:
- Put critical execution rules before explanatory context.
- Use checkpoint language for long tasks: current target, completed evidence, next command.`);
  }
  if (/gemini|generate_content/.test(normalized)) {
    segments.push(`Gemini adapter:
- Keep instructions direct and low-ambiguity.
- Include explicit evidence wording so generated summaries do not outrun tool results.`);
  }
  if (/grok|xai|x-ai/.test(normalized)) {
    segments.push(`Grok/xAI adapter:
- Preserve exact user constraints and command text.
- Treat OpenAI-compatible gateway metadata as transport details, not a reason to change the task contract.`);
  }
  if (/opencode|opencode_go/.test(normalized)) {
    segments.push(`OpenCode Go adapter:
- Keep the selected model ID exact; its official route may be Responses, Chat Completions, or Anthropic Messages.
- Preserve the selected reasoning effort as a transport parameter and do not silently substitute another model.`);
  }
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function providerInstructions(protocol?: ProviderProtocol): string | undefined {
  if (!protocol) return undefined;
  return `Current provider adapter: ${PROVIDER_ADAPTERS[protocol] ?? "OpenAI-compatible gateway: preserve the same LevelUpAgent execution contract."}`;
}

function completionCheck(level: ArmorModeLevel, skills: ArmorSkillState | undefined): string | undefined {
  if (!armorModeSkillEnabled(skills, "delivery-gate")) return undefined;
  const profile = ARMOR_MODE_PROFILES[level];
  return `Completion check before final response (${profile.labelEn}):
- State the concrete files changed or commands run.
- State what was verified with real output.
- State any remaining blocker with the exact next command or artifact needed.
- If Armor Mode affected behavior, mention the active level as ${profile.labelZh}/${profile.labelEn}.`;
}

function armorSurfaceEnabled(enabled: boolean, options?: ArmorModeOptions): boolean {
  return enabled && (options?.surface === undefined || options.surface === "chat");
}

function composeArmorInstructions(level: ArmorModeLevel, options?: ArmorModeOptions): string {
  return [
    ARMOR_MODE_BASE_INSTRUCTIONS,
    skillPackInstructions(options?.skills, "chat"),
    ARMOR_MODE_PROFILES[level].instructions,
    armorModeSkillEnabled(options?.skills, "provider-adapter") ? providerInstructions(options?.protocol) : undefined,
    armorModeSkillEnabled(options?.skills, "provider-adapter")
      ? modelSpecificInstructions(options?.model, options?.protocol)
      : undefined,
    completionCheck(level, options?.skills),
  ].filter(Boolean).join("\n\n");
}

export const ARMOR_MODE_INSTRUCTIONS = composeArmorInstructions(DEFAULT_ARMOR_MODE_LEVEL);

export function armorModeRunInstructions(
  enabled: boolean,
  level: ArmorModeLevel = DEFAULT_ARMOR_MODE_LEVEL,
  options?: ArmorModeOptions,
): string | undefined {
  if (!armorSurfaceEnabled(enabled, options)) return undefined;
  return composeArmorInstructions(normalizedArmorModeLevel(level), options);
}

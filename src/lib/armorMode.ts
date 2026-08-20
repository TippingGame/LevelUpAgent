import type { MediaKind, ProviderProtocol } from "./types";

export type ArmorModeLevel = "standard" | "deep" | "execution" | "reverse" | "delivery";
export type ArmorWritingIntensity = "balanced" | "immersive" | "precise";
export type ArmorSurface = "chat" | "writing" | "image" | "video" | "audio" | "constellation";
export type ArmorSkillId =
  | "execution-machine"
  | "reverse-package"
  | "product-ui"
  | "writing-studio"
  | "media-studio"
  | "constellation-flow"
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

export interface ArmorWritingIntensityProfile {
  id: ArmorWritingIntensity;
  labelZh: string;
  labelEn: string;
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

export interface ArmorCoverageItem {
  id: ArmorSurface;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  active: boolean;
}

export interface ArmorHealthCheck {
  id: string;
  labelZh: string;
  labelEn: string;
  state: "ready" | "disabled" | "failed";
  detailZh: string;
  detailEn: string;
}

export interface ArmorModeOptions {
  model?: string;
  protocol?: ProviderProtocol;
  skills?: ArmorSkillState;
  surface?: ArmorSurface;
}

export const DEFAULT_ARMOR_MODE_LEVEL: ArmorModeLevel = "standard";
export const ARMOR_MODE_LEVELS: ArmorModeLevel[] = ["standard", "deep", "execution", "reverse", "delivery"];
export const DEFAULT_ARMOR_WRITING_INTENSITY: ArmorWritingIntensity = "balanced";
export const ARMOR_WRITING_INTENSITIES: ArmorWritingIntensity[] = ["balanced", "immersive", "precise"];

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
    surfaces: ["chat", "writing", "constellation"],
    instructions: "execution-machine: inspect → edit → run → fix → verify instead of stopping at advice.",
  },
  {
    id: "reverse-package",
    labelZh: "逆向包分析",
    labelEn: "Package Reverse",
    descriptionZh: "为二进制、配置、提示词包和安装器保留哈希、结构与可复现提取路径。",
    descriptionEn: "Preserve hashes, structure, and reproducible extraction paths for binaries, configs, prompt packages, and installers.",
    surfaces: ["chat", "constellation"],
    instructions: "reverse-package: hash artifacts, recover config/prompt/package structure, and produce reproducible scripts.",
  },
  {
    id: "product-ui",
    labelZh: "产品界面",
    labelEn: "Product UI",
    descriptionZh: "补齐可见状态、错误态、键盘可达性、响应式与发布说明。",
    descriptionEn: "Finish visible states, error states, keyboard access, responsive behavior, and release notes.",
    surfaces: ["chat", "writing", "image", "video", "audio", "constellation"],
    instructions: "product-ui: finish visible states, contrast, hover/focus, responsive behavior, empty/error/loading states, and release notes.",
  },
  {
    id: "writing-studio",
    labelZh: "写作工作台",
    labelEn: "Writing Studio",
    descriptionZh: "保持题材、语气、视角、连续性和格式，不用空泛总结替代成稿。",
    descriptionEn: "Preserve genre, tone, viewpoint, continuity, and format instead of replacing usable prose with vague summaries.",
    surfaces: ["writing", "constellation"],
    instructions: "writing-studio: preserve the user's requested genre, tone, intensity, continuity, viewpoint, and output format; avoid bland summarization when the user asks for usable prose.",
  },
  {
    id: "media-studio",
    labelZh: "媒体编译器",
    labelEn: "Media Compiler",
    descriptionZh: "把短提示扩展成画面、镜头、动作、光线、节奏和交付约束完整的媒体 Brief。",
    descriptionEn: "Expand short prompts into complete media briefs with composition, camera, action, lighting, timing, and delivery constraints.",
    surfaces: ["image", "video", "audio", "constellation"],
    instructions: "media-studio: turn short prompts into production-ready visual/audio/video briefs with subject, style, composition, lighting, camera, motion, negative constraints, and output requirements.",
  },
  {
    id: "constellation-flow",
    labelZh: "星图流程",
    labelEn: "Constellation Flow",
    descriptionZh: "严格传递节点输入输出，保留上游上下文和节点承诺的产物类型。",
    descriptionEn: "Keep node inputs and outputs strict while preserving upstream context and promised artifact types.",
    surfaces: ["constellation"],
    instructions: "constellation-flow: keep each node contract strict, pass upstream context forward, and return only the artifact type that the node promises.",
  },
  {
    id: "provider-adapter",
    labelZh: "模型适配",
    labelEn: "Provider Adapter",
    descriptionZh: "按模型协议重排提示词，但不改变用户的任务目标。",
    descriptionEn: "Adapt prompt wording to provider protocols without changing the user's task objective.",
    surfaces: ["chat", "writing", "image", "video", "audio", "constellation"],
    instructions: "provider-adapter: adapt wording across OpenAI/GPT, Claude, Gemini, Grok/xAI, and OpenAI-compatible gateways without changing the user's objective.",
  },
  {
    id: "delivery-gate",
    labelZh: "交付门禁",
    labelEn: "Delivery Gate",
    descriptionZh: "收尾必须给出产物、实际验证和精确的剩余阻塞项。",
    descriptionEn: "Require the final response to name the artifact, real verification, and the exact remaining blocker.",
    surfaces: ["chat", "writing", "constellation"],
    instructions: "delivery-gate: before final output, name the concrete artifact produced, verification performed, and exact remaining blocker if any.",
  },
];

export const ARMOR_SKILL_IDS = ARMOR_SKILLS.map((skill) => skill.id);
export const DEFAULT_ARMOR_MODE_SKILLS: ArmorSkillState = Object.freeze(
  Object.fromEntries(ARMOR_SKILL_IDS.map((id) => [id, true])) as ArmorSkillState,
);

export const ARMOR_WRITING_INTENSITY_PROFILES: Record<ArmorWritingIntensity, ArmorWritingIntensityProfile> = {
  balanced: {
    id: "balanced",
    labelZh: "均衡",
    labelEn: "Balanced",
    descriptionZh: "兼顾可读性、连续性和有效细节的默认写作档。",
    descriptionEn: "The default writing profile balancing readability, continuity, and useful detail.",
    instructions: "Writing intensity: Balanced. Keep prose concrete and coherent; preserve pacing, viewpoint, and requested format.",
  },
  immersive: {
    id: "immersive",
    labelZh: "沉浸",
    labelEn: "Immersive",
    descriptionZh: "强调场景、动作、感官、节奏和角色反应之间的连续镜头感。",
    descriptionEn: "Emphasize scene, action, sensory detail, rhythm, and continuous character reactions.",
    instructions: "Writing intensity: Immersive. Use scene-specific action, sensory detail, rhythm, and character reactions. Maintain continuity instead of repeating generic phrases.",
  },
  precise: {
    id: "precise",
    labelZh: "精准",
    labelEn: "Precise",
    descriptionZh: "优先服从字数、视角、格式、设定、禁用项和分段等明确约束。",
    descriptionEn: "Prioritize explicit length, viewpoint, format, canon, exclusions, and paragraph constraints.",
    instructions: "Writing intensity: Precise. Treat every explicit constraint as a checklist: length, viewpoint, tense, format, canon, exclusions, and requested scene beats.",
  },
};

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

function normalizedWritingIntensity(value: unknown): ArmorWritingIntensity {
  return ARMOR_WRITING_INTENSITIES.includes(value as ArmorWritingIntensity)
    ? value as ArmorWritingIntensity
    : DEFAULT_ARMOR_WRITING_INTENSITY;
}

export function isArmorModeLevel(value: unknown): value is ArmorModeLevel {
  return ARMOR_MODE_LEVELS.includes(value as ArmorModeLevel);
}

export function isArmorWritingIntensity(value: unknown): value is ArmorWritingIntensity {
  return ARMOR_WRITING_INTENSITIES.includes(value as ArmorWritingIntensity);
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

export function armorModeWritingIntensityLabel(intensity: ArmorWritingIntensity): string {
  return ARMOR_WRITING_INTENSITY_PROFILES[intensity].labelZh;
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
  if (!enabled) return false;
  if (options?.surface === "constellation" && !armorModeSkillEnabled(options.skills, "constellation-flow")) {
    return false;
  }
  return true;
}

function composeArmorInstructions(level: ArmorModeLevel, options?: ArmorModeOptions): string {
  return [
    ARMOR_MODE_BASE_INSTRUCTIONS,
    skillPackInstructions(options?.skills, options?.surface),
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

export function armorModeWritingInstructions(
  enabled: boolean,
  level: ArmorModeLevel = DEFAULT_ARMOR_MODE_LEVEL,
  intensity: ArmorWritingIntensity = DEFAULT_ARMOR_WRITING_INTENSITY,
  options?: ArmorModeOptions,
): string | undefined {
  const base = armorModeRunInstructions(enabled, level, options);
  if (!base || !armorModeSkillEnabled(options?.skills, "writing-studio")) return base;
  const profile = ARMOR_WRITING_INTENSITY_PROFILES[normalizedWritingIntensity(intensity)];
  return [
    base,
    "Writing workspace contract: return usable prose or a directly actionable edit. Preserve the supplied source text unless the requested operation explicitly changes it.",
    profile.instructions,
  ].join("\n\n");
}

export function armorModeMediaPrompt(
  enabled: boolean,
  level: ArmorModeLevel = DEFAULT_ARMOR_MODE_LEVEL,
  kind: MediaKind = "image",
  prompt: string,
  options?: ArmorModeOptions,
): string {
  if (!armorSurfaceEnabled(enabled, options) || !armorModeSkillEnabled(options?.skills, "media-studio")) return prompt;
  const source = prompt.trim();
  if (!source) return source;
  const normalizedLevel = normalizedArmorModeLevel(level);

  if (kind === "image") {
    const pixelArt = /像素|pixel[\s-]?art|pixelated/i.test(source);
    const imageDirection = pixelArt
      ? "Crisp pixel-art illustration; one clear focal subject with a readable silhouette, intentional sprite-like pixel clusters, a limited cohesive palette, clean hard edges, and no anti-aliased or photorealistic rendering."
      : "One clear focal subject with intentional framing, coherent perspective, a balanced composition, a cohesive palette, believable materials and texture, and a finished visual style.";
    const levelDirection = normalizedLevel === "deep"
      ? "Layered foreground, middle ground, and background depth; controlled light falloff and environmental storytelling."
      : normalizedLevel === "execution"
        ? "Production-ready visual hierarchy, clean focal separation, and immediately readable details."
        : normalizedLevel === "reverse"
          ? "Structurally consistent shapes, perspective, lighting, and material construction."
          : normalizedLevel === "delivery"
            ? "Polished final-art presentation with consistent lighting, color, and edge treatment."
            : "Deliberate lighting, a simple fitting background, and a polished final-art finish.";
    return [
      source,
      imageDirection,
      levelDirection,
      "No unrequested text, watermark, logo, UI, border, collage, unrelated objects, duplicate anatomy, blur, or visual artifacts.",
    ].join("\n\n");
  }

  const direction = kind === "video"
    ? "Clear subject and setting; purposeful action beats, camera framing and movement, timing, lighting, visual continuity, and a finished cinematic style. No placeholder scenes, captions, watermarks, or unrelated cuts."
    : "Clear voice and delivery; natural pace, emotion, pauses, pronunciation, sound texture, and a finished usable performance. No filler, watermark, or unrelated spoken content.";
  return [source, direction].join("\n\n");
}

export function armorModeMediaInstructions(
  enabled: boolean,
  level: ArmorModeLevel = DEFAULT_ARMOR_MODE_LEVEL,
  kind: MediaKind = "image",
  instructions?: string,
  options?: ArmorModeOptions,
): string | undefined {
  if (!armorSurfaceEnabled(enabled, options) || !armorModeSkillEnabled(options?.skills, "media-studio")) return instructions;
  const profile = ARMOR_MODE_PROFILES[normalizedArmorModeLevel(level)];
  const armor = `${kind} direction: preserve the user's concrete creative target and requested intensity; avoid generic filler; return a finished, high-specificity result. Detail level: ${profile.labelZh}/${profile.labelEn}.`;
  return [armor, instructions?.trim()].filter(Boolean).join("\n\n");
}

export function armorModeCoverage(enabled: boolean, skills: ArmorSkillState = DEFAULT_ARMOR_MODE_SKILLS): ArmorCoverageItem[] {
  const has = (id: ArmorSkillId) => armorModeSkillEnabled(skills, id);
  return [
    {
      id: "chat",
      labelZh: "聊天",
      labelEn: "Chat",
      descriptionZh: "Harness 与浏览器预览请求注入",
      descriptionEn: "Inject into Harness and browser preview requests",
      active: enabled && (has("execution-machine") || has("provider-adapter") || has("delivery-gate")),
    },
    {
      id: "writing",
      labelZh: "写作",
      labelEn: "Writing",
      descriptionZh: "写作续写、改写、目标步骤与专用强度",
      descriptionEn: "Continue, rewrite, goal steps, and writing intensity",
      active: enabled && has("writing-studio"),
    },
    {
      id: "image",
      labelZh: "生图",
      labelEn: "Image",
      descriptionZh: "图片 Prompt 编译与 Instructions 增强",
      descriptionEn: "Compile image prompts and enhance instructions",
      active: enabled && has("media-studio"),
    },
    {
      id: "video",
      labelZh: "视频",
      labelEn: "Video",
      descriptionZh: "视频分镜、镜头、节奏与连续性编译",
      descriptionEn: "Compile video beats, camera, timing, and continuity",
      active: enabled && has("media-studio"),
    },
    {
      id: "audio",
      labelZh: "语音",
      labelEn: "Audio",
      descriptionZh: "声音、情绪、停顿和脚本交付编译",
      descriptionEn: "Compile voice, emotion, pauses, and usable scripts",
      active: enabled && has("media-studio"),
    },
    {
      id: "constellation",
      labelZh: "星图",
      labelEn: "Constellation",
      descriptionZh: "Writing 与媒体节点的上下文和节点契约",
      descriptionEn: "Preserve context and node contracts across Writing and media nodes",
      active: enabled && has("constellation-flow"),
    },
  ];
}

export function armorModeHealthChecks(
  enabled: boolean,
  level: ArmorModeLevel = DEFAULT_ARMOR_MODE_LEVEL,
  options?: ArmorModeOptions,
): ArmorHealthCheck[] {
  const skills = normalizeArmorModeSkills(options?.skills);
  const chatInstructions = armorModeRunInstructions(enabled, level, { ...options, skills });
  const writingInstructions = armorModeWritingInstructions(enabled, level, DEFAULT_ARMOR_WRITING_INTENSITY, { ...options, skills });
  const mediaPrompt = armorModeMediaPrompt(enabled, level, "image", "health check subject", { ...options, skills });
  const coverage = armorModeCoverage(enabled, skills);
  const activeCoverage = coverage.filter((item) => item.active).length;
  return [
    {
      id: "profile",
      labelZh: "Profile 编译",
      labelEn: "Profile compilation",
      state: enabled && chatInstructions?.includes("LevelUpAgent Armor Mode is ON") ? "ready" : "disabled",
      detailZh: enabled ? `${ARMOR_MODE_PROFILES[normalizedArmorModeLevel(level)].labelZh} 档可编译` : "一键破甲当前关闭",
      detailEn: enabled ? `${ARMOR_MODE_PROFILES[normalizedArmorModeLevel(level)].labelEn} profile compiles` : "Armor Mode is off",
    },
    {
      id: "skill-pack",
      labelZh: "Skill Pack",
      labelEn: "Skill Pack",
      state: enabled && activeSkills(skills).length > 0 ? "ready" : "disabled",
      detailZh: enabled ? `${activeSkills(skills).length}/${ARMOR_SKILLS.length} 个原生 Skill 已启用` : "开启后才会注入 Skill Pack",
      detailEn: enabled ? `${activeSkills(skills).length}/${ARMOR_SKILLS.length} native skills enabled` : "Skill Pack injects when Armor Mode is enabled",
    },
    {
      id: "writing",
      labelZh: "写作工作台",
      labelEn: "Writing Studio",
      state: enabled && writingInstructions?.includes("Writing workspace contract") ? "ready" : "disabled",
      detailZh: enabled && armorModeSkillEnabled(skills, "writing-studio") ? "续写、改写、润色和目标步骤可用" : "写作 Skill 已关闭",
      detailEn: enabled && armorModeSkillEnabled(skills, "writing-studio") ? "Continue, rewrite, polish, and goal steps are ready" : "Writing skill is disabled",
    },
    {
      id: "media",
      labelZh: "媒体编译器",
      labelEn: "Media Compiler",
      state: enabled
        && armorModeSkillEnabled(skills, "media-studio")
        && mediaPrompt.startsWith("health check subject")
        && mediaPrompt.includes("No unrequested text, watermark")
        ? "ready"
        : "disabled",
      detailZh: enabled && armorModeSkillEnabled(skills, "media-studio") ? "图片、视频和语音 Prompt 可编译" : "媒体 Skill 已关闭",
      detailEn: enabled && armorModeSkillEnabled(skills, "media-studio") ? "Image, video, and audio prompts compile" : "Media skill is disabled",
    },
    {
      id: "coverage",
      labelZh: "覆盖状态",
      labelEn: "Coverage status",
      state: enabled && activeCoverage === coverage.length ? "ready" : enabled ? "failed" : "disabled",
      detailZh: enabled ? `${activeCoverage}/${coverage.length} 个应用表面已激活` : "等待开启一键破甲",
      detailEn: enabled ? `${activeCoverage}/${coverage.length} application surfaces active` : "Waiting for Armor Mode",
    },
  ];
}

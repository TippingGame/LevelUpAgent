import type { WritingProjectRecord } from "./types";

export const WRITING_SCHEMA_VERSION = 1 as const;

export type WritingProjectType = "novel" | "screenplay" | "game";
export type WritingDocumentKind = "chapter" | "scene" | "outline" | "note";
export type WritingDocumentStatus = "draft" | "revised" | "final";
export type WritingEntityKind = "character" | "location" | "faction" | "item" | "world" | "plot" | "rule" | "quest" | "custom";
export type StoryNodeType = "scene" | "dialogue" | "choice" | "condition" | "ending";
export type StoryVariableType = "boolean" | "number" | "string";

export interface WritingDocument {
  id: string;
  title: string;
  kind: WritingDocumentKind;
  content: string;
  summary: string;
  status: WritingDocumentStatus;
  linkedEntityIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EntityRelation {
  id: string;
  targetId: string;
  type: string;
  note: string;
}

export interface WritingEntity {
  id: string;
  kind: WritingEntityKind;
  name: string;
  summary: string;
  details: string;
  aliases: string[];
  tags: string[];
  relations: EntityRelation[];
  createdAt: number;
  updatedAt: number;
}

export interface StoryVariable {
  id: string;
  name: string;
  type: StoryVariableType;
  initialValue: boolean | number | string;
  description: string;
}

export interface StoryChoice {
  id: string;
  label: string;
  targetNodeId?: string;
  condition: string;
  effects: string;
}

export interface StoryNode {
  id: string;
  type: StoryNodeType;
  title: string;
  content: string;
  speakerEntityId?: string;
  linkedEntityIds: string[];
  nextNodeId?: string;
  choices: StoryChoice[];
  x: number;
  y: number;
  createdAt: number;
  updatedAt: number;
}

export interface WritingSnapshotState {
  title: string;
  projectType: WritingProjectType;
  premise: string;
  styleGuide: string;
  documents: WritingDocument[];
  entities: WritingEntity[];
  variables: StoryVariable[];
  storyNodes: StoryNode[];
  activeDocumentId?: string;
  startNodeId?: string;
}

export interface WritingSnapshot {
  id: string;
  label: string;
  createdAt: number;
  state: WritingSnapshotState;
}

export interface WritingSettings {
  autoComplete: boolean;
  autoCompleteDelayMs: number;
  completionLength: number;
  contextBudget: number;
}

export interface WritingProject extends WritingSnapshotState {
  schemaVersion: typeof WRITING_SCHEMA_VERSION;
  id: string;
  snapshots: WritingSnapshot[];
  settings: WritingSettings;
  createdAt: number;
  updatedAt: number;
}

export interface WritingContextItem {
  id: string;
  name: string;
  kind: WritingEntityKind | "document" | "project";
  reason: "selected" | "linked" | "mentioned" | "related" | "global" | "neighbor";
  score: number;
  chars: number;
}

export interface WritingContextBundle {
  text: string;
  items: WritingContextItem[];
  entityIds: string[];
  estimatedTokens: number;
  usedChars: number;
  budgetChars: number;
}

export interface NarrativeIssue {
  id: string;
  severity: "error" | "warning" | "info";
  nodeId?: string;
  message: string;
}

export interface PlayState {
  nodeId?: string;
  variables: Record<string, boolean | number | string>;
  history: string[];
}

export type CompletionIntent =
  | "autocomplete"
  | "continue"
  | "rewrite"
  | "polish"
  | "expand"
  | "shorten"
  | "dialogue"
  | "describe"
  | "entity"
  | "node"
  | "choices";

const DEFAULT_SETTINGS: WritingSettings = {
  autoComplete: true,
  autoCompleteDelayMs: 1_800,
  completionLength: 420,
  contextBudget: 18_000,
};

export function createWritingProject(projectType: WritingProjectType = "novel", title?: string): WritingProject {
  const now = Date.now();
  const document = createWritingDocument(
    projectType === "screenplay" ? "第一场" : projectType === "game" ? "剧情概要" : "第一章",
    projectType === "screenplay" ? "scene" : projectType === "game" ? "outline" : "chapter",
  );
  const startNode = projectType === "game" ? createStoryNode("scene", "开始", 80, 100) : undefined;
  return {
    schemaVersion: WRITING_SCHEMA_VERSION,
    id: newId("writing"),
    title: title?.trim() || projectTypeLabel(projectType),
    projectType,
    premise: "",
    styleGuide: "",
    documents: [document],
    entities: [],
    variables: [],
    storyNodes: startNode ? [startNode] : [],
    activeDocumentId: document.id,
    startNodeId: startNode?.id,
    snapshots: [],
    settings: { ...DEFAULT_SETTINGS },
    createdAt: now,
    updatedAt: now,
  };
}

export function createWritingDocument(title = "新文稿", kind: WritingDocumentKind = "chapter"): WritingDocument {
  const now = Date.now();
  return {
    id: newId("document"),
    title,
    kind,
    content: "",
    summary: "",
    status: "draft",
    linkedEntityIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createWritingEntity(kind: WritingEntityKind = "character", name?: string): WritingEntity {
  const now = Date.now();
  return {
    id: newId("entity"),
    kind,
    name: name?.trim() || entityKindLabel(kind),
    summary: "",
    details: "",
    aliases: [],
    tags: [],
    relations: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createStoryNode(type: StoryNodeType = "scene", title?: string, x = 80, y = 80): StoryNode {
  const now = Date.now();
  return {
    id: newId("node"),
    type,
    title: title?.trim() || nodeTypeLabel(type),
    content: "",
    linkedEntityIds: [],
    choices: type === "choice" ? [{ id: newId("choice"), label: "选项 1", condition: "", effects: "" }] : [],
    x,
    y,
    createdAt: now,
    updatedAt: now,
  };
}

export function createStoryVariable(type: StoryVariableType = "boolean"): StoryVariable {
  return {
    id: newId("variable"),
    name: `variable_${Date.now().toString(36)}`,
    type,
    initialValue: type === "boolean" ? false : type === "number" ? 0 : "",
    description: "",
  };
}

export function projectToRecord(project: WritingProject): WritingProjectRecord {
  const title = project.title.trim().slice(0, 200) || projectTypeLabel(project.projectType);
  return {
    id: project.id,
    title,
    projectType: project.projectType,
    payload: project,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function projectFromRecord(record: WritingProjectRecord): WritingProject | null {
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return null;
  const value = record.payload as Partial<WritingProject>;
  if (value.schemaVersion !== WRITING_SCHEMA_VERSION) return null;
  const now = Date.now();
  const normalizedState = repairStateReferences({
    documents: uniqueIds(Array.isArray(value.documents) ? value.documents.map(normalizeDocument).filter(isDefined) : [], "document"),
    entities: uniqueIds(Array.isArray(value.entities) ? value.entities.map(normalizeEntity).filter(isDefined) : [], "entity"),
    storyNodes: uniqueIds(Array.isArray(value.storyNodes) ? value.storyNodes.map(normalizeNode).filter(isDefined) : [], "node"),
    variables: uniqueIds(Array.isArray(value.variables) ? value.variables.map(normalizeVariable).filter(isDefined) : [], "variable"),
  });
  const { documents, entities, storyNodes, variables } = normalizedState;
  const fallbackDocument = documents[0] ?? createWritingDocument();
  if (documents.length === 0) documents.push(fallbackDocument);
  const projectType = isProjectType(value.projectType)
    ? value.projectType
    : isProjectType(record.projectType) ? record.projectType : "novel";
  const projectId = [safeString(value.id), safeString(record.id)].find(isSafeWritingProjectId) ?? newId("writing");
  const title = (safeString(value.title).trim() || safeString(record.title).trim() || projectTypeLabel(projectType)).slice(0, 200);
  const createdAt = Math.max(0, Math.trunc(finiteNumber(value.createdAt, record.createdAt || now)));
  const updatedAt = Math.max(createdAt, Math.trunc(finiteNumber(value.updatedAt, record.updatedAt || now)));
  return {
    schemaVersion: WRITING_SCHEMA_VERSION,
    id: projectId,
    title,
    projectType,
    premise: safeString(value.premise),
    styleGuide: safeString(value.styleGuide),
    documents,
    entities,
    variables,
    storyNodes,
    activeDocumentId: documents.some((item) => item.id === value.activeDocumentId) ? value.activeDocumentId : documents[0]?.id,
    startNodeId: storyNodes.some((item) => item.id === value.startNodeId) ? value.startNodeId : storyNodes[0]?.id,
    snapshots: Array.isArray(value.snapshots)
      ? value.snapshots.slice(0, 30).map((snapshot) => normalizeSnapshot(snapshot, projectType)).filter(isDefined)
      : [],
    settings: {
      autoComplete: typeof value.settings?.autoComplete === "boolean" ? value.settings.autoComplete : DEFAULT_SETTINGS.autoComplete,
      autoCompleteDelayMs: clampNumber(value.settings?.autoCompleteDelayMs, 700, 10_000, DEFAULT_SETTINGS.autoCompleteDelayMs),
      completionLength: clampNumber(value.settings?.completionLength, 80, 2_000, DEFAULT_SETTINGS.completionLength),
      contextBudget: clampNumber(value.settings?.contextBudget, 4_000, 80_000, DEFAULT_SETTINGS.contextBudget),
    },
    createdAt,
    updatedAt,
  };
}

export function createSnapshot(project: WritingProject, label: string): WritingSnapshot {
  return {
    id: newId("snapshot"),
    label: label.trim() || new Date().toLocaleString(),
    createdAt: Date.now(),
    state: cloneSnapshotState(project),
  };
}

export function restoreSnapshot(project: WritingProject, snapshot: WritingSnapshot): WritingProject {
  return {
    ...project,
    ...structuredClone(snapshot.state),
    snapshots: project.snapshots,
    updatedAt: Date.now(),
  };
}

export function buildWritingContext(
  project: WritingProject,
  document: WritingDocument | undefined,
  cursor: number,
  selectedEntityIds: Iterable<string>,
  activeNodeId?: string,
): WritingContextBundle {
  const budget = project.settings.contextBudget;
  const scores = new Map<string, { score: number; reason: WritingContextItem["reason"] }>();
  const selected = new Set(selectedEntityIds);
  const activeNode = project.storyNodes.find((item) => item.id === activeNodeId);
  const nearbyText = document
    ? document.content.slice(Math.max(0, cursor - 8_000), Math.min(document.content.length, cursor + 2_000)).toLocaleLowerCase()
    : "";
  const addScore = (id: string, score: number, reason: WritingContextItem["reason"]) => {
    const current = scores.get(id);
    if (!current || score > current.score) scores.set(id, { score, reason });
  };

  for (const id of selected) addScore(id, 120, "selected");
  for (const id of document?.linkedEntityIds ?? []) addScore(id, 100, "linked");
  for (const id of activeNode?.linkedEntityIds ?? []) addScore(id, 105, "linked");
  if (activeNode?.speakerEntityId) addScore(activeNode.speakerEntityId, 110, "linked");

  for (const entity of project.entities) {
    const names = [entity.name, ...entity.aliases].map((item) => item.trim().toLocaleLowerCase()).filter(Boolean);
    if (names.some((name) => nearbyText.includes(name))) addScore(entity.id, 90, "mentioned");
    if (entity.kind === "rule" || entity.kind === "world") addScore(entity.id, 35, "global");
  }

  const firstPass = new Set(scores.keys());
  for (const entity of project.entities) {
    if (!firstPass.has(entity.id)) continue;
    for (const relation of entity.relations) addScore(relation.targetId, 65, "related");
    for (const source of project.entities) {
      if (source.relations.some((relation) => relation.targetId === entity.id)) addScore(source.id, 55, "related");
    }
  }

  const candidates: Array<{
    header: string;
    body: string;
    item: WritingContextItem;
    maxBodyChars: number;
  }> = [];

  const projectBlock = [
    project.premise && `核心设定：${project.premise}`,
    project.styleGuide && `写作规则：${project.styleGuide}`,
  ].filter(Boolean).join("\n");
  if (projectBlock) candidates.push({
    header: project.title,
    body: projectBlock,
    item: { id: project.id, name: project.title, kind: "project", reason: "global", score: 150, chars: 0 },
    maxBodyChars: Math.max(600, Math.floor(budget * .22)),
  });

  if (document?.summary) candidates.push({
    header: `${document.title} · 摘要`,
    body: document.summary,
    item: { id: document.id, name: document.title, kind: "document", reason: "linked", score: 130, chars: 0 },
    maxBodyChars: Math.max(500, Math.floor(budget * .2)),
  });

  const documentIndex = document ? project.documents.findIndex((item) => item.id === document.id) : -1;
  for (const neighbor of [project.documents[documentIndex - 1], project.documents[documentIndex + 1]]) {
    if (!neighbor?.summary) continue;
    candidates.push({
      header: `${neighbor.title} · 相邻文稿`,
      body: neighbor.summary,
      item: { id: neighbor.id, name: neighbor.title, kind: "document", reason: "neighbor", score: 45, chars: 0 },
      maxBodyChars: Math.max(300, Math.floor(budget * .12)),
    });
  }

  const ranked = project.entities
    .map((entity) => ({ entity, match: scores.get(entity.id) }))
    .filter((item): item is { entity: WritingEntity; match: { score: number; reason: WritingContextItem["reason"] } } => Boolean(item.match))
    .sort((left, right) => right.match.score - left.match.score || left.entity.name.localeCompare(right.entity.name));
  for (const { entity, match } of ranked) {
    const relations = entity.relations.map((relation) => {
      const target = project.entities.find((item) => item.id === relation.targetId);
      return target ? `${relation.type || "关联"} -> ${target.name}${relation.note ? `（${relation.note}）` : ""}` : "";
    }).filter(Boolean);
    const body = [
      entity.summary,
      entity.details,
      entity.tags.length > 0 ? `标签：${entity.tags.join("、")}` : "",
      relations.length > 0 ? `关系：${relations.join("；")}` : "",
    ].filter(Boolean).join("\n");
    const share = match.reason === "selected" ? .45 : match.reason === "linked" ? .35 : match.reason === "mentioned" ? .3 : .22;
    candidates.push({
      header: `${entityKindLabel(entity.kind)} · ${entity.name}`,
      body,
      item: { id: entity.id, name: entity.name, kind: entity.kind, reason: match.reason, score: match.score, chars: 0 },
      maxBodyChars: Math.max(600, Math.floor(budget * share)),
    });
  }

  const sections: string[] = [];
  const items: WritingContextItem[] = [];
  let usedChars = 0;
  for (const candidate of candidates.sort((left, right) => right.item.score - left.item.score || left.item.name.localeCompare(right.item.name))) {
    const body = candidate.body.trim();
    const header = `## ${candidate.header}\n`;
    const available = Math.min(candidate.maxBodyChars, budget - usedChars - header.length - 1);
    if (!body || available <= 0) continue;
    const includedBody = body.slice(0, available).trimEnd();
    if (!includedBody) continue;
    const block = `${header}${includedBody}\n`;
    sections.push(block);
    usedChars += block.length;
    items.push({ ...candidate.item, chars: block.length });
  }

  return {
    text: sections.join("\n"),
    items,
    entityIds: items.filter((item) => item.kind !== "document" && item.kind !== "project").map((item) => item.id),
    estimatedTokens: Math.ceil(usedChars / 2.6),
    usedChars,
    budgetChars: budget,
  };
}

export function buildCompletionPrompt({
  project,
  document,
  cursor,
  selectionStart,
  selectionEnd,
  intent,
  instruction,
  context,
  targetText,
  entity,
  node,
}: {
  project: WritingProject;
  document?: WritingDocument;
  cursor: number;
  selectionStart: number;
  selectionEnd: number;
  intent: CompletionIntent;
  instruction?: string;
  context: WritingContextBundle;
  targetText?: string;
  entity?: WritingEntity;
  node?: StoryNode;
}): string {
  const prefix = document?.content.slice(Math.max(0, cursor - 8_000), cursor) ?? "";
  const suffix = document?.content.slice(selectionEnd || cursor, Math.min(document.content.length, (selectionEnd || cursor) + 2_500)) ?? "";
  const selected = targetText ?? document?.content.slice(selectionStart, selectionEnd) ?? "";
  const goal = completionIntentInstruction(intent, project.settings.completionLength);
  const target = entity
    ? `设定条目：${entityKindLabel(entity.kind)}「${entity.name}」\n已有摘要：${entity.summary}\n已有详情：${entity.details}`
    : node
      ? `剧情节点：${nodeTypeLabel(node.type)}「${node.title}」\n已有内容：${node.content}`
      : `当前文稿：${document?.title ?? "未命名"}`;
  return [
    "你是嵌入写作编辑器的专业小说、剧本与游戏叙事补全引擎。",
    "优先延续作者已经建立的声音、人物行为逻辑、事实和节奏；人物应通过行为与语言呈现，而不是用心理学标签概括。",
    "不得改写既有事实，不得让未在场角色无故出现，不得重复前文，不得解释你的做法。",
    intent === "autocomplete" || intent === "continue"
      ? "必须从补全点之后的第一个新字开始续写；绝对不要复述、改写或再次输出补全点之前末尾已有的字词和句子。"
      : "",
    goal,
    instruction?.trim() ? `额外指示：${instruction.trim()}` : "",
    `项目类型：${projectTypeLabel(project.projectType)}\n${target}`,
    context.text ? `# 可用创作上下文\n${context.text}` : "",
    selected ? `# 需要处理的原文\n${selected}` : "",
    prefix ? `# 补全点之前\n${prefix}` : "",
    suffix ? `# 补全点之后（必须自然衔接，不要复述）\n${suffix}` : "",
    intent === "choices"
      ? "只输出 3-5 个选项，每行一个，格式严格为：- 选项文本。不要编号，不要补充说明。"
      : "只输出可直接放入作品的正文，不要标题、引号、Markdown 代码块、前言、解释或字数说明。",
  ].filter(Boolean).join("\n\n");
}

export function cleanCompletionText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  const fenced = text.match(/^[ \t]*```(?:markdown|text)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/i);
  if (fenced) text = fenced[1];
  else {
    text = text
      .replace(/^[ \t]*```(?:markdown|text)?[ \t]*(?:\n|$)/i, "")
      .replace(/(?:^|\n)```[ \t]*$/i, "");
  }
  return text
    .replace(/^(?:续写|改写|润色|扩写|结果|正文)[:：][ \t]*/i, "")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
}

export function inlineCompletionSegments(content: string, start: number, end: number, suggestion: string) {
  const normalizedStart = Number.isFinite(start) ? Math.trunc(start) : 0;
  const normalizedEnd = Number.isFinite(end) ? Math.trunc(end) : normalizedStart;
  const safeStart = Math.max(0, Math.min(content.length, normalizedStart));
  const safeEnd = Math.max(safeStart, Math.min(content.length, normalizedEnd));
  return {
    before: content.slice(0, safeStart),
    suggestion,
    after: content.slice(safeEnd),
  };
}

export function applyTextCompletion(content: string, start: number, end: number, suggestion: string): string {
  const segments = inlineCompletionSegments(content, start, end, suggestion);
  return `${segments.before}${segments.suggestion}${segments.after}`;
}

export function trimCompletionPrefixOverlap(prefix: string, suggestion: string): string {
  const maxOverlap = Math.min(240, prefix.length, suggestion.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    const overlap = suggestion.slice(0, length);
    if (prefix.slice(-length) !== overlap) continue;
    const punctuationOnly = /^[\p{P}\p{S}\s]+$/u.test(overlap);
    const containsNonAscii = /[^\x00-\x7f]/.test(overlap);
    const asciiWord = /^[A-Za-z0-9]+$/.test(overlap);
    const before = prefix.charAt(prefix.length - length - 1);
    const after = suggestion.charAt(length);
    const wholeAsciiWord = asciiWord
      && length >= 2
      && (!before || !/[A-Za-z0-9]/.test(before))
      && (!after || !/[A-Za-z0-9]/.test(after));
    if (punctuationOnly || (containsNonAscii && length >= 2) || wholeAsciiWord || length >= 4) {
      return suggestion.slice(length);
    }
  }
  return suggestion;
}

export function renameStoryVariableReferences(expression: string, previousName: string, nextName: string): string {
  if (!previousName || !nextName || previousName === nextName) return expression;
  return expression.replace(/(^|&&|;)(\s*!?)([A-Za-z_][A-Za-z0-9_.-]*)/g, (match, separator: string, spacing: string, name: string) => (
    name === previousName ? `${separator}${spacing}${nextName}` : match
  ));
}

export function parseChoiceSuggestion(value: string): string[] {
  return cleanCompletionText(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function writingStats(content: string) {
  const compact = content.trim();
  const cjk = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (compact.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  const paragraphs = compact ? compact.split(/\n\s*\n|\n/).filter((item) => item.trim()).length : 0;
  return { characters: [...compact].length, words: cjk + words, paragraphs };
}

export function validateNarrative(project: WritingProject): NarrativeIssue[] {
  const issues: NarrativeIssue[] = [];
  const nodes = new Map(project.storyNodes.map((node) => [node.id, node]));
  const variables = new Map(project.variables.map((variable) => [variable.name, variable]));
  const variableNames = new Set(variables.keys());
  for (const variable of project.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(variable.name)) issues.push({
      id: `invalid-variable-${variable.id}`,
      severity: "error",
      message: `变量「${variable.name || "未命名"}」的名称无效`,
    });
  }
  const duplicateVariables = project.variables.filter((variable, index, list) => list.findIndex((item) => item.name === variable.name) !== index);
  for (const duplicate of duplicateVariables) issues.push({
    id: `duplicate-variable-${duplicate.id}`,
    severity: "error",
    message: `变量「${duplicate.name}」重名`,
  });
  if (project.storyNodes.length === 0) {
    issues.push({ id: "no-nodes", severity: "warning", message: "还没有剧情节点" });
    return issues;
  }
  if (!project.startNodeId || !nodes.has(project.startNodeId)) issues.push({ id: "missing-start", severity: "error", message: "请选择有效的开始节点" });

  for (const node of project.storyNodes) {
    const targets = [node.nextNodeId, ...node.choices.map((choice) => choice.targetNodeId)].filter(Boolean) as string[];
    for (const target of targets) {
      if (!nodes.has(target)) issues.push({ id: `missing-target-${node.id}-${target}`, severity: "error", nodeId: node.id, message: `「${node.title}」指向不存在的节点` });
    }
    if (node.type !== "ending" && targets.length === 0) issues.push({ id: `dead-end-${node.id}`, severity: "warning", nodeId: node.id, message: `「${node.title}」没有后续路径` });
    for (const choice of node.choices) {
      if (!choice.label.trim()) issues.push({ id: `empty-choice-${node.id}-${choice.id}`, severity: "warning", nodeId: node.id, message: `「${node.title}」包含空白选项` });
      if (!choice.targetNodeId && !node.nextNodeId) issues.push({ id: `choice-no-target-${node.id}-${choice.id}`, severity: "warning", nodeId: node.id, message: `「${node.title}」的选项「${choice.label || "未命名"}」没有后续路径` });
      if (choice.condition.trim() && !parseConditionExpression(choice.condition)) issues.push({ id: `invalid-condition-${node.id}-${choice.id}`, severity: "error", nodeId: node.id, message: `「${node.title}」包含无法执行的条件表达式` });
      for (const effect of choice.effects.split(";").map((item) => item.trim()).filter(Boolean)) {
        const parsed = parseEffectTerm(effect);
        if (!parsed) {
          issues.push({ id: `invalid-effect-${node.id}-${choice.id}-${issues.length}`, severity: "error", nodeId: node.id, message: `「${node.title}」包含无法执行的效果：${effect}` });
          continue;
        }
        const variable = variables.get(parsed.name);
        if (!variable) continue;
        const literal = parsed.operator === "toggle" ? undefined : parseLiteral(parsed.rawValue);
        const validType = parsed.operator === "toggle"
          ? variable.type === "boolean"
          : parsed.operator === "+=" || parsed.operator === "-="
            ? variable.type === "number" && Number.isFinite(Number(literal))
            : variable.type === "string"
              || (variable.type === "boolean" && typeof literal === "boolean")
              || (variable.type === "number" && Number.isFinite(Number(literal)));
        if (!validType) issues.push({ id: `effect-type-${node.id}-${choice.id}-${parsed.name}-${issues.length}`, severity: "error", nodeId: node.id, message: `「${node.title}」对变量 ${parsed.name} 使用了不匹配的效果` });
      }
      for (const name of referencedVariables(`${choice.condition};${choice.effects}`)) {
        if (!variableNames.has(name)) issues.push({ id: `unknown-${node.id}-${choice.id}-${name}`, severity: "error", nodeId: node.id, message: `「${node.title}」引用了未知变量 ${name}` });
      }
    }
  }

  if (project.startNodeId && nodes.has(project.startNodeId)) {
    const reachable = new Set<string>();
    const queue = [project.startNodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const node = nodes.get(id);
      if (!node) continue;
      for (const target of [node.nextNodeId, ...node.choices.map((choice) => choice.targetNodeId)]) {
        if (target && !reachable.has(target)) queue.push(target);
      }
    }
    for (const node of project.storyNodes) {
      if (!reachable.has(node.id)) issues.push({ id: `unreachable-${node.id}`, severity: "warning", nodeId: node.id, message: `「${node.title}」从开始节点不可达` });
    }
  }
  if (issues.length === 0) issues.push({ id: "healthy", severity: "info", message: "没有发现断路、悬空引用或未知变量" });
  return issues;
}

export function createPlayState(project: WritingProject): PlayState {
  return {
    nodeId: project.startNodeId ?? project.storyNodes[0]?.id,
    variables: Object.fromEntries(project.variables.map((variable) => [variable.name, variable.initialValue])),
    history: [],
  };
}

export function visibleStoryChoices(node: StoryNode, state: PlayState): StoryChoice[] {
  return node.choices.filter((choice) => evaluateCondition(choice.condition, state.variables));
}

export function followStoryChoice(state: PlayState, node: StoryNode, choice?: StoryChoice): PlayState {
  const variables = { ...state.variables };
  if (choice) applyEffects(choice.effects, variables);
  return {
    nodeId: choice?.targetNodeId ?? node.nextNodeId,
    variables,
    history: [...state.history, node.id],
  };
}

export function evaluateCondition(expression: string, variables: Record<string, boolean | number | string>): boolean {
  const source = expression.trim();
  if (!source) return true;
  const terms = parseConditionExpression(source);
  if (!terms) return false;
  return terms.every(({ negated, name, operator, rawExpected }) => {
    if (!(name in variables)) return false;
    const actual = variables[name];
    if (!operator) return negated ? !Boolean(actual) : Boolean(actual);
    const expected = parseLiteral(rawExpected);
    if (operator === "==") return actual === expected || String(actual) === String(expected);
    if (operator === "!=") return actual !== expected && String(actual) !== String(expected);
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === ">=") return left >= right;
    if (operator === "<=") return left <= right;
    if (operator === ">") return left > right;
    return left < right;
  });
}

export function applyEffects(expression: string, variables: Record<string, boolean | number | string>) {
  for (const term of expression.split(";").map((item) => item.trim()).filter(Boolean)) {
    const parsedEffect = parseEffectTerm(term);
    if (!parsedEffect) continue;
    const { name, operator, rawValue } = parsedEffect;
    if (!(name in variables)) continue;
    const current = variables[name];
    if (operator === "toggle") {
      if (typeof current === "boolean") variables[name] = !current;
      continue;
    }
    if (operator === "+=" || operator === "-=") {
      const operand = Number(parseLiteral(rawValue));
      if (typeof current === "number" && Number.isFinite(operand)) {
        variables[name] = operator === "+=" ? current + operand : current - operand;
      }
      continue;
    }
    const parsed = parseLiteral(rawValue);
    if (typeof current === "number") {
      const numeric = Number(parsed);
      if (Number.isFinite(numeric)) variables[name] = numeric;
    } else if (typeof current === "boolean") {
      if (typeof parsed === "boolean") variables[name] = parsed;
    } else {
      variables[name] = String(parsed);
    }
  }
}

export function projectToMarkdown(project: WritingProject): string {
  const lines = [`# ${project.title}`, "", project.premise, ""];
  if (project.styleGuide) lines.push("## 写作规则", "", project.styleGuide, "");
  if (project.entities.length > 0) {
    lines.push("## 设定集", "");
    for (const entity of project.entities) {
      lines.push(`### ${entity.name}`, "", `类型：${entityKindLabel(entity.kind)}`, entity.summary, entity.details, "");
    }
  }
  lines.push("## 文稿", "");
  for (const document of project.documents) lines.push(`### ${document.title}`, "", document.content, "");
  return lines.filter((line, index, list) => line !== "" || list[index - 1] !== "").join("\n").trim() + "\n";
}

export function projectToYarn(project: WritingProject): string {
  const lines = [`// ${project.title}`, ""];
  const yarnNames = buildYarnVariableNames(project.variables);
  const variables = new Map(project.variables.map((variable) => [variable.name, variable]));
  const declaredNames = new Set<string>();
  for (const variable of project.variables) {
    const yarnName = yarnNames.get(variable.name);
    if (yarnName && !declaredNames.has(yarnName)) {
      declaredNames.add(yarnName);
      lines.push(`<<declare $${yarnName} = ${formatYarnValue(variable.initialValue)}>>`);
    }
  }
  if (project.variables.length > 0) lines.push("");
  for (const node of project.storyNodes) {
    lines.push(`title: ${technicalName(node)}`, "---");
    if (node.speakerEntityId) {
      const speaker = project.entities.find((entity) => entity.id === node.speakerEntityId)?.name;
      lines.push(speaker ? `${speaker}: ${node.content}` : node.content);
    } else if (node.content) lines.push(node.content);
    for (const choice of node.choices) {
      const condition = choice.condition ? ` <<if ${toYarnCondition(choice.condition, variables, yarnNames)}>>` : "";
      lines.push(`-> ${choice.label}${condition}`);
      for (const effect of choice.effects.split(";").map((item) => item.trim()).filter(Boolean)) {
        const yarnEffect = toYarnEffect(effect, variables, yarnNames);
        if (yarnEffect) lines.push(`    <<set ${yarnEffect}>>`);
      }
      const target = project.storyNodes.find((item) => item.id === choice.targetNodeId);
      if (target) lines.push(`    <<jump ${technicalName(target)}>>`);
    }
    if (node.nextNodeId) {
      const target = project.storyNodes.find((item) => item.id === node.nextNodeId);
      if (target) lines.push(`<<jump ${technicalName(target)}>>`);
    }
    lines.push("===", "");
  }
  return lines.join("\n").trim() + "\n";
}

export function parseImportedProject(value: unknown): WritingProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WritingProjectRecord> & Partial<WritingProject>;
  if (candidate.payload) {
    const projectType = isProjectType(candidate.projectType) ? candidate.projectType : "novel";
    return projectFromRecord({
      id: safeString(candidate.id) || newId("writing"),
      title: safeString(candidate.title) || "导入项目",
      projectType,
      payload: candidate.payload,
      createdAt: finiteNumber(candidate.createdAt, Date.now()),
      updatedAt: finiteNumber(candidate.updatedAt, Date.now()),
    });
  }
  if (candidate.schemaVersion === WRITING_SCHEMA_VERSION) {
    const projectType = isProjectType(candidate.projectType) ? candidate.projectType : "novel";
    return projectFromRecord({
      id: safeString(candidate.id) || newId("writing"),
      title: safeString(candidate.title) || "导入项目",
      projectType,
      payload: candidate,
      createdAt: finiteNumber(candidate.createdAt, Date.now()),
      updatedAt: finiteNumber(candidate.updatedAt, Date.now()),
    });
  }
  return null;
}

export function entityKindLabel(kind: WritingEntityKind) {
  return ({ character: "人物", location: "地点", faction: "阵营", item: "物品", world: "世界观", plot: "剧情", rule: "写作规则", quest: "任务", custom: "自定义" } as const)[kind];
}

export function projectTypeLabel(type: WritingProjectType) {
  return ({ novel: "小说项目", screenplay: "剧本项目", game: "游戏剧情项目" } as const)[type];
}

export function nodeTypeLabel(type: StoryNodeType) {
  return ({ scene: "场景", dialogue: "对白", choice: "选择", condition: "条件", ending: "结局" } as const)[type];
}

function completionIntentInstruction(intent: CompletionIntent, length: number) {
  const instructions: Record<CompletionIntent, string> = {
    autocomplete: `从光标处自然补全，优先完成当前句与紧邻段落，最多约 ${length} 字，并在自然停顿处结束。`,
    continue: `从光标处继续写作，推动当前动作或冲突，最多约 ${length} 字。`,
    rewrite: "在不改变事实、视角和信息量的前提下重写所选文字。",
    polish: "润色所选文字，改善节奏、用词和可读性，保留原意与作者声音。",
    expand: "扩写所选文字，增加有作用的动作、感官或潜台词，不堆砌形容词。",
    shorten: "压缩所选文字，删除重复和解释性语言，保留必要事实与情绪转折。",
    dialogue: "把当前情境续写成有潜台词、人物声音可区分的对话与动作。",
    describe: "补充服务于情节和人物感受的场景描写，避免静态景物清单。",
    entity: "补全或深化这个设定条目，输出可直接写入详情字段的连贯文字，避免与已有信息重复。",
    node: "补全这个互动剧情节点，使它可直接进入游戏脚本，并与相连设定一致。",
    choices: "根据当前节点、变量与人物动机生成有意义且后果可区分的玩家选项。",
  };
  return instructions[intent];
}

function normalizeDocument(value: unknown): WritingDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<WritingDocument>;
  const now = Date.now();
  const createdAt = Math.max(0, Math.trunc(finiteNumber(item.createdAt, now)));
  return {
    id: safeString(item.id) || newId("document"),
    title: safeString(item.title) || "未命名文稿",
    kind: isDocumentKind(item.kind) ? item.kind : "chapter",
    content: safeString(item.content),
    summary: safeString(item.summary),
    status: item.status === "revised" || item.status === "final" ? item.status : "draft",
    linkedEntityIds: stringArray(item.linkedEntityIds),
    createdAt,
    updatedAt: Math.max(createdAt, Math.trunc(finiteNumber(item.updatedAt, createdAt))),
  };
}

function normalizeEntity(value: unknown): WritingEntity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<WritingEntity>;
  const now = Date.now();
  const createdAt = Math.max(0, Math.trunc(finiteNumber(item.createdAt, now)));
  return {
    id: safeString(item.id) || newId("entity"),
    kind: isEntityKind(item.kind) ? item.kind : "custom",
    name: safeString(item.name) || "未命名设定",
    summary: safeString(item.summary),
    details: safeString(item.details),
    aliases: stringArray(item.aliases),
    tags: stringArray(item.tags),
    relations: uniqueIds(Array.isArray(item.relations) ? item.relations.flatMap((relation) => {
      if (!relation || typeof relation !== "object" || Array.isArray(relation)) return [];
      const candidate = relation as Partial<EntityRelation>;
      const targetId = safeString(candidate.targetId);
      return targetId ? [{ id: safeString(candidate.id) || newId("relation"), targetId, type: safeString(candidate.type), note: safeString(candidate.note) }] : [];
    }) : [], "relation"),
    createdAt,
    updatedAt: Math.max(createdAt, Math.trunc(finiteNumber(item.updatedAt, createdAt))),
  };
}

function normalizeNode(value: unknown): StoryNode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<StoryNode>;
  const now = Date.now();
  const createdAt = Math.max(0, Math.trunc(finiteNumber(item.createdAt, now)));
  return {
    id: safeString(item.id) || newId("node"),
    type: isNodeType(item.type) ? item.type : "scene",
    title: safeString(item.title) || "未命名节点",
    content: safeString(item.content),
    speakerEntityId: safeString(item.speakerEntityId) || undefined,
    linkedEntityIds: stringArray(item.linkedEntityIds),
    nextNodeId: safeString(item.nextNodeId) || undefined,
    choices: uniqueIds(Array.isArray(item.choices) ? item.choices.flatMap((choice) => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return [];
      const candidate = choice as Partial<StoryChoice>;
      return [{
        id: safeString(candidate.id) || newId("choice"),
        label: safeString(candidate.label) || "未命名选项",
        targetNodeId: safeString(candidate.targetNodeId) || undefined,
        condition: safeString(candidate.condition),
        effects: safeString(candidate.effects),
      }];
    }) : [], "choice"),
    x: clampNumber(item.x, 0, 4_000, 80),
    y: clampNumber(item.y, 0, 4_000, 80),
    createdAt,
    updatedAt: Math.max(createdAt, Math.trunc(finiteNumber(item.updatedAt, createdAt))),
  };
}

function normalizeVariable(value: unknown): StoryVariable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<StoryVariable>;
  const type = item.type === "number" || item.type === "string" ? item.type : "boolean";
  const numericInitialValue = Number(item.initialValue);
  return {
    id: safeString(item.id) || newId("variable"),
    name: safeString(item.name) || `variable_${Date.now().toString(36)}`,
    type,
    initialValue: type === "boolean"
      ? item.initialValue === true || item.initialValue === "true"
      : type === "number" ? Number.isFinite(numericInitialValue) ? numericInitialValue : 0 : safeString(item.initialValue),
    description: safeString(item.description),
  };
}

function cloneSnapshotState(project: WritingProject): WritingSnapshotState {
  return structuredClone({
    title: project.title,
    projectType: project.projectType,
    premise: project.premise,
    styleGuide: project.styleGuide,
    documents: project.documents,
    entities: project.entities,
    variables: project.variables,
    storyNodes: project.storyNodes,
    activeDocumentId: project.activeDocumentId,
    startNodeId: project.startNodeId,
  });
}

function normalizeSnapshot(value: unknown, fallbackProjectType: WritingProjectType): WritingSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<WritingSnapshot>;
  if (!item.state || typeof item.state !== "object" || Array.isArray(item.state)) return undefined;
  const state = item.state as Partial<WritingSnapshotState>;
  const normalizedState = repairStateReferences({
    documents: uniqueIds(Array.isArray(state.documents) ? state.documents.map(normalizeDocument).filter(isDefined) : [], "document"),
    entities: uniqueIds(Array.isArray(state.entities) ? state.entities.map(normalizeEntity).filter(isDefined) : [], "entity"),
    variables: uniqueIds(Array.isArray(state.variables) ? state.variables.map(normalizeVariable).filter(isDefined) : [], "variable"),
    storyNodes: uniqueIds(Array.isArray(state.storyNodes) ? state.storyNodes.map(normalizeNode).filter(isDefined) : [], "node"),
  });
  const { documents, entities, variables, storyNodes } = normalizedState;
  if (documents.length === 0) documents.push(createWritingDocument());
  const projectType = isProjectType(state.projectType) ? state.projectType : fallbackProjectType;
  return {
    id: safeString(item.id) || newId("snapshot"),
    label: safeString(item.label).trim().slice(0, 160) || "导入快照",
    createdAt: Math.max(0, Math.trunc(finiteNumber(item.createdAt, Date.now()))),
    state: {
      title: safeString(state.title).trim().slice(0, 200) || projectTypeLabel(projectType),
      projectType,
      premise: safeString(state.premise),
      styleGuide: safeString(state.styleGuide),
      documents,
      entities,
      variables,
      storyNodes,
      activeDocumentId: documents.some((document) => document.id === state.activeDocumentId) ? state.activeDocumentId : documents[0]?.id,
      startNodeId: storyNodes.some((node) => node.id === state.startNodeId) ? state.startNodeId : storyNodes[0]?.id,
    },
  };
}

function referencedVariables(expression: string) {
  const names = new Set<string>();
  for (const term of expression.split(/[;]|&&/)) {
    const match = term.trim().match(/^!?([A-Za-z_][A-Za-z0-9_.-]*)/);
    if (match) names.add(match[1]);
  }
  return [...names];
}

interface ParsedConditionTerm {
  negated: boolean;
  name: string;
  operator?: "==" | "!=" | ">=" | "<=" | ">" | "<";
  rawExpected: string;
}

interface ParsedEffect {
  name: string;
  operator: "=" | "+=" | "-=" | "toggle";
  rawValue: string;
}

function parseConditionExpression(expression: string): ParsedConditionTerm[] | null {
  const terms = expression.trim().split(/\s*&&\s*/);
  if (terms.some((term) => !term)) return null;
  const parsed: ParsedConditionTerm[] = [];
  for (const term of terms) {
    const match = term.match(/^(!?)([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*(==|!=|>=|<=|>|<)\s*(.+))?$/);
    if (!match) return null;
    const negated = match[1] === "!";
    const operator = match[3] as ParsedConditionTerm["operator"];
    if (negated && operator) return null;
    parsed.push({ negated, name: match[2], operator, rawExpected: match[4] ?? "" });
  }
  return parsed;
}

function parseEffectTerm(value: string): ParsedEffect | null {
  const match = value.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*(toggle|\+=|-=|=)\s*(.*)$/);
  if (!match) return null;
  const operator = match[2] as ParsedEffect["operator"];
  const rawValue = match[3].trim();
  if ((operator === "toggle" && rawValue) || (operator !== "toggle" && !rawValue)) return null;
  return { name: match[1], operator, rawValue };
}

function parseLiteral(value: string): boolean | number | string {
  const source = value.trim();
  if (source === "true") return true;
  if (source === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return Number(source);
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) return source.slice(1, -1);
  return source;
}

function formatYarnValue(value: boolean | number | string) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function buildYarnVariableNames(variables: StoryVariable[]) {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const variable of variables) {
    if (result.has(variable.name)) continue;
    const source = variable.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "").slice(0, 80) || "variable";
    let candidate = source;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${source}_${suffix++}`;
    used.add(candidate);
    result.set(variable.name, candidate);
  }
  return result;
}

function toYarnCondition(
  value: string,
  variables: ReadonlyMap<string, StoryVariable>,
  yarnNames: ReadonlyMap<string, string>,
) {
  const terms = parseConditionExpression(value);
  if (!terms) return "false";
  return terms.map((term) => {
    const variable = variables.get(term.name);
    const yarnName = yarnNames.get(term.name);
    if (!variable || !yarnName) return "false";
    if (!term.operator) return `${term.negated ? "not " : ""}$${yarnName}`;
    const parsed = parseLiteral(term.rawExpected);
    const expected = variable.type === "string" ? String(parsed) : parsed;
    return `$${yarnName} ${term.operator} ${formatYarnValue(expected)}`;
  }).join(" and ");
}

function toYarnEffect(
  value: string,
  variables: ReadonlyMap<string, StoryVariable>,
  yarnNames: ReadonlyMap<string, string>,
) {
  const effect = parseEffectTerm(value);
  if (!effect) return undefined;
  const variable = variables.get(effect.name);
  const yarnName = yarnNames.get(effect.name);
  if (!variable || !yarnName) return undefined;
  if (effect.operator === "toggle") return variable.type === "boolean" ? `$${yarnName} = not $${yarnName}` : undefined;
  const parsed = parseLiteral(effect.rawValue);
  if (effect.operator === "+=" || effect.operator === "-=") {
    const operand = Number(parsed);
    return variable.type === "number" && Number.isFinite(operand) ? `$${yarnName} ${effect.operator} ${operand}` : undefined;
  }
  if (variable.type === "boolean" && typeof parsed !== "boolean") return undefined;
  if (variable.type === "number" && !Number.isFinite(Number(parsed))) return undefined;
  const assigned = variable.type === "string" ? String(parsed) : variable.type === "number" ? Number(parsed) : parsed;
  return `$${yarnName} = ${formatYarnValue(assigned)}`;
}

function technicalName(node: StoryNode) {
  const source = node.title.trim().replace(/[^A-Za-z0-9_\u3400-\u9fff]+/g, "_").replace(/^_+|_+$/g, "");
  const suffix = node.id.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(-10) || "node";
  return `${source || "Node"}_${suffix}`;
}

function uniqueIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const used = new Set<string>();
  return items.map((item) => {
    let id = item.id;
    if (!id || used.has(id)) id = newId(prefix);
    used.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function repairStateReferences(state: {
  documents: WritingDocument[];
  entities: WritingEntity[];
  variables: StoryVariable[];
  storyNodes: StoryNode[];
}) {
  const entityIds = new Set(state.entities.map((entity) => entity.id));
  const linkedIds = (values: string[]) => [...new Set(values.filter((id) => entityIds.has(id)))];
  return {
    documents: state.documents.map((document) => ({ ...document, linkedEntityIds: linkedIds(document.linkedEntityIds) })),
    entities: state.entities.map((entity) => ({
      ...entity,
      relations: uniqueIds(entity.relations.filter((relation) => relation.targetId !== entity.id && entityIds.has(relation.targetId)), "relation"),
    })),
    variables: state.variables,
    storyNodes: state.storyNodes.map((node) => ({
      ...node,
      linkedEntityIds: linkedIds(node.linkedEntityIds),
      speakerEntityId: node.speakerEntityId && entityIds.has(node.speakerEntityId) ? node.speakerEntityId : undefined,
    })),
  };
}

function isProjectType(value: unknown): value is WritingProjectType {
  return value === "novel" || value === "screenplay" || value === "game";
}

function isDocumentKind(value: unknown): value is WritingDocumentKind {
  return value === "chapter" || value === "scene" || value === "outline" || value === "note";
}

function isEntityKind(value: unknown): value is WritingEntityKind {
  return value === "character" || value === "location" || value === "faction" || value === "item"
    || value === "world" || value === "plot" || value === "rule" || value === "quest" || value === "custom";
}

function isNodeType(value: unknown): value is StoryNodeType {
  return value === "scene" || value === "dialogue" || value === "choice" || value === "condition" || value === "ending";
}

function isSafeWritingProjectId(value: string) {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(safeString).map((item) => item.trim()).filter(Boolean))] : [];
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function newId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

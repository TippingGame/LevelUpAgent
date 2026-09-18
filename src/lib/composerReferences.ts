import type { SkillInfo } from "./types";

export interface ComposerTrigger { kind: "skill" | "file"; start: number; end: number; query: string }
export interface WorkspaceFileMatch { path: string; name: string }
export interface WorkspaceFileSearch { files: WorkspaceFileMatch[]; truncated: boolean }

// Only a new token opens the picker; emails, URLs and existing paths stay text.
export function composerTrigger(text: string, caret: number): ComposerTrigger | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s（(])([/@])([^\s@]*)$/u.exec(before);
  if (!match || (match[1] === "/" && /[/\\]/.test(match[2]))) return null;
  const start = before.length - match[2].length - 1;
  return { kind: match[1] === "/" ? "skill" : "file", start, end: caret, query: match[2] };
}

export function replaceComposerTrigger(text: string, trigger: ComposerTrigger, reference: string) {
  const suffix = text.slice(trigger.end);
  const insert = reference + (suffix.startsWith(" ") ? "" : " ");
  return { text: text.slice(0, trigger.start) + insert + suffix, caret: trigger.start + insert.length };
}

export function skillReference(skill: Pick<SkillInfo, "id" | "name">): string {
  const name = skill.name.replace(/[\\\[\]]/g, "\\$&");
  return `[$${name}](levelup-skill:${encodeURIComponent(skill.id)})`;
}

export function fileReference(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const label = normalized.replace(/[\\\[\]]/g, "\\$&");
  return `[@${label}](levelup-file:${encodeURIComponent(normalized)})`;
}

export function matchingSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const needle = query.toLocaleLowerCase();
  return skills.filter((skill) => skill.enabled && skill.valid && `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => Number(!left.name.toLocaleLowerCase().startsWith(needle)) - Number(!right.name.toLocaleLowerCase().startsWith(needle)) || left.name.localeCompare(right.name))
    .slice(0, 40);
}

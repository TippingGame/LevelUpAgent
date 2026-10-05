import { SPINE_LIMITS, createSpinePart, plannedSpinePartId, validateSpinePartPlan, validateSpineProject, type SpineClip, type SpineNewPartDraft, type SpinePart, type SpineProject } from "./spine";
export { plannedSpinePartId, validateSpinePartPlan };
export type { SpineNewPartDraft };

type PartChange = Partial<Pick<SpinePart, "name" | "parent" | "role" | "x" | "y" | "width" | "height" | "pivotX" | "pivotY" | "flexibility" | "skinDirection">> & { id: string };
export interface SpineAssistantProposal {
  reply: string;
  parts?: PartChange[];
  clips?: Array<Pick<SpineClip, "name" | "duration" | "tracks">>;
  newParts?: SpineNewPartDraft[];
  /** Complete list of existing part IDs, back-to-front. */
  drawOrder?: string[];
}

export function orderSpinePlannedParts(parts: SpinePart[], drafts: SpineNewPartDraft[], planId?: string): SpinePart[] {
  const ranks = new Map(drafts.map((draft, index) => [plannedSpinePartId(draft.key, planId), draft.drawOrder ?? index]));
  const planned = parts.filter((part) => ranks.has(part.id)).sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  let index = 0;
  return parts.map((part) => ranks.has(part.id) ? planned[index++] : part);
}

export function createSpinePlannedPart(project: SpineProject, draft: SpineNewPartDraft, image: string, imageWidth: number, imageHeight: number): SpinePart {
  const source = project.sourceImage;
  if (!source) throw new Error("A source image is required to place planned parts.");
  const scale = 480 / Math.max(source.width, source.height);
  const width = (draft.right - draft.left) * source.width * scale;
  const height = (draft.bottom - draft.top) * source.height * scale;
  return {
    ...createSpinePart(draft.name, image, imageWidth, imageHeight, draft.role),
    id: plannedSpinePartId(draft.key, project.rigPartPlan?.id),
    parent: draft.parent === null ? null : project.parts.some((part) => part.id === draft.parent)
      ? draft.parent : plannedSpinePartId(draft.parent, project.rigPartPlan?.id),
    x: (source.width * (draft.left + (draft.right - draft.left) * draft.pivotX) - source.width / 2) * scale,
    y: source.height * (1 - draft.top - (draft.bottom - draft.top) * draft.pivotY) * scale,
    width, height, pivotX: draft.pivotX, pivotY: draft.pivotY, flexibility: draft.flexibility,
    skinDirection: draft.skinDirection,
  };
}

export function parseSpineAssistantProposal(text: string): SpineAssistantProposal {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("The rig assistant did not return valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rig proposal must be a JSON object.");
  const proposal = value as Record<string, unknown>;
  if (typeof proposal.reply !== "string" || proposal.reply.length > 12000 ||
      (proposal.parts !== undefined && (!Array.isArray(proposal.parts) || proposal.parts.length > SPINE_LIMITS.parts)) ||
      (proposal.clips !== undefined && (!Array.isArray(proposal.clips) || proposal.clips.length > SPINE_LIMITS.clips)) ||
      (proposal.newParts !== undefined && (!Array.isArray(proposal.newParts) || proposal.newParts.length > SPINE_LIMITS.parts)) ||
      (proposal.drawOrder !== undefined && (!Array.isArray(proposal.drawOrder) || proposal.drawOrder.length > SPINE_LIMITS.parts)))
    throw new Error("Rig proposal has invalid content or exceeds limits.");
  return proposal as unknown as SpineAssistantProposal;
}

export function applySpineAssistantProposal(project: SpineProject, proposal: SpineAssistantProposal): SpineProject {
  if (proposal.newParts?.length) validateSpinePartPlan(project, proposal.newParts);
  const ids = new Set(project.parts.map((part) => part.id));
  const changes = new Map<string, PartChange>();
  for (const change of proposal.parts ?? []) {
    if (!change || typeof change !== "object" || !ids.has(change.id) || changes.has(change.id))
      throw new Error("Rig proposal refers to an unknown or duplicate part.");
    const allowed = new Set(["id", "name", "parent", "role", "x", "y", "width", "height", "pivotX", "pivotY", "flexibility", "skinDirection"]);
    if (Object.keys(change).some((key) => !allowed.has(key))) throw new Error("Rig proposal contains unsupported part fields.");
    changes.set(change.id, change);
  }
  let parts = project.parts.map((part) => ({ ...part, ...changes.get(part.id) }));
  if (proposal.drawOrder !== undefined) {
    const order = proposal.drawOrder;
    if (order.length !== parts.length || new Set(order).size !== parts.length || order.some((id) => !ids.has(id)))
      throw new Error("Draw order must list every existing part exactly once.");
    const byId = new Map(parts.map((part) => [part.id, part]));
    parts = order.map((id) => byId.get(id)!);
  }
  const clips = [...project.clips];
  for (const item of proposal.clips ?? []) {
    if (!item || typeof item !== "object" || !item.tracks || typeof item.tracks !== "object")
      throw new Error("Rig proposal contains an invalid animation.");
    if (Object.keys(item.tracks).some((id) => !ids.has(id)))
      throw new Error("Animation refers to an unknown part.");
    const same = clips.findIndex((clip) => clip.name === item.name);
    const id = same >= 0 ? clips[same].id : `clip_${crypto.randomUUID().replace(/-/g, "")}`;
    const clip = { id, name: item.name, duration: item.duration, tracks: item.tracks };
    if (same >= 0) clips[same] = clip;
    else clips.push(clip);
  }
  return validateSpineProject({ ...project, parts, clips, updatedAt: Date.now() });
}

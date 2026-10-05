import { useEffect, useRef, useState } from "react";
import { Bot, Check, Layers3, Send, X } from "lucide-react";
import { agentTurn, getModelCatalog, getProviderSettings, importClipboardImages, isDesktop } from "../lib/bridge";
import { tr } from "../lib/i18n";
import { isTextGenerationModel } from "../lib/modelSelection";
import { applySpineAssistantProposal, parseSpineAssistantProposal, plannedSpinePartId, validateSpinePartPlan, type SpineAssistantProposal, type SpineNewPartDraft } from "../lib/spineAssistant";
import type { SpineClip, SpineProject } from "../lib/spine";
import { createSpineAssistantImages, createSpineMotionImage, spineAssistantImageFile, type SpineAssistantImage } from "../lib/spineAssistantImages";
import type { AgentMessage, ImageAttachment, ProviderModelInfo, ProviderProfile } from "../lib/types";

const instructions = `You are a 2D skeletal-animation rigging assistant for characters AND arbitrary objects. Return ONLY a JSON object with a short "reply" and optional "newParts", "parts", "clips" arrays. When asked to decompose a source image, propose newParts: [{"key":"unique_lowercase_key","name":"visible layer name","description":"precise visual content to generate, including plausible hidden attachment ends","role":"body|head|arm-left|arm-right|leg-left|leg-right|other","parent":null,"left":0.1,"top":0.1,"right":0.9,"bottom":0.9,"pivotX":0.5,"pivotY":0.5,"flexibility":0}]. Bounds are fractions of the FULL source canvas, origin at top-left, and describe each part's visible region. Order parent parts before children; parent is an earlier newParts key, an existing part ID, or null. Order layers roughly back-to-front. For non-human objects use role "other" and their real component names. Propose at most the number of remaining slots (24 total). These are generation plans, not existing images; never claim a layer has already been reconstructed. For changes to existing bones use parts: [{"id":"existing part id","parent":"existing id or null","role":"other","x":0,"y":0,"width":100,"height":100,"pivotX":0.5,"pivotY":0.5,"flexibility":0.5}]. For animation use clips: [{"name":"action name","duration":2,"tracks":{"existing part id":[{"time":0,"rotation":0,"bend":0,"x":0,"y":0,"curve":"linear"}]}}]. Omit unchanged fields and arrays. Clips refer only to existing part IDs; plan new parts first, then propose their clips in a later turn after images exist. All rig coordinates are Y-up; animation x/y are offsets from setup pose. Parent graph must be acyclic. Keys must be time-ordered in [0,duration]. Rotation and bend are degrees in [-360,360]. State uncertainty about occluded regions. Do not call tools.`;

const drawOrderInstructions = `Separate bone parentage from visual stacking: keep newParts parent-first for generation, and include integer drawOrder (0..23) on every new part, smaller values behind larger values. Hair behind a face and legs behind clothing can still be child bones. To change stacking of existing images, return a top-level drawOrder array containing EVERY existing part ID exactly once, ordered back-to-front. Include this array when correcting occlusion; do not change parentage just to reorder images.`;
const keyInstructions = `Every animation key MUST explicitly contain time, rotation, bend, x, y and curve. Use numeric 0 for unused rotation, bend and translations; never omit these fields from a key. The rule to omit unchanged fields applies only to part patches. A clip replaces all tracks of an existing same-named clip, so include every track that must remain in that clip. For a looping clip, match the first and final pose.`;
const visualInstructions = `Attached images are labeled in Visual evidence. Source image is the intended design; setup assembly and part sheets show the ACTUAL generated textures and current rig. Use these to diagnose gaps, unwanted painted content, distorted proportions, pivots and occlusion. Part # labels map to the back-to-front part list. Bone x/y are absolute world-space setup pivots, not parent-local. To change pivotX/pivotY without moving artwork, adjust x by width*(newPivotX-oldPivotX) and y by -height*(newPivotY-oldPivotY). A geometry change cannot erase unwanted painted sleeves, necks or backgrounds; explain when the user should redraw the affected part. Never claim to have inspected motion from the static setup picture.`;
const skinInstructions = `Weighted skinning is available on every part. Set flexibility in [0,1] (0=rigid) and skinDirection (down/up/left/right, default down), pointing from the pivot into the deforming region. New part plans may include skinDirection too. Animation keys may additionally include scaleX/scaleY (0.25..2, neutral 1) and tipX/tipY (-1000..1000, neutral 0). These scale and translate the WEIGHTED end bone in the part local axes; they do not scale the whole part or its child parts. The attachment near the pivot stays anchored; stronger effects occur toward the selected edge. Use moderate deformation for breathing, squash/stretch, recoil, tails, foliage and cloth, with anticipation, follow-through and distinct timing. Do not reduce every action to side-to-side rotation. Include flexibility/skinDirection patches when the requested deformation requires enabling skinning; keep mechanical rigid parts rigid. Check seams using supplied rendered evidence and match all channels at loop endpoints. For a generated replacement texture use the texture retouch panel; do not re-plan already existing parts unless requested.`;
const motionInstructions = `When an ACTUAL SAMPLED ANIMATION sheet is attached, inspect the labeled times of the selected clip. All frames share a fixed camera, so preserve visible translations in your reasoning. Use these frames to review joint gaps, overlap, amplitude and first/last pose closure. The sheet is sparse evidence, not video: do not claim that unsampled motion or loop velocity was verified. Cite only frame numbers and times explicitly listed in the attached sheet and its description; do not invent evenly spaced sample times or describe unsampled instants as visual observations. Distinguish any inference from what a labeled frame actually shows. When modifying the current action, use its exact name to replace it, preserving every track that should remain. Animation x/y are PARENT-LOCAL offsets from setup; positive rotation is counter-clockwise, with inherited parent rotation. A rigid hinged part normally has x=y=bend=0. Do not hide texture defects by claiming a bone correction erased them.`;

export function SpineAssistantPanel({ project, clip, time = 0, onUpdate, onApply, onGenerate, canGenerate, mediaCatalogRevision = 0, externalBusy = false }: {
  project: SpineProject;
  clip?: SpineClip;
  time?: number;
  onUpdate: (change: (project: SpineProject) => SpineProject) => void;
  onApply: (proposal: SpineAssistantProposal) => void;
  onGenerate: (drafts: SpineNewPartDraft[]) => Promise<void>;
  canGenerate: boolean;
  mediaCatalogRevision?: number;
  externalBusy?: boolean;
}) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [route, setRoute] = useState("");
  const [input, setInput] = useState("");
  const [proposal, setProposal] = useState<SpineAssistantProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [failedRequest, setFailedRequest] = useState("");
  const sending = useRef(false);
  const activeRequest = useRef("");
  const [motionEvidence, setMotionEvidence] = useState<SpineAssistantImage>();
  const attachment = useRef<{ image: string; value: ImageAttachment } | undefined>(undefined);
  const rigImages = useRef<{ parts: SpineProject["parts"]; values: ImageAttachment[]; descriptions: string[] } | undefined>(undefined);
  const state = useRef({ project, clipId: clip?.id });
  state.current = { project, clipId: clip?.id };
  const proposalBase = useRef<typeof state.current | undefined>(undefined);
  const serial = useRef(0);
  const sameContext = (context: typeof state.current) => {
    const latest = state.current;
    return latest.project.id === context.project.id && latest.clipId === context.clipId &&
      latest.project.parts === context.project.parts && latest.project.clips === context.project.clips &&
      latest.project.sourceImage?.id === context.project.sourceImage?.id &&
      latest.project.sourceImage?.image === context.project.sourceImage?.image &&
      latest.project.sourceImage?.originalImage === context.project.sourceImage?.originalImage;
  };
  useEffect(() => {
    setProposal(undefined);
    proposalBase.current = undefined;
    setMotionEvidence(undefined);
  }, [project.id, project.parts, project.clips, project.sourceImage?.id, project.sourceImage?.image, project.sourceImage?.originalImage, clip?.id]);
  useEffect(() => {
    serial.current++;
    sending.current = false; activeRequest.current = "";
    setBusy(false); setError(""); setFailedRequest("");
    attachment.current = undefined;
    rigImages.current = undefined;
    return () => { serial.current++; };
  }, [project.id]);
  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    void Promise.all([getProviderSettings(), getModelCatalog()]).then(([settings, catalog]) => {
      if (!active) return;
      setProfiles(settings?.profiles ?? []);
      const available = catalog.models.filter(isTextGenerationModel);
      setModels(available);
      setRoute((value) => value || `${settings?.activeProfileId ?? available[0]?.profileId}::${settings?.profiles.find((p) => p.id === settings.activeProfileId)?.model ?? available[0]?.id}`);
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [mediaCatalogRevision, catalogRevision]);
  const selected = models.find((model) => `${model.profileId}::${model.id}` === route) ?? models[0];
  const drafts = proposal?.newParts?.length ? proposal.newParts : project.rigPartPlan?.drafts;
  const submit = async (retry?: string) => {
    const request = (retry ?? input).trim();
    if (!request || sending.current || busy || externalBusy || !selected) return;
    const base = profiles.find((profile) => profile.id === selected.profileId);
    if (!base) { setError(tr("未找到会话连接", "Conversation connection unavailable")); return; }
    sending.current = true; activeRequest.current = request;
    setBusy(true); setError(""); setFailedRequest(""); setProposal(undefined); setInput("");
    setMotionEvidence(undefined);
    const ticket = ++serial.current;
    const contextAtSend = { project, clipId: clip?.id };
    const assertCurrent = () => {
      if (ticket !== serial.current || !sameContext(contextAtSend))
        throw new Error(tr("工程或当前动作已改变，请重新发送需求", "The project or selected clip changed; send the request again"));
    };
    const entry = { id: `msg_${crypto.randomUUID().replace(/-/g, "")}`, role: "user" as const, content: request, createdAt: Date.now() };
    try {
    onUpdate((current) => current.id === project.id
      ? { ...current, rigConversation: [...(current.rigConversation ?? []), entry].slice(-80) }
      : current);
      let images: ImageAttachment[] = [];
      const descriptions: string[] = [];
      if (project.sourceImage) {
        if (attachment.current?.image !== project.sourceImage.image) {
          const file = spineAssistantImageFile({ image: project.sourceImage.image, name: "spine-source.png" });
          const [value] = await importClipboardImages([file]);
          assertCurrent();
          if (!value) throw new Error(tr("整图未能附加到会话", "Could not attach the source image to the conversation"));
          attachment.current = { image: project.sourceImage.image, value };
        }
        if (attachment.current) images = [attachment.current.value];
        descriptions.push(`Source image: intended design, ${project.sourceImage.width}x${project.sourceImage.height}px, full canvas.`);
      }
      if (project.parts.length) {
        if (rigImages.current?.parts !== project.parts) {
          const visual = await createSpineAssistantImages(project.parts);
          const values = await importClipboardImages(visual.map(spineAssistantImageFile));
          assertCurrent();
          if (values.length !== visual.length) throw new Error(tr("装配参考图未能完整附加到会话", "Could not attach all rig reference images"));
          rigImages.current = { parts: project.parts, values, descriptions: visual.map((item) => item.description) };
        }
        images.push(...rigImages.current.values);
        descriptions.push(...rigImages.current.descriptions);
      }
      if (project.parts.length && clip) {
        const visual = await createSpineMotionImage(project.parts, clip, time);
        assertCurrent();
        const [value] = await importClipboardImages([spineAssistantImageFile(visual)]);
        assertCurrent();
        if (!value) throw new Error(tr("动作采样图未能附加到会话", "Could not attach the animation sample sheet"));
        images.push(value); descriptions.push(visual.description);
        setMotionEvidence(visual);
      }
      const geometry = project.parts.map(({ id, name, parent, role, x, y, width, height, pivotX, pivotY, flexibility, skinDirection }) =>
        ({ id, name, parent, role, x, y, width, height, pivotX, pivotY, flexibility, skinDirection }));
      const context = `Project: ${project.name}\nDescription: ${project.prompt}\nParts back-to-front: ${JSON.stringify(geometry)}\nExisting clips: ${JSON.stringify(project.clips)}\nSelected clip: ${clip ? JSON.stringify({ id: clip.id, name: clip.name, duration: clip.duration, focusTime: time }) : "None; no animation evidence"}\nVisual evidence:\n${descriptions.map((description, index) => `Image ${index + 1}: ${description}`).join("\n") || "No images available"}\nRemaining part slots: ${24 - project.parts.length}\nCurrent request: ${request}`;
      const history = (project.rigConversation ?? []).slice(-10).map((message): AgentMessage => ({
        ...message, toolCalls: [], attachments: [],
      }));
      const messages: AgentMessage[] = [...history, { ...entry, content: context, toolCalls: [], attachments: images }];
      let next: SpineAssistantProposal | undefined;
      let requestMessages = messages;
      for (let attempt = 0; attempt < 2; attempt++) {
        assertCurrent();
        const response = await agentTurn({ ...base, model: selected.id, protocol: selected.protocol }, requestMessages, "chat", undefined, undefined, [], false, false, `${instructions}\n${drawOrderInstructions}\n${keyInstructions}\n${visualInstructions}\n${motionInstructions}\n${skinInstructions}`);
        assertCurrent();
        try {
          const candidate = parseSpineAssistantProposal(response.content);
          applySpineAssistantProposal(project, candidate);
          next = candidate;
          break;
        } catch (reason) {
          if (attempt > 0) throw reason;
          const validationError = reason instanceof Error ? reason.message : String(reason);
          requestMessages = [...messages, {
            id: `repair_${crypto.randomUUID()}`, createdAt: Date.now(), role: "assistant", content: response.content, toolCalls: [], attachments: [],
          }, {
            id: `repair_${crypto.randomUUID()}`, createdAt: Date.now(), role: "user", content: `The proposal was rejected before any changes were applied: ${validationError}. Return a corrected complete JSON proposal for the same request. Every key must include time, rotation, bend, x, y, curve. Keep only valid existing part IDs and numeric values.`, toolCalls: [], attachments: [],
          }];
        }
      }
      if (!next) throw new Error(tr("模型未返回有效方案", "No valid proposal returned"));
      const acceptedProposal = next;
      let accepted = false;
      onUpdate((current) => {
        if (current.id !== project.id || current.parts !== project.parts || current.clips !== project.clips ||
            current.sourceImage?.id !== project.sourceImage?.id ||
            current.sourceImage?.originalImage !== project.sourceImage?.originalImage) return current;
        applySpineAssistantProposal(current, acceptedProposal);
        const sourceId = current.sourceImage?.id ?? `source_${crypto.randomUUID().replace(/-/g, "")}`;
        const planId = `plan_${crypto.randomUUID().replace(/-/g, "")}`;
        if (acceptedProposal.newParts?.length) validateSpinePartPlan(current, acceptedProposal.newParts, planId);
        accepted = true;
        return {
          ...current,
          sourceImage: acceptedProposal.newParts?.length && current.sourceImage ? { ...current.sourceImage, id: sourceId } : current.sourceImage,
          rigPartPlan: acceptedProposal.newParts?.length ? { id: planId, sourceId, drafts: acceptedProposal.newParts } : current.rigPartPlan,
          rigConversation: [...(current.rigConversation ?? []), {
            id: `msg_${crypto.randomUUID().replace(/-/g, "")}`, role: "assistant" as const, content: acceptedProposal.reply, createdAt: Date.now(),
          }].slice(-80),
        };
      });
      if (accepted) { proposalBase.current = contextAtSend; setProposal(next); }
      else throw new Error(tr("生成期间工程的骨骼、动作或整图已改变，请重新发送需求", "The rig, clips or source changed during generation; send the request again"));
    } catch (reason) {
      if (ticket === serial.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setFailedRequest(request);
        setInput((draft) => draft || request);
      }
    } finally {
      if (ticket === serial.current) { sending.current = false; activeRequest.current = ""; setBusy(false); }
    }
  };
  return <section className="spine-assistant">
    <div className="spine-section-title"><Bot size={17} /><h2>{tr("部件、蒙皮与动作", "Parts, skin & motion")}</h2></div>
    <select disabled={busy} aria-label={tr("骨骼会话模型", "Rig assistant model")} value={selected ? `${selected.profileId}::${selected.id}` : ""} onChange={(event) => setRoute(event.target.value)}>
      {!models.length && <option value="">{tr("未配置文本模型", "No text model configured")}</option>}
      {models.map((model) => <option key={`${model.profileId}::${model.id}`} value={`${model.profileId}::${model.id}`}>{model.id} · {model.profileName}</option>)}
    </select>
    <div className="spine-assistant-messages" aria-label={tr("骨骼会话记录", "Rig conversation")}>{(project.rigConversation ?? []).map((message) =>
      <p key={message.id} className={message.role}><strong>{message.role === "user" ? tr("我", "You") : "AI"}</strong>{message.content}</p>)}</div>
    {!!project.parts.length && <p className="spine-hint">{tr("发送时会附上原图、当前绑定姿态装配图和带枢轴的分件对照图。", "Each request includes the source, current setup assembly, and individual textures with pivots.")}</p>}
    {!!project.parts.length && clip && <p className="spine-hint">{tr(`同时附上「${clip.name}」的九帧动作采样，含首尾帧和发送时的时间轴位置。`, `Also includes nine sampled moments of “${clip.name}”, including both endpoints and the timeline position at send time.`)}</p>}
    {motionEvidence && <details className="spine-motion-evidence"><summary>{tr("本次会话的动作采样", "Animation samples sent with this request")}</summary><img src={motionEvidence.image} alt={tr("同一视角下按时间排列的当前动作采样", "Current animation sampled chronologically with a fixed camera")} style={{ width: "100%", height: "auto" }} /><p className="spine-hint">{tr("采样图用于检查姿态、接缝和遮挡；连续运动仍需播放检查。", "Review poses, joints and occlusion here; use playback to inspect continuous motion.")}</p></details>}
    {(proposal || drafts?.length) && <div className="spine-assistant-proposal">
      <span>{tr(`${drafts?.length ?? 0} 个新部件 · ${proposal?.parts?.length ?? 0} 个骨骼调整 · ${proposal?.clips?.length ?? 0} 个动作`, `${drafts?.length ?? 0} new parts · ${proposal?.parts?.length ?? 0} rig edits · ${proposal?.clips?.length ?? 0} clips`)}</span>
      {!!proposal?.drawOrder && <small>{tr("包含绘制顺序调整", "Includes layer order changes")}</small>}
      {!!drafts?.length && <div className="spine-assistant-drafts">{drafts.map((draft) => <div key={draft.key}>
        <strong>{draft.name}</strong><small>{draft.description}</small><small>{draft.parent ?? "root"} · {project.parts.some((part) => part.id === plannedSpinePartId(draft.key, project.rigPartPlan?.id)) ? tr("已生成", "Generated") : tr("待生成", "Pending")}</small>
      </div>)}</div>}
      <div className="spine-button-row">
        {!!drafts?.length && <button className="primary" disabled={!canGenerate || busy || drafts.every((draft) => project.parts.some((part) => part.id === plannedSpinePartId(draft.key, project.rigPartPlan?.id)))} onClick={() => { setBusy(true); setError(""); void onGenerate(drafts).catch((reason) => setError(String(reason))).finally(() => setBusy(false)); }}><Layers3 size={14} />{tr("生成草案部件", "Generate planned parts")}</button>}
        {!!(proposal?.parts?.length || proposal?.clips?.length || proposal?.drawOrder) && <button disabled={busy} onClick={() => { try { if (!proposalBase.current || !sameContext(proposalBase.current)) throw new Error(tr("方案已过期，请重新发送需求", "The proposal is stale; send the request again")); onApply(proposal!); setProposal((current) => current?.newParts?.length ? { ...current, parts: undefined, clips: undefined, drawOrder: undefined } : undefined); } catch (reason) { setError(String(reason)); } }}><Check size={14} />{tr("应用骨骼与动作", "Apply rig & motion")}</button>}
        {!!drafts?.length && <button type="button" disabled={busy} title={tr("清除拆件草案", "Clear part plan")} aria-label={tr("清除拆件草案", "Clear part plan")} onClick={() => { onUpdate((current) => ({ ...current, rigPartPlan: undefined })); setProposal((current) => current ? { ...current, newParts: undefined } : undefined); }}><X size={14} /></button>}
      </div>
    </div>}
    <div className="spine-chat-shortcuts">{(project.parts.length ? [tr("制作有蓄力、挤压回弹和跟随动作的动画，启用适合的柔性蒙皮", "Create anticipation, squash/stretch and follow-through using suitable skinning"), tr("根据装配修正接缝、枢轴和遮挡", "Fix seams, pivots and overlap from the assembly")] : [tr("根据整图规划可独立运动的部件，补齐连接处，并设置柔性蒙皮方向", "Plan movable parts from the source, including attachment ends and skin direction")]).map((text) => <button key={text} disabled={busy} onClick={() => setInput(text)}>{text}</button>)}</div>
    <textarea aria-label={tr("部件、骨骼或动作需求", "Parts, rig or animation request")} value={input} onChange={(event) => setInput(event.target.value)} maxLength={4000} placeholder={tr("例如：把这张机械鸟分为身体、双翼和尾羽；生成后再做扇翼动作", "For example: split this mechanical bird into body, wings and tail; then animate the wings")} />
    <button disabled={!selected || !input.trim() || busy || externalBusy} onClick={() => void submit()}><Send size={14} />{busy ? tr("生成方案中…", "Proposing…") : tr("发送", "Send")}</button>
    {busy && sending.current && <button onClick={() => {
      const stoppedRequest = activeRequest.current;
      serial.current++; sending.current = false; setBusy(false);
      setInput((draft) => draft || stoppedRequest); activeRequest.current = "";
      setError(tr("已停止等待，可以再次发送；服务端请求可能仍在执行。", "Stopped waiting; you can send again. The server request may still be running."));
    }}>{tr("停止等待", "Stop waiting")}</button>}
    {error && <div className="spine-chat-error"><p className="spine-layer-error" role="alert">{error}</p>
      <div className="spine-button-row">
        {!!failedRequest && <button disabled={busy || externalBusy || !selected} onClick={() => void submit(input.trim() || failedRequest)}>{tr("重试发送", "Retry request")}</button>}
        {!models.length && <button onClick={() => { setError(""); setCatalogRevision((value) => value + 1); }}>{tr("重新加载会话模型", "Reload chat models")}</button>}
        <button onClick={() => setError("")}>{tr("关闭提示", "Dismiss")}</button>
      </div>
    </div>}
  </section>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { agentTurn, getModelCatalog, getProviderSettings, importClipboardImages, isDesktop } from "../lib/bridge";
import { createSpineAssistantImages, spineAssistantImageFile } from "../lib/spineAssistantImages";
import { parseSpinePoseInference, type SpinePoseInference } from "../lib/spineMotion";
import { compareSpinePose, renderSpinePoseImage, type SpinePoseComparison } from "../lib/spinePoseComparison";
import { refineSpinePose, type SpinePoseFitProgress, type SpinePoseFitResult } from "../lib/spinePoseFit";
import { isTextGenerationModel } from "../lib/modelSelection";
import { tr } from "../lib/i18n";
import type { SpineClip, SpineMotionStudy, SpinePoseFrame, SpineProject } from "../lib/spine";
import type { AgentMessage, ProviderModelInfo, ProviderProfile } from "../lib/types";
import { SpineCanvas } from "./SpineCanvas";

const instructions = `You estimate editable 2D skeletal poses from images for characters AND arbitrary objects. Examine the TARGET pose image against the actual setup assembly and individual texture sheets. Return ONLY JSON: {"summary":"brief explanation of visual evidence, limitations and uncertainty in the user's language","targets":{"EVERY existing part ID":{"rotation":0,"bend":0,"x":0,"y":0}},"uncertain":["part IDs whose motion is ambiguous"]}. Include every current part, four numeric fields each, no new parts. Do not call tools.
Coordinate rules: setup part x/y are WORLD-space pivots, Y up. Setup rotation is zero for EVERY part; source textures already contain their setup orientation. Positive rotation is counter-clockwise in world space (visually counter-clockwise). Targets rotation and bend are degrees [-360,360]; x/y are offsets [-1000,1000] in PARENT-LOCAL world units, not pixels. Child world rotation = parent world rotation + target.rotation; child world pivot = parent world pivot + rotate(parent world rotation, [setupChild.x-setupParent.x+target.x, setupChild.y-setupParent.y+target.y]). Subtract inherited parent rotation when estimating a child's local rotation. Root parent is [0,0,0]. Texture width/height and pivots cannot change. A hinged part should normally have x=y=0. Use translation only for clear displacement; do not compensate for mere camera/framing differences. Bend deforms the lower portion of the image about a second bone 45% of its height below the pivot; default bend=0 for rigid objects and when that deformation cannot represent the image. Preserve hidden or ambiguous targets from current values and list their IDs in uncertain. Rotation is relative to SETUP texture direction, not the object's absolute angle in the image. Do not infer anatomy for non-human objects. Camera turns, new occlusion, texture redraws, scaling and topology changes may be impossible with this fixed rig; explain these limits instead of inventing exact measurements. Neighbor pose images only give motion context; fit the TARGET time. Do not claim pixel-perfect fitting or having inspected animation.`;

export function SpinePoseAssistant({ project, study, frame, disabled, onAccept, onClose }: {
  project: SpineProject;
  study: SpineMotionStudy;
  frame: SpinePoseFrame;
  disabled: boolean;
  onAccept: (inference: SpinePoseInference) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [route, setRoute] = useState("");
  const [request, setRequest] = useState("");
  const [proposal, setProposal] = useState<SpinePoseInference>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<SpinePoseComparison>();
  const [comparisonUnavailable, setComparisonUnavailable] = useState(false);
  const [rigOpacity, setRigOpacity] = useState(50);
  const [fitParts, setFitParts] = useState<string[]>([]);
  const [fitAngle, setFitAngle] = useState(30);
  const [fitBend, setFitBend] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [fitProgress, setFitProgress] = useState<SpinePoseFitProgress>();
  const [fitResult, setFitResult] = useState<SpinePoseFitResult>();
  const fitAbort = useRef<AbortController | null>(null);
  const fitBaseline = useRef<SpinePoseInference | undefined>(undefined);
  const state = useRef({ project, study, frame });
  state.current = { project, study, frame };
  const serial = useRef(0);
  useEffect(() => {
    setProposal(undefined);
    setBusy(false);
    setError("");
    fitAbort.current?.abort();
    setFitting(false); setFitProgress(undefined); setFitResult(undefined);
    serial.current++;
    return () => { serial.current++; fitAbort.current?.abort(); };
  }, [project.id, project.parts, project.clips, project.sourceImage, study, frame]);
  useEffect(() => {
    const children = project.parts.filter((part) => part.parent);
    setFitParts((children.length ? children : project.parts).map((part) => part.id));
  }, [project.parts]);
  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    void Promise.all([getProviderSettings(), getModelCatalog()]).then(([settings, catalog]) => {
      if (!active) return;
      setProfiles(settings?.profiles ?? []);
      setModels(catalog.models.filter(isTextGenerationModel));
      const profile = settings?.profiles.find((item) => item.id === settings.activeProfileId);
      if (profile) setRoute(`${profile.id}::${profile.model}`);
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);
  const selected = models.find((model) => `${model.profileId}::${model.id}` === route) ?? models[0];
  const reportError = useCallback((message: string) => setError(message), []);
  const preview: SpineClip = {
    id: "pose_preview", name: "Pose preview", duration: 1,
    tracks: Object.fromEntries(Object.entries(proposal?.targets ?? frame.targets).map(([id, target]) =>
      [id, [{ ...target, time: 0, curve: "linear" as const }]])),
  };
  useEffect(() => {
    let active = true;
    setComparison(undefined);
    setComparisonUnavailable(false);
    if (frame.image) void compareSpinePose(project.parts, proposal?.targets ?? frame.targets, frame.image)
      .then((result) => { if (active) setComparison(result); })
      .catch(() => { if (active) setComparisonUnavailable(true); });
    return () => { active = false; };
  }, [project.parts, frame.image, frame.targets, proposal?.targets]);
  const fit = async () => {
    if (busy || fitting || disabled || !frame.image || !fitParts.length) return;
    const controller = new AbortController();
    fitAbort.current = controller;
    const ticket = ++serial.current;
    const current = () => !controller.signal.aborted && ticket === serial.current &&
      state.current.project.parts === project.parts && state.current.study === study && state.current.frame === frame;
    fitBaseline.current = proposal;
    setFitting(true); setFitResult(undefined); setFitProgress(undefined); setError("");
    try {
      const result = await refineSpinePose(project.parts, proposal?.targets ?? frame.targets, frame.image, {
        partIds: fitParts, maxAngle: fitAngle, bend: fitBend, signal: controller.signal,
        onProgress: (progress) => { if (current()) setFitProgress(progress); },
      });
      if (!current()) return;
      setFitResult(result);
      if (result.after.loss < result.before.loss - 0.00001) setProposal({
        targets: result.targets,
        summary: tr(
          `本地角度微调：轮廓重合率 ${(result.before.overlap * 100).toFixed(1)}% → ${(result.after.overlap * 100).toFixed(1)}%。请检查连接与遮挡；分数改善不保证动作正确。`,
          `Local angle refinement: silhouette overlap ${(result.before.overlap * 100).toFixed(1)}% → ${(result.after.overlap * 100).toFixed(1)}%. Review joints and occlusion; a better score does not guarantee a correct pose.`),
        uncertain: [...new Set([...(proposal?.uncertain ?? []), ...fitParts])],
      });
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current()) setFitting(false); }
  };
  const cancelFit = () => {
    fitAbort.current?.abort(); setFitting(false); setFitProgress(undefined);
  };
  const submit = async () => {
    if (busy || fitting || disabled || !frame.image || !selected) return;
    const profile = profiles.find((item) => item.id === selected.profileId);
    if (!profile) { setError(tr("未找到会话连接", "Conversation connection unavailable")); return; }
    const ticket = ++serial.current;
    const current = () => ticket === serial.current && state.current.project.id === project.id &&
      state.current.project.parts === project.parts && state.current.project.clips === project.clips &&
      state.current.project.sourceImage === project.sourceImage && state.current.study === study && state.current.frame === frame;
    setBusy(true); setError(""); setFitResult(undefined); setFitProgress(undefined);
    try {
      const visual = await createSpineAssistantImages(project.parts);
      if (project.sourceImage) visual.unshift({ name: "spine-source.png", image: project.sourceImage.image,
        description: "Original intended design. Use actual assembly as the rig's setup orientation." });
      visual.push({ name: "spine-target-pose.png", image: frame.image,
        description: `TARGET pose to fit: ${frame.name}, time ${frame.time}s, ${frame.imageWidth}x${frame.imageHeight}px. User notes: ${frame.notes ?? ""}` });
      const currentPose = await renderSpinePoseImage(project.parts, proposal?.targets ?? frame.targets);
      if (!current()) return;
      visual.push({ name: "spine-current-pose.png", image: currentPose.image,
        description: "Actual rendered CURRENT targets (including any unaccepted proposal), foreground-centered and scaled to fit. Compare to TARGET to correct angles and overlap; this is not the setup image or a new texture." });
      const others = study.frames.filter((item) => item.id !== frame.id && item.image).sort((a, b) => a.time - b.time);
      const before = others.filter((item) => item.time < frame.time);
      const neighbors = [before[before.length - 1], others.find((item) => item.time > frame.time)];
      for (const neighbor of neighbors) if (neighbor?.image) visual.push({ name: `spine-neighbor-${neighbor.id}.png`, image: neighbor.image,
        description: `Neighbor reference, NOT the target: ${neighbor.name}, time ${neighbor.time}s.` });
      const attachments = await importClipboardImages(visual.map(spineAssistantImageFile));
      if (!current()) return;
      if (attachments.length !== visual.length) throw new Error(tr("姿态参考图未能完整附加", "Could not attach every pose reference"));
      const geometry = project.parts.map(({ id, name, parent, role, x, y, width, height, pivotX, pivotY, flexibility }) =>
        ({ id, name, parent, role, x, y, width, height, pivotX, pivotY, flexibility }));
      const context = `Pose inference for ${project.name}\nParts back-to-front: ${JSON.stringify(geometry)}\nCurrent targets: ${JSON.stringify(proposal?.targets ?? frame.targets)}\nVisual evidence:\n${visual.map((item, index) => `Image ${index + 1}: ${item.description}`).join("\n")}\nUser request: ${request.trim() || "请根据目标姿态图片推断骨骼姿态，用中文说明不确定部位。"}`;
      const messages: AgentMessage[] = [{ id: `pose_${crypto.randomUUID()}`, role: "user", content: context, createdAt: Date.now(), toolCalls: [], attachments }];
      let requestMessages = messages;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await agentTurn({ ...profile, model: selected.id, protocol: selected.protocol }, requestMessages, "chat", undefined, undefined, [], false, false, instructions);
        if (!current()) return;
        try { setProposal(parseSpinePoseInference(response.content, project.parts)); break; }
        catch (reason) {
          if (attempt) throw reason;
          requestMessages = [...messages,
            { id: `pose_${crypto.randomUUID()}`, role: "assistant", content: response.content, createdAt: Date.now(), toolCalls: [], attachments: [] },
            { id: `pose_${crypto.randomUUID()}`, role: "user", content: `Pose proposal rejected: ${String(reason)}. Return corrected complete JSON with summary, targets for EVERY part (rotation,bend,x,y), and uncertain part IDs. No changes have been applied.`, createdAt: Date.now(), toolCalls: [], attachments: [] }];
        }
      }
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current()) setBusy(false); }
  };
  return <section className="spine-pose-assistant" aria-label={tr("姿态识别与审阅", "Pose inference and review")}>
    <div className="spine-section-title"><h3>{frame.name} · {tr("姿态识别与审阅", "Pose inference and review")}</h3><button aria-label={tr("关闭姿态审阅", "Close pose review")} onClick={onClose}><X size={14} /></button></div>
    <p className="spine-hint">{tr("AI 会同时参考整图、装配、分件和相邻姿态图。请选用支持图片的会话模型，核对预览后再采纳；识别结果是估计值，可以继续描述修改。", "AI compares the source, assembly, textures and neighboring poses. Choose a vision-capable chat model and review the estimate before accepting. Describe corrections to refine it.")}</p>
    <div className="spine-pose-review-images">
      <figure><figcaption>{tr("目标姿态图", "Target pose")}</figcaption><img src={frame.image} alt={frame.name} /></figure>
      <figure><figcaption>{proposal ? tr("待采纳姿态预览", "Proposed pose preview") : tr("当前骨骼姿态", "Current rig pose")}</figcaption>
        <SpineCanvas parts={project.parts} clip={preview} time={0} selected="" bones={true} mesh={false} zoom={0.8} setup={false} disabled={true} onSelect={() => {}} onMove={() => {}} onError={reportError} />
      </figure>
    </div>
    {comparison && <div className="spine-pose-comparison">
      <div className="spine-pose-comparison-head"><strong>{tr("轮廓对照", "Silhouette comparison")}</strong>
        <span>{tr("轮廓重合", "Silhouette overlap")} {Math.round(comparison.overlap * 100)}%</span></div>
      <div className="spine-pose-comparison-stage" aria-label={tr("目标与骨骼轮廓叠图", "Target and rig silhouette overlay")}>
        <img src={comparison.target} alt={tr("目标轮廓", "Target silhouette")} />
        <img src={comparison.rig} alt={tr("骨骼轮廓", "Rig silhouette")} style={{ opacity: rigOpacity / 100 }} />
      </div>
      <label className="spine-pose-comparison-control">{tr("骨骼叠图透明度", "Rig overlay opacity")}
        <input type="range" min="0" max="100" value={rigOpacity} onChange={(event) => setRigOpacity(Number(event.target.value))} />
      </label>
      <p className="spine-hint">{tr("按前景外接框对齐后的轮廓重合率，仅供比较形状；生图重绘差异会影响结果。", "Silhouette overlap after foreground alignment compares shape only; redraw differences affect the result.")}</p>
    </div>}
    {comparisonUnavailable && <p className="spine-hint">{tr("轮廓对照不可用，请检查目标图背景、部件图片和预览是否正常。", "Comparison is unavailable. Check the target background, part images and preview.")}</p>}
    <fieldset className="spine-pose-fit" disabled={busy || fitting || disabled}>
      <legend>{tr("本地姿态微调", "Local pose refinement")}</legend>
      <p className="spine-hint">{tr("勾选允许转动的部件，以当前姿态为起点对照目标图微调。未勾选部件的局部角度固定，仍会跟随父骨骼。位移与绑定保持；结果需审阅采纳。", "Select parts allowed to rotate. Refine from the current pose against the target image. Unselected local angles stay fixed; children still follow parents. Translation and binding stay fixed. Review before accepting.")}</p>
      <div className="spine-pose-fit-parts">{project.parts.map((part) => <label key={part.id}>
        <input type="checkbox" checked={fitParts.includes(part.id)} onChange={(event) => setFitParts((previous) => event.target.checked ? [...previous, part.id] : previous.filter((id) => id !== part.id))} />{part.name}
      </label>)}</div>
      <div className="spine-button-row">
        <label>{tr("最大角度改动", "Maximum angle change")} <select value={fitAngle} onChange={(event) => setFitAngle(Number(event.target.value))}>
          {[5, 15, 30, 60].map((angle) => <option key={angle} value={angle}>±{angle}°</option>)}
        </select></label>
        <label><input type="checkbox" checked={fitBend} onChange={(event) => setFitBend(event.target.checked)} />{tr("允许柔性部件弯曲", "Allow flexible parts to bend")}</label>
        <button disabled={!comparison || !fitParts.length || busy || fitting || disabled} onClick={() => void fit()}>{tr("按目标图微调", "Refine against target")}</button>
      </div>
    </fieldset>
    {fitting && <div className="spine-button-row" role="status"><span>{tr("本地微调中", "Refining locally")} · {fitProgress?.evaluations ?? 0} {tr("次比较", "comparisons")}</span><button onClick={cancelFit}>{tr("取消微调", "Cancel refinement")}</button></div>}
    {fitResult && <div className="spine-pose-fit-result" role="status">
      <p>{tr("图像误差", "Image error")} {fitResult.before.loss.toFixed(4)} → {fitResult.after.loss.toFixed(4)} · {tr("越低越好", "lower is better")}</p>
      <p className="spine-hint">{tr("误差结合对齐后的轮廓和重叠区域颜色，仅比较这张目标图，不能保证部件身份、关节或时序正确。", "Error combines aligned silhouettes and colors in their overlap. It compares only this target, not part identity, joint validity or motion continuity.")}</p>
      {fitResult.after.loss >= fitResult.before.loss - 0.00001 && <p>{tr("在所选范围内未找到更好的姿态。", "No better pose found within the selected range.")}</p>}
      <button disabled={busy || fitting || disabled} onClick={() => { setProposal(fitBaseline.current); setFitResult(undefined); setFitProgress(undefined); }}>{tr("恢复微调前姿态", "Restore pose before refinement")}</button>
    </div>}
    <select aria-label={tr("姿态识别模型", "Pose inference model")} value={selected ? `${selected.profileId}::${selected.id}` : ""} disabled={busy || fitting || disabled} onChange={(event) => setRoute(event.target.value)}>
      {!models.length && <option value="">{tr("未配置文本模型", "No text model configured")}</option>}
      {models.map((model) => <option key={`${model.profileId}::${model.id}`} value={`${model.profileId}::${model.id}`}>{model.id} · {model.profileName}</option>)}
    </select>
    <textarea aria-label={tr("姿态识别补充要求", "Pose inference instructions")} rows={2} maxLength={2000} value={request} onChange={(event) => setRequest(event.target.value)} placeholder={tr("例如：只转动双翼，主体保持固定；左翼幅度再小一些", "For example: rotate the wings only, keep the body fixed; reduce the left wing angle")} />
    {proposal && <div className="spine-assistant-proposal"><p>{proposal.summary}</p>
      {!!proposal.uncertain.length && <p>{tr("需重点检查：", "Review carefully: ")}{proposal.uncertain.map((id) => project.parts.find((part) => part.id === id)?.name).join("、")}</p>}
    </div>}
    <div className="spine-button-row"><button disabled={busy || fitting || disabled || !selected || !frame.image} onClick={() => void submit()}><Send size={14} />{busy ? tr("识别中…", "Analyzing…") : proposal ? tr("继续调整姿态", "Refine pose") : tr("从图片识别姿态", "Infer pose from image")}</button>
      <button disabled={busy || fitting || disabled || !proposal} onClick={() => { if (proposal) onAccept(parseSpinePoseInference(JSON.stringify(proposal), project.parts)); }}><Check size={14} />{tr("采纳姿态目标", "Accept pose targets")}</button>
    </div>
    {error && <p className="spine-layer-error" role="alert">{error}</p>}
  </section>;
}

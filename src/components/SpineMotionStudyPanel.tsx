import { useEffect, useRef, useState } from "react";
import { Check, Film, ImagePlus, Plus, Sparkles, Upload, X } from "lucide-react";
import { tr } from "../lib/i18n";
import {
  captureSpinePose,
  acceptSpinePoseInference,
  fitSpinePose,
  interpolateSpineTargets,
  type SpineMotionStudy,
} from "../lib/spineMotion";
import { prepareSpineSource } from "../lib/spineSource";
import { createSpinePoseImageRequest, spinePoseImageNeighbors, spinePoseImageReferencesMatch, type SpinePoseImageRequest } from "../lib/spinePoseGeneration";
import { SpinePoseAssistant } from "./SpinePoseAssistant";
import { SPINE_LIMITS } from "../lib/spine";
import { isDesktop } from "../lib/bridge";
import { interpolateSpinePixels } from "../lib/spineBridge";
import { planSpinePixelFrames, prepareSpinePixelInputs, spinePixelPlanMatches } from "../lib/spinePixelInterpolation";
import type {
  SpineClip,
  SpineProject,
  SpinePoseFrame,
} from "../lib/spine";

interface SpineMotionStudyPanelProps {
  open: boolean;
  project: SpineProject;
  clip: SpineClip;
  time: number;
  selectedPart: string;
  modelAvailable: boolean;
  busy: boolean;
  onClose: () => void;
  onUpdate: (study: SpineMotionStudy) => void;
  onGenerateImage: (request: SpinePoseImageRequest) => Promise<{
    image: string;
    width: number;
    height: number;
  }>;
  onApply: (study: SpineMotionStudy, replace: boolean) => void;
}

function targetValue(frame: SpinePoseFrame, partId: string, key: "rotation" | "bend" | "x" | "y") {
  return frame.targets[partId]?.[key] ?? 0;
}

function readRifeSetting(key: string) {
  try { return localStorage.getItem(`levelup-spine-rife-${key}`) || ""; } catch { return ""; }
}

export function SpineMotionStudyPanel({
  open,
  project,
  clip,
  time,
  selectedPart,
  modelAvailable,
  busy,
  onClose,
  onUpdate,
  onGenerateImage,
  onApply,
}: SpineMotionStudyPanelProps) {
  const study = project.motionStudies?.find((item) => item.clipId === clip.id);
  const [editingPart, setEditingPart] = useState(selectedPart || project.parts[0]?.id || "");
  const [panelError, setPanelError] = useState("");
  const [poseDescription, setPoseDescription] = useState("");
  const [reviewFrameId, setReviewFrameId] = useState("");
  const [loadingImage, setLoadingImage] = useState(false);
  const [poseTime, setPoseTime] = useState(time);
  const [rifeExecutable, setRifeExecutable] = useState(() => readRifeSetting("executable"));
  const [rifeModel, setRifeModel] = useState(() => readRifeSetting("model"));
  const [rifeCount, setRifeCount] = useState(3);
  const [rifeGpu, setRifeGpu] = useState(0);
  const [rifeProgress, setRifeProgress] = useState("");
  const stopRife = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const state = useRef({ project, study, clip, onUpdate });
  state.current = { project, study, clip, onUpdate };
  const generationRef = useRef(0);
  useEffect(() => { if (open) setPoseTime(time); }, [open, study?.id, clip.id, time]);
  useEffect(() => {
    generationRef.current += 1;
    setLoadingImage(false);
    setPanelError("");
    setRifeProgress("");
    stopRife.current = true;
    return () => { generationRef.current += 1; };
  }, [project.id, study?.id, project.parts, project.sourceImage, clip]);
  if (!open || !study) return null;
  const part = project.parts.find((item) => item.id === editingPart) ?? project.parts[0];
  const updateFrames = (frames: SpinePoseFrame[]) =>
    onUpdate({ ...study, frames, updatedAt: Date.now() });
  const addFrame = (frame: SpinePoseFrame) => {
    if (study.frames.length >= SPINE_LIMITS.poseFrames) {
      setPanelError(tr("关键姿态已达到 64 帧上限", "The study already has 64 key poses"));
      return;
    }
    updateFrames([...study.frames, frame].sort((a, b) => a.time - b.time));
  };
  const capture = () => addFrame(captureSpinePose(clip, project.parts, time, `Pose ${study.frames.length + 1}`));
  const captureAtCurrent = () => {
    addFrame(captureSpinePose(clip, project.parts, time, `Pose ${study.frames.length + 1}`));
  };
  const addImage = async (
    load: () => Promise<{ image: string; width: number; height: number }>,
    source: SpinePoseFrame["source"],
    name: string,
    notes?: string,
    imageRequest?: SpinePoseImageRequest,
  ) => {
    if (busy || loadingImage) return;
    if (study.frames.length >= SPINE_LIMITS.poseFrames) {
      setPanelError(tr("关键姿态已达到 64 帧上限", "The study already has 64 key poses"));
      return;
    }
    const request = ++generationRef.current;
    const current = () => request === generationRef.current &&
      state.current.project.id === project.id && state.current.study?.id === study.id &&
      state.current.project.parts === project.parts && state.current.project.sourceImage === project.sourceImage &&
      state.current.clip === clip;
    // Capture the requested time and targets before waiting for file decoding or inference.
    const frame = captureSpinePose(clip, project.parts, poseTime, name, source);
    setLoadingImage(true);
    setRifeProgress("");
    setPanelError("");
    try {
      const data = await load();
      if (!current()) return;
      const latest = state.current.study!;
      if (imageRequest && !spinePoseImageReferencesMatch(imageRequest, latest))
        throw new Error(tr("参考姿态已改变，结果未写入，请重新生成", "Reference poses changed; the result was not added. Generate it again."));
      if (imageRequest?.inbetween && latest.frames.some((item) => Math.abs(item.time - frame.time) < 0.0005))
        throw new Error(tr("目标时间已有姿态，结果未写入，请选择新时间", "A pose now occupies the requested time; choose a new time."));
      if (latest.frames.length >= SPINE_LIMITS.poseFrames)
        throw new Error(tr("关键姿态已达到 64 帧上限", "The study already has 64 key poses"));
      if (data.image.length > 8 * 1024 * 1024 ||
        latest.frames.reduce((bytes, item) => bytes + (item.image?.length ?? 0), data.image.length) > SPINE_LIMITS.poseImageBytes)
        throw new Error(tr("姿态图超过保存限制，请缩小图片或删除不需要的姿态图", "Pose images exceed the storage limit; resize the image or remove unused poses."));
      // Preserve edits and deletions made while the image request was in flight.
      const generatedFrame: SpinePoseFrame = {
        ...frame, image: data.image, imageWidth: data.width, imageHeight: data.height,
        notes: notes?.slice(0, 2000), fitStatus: "review",
      };
      state.current.onUpdate({ ...latest, updatedAt: Date.now(), frames: [...latest.frames, generatedFrame].sort((a, b) => a.time - b.time) });
    } catch (error) {
      if (current()) setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) setLoadingImage(false);
    }
  };
  const generateImage = (inbetween: boolean) => {
    try {
      const request = createSpinePoseImageRequest(study, clip.duration, poseTime, poseDescription, inbetween);
      const notes = inbetween
        ? `${request.description}\nImage inbetween: ${request.neighbors.map((frame) => `${frame.name} (${frame.time}s)`).join(" → ")}; target ${request.time}s. Bone targets require review.`
        : request.description;
      void addImage(() => onGenerateImage(request), "generated", `${inbetween ? "Inbetween" : "Generated pose"} ${study.frames.length + 1}`, notes, request);
    } catch (error) { setPanelError(error instanceof Error ? error.message : String(error)); }
  };
  const neighbors = spinePoseImageNeighbors(study, poseTime);
  const canGenerateBetween = neighbors.length === 2 && !study.frames.some((frame) => Math.abs(frame.time - poseTime) < 0.0005);
  const interpolatePixels = async () => {
    if (busy || loadingImage) return;
    const request = ++generationRef.current;
    const current = () => request === generationRef.current && state.current.project.id === project.id &&
      state.current.project.parts === project.parts && state.current.project.sourceImage === project.sourceImage &&
      state.current.clip === clip && state.current.study?.id === study.id;
    setLoadingImage(true); setPanelError(""); stopRife.current = false;
    const generated: SpinePoseFrame[] = [];
    try {
      const plan = planSpinePixelFrames(study, poseTime, rifeCount);
      if (!spinePixelPlanMatches(plan, study)) throw new Error(tr("参考姿态已改变，请重新选择区间", "Reference poses changed; select the interval again."));
      try {
        localStorage.setItem("levelup-spine-rife-executable", rifeExecutable.trim());
        localStorage.setItem("levelup-spine-rife-model", rifeModel.trim());
      } catch { /* Settings persistence does not block inference. */ }
      const inputs = await prepareSpinePixelInputs(plan);
      const [first, last] = plan.endpoints;
      for (const at of plan.times) {
        if (!current()) return;
        if (stopRife.current) break;
        if (!spinePixelPlanMatches(plan, state.current.study!))
          throw new Error(tr("端点或区间已改变，补帧结果未写入", "The endpoints or interval changed; frames were not added."));
        setRifeProgress(tr(`本地补帧 ${generated.length + 1} / ${plan.times.length}`, `Local interpolation ${generated.length + 1} / ${plan.times.length}`));
        const fraction = (at - first.time) / (last.time - first.time);
        const image = await interpolateSpinePixels({ executable: rifeExecutable.trim(), modelDirectory: rifeModel.trim(),
          first: inputs.first, last: inputs.last, fraction, gpu: rifeGpu });
        if (!current()) return;
        generated.push({ ...captureSpinePose(clip, project.parts, at, `RIFE ${at.toFixed(3)}s`, "reference"),
          image, imageWidth: inputs.width, imageHeight: inputs.height, fitStatus: "review",
          targets: Object.fromEntries(project.parts.map(p => [p.id, interpolateSpineTargets(
            first.targets[p.id] ?? {rotation:0,bend:0,x:0,y:0}, last.targets[p.id] ?? {rotation:0,bend:0,x:0,y:0}, fraction)])),
          notes: `RIFE v4.6 RGB reference at ${at}s between ${first.time}s and ${last.time}s. Initial bone targets interpolate endpoint targets; not inferred from pixels. Review and fit before applying.`,
        });
      }
      if (!current()) return;
      const latest = state.current.study!;
      if (!spinePixelPlanMatches(plan, latest))
        throw new Error(tr("端点或区间已改变，补帧结果未写入", "The endpoints or interval changed; frames were not added."));
      const frames = [...latest.frames, ...generated].sort((a,b) => a.time - b.time);
      if (frames.length > SPINE_LIMITS.poseFrames || frames.reduce((n,f) => n + (f.image?.length ?? 0), 0) > SPINE_LIMITS.poseImageBytes)
        throw new Error(tr("补帧超过工程姿态图限制，请减少帧数", "The interpolated images exceed study limits; reduce the frame count."));
      if (generated.length) state.current.onUpdate({ ...latest, frames, updatedAt: Date.now() });
      setRifeProgress(tr(`${stopRife.current ? "已停止；" : ""}已添加 ${generated.length} 张 RIFE 参考图，请识别或微调并审阅骨骼目标。`, `${stopRife.current ? "Stopped. " : ""}Added ${generated.length} RIFE reference images. Infer or refine and review their bone targets.`));
    } catch (error) {
      if (current()) { setPanelError(`${error instanceof Error ? error.message : String(error)}${generated.length ? tr("；本次批次未写入，可重新生成。", "; this batch was not added; you can retry.") : ""}`); setRifeProgress(""); }
    } finally { if (current()) setLoadingImage(false); }
  };
  const updateFrame = (id: string, patch: Partial<SpinePoseFrame>) =>
    updateFrames(study.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)));
  const updateTarget = (
    frame: SpinePoseFrame,
    key: "rotation" | "bend" | "x" | "y",
    value: number,
  ) =>
    updateFrame(frame.id, {
      targets: {
        ...frame.targets,
        [part.id]: {
          ...(frame.targets[part.id] ?? { rotation: 0, bend: 0, x: 0, y: 0 }),
          [key]: value,
        },
      },
      fitStatus: "ready",
    });
  const hasTwoDistinctTimes = new Set(study.frames.map((frame) => frame.time)).size >= 2;
  const reviewFrame = study.frames.find((frame) => frame.id === reviewFrameId && frame.image);
  return (
    <div className="spine-modal-backdrop" onClick={onClose}>
      <div
        className="spine-motion-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("多图关键姿态与插帧", "Multi-image poses and interpolation")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="spine-section-title">
          <div>
            <span>POSES</span>
            <h2>{tr("多图关键姿态与插帧", "Multi-image poses & interpolation")}</h2>
          </div>
          <button aria-label={tr("关闭", "Close")} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <p className="spine-hint">
          {tr(
            "导入或生成姿态图后，可用 AI 识别并审阅骨骼目标，也可手工调整 R/B/X/Y。至少两个不同时间的姿态才能插帧为可编辑动作；插帧生成的是骨骼关键帧。",
            "After importing or generating images, use AI to infer and review bone targets, or edit R/B/X/Y manually. Two poses at different times can be interpolated into editable bone keys.",
          )}
        </p>
        <div className="spine-motion-toolbar">
          <label className="spine-label">
            {tr("编辑部件", "Edit part")}
            <select value={part.id} onChange={(event) => setEditingPart(event.target.value)}>
              {project.parts.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label className="spine-label">
            {tr("插帧 FPS", "Interpolation FPS")}
            <select
              value={study.fps}
              onChange={(event) => onUpdate({ ...study, fps: Number(event.target.value) as 12 | 24 | 30, updatedAt: Date.now() })}
            >
              {[12, 24, 30].map((fps) => <option key={fps} value={fps}>{fps}</option>)}
            </select>
          </label>
          <label className="spine-label">
            {tr("关键帧间曲线", "Between-pose curve")}
            <select
              value={study.interpolation}
              onChange={(event) => onUpdate({ ...study, interpolation: event.target.value as "linear" | "stepped", updatedAt: Date.now() })}
            >
              <option value="linear">{tr("线性 / 最短旋转", "Linear / shortest rotation")}</option>
              <option value="stepped">{tr("阶梯", "Stepped")}</option>
            </select>
          </label>
        </div>
        <label className="spine-label">{tr("关键姿态时间 (秒)", "New pose time (s)")}
          <input aria-label={tr("关键姿态时间 (秒)", "New pose time (s)")} type="number" min={0} max={clip.duration} step={0.01} value={poseTime}
            onChange={(event) => setPoseTime(Math.min(clip.duration, Math.max(0, event.target.valueAsNumber || 0)))} />
        </label>
        {!!neighbors.length && <div className="spine-pose-references" aria-label={tr("相邻姿态参考", "Neighbor pose references")}>
          {neighbors.map((frame) => <figure key={frame.id}>
            <img src={frame.image} alt={frame.name} />
            <figcaption>{frame.time < poseTime ? tr("前姿态", "Previous") : tr("后姿态", "Next")} · {frame.time}s</figcaption>
          </figure>)}
        </div>}
        <p className="spine-hint">{tr("生图会附上整图、最近前后姿态图和已选参考。把时间设在两张图之间，可生成中间姿态图，再识别骨骼并拟合动作。", "Generation includes the source, nearest pose images and selected references. Choose a time between two images to generate an intermediate pose, then infer its bones and fit the action.")}</p>
        <label className="spine-label">{tr("关键姿态描述", "Key pose description")}
          <textarea aria-label={tr("关键姿态描述", "Key pose description")} value={poseDescription} maxLength={2000} rows={2}
            onChange={(event) => setPoseDescription(event.target.value)}
            placeholder={tr("例如：机械鸟双翼抬起，摆锤向画面左侧摆动；保留整图造型", "For example: mechanical bird with raised wings and pendulum swinging left; preserve the source design")} />
        </label>
        <div className="spine-button-row spine-motion-actions">
          <button onClick={captureAtCurrent} disabled={busy}>
            <Plus size={14} /> {tr(`记录时间轴姿态 ${time.toFixed(2)}s`, `Capture timeline pose ${time.toFixed(2)}s`)}
          </button>
          <button onClick={() => input.current?.click()} disabled={busy || loadingImage}>
            <Upload size={14} /> {tr("导入姿态图", "Import pose image")}
          </button>
          <button onClick={() => generateImage(false)} disabled={busy || loadingImage || !modelAvailable || !poseDescription.trim()}>
            <Sparkles size={14} /> {tr("生图关键姿态", "Generate pose image")}
          </button>
          <button onClick={() => generateImage(true)} disabled={busy || loadingImage || !modelAvailable || !canGenerateBetween}>
            <Film size={14} /> {tr("生成中间姿态图", "Generate intermediate pose")}
          </button>
          <input
            ref={input}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void addImage(async () => {
                const url = URL.createObjectURL(file);
                try { return await prepareSpineSource(url, file.name); }
                finally { URL.revokeObjectURL(url); }
              }, "upload", file.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </div>
        <details>
          <summary>{tr("本地像素补帧（RIFE）", "Local pixel interpolation (RIFE)")}</summary>
          <p className="spine-hint">{tr("在前后姿态之间生成 1、3 或 7 张参考图，最长边 512 像素。透明区域合成浅灰背景；原有纯色背景保留。适合小幅连续运动，生成后请识别或微调骨骼目标并审阅。", "Generate 1, 3 or 7 reference images between neighboring poses, up to 512 px. Transparent areas become light gray; existing solid backgrounds remain. Best for small continuous motions. Infer or refine bone targets and review the results.")}</p>
          <label className="spine-label">{tr("RIFE 程序路径", "RIFE executable path")}<input aria-label={tr("RIFE 程序路径", "RIFE executable path")} value={rifeExecutable} disabled={loadingImage} onChange={e=>setRifeExecutable(e.target.value)} placeholder="C:\\Tools\\rife-ncnn-vulkan.exe" /></label>
          <label className="spine-label">{tr("rife-v4.6 模型目录", "rife-v4.6 model directory")}<input aria-label={tr("rife-v4.6 模型目录", "rife-v4.6 model directory")} value={rifeModel} disabled={loadingImage} onChange={e=>setRifeModel(e.target.value)} placeholder="C:\\Tools\\rife-v4.6" /></label>
          <div className="spine-motion-toolbar">
            <label className="spine-label">{tr("补帧数量", "Intermediate frames")}<select aria-label={tr("补帧数量", "Intermediate frames")} value={rifeCount} disabled={loadingImage} onChange={e=>setRifeCount(Number(e.target.value))}>{[1,3,7].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
            <label className="spine-label">{tr("GPU 编号（-1 为 CPU）", "GPU index (-1 for CPU)")}<input type="number" min={-1} max={7} step={1} value={rifeGpu} disabled={loadingImage} onChange={e=>setRifeGpu(Math.max(-1,Math.min(7,Math.trunc(e.target.valueAsNumber || 0))))} /></label>
          </div>
          <div className="spine-button-row">
            <button disabled={busy || loadingImage || !isDesktop() || neighbors.length !== 2 || !rifeExecutable.trim() || !rifeModel.trim()} onClick={()=>void interpolatePixels()}><Film size={14}/>{tr("本地生成参考帧", "Generate local reference frames")}</button>
            {loadingImage && rifeProgress && <button onClick={()=>{stopRife.current=true;setRifeProgress(tr("当前帧完成后停止，保留本批已生成帧", "Stop after the current frame; retain completed frames in this batch."));}}>{tr("停止后续补帧", "Stop subsequent frames")}</button>}
          </div>
          {!isDesktop() && <p className="spine-hint">{tr("本地 RIFE 请使用桌面版", "Local RIFE requires the desktop app")}</p>}
          {rifeProgress && <p className="spine-hint" role="status">{rifeProgress}</p>}
        </details>
        {panelError && <p className="spine-layer-error" role="alert">{panelError}</p>}
        {!study.frames.length ? (
          <div className="spine-motion-empty">
            <Film size={24} />
            <span>{tr("还没有关键姿态。可从当前动作、姿态图或生图结果开始。", "No key poses yet. Start from the current animation, a pose image, or a generated result.")}</span>
            <button onClick={capture} disabled={busy}><ImagePlus size={13} /> {tr("创建第一帧", "Create first pose")}</button>
          </div>
        ) : (
          <div className="spine-pose-list">
            {study.frames.map((frame, index) => (
              <article className="spine-pose-card" key={frame.id}>
                <div className="spine-pose-card-head">
                  <strong>{index + 1}. {frame.name}</strong>
                  <button aria-label={tr("删除姿态", "Delete pose")} onClick={() => updateFrames(study.frames.filter((item) => item.id !== frame.id))}><X size={13} /></button>
                </div>
                <div className="spine-pose-card-body">
                  {frame.image ? <img src={frame.image} alt="" /> : <div className="spine-pose-placeholder"><Film size={18} /></div>}
                  <div className="spine-pose-fields">
                    <label className="spine-label">{tr("名称", "Name")}<input value={frame.name} onChange={(event) => updateFrame(frame.id, { name: event.target.value || `Pose ${index + 1}` })} /></label>
                    <label className="spine-label">{tr("时间 (秒)", "Time (s)")}<input type="number" min={0} max={clip.duration} step={0.01} value={frame.time} onChange={(event) => updateFrame(frame.id, { time: Math.min(clip.duration, Math.max(0, event.target.valueAsNumber || 0)) })} /></label>
                    <div className="spine-field-grid">
                      {(["rotation", "bend", "x", "y"] as const).map((key) => (
                        <label className="spine-number" key={key}>
                          <span>{key === "rotation" ? "R" : key === "bend" ? "B" : key.toUpperCase()}</span>
                          <input type="number" value={targetValue(frame, part.id, key)} step={0.1} onChange={(event) => updateTarget(frame, key, event.target.valueAsNumber || 0)} />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="spine-pose-meta">
                  <span>{frame.source} · {frame.fitStatus ?? "ready"}{frame.fitError !== undefined ? ` · ${Math.round(frame.fitError * 100)}% review` : ""}</span>
                  {frame.image && <button disabled={busy} onClick={() => setReviewFrameId(frame.id)}><Sparkles size={12} />{tr("AI 识别姿态", "AI pose inference")}</button>}
                  <button onClick={() => onUpdate({ ...study, frames: study.frames.map((item) => item.id === frame.id ? fitSpinePose(project, study, item) : item), updatedAt: Date.now() })}>
                    <Check size={12} /> {tr("确认目标", "Confirm targets")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {reviewFrame && <SpinePoseAssistant key={`${project.id}:${reviewFrame.id}`} project={project} study={study} frame={reviewFrame} disabled={busy}
          onClose={() => setReviewFrameId("")} onAccept={(inference) => {
            updateFrame(reviewFrame.id, acceptSpinePoseInference(reviewFrame, inference));
            setPanelError("");
          }} />}
        <div className="spine-motion-footer">
          <button disabled={busy || loadingImage || !hasTwoDistinctTimes} onClick={() => onApply(study, false)}><Film size={14} /> {tr("插帧为新动作", "Interpolate as new action")}</button>
          <button className="primary" disabled={busy || loadingImage || !hasTwoDistinctTimes} onClick={() => onApply(study, true)}><Check size={14} /> {tr("覆盖当前动作", "Replace current action")}</button>
        </div>
      </div>
    </div>
  );
}

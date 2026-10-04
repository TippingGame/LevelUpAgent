import { useRef, useState } from "react";
import { Check, Film, ImagePlus, Plus, Sparkles, Upload, X } from "lucide-react";
import { tr } from "../lib/i18n";
import {
  captureSpinePose,
  fitSpinePose,
  type SpineMotionStudy,
} from "../lib/spineMotion";
import { readSpineImageFile } from "../lib/spineAssets";
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
  onGenerateImage: () => Promise<{
    image: string;
    width: number;
    height: number;
  }>;
  onApply: (study: SpineMotionStudy, replace: boolean) => void;
}

function targetValue(frame: SpinePoseFrame, partId: string, key: "rotation" | "bend" | "x" | "y") {
  return frame.targets[partId]?.[key] ?? 0;
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
  const input = useRef<HTMLInputElement>(null);
  if (!open || !study) return null;
  const part = project.parts.find((item) => item.id === editingPart) ?? project.parts[0];
  const updateFrames = (frames: SpinePoseFrame[]) =>
    onUpdate({ ...study, frames, updatedAt: Date.now() });
  const addFrame = (frame: SpinePoseFrame) => {
    updateFrames([...study.frames, frame].sort((a, b) => a.time - b.time));
  };
  const capture = () => addFrame(captureSpinePose(clip, project.parts, time, `Pose ${study.frames.length + 1}`));
  const captureAtCurrent = () => {
    addFrame(captureSpinePose(clip, project.parts, time, `Pose ${study.frames.length + 1}`));
  };
  const addImage = async (file: File, source: SpinePoseFrame["source"]) => {
    try {
      const data = await readSpineImageFile(file);
      addFrame(
        captureSpinePose(clip, project.parts, time, file.name.replace(/\.[^.]+$/, ""), source, {
          image: data.image,
          imageWidth: data.width,
          imageHeight: data.height,
        }),
      );
      setPanelError("");
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
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
            <span>V3</span>
            <h2>{tr("多图关键姿态与插帧", "Multi-image poses & interpolation")}</h2>
          </div>
          <button aria-label={tr("关闭", "Close")} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <p className="spine-hint">
          {tr(
            "姿态图仅作对照和留档。R/B/X/Y 目标从当前动作初始化，请逐帧对照图片手动调整；拟合会补齐缺失部件，不会从像素自动识别姿态。至少两个不同时间的姿态才能插帧。",
            "Pose images are references only. R/B/X/Y targets start from the current animation; adjust them against each image. Fit fills missing parts and does not infer poses from pixels. Interpolation needs two poses at different times.",
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
        <div className="spine-button-row spine-motion-actions">
          <button onClick={captureAtCurrent} disabled={busy}>
            <Plus size={14} /> {tr(`记录时间轴姿态 ${time.toFixed(2)}s`, `Capture timeline pose ${time.toFixed(2)}s`)}
          </button>
          <button onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={14} /> {tr("导入姿态图", "Import pose image")}
          </button>
          <button onClick={() => void onGenerateImage().then((data) => {
            addFrame(captureSpinePose(clip, project.parts, time, `Generated pose ${study.frames.length + 1}`, "generated", data));
            setPanelError("");
          }).catch((error) => setPanelError(error instanceof Error ? error.message : String(error)))} disabled={busy || !modelAvailable}>
            <Sparkles size={14} /> {tr("生图关键姿态", "Generate pose image")}
          </button>
          <input
            ref={input}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void addImage(file, "upload");
            }}
          />
        </div>
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
                  <button onClick={() => onUpdate({ ...study, frames: study.frames.map((item) => item.id === frame.id ? fitSpinePose(project, study, item) : item), updatedAt: Date.now() })}>
                    <Check size={12} /> {tr("拟合", "Fit")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="spine-motion-footer">
          <button disabled={busy || !hasTwoDistinctTimes} onClick={() => onApply(study, false)}><Film size={14} /> {tr("插帧为新动作", "Interpolate as new action")}</button>
          <button className="primary" disabled={busy || !hasTwoDistinctTimes} onClick={() => onApply(study, true)}><Check size={14} /> {tr("覆盖当前动作", "Replace current action")}</button>
        </div>
      </div>
    </div>
  );
}

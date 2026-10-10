import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bone,
  Download,
  Eye,
  Film,
  Grid2X2,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { CreativeStudioHeader } from "./CreativeStudioHeader";
import { SpineCanvas } from "./SpineCanvas";
import { SpineLayerImport } from "./SpineLayerImport";
import { SpineComfyPanel } from "./SpineComfyPanel";
import { SpineMotionStudyPanel } from "./SpineMotionStudyPanel";
import { spinePoseImagePrompt, spinePoseImageReferencesMatch, type SpinePoseImageRequest } from "../lib/spinePoseGeneration";
import { SpineAssistantPanel } from "./SpineAssistantPanel";
import { SpineRedrawReview } from "./SpineRedrawReview";
import type { PreparedSpineLayers } from "../lib/spineLayers";
import { tr } from "../lib/i18n";
import {
  generateMedia,
  getMediaCatalog,
  importAttachments,
  importClipboardImages,
  listMediaAssets,
  mediaAssetUrl,
  selectImageReferences,
  isDesktop,
} from "../lib/bridge";
import {
  imageModelCapabilities,
  selectStudioMediaModel,
  sortStudioMediaModels,
} from "../lib/mediaCapabilities";
import type { ImageAttachment, MediaAsset, MediaModelInfo } from "../lib/types";
import {
  addSpineParts,
  createSpinePart,
  generateSpineClip,
  newSpineProject,
  orderedSpineParts,
  sampleSpineKeys,
  SPINE_LIMITS,
  SPINE_ROLES,
  upsertSpineKey,
  validateSpineProject,
  type SpineClip,
  type SpineKey,
  type SpineMotionPreset,
  type SpinePart,
  type SpineProject,
} from "../lib/spine";
import {
  createSpineDemo,
  exportSpineArchive,
  normalizeSpineImage,
  readSpineImageFile,
  verifySpineProjectImages,
} from "../lib/spineAssets";
import {
  listSpineProjects,
  loadSpineProject,
  saveSpineProject,
  type SpineProjectSummary,
} from "../lib/spineStorage";
import { runSpinePartGeneration, spineImageBackgroundPrompt } from "../lib/spineGeneration";
import { saveSpineArchive } from "../lib/spineBridge";
import { cropSpineSourceReference, prepareSpineGeneratedPart, prepareSpineSource, removeSpineSolidBackground } from "../lib/spineSource";
import { applySpineAssistantProposal, createSpinePlannedPart, orderSpinePlannedParts, plannedSpinePartId, validateSpinePartPlan, type SpineNewPartDraft } from "../lib/spineAssistant";
import { spineAssistantImageFile } from "../lib/spineAssistantImages";
import {
  applySpineStudy,
  createSpineMotionStudy,
  type SpineMotionStudy,
} from "../lib/spineMotion";
import "./SpineStudio.css";

interface SpineStudioProps {
  active: boolean;
  locale: string;
  mediaCatalogRevision: number;
  onMedia: () => void;
  onWriting: () => void;
  onConstellation: () => void;
  onModel3d: () => void;
  onMusic: () => void;
  onConfigureConnection: () => void;
  onPendingCountChange: (count: number) => void;
}
function roleName(role: SpinePart["role"]) {
  return {
    body: tr("躯干", "Torso"),
    head: tr("头部", "Head"),
    "arm-left": tr("画面左臂", "Left arm (view)"),
    "arm-right": tr("画面右臂", "Right arm (view)"),
    "leg-left": tr("画面左腿", "Left leg (view)"),
    "leg-right": tr("画面右腿", "Right leg (view)"),
    other: tr("其他部件", "Other part"),
  }[role];
}
function roleFromName(name: string): SpinePart["role"] {
  const n = name.toLowerCase();
  return (
    SPINE_ROLES.find((r) => n.includes(r)) ??
    (/头|head/.test(n)
      ? "head"
      : /躯干|身体|torso|body/.test(n)
        ? "body"
        : /左.*(臂|手)/.test(n)
          ? "arm-left"
          : /右.*(臂|手)/.test(n)
            ? "arm-right"
            : /左.*腿/.test(n)
              ? "leg-left"
              : /右.*腿/.test(n)
                ? "leg-right"
                : "other")
  );
}
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="spine-number">
      <span>{label}</span>
      <input
        type="number"
        value={Math.round(value * 1000) / 1000}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            onChange(Math.min(max, Math.max(min, e.target.valueAsNumber)));
        }}
      />
    </label>
  );
}
export function SpineStudio({
  active,
  locale: _locale,
  mediaCatalogRevision,
  onMedia,
  onWriting,
  onConstellation,
  onModel3d, onMusic,
  onConfigureConnection,
  onPendingCountChange,
}: SpineStudioProps) {
  const [project, setProject] = useState<SpineProject>(),
    [projects, setProjects] = useState<SpineProjectSummary[]>([]);
  const [selected, setSelected] = useState(""),
    [clipId, setClipId] = useState(""),
    [setup, setSetup] = useState(true),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false);
  const [showBones, setShowBones] = useState(true),
    [showMesh, setShowMesh] = useState(false),
    [zoom, setZoom] = useState(1);
  const [models, setModels] = useState<MediaModelInfo[]>([]),
    [modelKey, setModelKey] = useState("");
  const [references, setReferences] = useState<ImageAttachment[]>([]);
  const [assetTab, setAssetTab] = useState<"chat" | "source" | "retouch">("chat");
  const [sourceHistory, setSourceHistory] = useState<MediaAsset[] | null>(null),
    [backgroundTolerance, setBackgroundTolerance] = useState(46);
  const [redrawPrompt, setRedrawPrompt] = useState("");
  const [redrawCandidate, setRedrawCandidate] = useState<{ base: SpineProject; part: SpinePart; opaque: boolean }>();
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [saveState, setSaveState] = useState("loading"),
    [history, setHistory] = useState<MediaAsset[] | null>(null),
    [historyLoading, setHistoryLoading] = useState(false);
  const [layerImport, setLayerImport] = useState<{
      initial?: PreparedSpineLayers;
    } | null>(null),
    [comfyOpen, setComfyOpen] = useState(false),
    [comfyPending, setComfyPending] = useState(0),
    [motionOpen, setMotionOpen] = useState(false);
  const partsInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    replaceInput = useRef<HTMLInputElement>(null),
    sourceInput = useRef<HTMLInputElement>(null),
    sourceReference = useRef<{ image: string; attachment: ImageAttachment } | undefined>(undefined);
  const projectRef = useRef(project),
    undo = useRef<SpineProject[]>([]),
    stop = useRef(false),
    mounted = useRef(true),
    busyRef = useRef(false);
  projectRef.current = project;
  useEffect(() => setRedrawPrompt(""), [selected, project?.id]);
  useEffect(() => setRedrawCandidate(undefined), [selected, project?.id, project?.parts, project?.sourceImage]);
  const model = selectStudioMediaModel(models, modelKey),
    part = project?.parts.find((p) => p.id === selected),
    clip = project?.clips.find((c) => c.id === clipId);
  const key = sampleSpineKeys(clip?.tracks[selected], time);
  const reportError = useCallback((message: string) => setError(message), []);
  const update = useCallback(
    (change: (project: SpineProject) => SpineProject, remember = true) => {
      const previous = projectRef.current;
      if (!previous) return;
      const next = { ...change(previous), updatedAt: Date.now() };
      if (remember) {
        undo.current.push(previous);
        if (undo.current.length > 30) undo.current.shift();
      }
      projectRef.current = next;
      setProject(next);
      setSaveState("pending");
    },
    [],
  );
  const selectProject = useCallback((next: SpineProject) => {
    projectRef.current = next;
    setProject(next);
    setSelected(next.parts[0]?.id ?? "");
    setClipId(next.clips[0]?.id ?? "");
    setSetup(!next.clips.length);
    setTime(0);
    setPlaying(false);
    setZoom(1);
    undo.current = [];
    setError("");
    setNotice("");
    setReferences([]);
    setSourceHistory(null);
    sourceReference.current = undefined;
  }, []);
  const persist = useCallback(async (snapshot: SpineProject) => {
    await saveSpineProject(snapshot);
    if (!mounted.current) return;
    setProjects((current) =>
      [
        { id: snapshot.id, name: snapshot.name, updatedAt: snapshot.updatedAt },
        ...current.filter((p) => p.id !== snapshot.id),
      ].sort((a, b) => b.updatedAt - a.updatedAt),
    );
    if (projectRef.current === snapshot) setSaveState("saved");
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void listSpineProjects()
      .then(async (list) => {
        const first = list[0] ? await loadSpineProject(list[0].id) : undefined;
        if (disposed) return;
        setProjects(list);
        selectProject(
          first ?? newSpineProject(tr("未命名角色", "Untitled character")),
        );
        setSaveState(first ? "saved" : "pending");
      })
      .catch((e) => {
        if (!disposed) {
          setError(String(e));
          setSaveState("error");
        }
      });
    return () => {
      disposed = true;
      mounted.current = false;
      stop.current = true;
      // Flush the current draft if a layout change unmounts the studio.
      if (projectRef.current)
        void saveSpineProject(projectRef.current).catch(() => {});
    };
  }, [selectProject]);
  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      setSaveState("saving");
      void persist(project).catch((e) => {
        if (mounted.current) {
          setSaveState("error");
          setError(String(e));
        }
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [project, persist]);
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" && projectRef.current)
        void persist(projectRef.current).catch(() => {
          if (mounted.current) setSaveState("error");
        });
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [persist]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void getMediaCatalog()
      .then((catalog) => {
        if (!disposed) {
          setModels(
            sortStudioMediaModels(
              catalog.models.filter((m) => m.kind === "image"),
            ),
          );
          if (catalog.errors.length) setNotice(catalog.errors.join(" · "));
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [active, mediaCatalogRevision]);
  useEffect(() => {
    onPendingCountChange((busy ? 1 : 0) + comfyPending);
    return () => onPendingCountChange(0);
  }, [busy, comfyPending, onPendingCountChange]);
  useEffect(() => {
    if (!project) return;
    if (selected && !project.parts.some((p) => p.id === selected))
      setSelected(project.parts[0]?.id ?? "");
    if (!project.clips.some((c) => c.id === clipId)) {
      setClipId(project.clips[0]?.id ?? "");
      setTime(0);
      setPlaying(false);
    }
    if (!project.clips.length) setSetup(true);
  }, [project, selected, clipId]);
  useEffect(() => {
    if (!active || !playing || setup || !clip) return;
    let handle = 0,
      previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      setTime((t) => (t + delta) % clip.duration);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [active, playing, setup, clip]);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    stop.current = false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
    }
  };
  const changePart = (patch: Partial<SpinePart>) => {
    if (part)
      update((p) => ({
        ...p,
        parts: p.parts.map((item) =>
          item.id === part.id ? { ...item, ...patch } : item,
        ),
      }));
  };
  const editClip = (change: (clip: SpineClip) => SpineClip) => {
    if (clip)
      update((p) => ({
        ...p,
        clips: p.clips.map((c) => (c.id === clip.id ? change(c) : c)),
      }));
  };
  const editKey = (patch: Partial<SpineKey>) => {
    if (part && clip) {
      setPlaying(false);
      editClip((c) => upsertSpineKey(c, part.id, { ...key, ...patch, time }));
    }
  };
  const newProject = async (demo = false) =>
    run(async () => {
      if (projectRef.current) await persist(projectRef.current);
      const next = demo
        ? createSpineDemo()
        : newSpineProject(tr("未命名角色", "Untitled character"));
      await persist(next);
      selectProject(next);
      if (demo) setPlaying(true);
    });
  const importParts = async (files: File[], replace = false) =>
    run(async () => {
      if (!project || !files.length) return;
      if (!replace && project.parts.length + files.length > SPINE_LIMITS.parts)
        throw new Error(tr("最多 24 个部件", "At most 24 parts"));
      const incoming: SpinePart[] = [];
      let opaque = false;
      for (const file of files) {
        const data = await readSpineImageFile(file);
        opaque ||= data.opaque;
        incoming.push(
          createSpinePart(
            file.name.replace(/\.[^.]+$/, ""),
            data.image,
            data.width,
            data.height,
            roleFromName(file.name),
          ),
        );
      }
      if (replace && part)
        changePart({
          image: incoming[0].image,
          imageWidth: incoming[0].imageWidth,
          imageHeight: incoming[0].imageHeight,
        });
      else {
        update((p) => addSpineParts(p, incoming));
        setSelected(incoming[0].id);
      }
      setSetup(true);
      setPlaying(false);
      setNotice(
        opaque
          ? tr(
              "部分图片没有透明背景，请先在生图编辑器或绘图软件中抠图。没有自动去除背景。",
              "Some images are opaque. Remove the background in the image editor or your painting app; backgrounds were preserved.",
            )
          : tr(
              "部件已导入。拖动调整位置，再设置父骨骼和枢轴。",
              "Parts imported. Drag to position, then set parent bones and pivots.",
            ),
      );
    });
  const setSourceImage = async (url: string, name: string, autoMatte = false) => {
    let sourceImage = await prepareSpineSource(url, name);
    if (autoMatte && (await normalizeSpineImage(sourceImage.image)).opaque) {
      try { sourceImage = await removeSpineSolidBackground(sourceImage, 60); }
      catch { /* Preserve the generated source when its backdrop is not a solid screen. */ }
    }
    update((p) => ({ ...p, sourceImage, rigPartPlan: undefined }));
    setSourceHistory(null);
    sourceReference.current = undefined;
    setNotice(tr("整图已保存到当前工程", "Source image saved in this project"));
  };
  const generateSource = () => run(async () => {
    if (!model || !project) return;
    setProgress(tr("正在生成整图…", "Generating source image…"));
    const result = await generateMedia({
      kind: "image", profileId: model.profileId, model: model.id, protocol: model.protocol,
      prompt: `${project.prompt.trim() || "A stylized character or object"}. Single full subject, neutral pose, centered, entire silhouette visible. Clean 2D animation-ready art. No text, no contact sheet. ${spineImageBackgroundPrompt(model.id)}`,
      count: 1, size: "auto", outputFormat: "png",
      background: !model.id.includes("gpt-image-2") && !imageModelCapabilities(model.id).minimax ? "transparent" : "auto",
      referenceAttachmentIds: [],
    });
    const asset = result.assets.find((a) => a.kind === "image" && a.status === "completed" && a.filePath);
    const url = asset ? mediaAssetUrl(asset) : undefined;
    if (!url) throw new Error(result.errors.join("\n") || tr("生图未返回图片", "Image model returned no image"));
    await setSourceImage(url, asset?.fileName ?? "generated-source.png", true);
  });
  const generatePlannedParts = async (drafts: SpineNewPartDraft[]) => run(async () => {
    const current = projectRef.current;
    if (!current || !model) throw new Error(tr("请先选择生图模型", "Select an image model first"));
    validateSpinePartPlan(current, drafts);
    const pending = drafts.filter((draft) => !current.parts.some((part) => part.id === plannedSpinePartId(draft.key, current.rigPartPlan?.id)));
    if (!pending.length) {
      setNotice(tr("草案中的部件都已生成", "All planned parts are already generated"));
      return;
    }
    const source = current.sourceImage!;
    let workingProject = current;
    if (sourceReference.current?.image !== source.image) {
      const bytes = Uint8Array.from(atob(source.image.split(",")[1]), (char) => char.charCodeAt(0));
      const [attachment] = await importClipboardImages([new File([bytes], "spine-source.png", { type: "image/png" })]);
      if (!attachment) throw new Error(tr("整图参考未能导入", "Could not attach source image"));
      sourceReference.current = { image: source.image, attachment };
    }
    const { completed, opaque } = await runSpinePartGeneration({
      project: current,
      roles: pending,
      shouldStop: () => stop.current || !mounted.current,
      onProgress: ({ role, index, total }) => setProgress(tr(
        `正在生成 ${role.name} · ${index}/${total}`,
        `Generating ${role.name} · ${index}/${total}`,
      )),
      generate: async (draft) => {
        const crop = await cropSpineSourceReference(source, draft);
        const cropBytes = Uint8Array.from(atob(crop.split(",")[1]), (char) => char.charCodeAt(0));
        const [detail] = await importClipboardImages([new File([cropBytes], `${draft.key}-detail.png`, { type: "image/png" })]);
        if (!detail) throw new Error(tr("局部参考未能导入", "Could not attach detail reference"));
        const prompt = `Create exactly ONE isolated sprite layer for an editable 2D skeletal animation. Subject: ${current.prompt.trim() || current.name}. Layer name: ${draft.name}. Layer description: ${draft.description}. Reference Image 1 is the complete source subject and defines identity, materials, palette and style. Reference Image 2 is the target region cropped from that source. Target bounds in the full source are left ${Math.round(draft.left * 100)}%, top ${Math.round(draft.top * 100)}%, right ${Math.round(draft.right * 100)}%, bottom ${Math.round(draft.bottom * 100)}%. Preserve the source design and neutral setup pose. Draw only this layer, with occluded attachment ends completed plausibly for rigging. Do not include adjacent layers, the whole subject, a contact sheet, text or a floor. ${spineImageBackgroundPrompt(model.id, "single part")}`;
        const result = await generateMedia({
          kind: "image", profileId: model.profileId, model: model.id, protocol: model.protocol,
          prompt, count: 1, size: "auto", outputFormat: "png",
          background: !model.id.includes("gpt-image-2") && !imageModelCapabilities(model.id).minimax ? "transparent" : "auto",
          referenceAttachmentIds: [sourceReference.current!.attachment.id, detail.id, ...references.map((item) => item.id)],
        });
        const asset = result.assets.find((item) => item.kind === "image" && item.status === "completed" && item.filePath);
        const url = asset ? mediaAssetUrl(asset) : undefined;
        if (!url) throw new Error(result.errors.join("\n") || result.assets.find((item) => item.error)?.error || `No image returned for ${draft.name}.`);
        const data = await prepareSpineGeneratedPart(url);
        return { part: createSpinePlannedPart(workingProject, draft, data.image, data.width, data.height), opaque: data.opaque };
      },
      checkpoint: async (incoming) => {
        workingProject = validateSpineProject({
          ...workingProject, parts: orderSpinePlannedParts([...workingProject.parts, incoming], drafts, current.rigPartPlan?.id), updatedAt: Date.now(),
        });
        if (!mounted.current || projectRef.current?.id !== current.id) {
          await saveSpineProject(workingProject);
          return;
        }
        update((project) => ({ ...project, parts: orderSpinePlannedParts([...project.parts, incoming], drafts, current.rigPartPlan?.id) }));
        setSelected(incoming.id);
        setSetup(true);
        setPlaying(false);
        if (projectRef.current) await persist(projectRef.current);
      },
    });
    if (mounted.current) setNotice(tr(
      `已生成 ${completed} 个部件。${opaque ? "部分背景未能自动抠除，请检查贴图。" : ""}可继续在会话中调整骨骼和动作。`,
      `Generated ${completed} parts. ${opaque ? "Some backgrounds need manual cleanup. " : ""}Continue refining bones and motion in chat.`,
    ));
  });
  const redrawPart = () => run(async () => {
    const current = projectRef.current;
    const target = current?.parts.find((item) => item.id === selected);
    if (!current?.sourceImage || !target || !model || !redrawPrompt.trim()) return;
    const draft = current.rigPartPlan?.drafts.find((item) => plannedSpinePartId(item.key, current.rigPartPlan?.id) === target.id);
    const source = current.sourceImage;
    const images = [source.image, ...(draft ? [await cropSpineSourceReference(source, draft)] : []), target.image];
    const attachments = await importClipboardImages(images.map((image, index) => {
      const bytes = Uint8Array.from(atob(image.split(",")[1]), (char) => char.charCodeAt(0));
      return new File([bytes], `redraw-reference-${index + 1}.png`, { type: "image/png" });
    }));
    if (attachments.length !== images.length) throw new Error(tr("重绘参考图未能附加", "Could not attach redraw references"));
    setProgress(tr(`正在重绘 ${target.name}`, `Redrawing ${target.name}`));
    const result = await generateMedia({
      kind: "image", profileId: model.profileId, model: model.id, protocol: model.protocol,
      prompt: `Create exactly ONE isolated replacement sprite layer for an editable 2D skeletal animation. Layer: ${target.name}. Reference Image 1 is the complete source and fixes identity, color, style and setup pose.${draft ? ` Reference Image 2 is its target region. Original layer description: ${draft.description}.` : ""} Reference Image ${images.length} is the CURRENT isolated texture to edit. Preserve its unaffected details, orientation and silhouette proportions; correct only the requested defects, without adding adjacent layers. The following correction takes priority over the original layer description: ${redrawPrompt.trim()}. Keep only the requested detached layer; complete hidden attachment ends. Preserve the source's scale proportions and orientation; no other body parts, text, floor or contact sheet. ${spineImageBackgroundPrompt(model.id, "single part")}`,
      count: 1, size: "auto", outputFormat: "png",
      background: !model.id.includes("gpt-image-2") && !imageModelCapabilities(model.id).minimax ? "transparent" : "auto",
      referenceAttachmentIds: attachments.map((item) => item.id),
    });
    const asset = result.assets.find((item) => item.kind === "image" && item.status === "completed" && item.filePath);
    const url = asset ? mediaAssetUrl(asset) : undefined;
    if (!url) throw new Error(result.errors.join("\n") || result.assets.find((item) => item.error)?.error || tr("模型未返回重绘贴图", "No replacement texture returned"));
    const data = await prepareSpineGeneratedPart(url);
    if (!mounted.current || projectRef.current?.id !== current.id || projectRef.current.parts !== current.parts || projectRef.current.sourceImage !== current.sourceImage) return;
    setPlaying(false);
    setRedrawCandidate({ base: current, part: { ...target, image: data.image, imageWidth: data.width, imageHeight: data.height }, opaque: data.opaque });
  });
  const applyRedraw = () => run(async () => {
    const candidate = redrawCandidate, current = projectRef.current;
    if (!candidate || !current || current.id !== candidate.base.id || current.parts !== candidate.base.parts || current.sourceImage !== candidate.base.sourceImage) {
      setRedrawCandidate(undefined);
      throw new Error(tr("工程已改变，请重新生成重绘结果", "The project changed; generate a new replacement"));
    }
    update((project) => ({ ...project, parts: project.parts.map((item) => item.id === candidate.part.id ? candidate.part : item) }));
    setRedrawCandidate(undefined);
    if (projectRef.current) await persist(projectRef.current);
    setNotice(tr(`已替换 ${candidate.part.name} 的贴图，骨骼和动作保持；可撤销。`, `Replaced ${candidate.part.name}'s texture, preserving rig and motion. Undo is available.`));
  });
  const generateMotion = (preset: SpineMotionPreset) => {
    if (!project?.parts.length || project.clips.length >= SPINE_LIMITS.clips)
      return;
    let name = preset as string,
      index = 2;
    while (project.clips.some((c) => c.name === name))
      name = `${preset}-${index++}`;
    const deforming = ["breathe", "spring", "ripple"].includes(preset);
    const parts = deforming && part ? project.parts.map((item) => item.id === part.id
      ? { ...item, flexibility: item.flexibility || 0.8 } : item) : project.parts;
    const next = generateSpineClip(parts, preset, name);
    update((p) => ({ ...p, parts, clips: [...p.clips, next] }));
    setClipId(next.id);
    setSetup(false);
    setTime(0);
    setPlaying(true);
  };
  const openMotionStudy = () => {
    if (!project || !clip) return;
    const existing = project.motionStudies?.find((item) => item.clipId === clip.id);
    if (!existing) {
      if ((project.motionStudies?.length ?? 0) >= SPINE_LIMITS.motionStudies) {
        setError(tr("动作研究已达到 8 个上限", "The project already has 8 motion studies"));
        return;
      }
      const study = createSpineMotionStudy(clip);
      update((p) => ({ ...p, motionStudies: [...(p.motionStudies ?? []), study] }));
    }
    setMotionOpen(true);
    setPlaying(false);
  };
  const updateMotionStudy = (study: SpineMotionStudy) => {
    update((p) => ({
      ...p,
      motionStudies: (p.motionStudies ?? []).map((item) =>
        item.id === study.id ? study : item,
      ),
    }));
  };
  const generatePoseImage = async (request: SpinePoseImageRequest) => {
    if (!model) throw new Error(tr("请先配置生图模型", "Configure an image model first."));
    const current = projectRef.current;
    const study = current?.motionStudies?.find((item) => item.id === request.studyId);
    if (!current || !study || !spinePoseImageReferencesMatch(request, study))
      throw new Error(tr("姿态研究已改变，请重新生成", "The pose study changed; generate again."));
    const capabilities = imageModelCapabilities(model.id);
    const images = [
      ...(current.sourceImage ? [{image: current.sourceImage.image, name: "spine-source.png"}] : []),
      ...request.neighbors.map((frame) => ({image: frame.image!, name: `spine-pose-${frame.time < request.time ? "previous" : "next"}-${frame.time}s.png`})),
    ];
    const attached = await importClipboardImages(images.map(spineAssistantImageFile));
    if (attached.length !== images.length) throw new Error(tr("姿态参考图未能完整附加", "Could not attach every pose reference"));
    const latest = projectRef.current;
    const latestStudy = latest?.motionStudies?.find((item) => item.id === request.studyId);
    if (!mounted.current || latest?.id !== current.id || latest.parts !== current.parts || latest.sourceImage !== current.sourceImage ||
      latest.clips !== current.clips || !latestStudy || !spinePoseImageReferencesMatch(request, latestStudy))
      throw new Error(tr("参考上下文已改变，请重新生成", "The reference context changed; generate again."));
    const effectiveReferences = [...attached, ...references];
    const result = await generateMedia({
      kind: "image",
      profileId: model.profileId,
      model: model.id,
      protocol: model.protocol,
      prompt: `${spinePoseImagePrompt(current, request)} ${spineImageBackgroundPrompt(model.id)}`,
      count: 1,
      size: "auto",
      outputFormat: "png",
      background:
        !model.id.includes("gpt-image-2") && !capabilities.minimax
          ? "transparent"
          : "auto",
      referenceAttachmentIds: effectiveReferences.map((r) => r.id),
    });
    const asset = result.assets.find((item) => item.kind === "image" && item.status === "completed" && item.filePath);
    const url = asset ? mediaAssetUrl(asset) : undefined;
    if (!url) throw new Error(result.errors.join("\n") || tr("生图模型没有返回姿态图", "The image model returned no pose image."));
    return prepareSpineSource(url, `pose-${request.time}s.png`);
  };
  const runGeneratePoseImage = async (request: SpinePoseImageRequest) => {
    let generated: Awaited<ReturnType<typeof generatePoseImage>> | undefined;
    await run(async () => {
      generated = await generatePoseImage(request);
    });
    if (!generated)
      throw new Error(tr("姿态图生成失败", "Pose image generation failed."));
    return generated;
  };
  const applyMotionStudy = (study: SpineMotionStudy, replace: boolean) => {
    if (!project || !clip) return;
    if (!replace && project.clips.length >= SPINE_LIMITS.clips) {
      setError(tr("动作数量已达到 16 个上限", "The project already has 16 animations"));
      return;
    }
    const compiled = applySpineStudy(project, study);
    if (replace) {
      update((p) => ({
        ...p,
        clips: p.clips.map((item) => (item.id === clip.id ? compiled : item)),
      }));
      setNotice(tr("已将插帧结果写回当前动作，骨骼轨道仍可继续编辑。", "Interpolated keys were written to the current action and remain editable."));
    } else {
      let name = `${clip.name} · fitted`;
      let index = 2;
      while (project.clips.some((item) => item.name === name)) name = `${clip.name} · fitted ${index++}`;
      const next = {
        ...compiled,
        id: `clip_${crypto.randomUUID().replace(/-/g, "")}`,
        name,
      };
      update((p) => ({ ...p, clips: [...p.clips, next] }));
      setClipId(next.id);
      setNotice(tr("已创建新的可编辑动作，原动作保留。", "Created a new editable action; the source action was kept."));
    }
    setMotionOpen(false);
    setSetup(false);
    setTime(0);
  };
  const removePart = () => {
    if (!part) return;
    update((p) => ({
      ...p,
      parts: p.parts
        .filter((item) => item.id !== part.id)
        .map((item) =>
          item.parent === part.id ? { ...item, parent: part.parent } : item,
        ),
      clips: p.clips.map((c) => ({
        ...c,
        tracks: Object.fromEntries(
          Object.entries(c.tracks).filter(([id]) => id !== part.id),
        ),
      })),
    }));
    setSelected("");
  };
  const reorderPart = (direction: number) => {
    if (!part) return;
    update((p) => {
      const parts = [...p.parts],
        index = parts.findIndex((item) => item.id === part.id),
        to = index + direction;
      if (to >= 0 && to < parts.length)
        [parts[index], parts[to]] = [parts[to], parts[index]];
      return { ...p, parts };
    });
  };
  const loadHistory = () => {
    setHistory([]);
    setHistoryLoading(true);
    void listMediaAssets("image", 24)
      .then((page) =>
        setHistory(
          page.assets.filter((a) => a.status === "completed" && a.filePath),
        ),
      )
      .catch((e) => setError(String(e)))
      .finally(() => setHistoryLoading(false));
  };
  return (
    <section
      className="spine-studio creative-studio"
      hidden={!active}
      aria-label={tr("Spine 工作台", "Spine Studio")}
    >
      <CreativeStudioHeader
        mode="spine"
        onModel3d={onModel3d} onMusic={onMusic}
        subtitle={tr("可编辑的 2D 骨骼动画", "Editable 2D skeletal animation")}
        onMedia={onMedia}
        onWriting={onWriting}
        onConstellation={onConstellation}
        actions={
          <div className="spine-header-actions">
            <button onClick={() => void newProject()} disabled={busy}>
              <Plus size={14} />
              {tr("新建", "New")}
            </button>
            <button
              onClick={() => projectInput.current?.click()}
              disabled={busy}
            >
              <Upload size={14} />
              {tr("打开工程", "Open project")}
            </button>
            <button
              onClick={() =>
                void run(async () => {
                  if (project) await persist(project);
                })
              }
              disabled={busy || !project}
            >
              <Save size={14} />
              {tr("保存", "Save")}
            </button>
            <button
              className="primary"
              disabled={busy || !project?.parts.length}
              onClick={() =>
                void run(async () => {
                  if (!project) return;
                  setProgress(
                    tr("编译骨骼与图集…", "Compiling skeleton and atlas…"),
                  );
                  const destination = await saveSpineArchive(
                    await exportSpineArchive(project),
                    project.name,
                  );
                  if (destination)
                    setNotice(
                      tr(`已导出：${destination}`, `Exported: ${destination}`),
                    );
                })
              }
            >
              <Download size={14} />
              {tr("导出 Spine", "Export Spine")}
            </button>
          </div>
        }
      />
      <input
        ref={sourceInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run(async () => {
            if (file.size > 16 * 1024 * 1024) throw new Error("Source image exceeds 16 MiB.");
            const url = URL.createObjectURL(file);
            try { await setSourceImage(url, file.name); }
            finally { URL.revokeObjectURL(url); }
          });
        }}
      />
      <input
        ref={partsInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void importParts(files);
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void importParts(files, true);
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void run(async () => {
              if (file.size > 64 * 1024 * 1024)
                throw new Error(
                  tr("工程不能超过 64 MiB", "Project may not exceed 64 MiB"),
                );
              const incoming = await verifySpineProjectImages(
                validateSpineProject(JSON.parse(await file.text())),
              );
              if (projectRef.current) await persist(projectRef.current);
              const next = {
                ...incoming,
                id: newSpineProject().id,
                updatedAt: Date.now(),
              };
              await persist(next);
              selectProject(next);
            });
        }}
      />
      <div className="spine-workspace">
        <aside className="spine-assets">
          <div className="spine-section-title">
            <span>01</span>
            <h2>{tr("角色与部件", "Character & parts")}</h2>
            <small>{project?.parts.length ?? 0}/24</small>
          </div>
          <fieldset disabled={busy || !project}>
            <details className="spine-project-details"><summary>{project?.name ?? tr("本地工程", "Local project")}</summary>
            <label className="spine-label">
              {tr("本地工程", "Local project")}
              <select
                aria-label={tr("本地工程", "Local project")}
                value={project?.id ?? ""}
                onChange={(e) => {
                  const id = e.target.value;
                  void run(async () => {
                    if (projectRef.current) await persist(projectRef.current);
                    const next = await loadSpineProject(id);
                    if (next) selectProject(next);
                  });
                }}
              >
                {project && !projects.some((p) => p.id === project.id) && (
                  <option value={project.id}>{project.name}</option>
                )}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="spine-project-name"
              aria-label={tr("工程名称", "Project name")}
              maxLength={160}
              value={project?.name ?? ""}
              onChange={(e) =>
                update((p) => ({
                  ...p,
                  name:
                    e.target.value || tr("未命名角色", "Untitled character"),
                }))
              }
            />
            </details>
            <div className="spine-save-state" role="status">
              {saveState === "saved"
                ? tr("已保存到本机", "Saved on this device")
                : saveState === "error"
                  ? tr("保存失败，请导出备份", "Save failed; export a backup")
                  : saveState === "loading"
                    ? tr("正在读取工程…", "Loading projects…")
                    : tr("正在保存…", "Saving…")}
            </div>
              <label className="spine-label">
                {tr("生图连接与模型", "Image connection & model")}
                <select
                  value={model ? `${model.profileId}::${model.id}` : ""}
                  onChange={(e) => setModelKey(e.target.value)}
                >
                  {!models.length && (
                    <option value="">
                      {tr("未配置生图模型", "No image model configured")}
                    </option>
                  )}
                  {models.map((m) => (
                    <option
                      key={`${m.profileId}::${m.id}`}
                      value={`${m.profileId}::${m.id}`}
                    >
                      {m.id} · {m.profileName}
                    </option>
                  ))}
                </select>
              </label>
              {!models.length && (
                <button className="spine-wide" onClick={onConfigureConnection}>
                  {tr("配置生图连接", "Configure image connection")}
                </button>
              )}
          </fieldset>
          <div className="spine-asset-tabs" role="tablist" aria-label={tr("工作流程", "Workflow")}>
            {(["chat", "source", "retouch"] as const).map((tab, i) => <button key={tab} role="tab" id={`spine-tab-${tab}`} aria-selected={assetTab === tab} aria-controls={`spine-panel-${tab}`} onClick={() => setAssetTab(tab)}>{[tr("部件与动作", "Rig & motion"), tr("素材", "Sources"), tr("贴图微调", "Retouch")][i]}</button>)}
          </div>
          <fieldset disabled={busy || !project} hidden={assetTab !== "source"} id="spine-panel-source" role="tabpanel" aria-labelledby="spine-tab-source">
            <section className="spine-source">
              <div className="spine-section-title"><ImagePlus size={16} /><h2>{tr("整图素材", "Source image")}</h2></div>
              {project?.sourceImage && <img className="spine-source-preview" src={project.sourceImage.image} alt={project.sourceImage.name} />}
              <div className="spine-button-row">
                <button onClick={() => sourceInput.current?.click()}><Upload size={14} />{tr("上传整图", "Upload image")}</button>
                <button disabled={!model} onClick={() => void generateSource()}><Sparkles size={14} />{tr("生成整图", "Generate image")}</button>
                <button disabled={!isDesktop()} onClick={() => void run(async () => setSourceHistory((await listMediaAssets("image", 24)).assets.filter((asset) => asset.status === "completed" && asset.filePath)))}><Eye size={14} />{tr("生图历史", "History")}</button>
              </div>
              {sourceHistory && <div className="spine-source-history">{sourceHistory.map((asset) => <button key={asset.id} title={asset.prompt} onClick={() => void run(async () => { const url = mediaAssetUrl(asset); if (url) await setSourceImage(url, asset.fileName ?? asset.id); })}><img src={mediaAssetUrl(asset)} alt={asset.prompt} /></button>)}</div>}
              {project?.sourceImage && <>
                <p className="spine-hint">{tr("下一步：在「部件与动作」发送拆件要求，再生成草案部件。", "Next: describe the parts in Rig & motion, then generate the planned textures.")}</p>
                <button className="spine-wide primary" onClick={() => setAssetTab("chat")}>{tr("规划拆件与动作", "Plan parts & motion")}</button>
                <label className="spine-label">{tr("背景容差", "Background tolerance")} {backgroundTolerance}<input type="range" min={10} max={100} value={backgroundTolerance} onChange={(event) => setBackgroundTolerance(Number(event.target.value))} /></label>
                <div className="spine-button-row">
                  <button onClick={() => void run(async () => { const next = await removeSpineSolidBackground(project.sourceImage!, backgroundTolerance); update((p) => ({ ...p, sourceImage: next })); })}><WandSparkles size={14} />{tr("去纯色背景", "Remove solid background")}</button>
                  <button onClick={() => update((p) => ({ ...p, sourceImage: { ...p.sourceImage!, image: p.sourceImage!.originalImage } }))}><RotateCcw size={14} />{tr("还原", "Restore")}</button>
                </div>
              </>}
            </section>
            <details className="spine-import-options"><summary>{tr("导入分层与本地拆层", "Layer import & local splitting")}</summary>
            <button
              className="spine-wide"
              onClick={() => partsInput.current?.click()}
            >
              <ImagePlus size={15} />
              {tr("导入 PNG 部件", "Import PNG parts")}
            </button>
            <p className="spine-hint">
              {tr(
                "使用已分层、补全遮挡的透明部件。名称含 head / body / arm-left 等会自动识别角色。",
                "Use transparent, complete parts. Names such as head, body and arm-left set their roles automatically.",
              )}
            </p>
            <div className="spine-layer-entry">
              <button className="spine-wide" onClick={() => setLayerImport({})}>
                <Upload size={15} />
                {tr("导入图层清单", "Import layer manifest")}
              </button>
              <button className="spine-wide" onClick={() => setComfyOpen(true)}>
                <Sparkles size={15} />
                {tr("本地 AI 拆层", "Local AI layers")}
              </button>
              <p className="spine-hint">
                {tr(
                  "本地 AI 拆层需要另行部署 ComfyUI、See-through 和模型。会话规划与部件生图可直接使用已配置的模型连接。",
                  "Local splitting needs a separate ComfyUI, See-through and model installation. Chat planning and texture generation use your configured model connections.",
                )}
              </p>
            </div>
            </details>
          </fieldset>
          <fieldset disabled={busy || !project} hidden={assetTab !== "retouch"} id="spine-panel-retouch" role="tabpanel" aria-labelledby="spine-tab-retouch">
            <section className="spine-retouch">
              <h3>{tr("微调当前贴图", "Refine selected texture")}</h3>
              <label className="spine-label">{tr("当前部件", "Selected part")}
                <select aria-label={tr("微调部件", "Part to retouch")} value={selected} onChange={(event) => setSelected(event.target.value)}>
                  {!project?.parts.length && <option value="">{tr("先在会话中生成部件", "Generate parts in chat first")}</option>}
                  {project?.parts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              {part && <img className="spine-retouch-preview" src={part.image} alt={part.name} />}
              <label className="spine-label">{tr("单件重绘要求", "Part redraw instructions")}
                <textarea aria-label={tr("单件重绘要求", "Part redraw instructions")} value={redrawPrompt} maxLength={2000} onChange={(event) => setRedrawPrompt(event.target.value)} placeholder={tr("例如：补齐肩部连接，保留原来的配色和轮廓", "For example: complete the shoulder joint, keeping its palette and silhouette")} />
              </label>
              <div className="spine-retouch-shortcuts">{[tr("补齐连接处，保持其他细节", "Complete attachment ends; preserve other details"), tr("去掉相邻部件残留，保持比例", "Remove neighboring parts; preserve proportions")].map((text) => <button key={text} onClick={() => setRedrawPrompt(text)}>{text}</button>)}</div>
              <button className="spine-wide primary" disabled={!part || !model || !project?.sourceImage || !redrawPrompt.trim()} onClick={() => void redrawPart()}><Sparkles size={14} />{tr("重绘当前部件", "Redraw selected part")}</button>
              <p className="spine-hint">{tr("先对比贴图、装配和动作，再采纳。保留已有骨骼与动作，可撤销。", "Compare texture, assembly and motion before accepting. Keeps the rig and animation; supports undo.")}</p>
            </section>
            <details className="spine-generate">
              <summary>
                <Sparkles size={14} />
                {tr("外观描述与补充参考", "Appearance & extra references")}
              </summary>
              <label className="spine-label">
                {tr("角色或物体描述", "Character or object description")}
                <textarea
                  maxLength={10000}
                  rows={3}
                  value={project?.prompt ?? ""}
                  placeholder={tr(
                    "角色或物体的外观、画风、配色、材质…",
                    "Character or object appearance, style, palette, materials…",
                  )}
                  onChange={(e) =>
                    update((p) => ({ ...p, prompt: e.target.value }))
                  }
                />
              </label>
              <div className="spine-button-row">
                <button
                  disabled={!isDesktop()}
                  onClick={() =>
                    void run(async () =>
                      setReferences(await selectImageReferences(3)),
                    )
                  }
                >
                  <Upload size={13} />
                  {tr("参考图", "References")} ({references.length}/3)
                </button>
                <button disabled={!isDesktop()} onClick={loadHistory}>
                  <Eye size={13} />
                  {tr("生图历史", "Image history")}
                </button>
              </div>
              {references.map((r, i) => (
                <div className="spine-reference" key={r.id}>
                  <span>
                    {i + 1}. {r.name}
                  </span>
                  <button
                    aria-label={tr("移除参考图", "Remove reference")}
                    onClick={() =>
                      setReferences((all) =>
                        all.filter((item) => item.id !== r.id),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </details>
          </fieldset>
          <div hidden={assetTab !== "chat"} id="spine-panel-chat" role="tabpanel" aria-labelledby="spine-tab-chat">
          {!project?.sourceImage && <div className="spine-chat-start"><p className="spine-hint">{tr("先上传整图，再在会话中规划部件、蒙皮和动作。", "Upload a source image, then plan parts, skinning and motion in chat.")}</p><button disabled={busy || !project} onClick={() => sourceInput.current?.click()}><Upload size={14} />{tr("上传整图开始", "Upload to start")}</button></div>}
          {project && <SpineAssistantPanel project={project} clip={clip} time={time} onUpdate={update}
            canGenerate={!!model && !!project.sourceImage && !busy}
            mediaCatalogRevision={mediaCatalogRevision} externalBusy={busy}
            onGenerate={generatePlannedParts}
            onApply={(proposal) => {
            const current = projectRef.current;
            if (!current) return;
            const next = applySpineAssistantProposal(current, proposal);
            update(() => next);
            const proposedClip = next.clips.find((item) => item.name === proposal.clips?.[0]?.name);
            if (proposedClip) { setClipId(proposedClip.id); setTime(0); }
            setSetup(false);
            setPlaying(false);
          }} />}
          {!!project?.parts.length && <div className="spine-chat-parts">
            <div className="spine-section-title"><Layers3 size={16} /><h2>{tr("当前部件", "Current parts")}</h2><small>{project.parts.length}/24</small></div>
            <div className="spine-part-list" role="list" aria-label={tr("部件图层，后面的部件在上方", "Parts; later parts draw on top")}>
              {project.parts.map((p, index) => <button key={p.id} disabled={busy} className={`spine-part${selected === p.id ? " selected" : ""}`} onClick={() => setSelected(p.id)}>
                <span className="spine-part-thumb"><img src={p.image} alt="" /></span>
                <span><strong>{p.name}</strong><small>{roleName(p.role)}</small></span>
                <small>{String(index + 1).padStart(2, "0")}</small>
              </button>)}
            </div>
          </div>}
          </div>
        </aside>
        <main className="spine-stage">
          <div className="spine-stage-toolbar">
            <div className="spine-mode-toggle">
              <button
                className={setup ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setSetup(true);
                  setPlaying(false);
                }}
              >
                <Bone size={14} />
                {tr("绑定姿势", "Setup")}
              </button>
              <button
                className={!setup ? "active" : ""}
                disabled={!clip || busy}
                onClick={() => setSetup(false)}
              >
                <Play size={14} />
                {tr("动作", "Animate")}
              </button>
            </div>
            <div className="spine-view-options">
              <button
                className={showBones ? "active" : ""}
                aria-label={tr("显示骨骼", "Show bones")}
                title={tr("显示骨骼", "Show bones")}
                aria-pressed={showBones}
                onClick={() => setShowBones((v) => !v)}
              >
                <Bone size={15} />
              </button>
              <button
                className={showMesh ? "active" : ""}
                aria-label={tr("显示选中网格", "Show selected mesh")}
                title={tr("显示选中网格", "Show selected mesh")}
                aria-pressed={showMesh}
                onClick={() => setShowMesh((v) => !v)}
              >
                <Grid2X2 size={15} />
              </button>
              <select
                aria-label={tr("预览缩放", "Preview zoom")}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                  <option value={v} key={v}>
                    {v === 1 ? tr("适应", "Fit") : `${v * 100}%`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="spine-viewport">
            {project?.parts.length ? (
              <>
                <SpineCanvas
                  parts={project.parts}
                  clip={clip}
                  time={time}
                  selected={selected}
                  bones={showBones}
                  mesh={showMesh}
                  zoom={zoom}
                  setup={setup}
                  disabled={busy}
                  onSelect={setSelected}
                  onMove={(id, x, y, remember) =>
                    update(
                      (p) => ({
                        ...p,
                        parts: p.parts.map((item) =>
                          item.id === id
                            ? {
                                ...item,
                                x: Math.min(4000, Math.max(-4000, x)),
                                y: Math.min(4000, Math.max(-4000, y)),
                              }
                            : item,
                        ),
                      }),
                      remember,
                    )
                  }
                  onError={reportError}
                />
                <span className="spine-canvas-caption">
                  {setup
                    ? tr(
                        "绑定姿势 · 拖动部件调整位置",
                        "Setup pose · drag parts to position",
                      )
                    : `${clip?.name ?? ""} · ${time.toFixed(2)}s`}
                </span>
              </>
            ) : (
              <div className="spine-empty">
                <div className="spine-empty-symbol">
                  <Bone size={38} />
                </div>
                <small>SPINE STUDIO</small>
                <h1>{tr("让角色动起来", "Bring your character to life")}</h1>
                <p>
                  {tr(
                    "从透明部件开始，生成可编辑的骨骼和动作。在同一张画布上绑定、预览和调整。",
                    "Start with transparent parts. Generate editable bones and motion, then rig, preview and refine on one canvas.",
                  )}
                </p>
                <div>
                  <button
                    className="primary"
                    disabled={busy || !project}
                    onClick={() => partsInput.current?.click()}
                  >
                    <Upload size={15} />
                    {tr("导入角色部件", "Import character parts")}
                  </button>
                  <button disabled={busy} onClick={() => void newProject(true)}>
                    {tr("体验机器人示例", "Try robot example")}
                  </button>
                </div>
                <span>
                  {tr(
                    "本地绑定与预览 · Spine 4.2 资产导出",
                    "Local rigging & preview · Spine 4.2 export",
                  )}
                </span>
              </div>
            )}
          </div>
          <div className="spine-timeline">
            <div className="spine-timeline-toolbar">
              <div className="spine-section-title">
                <span>02</span>
                <h2>{tr("动作与关键帧", "Motion & keyframes")}</h2>
              </div>
              <button
                aria-label={tr("撤销编辑", "Undo edit")}
                title={tr("撤销编辑", "Undo edit")}
                disabled={busy || !undo.current.length}
                onClick={() => {
                  const previous = undo.current.pop();
                  if (previous) {
                    const restored = { ...previous, updatedAt: Date.now() };
                    projectRef.current = restored;
                    setProject(restored);
                    setTime(0);
                    setPlaying(false);
                  }
                }}
              >
                <RotateCcw size={14} />
              </button>
            </div>
            <div className="spine-motion-presets">
              <span>{tr("生成动作", "Generate motion")}</span>
              {(["idle", "wave", "walk", "breathe", "spring", "ripple"] as const).map((preset, i) => (
                <button
                  key={preset}
                  disabled={
                    busy ||
                    !project?.parts.length ||
                    project.clips.length >= SPINE_LIMITS.clips
                  }
                  onClick={() => generateMotion(preset)}
                >
                  <Sparkles size={12} />
                  {
                    [
                      tr("呼吸待机", "Idle"),
                      tr("挥手", "Wave"),
                      tr("原地行走", "Walk in place"),
                      tr("弹性呼吸", "Elastic breathing"),
                      tr("蓄力弹跳", "Squash & jump"),
                      tr("柔性波动", "Flexible ripple"),
                    ][i]
                  }
                </button>
              ))}
              <button
                disabled={!clip || !project?.parts.length || busy}
                onClick={openMotionStudy}
                title={tr("多图关键姿态、拟合与插帧", "Multi-image poses, fitting and interpolation")}
              >
                <Film size={12} />
                {tr("姿态研究", "Pose study")}
              </button>
            </div>
            <div className="spine-playback">
              <button
                className="spine-play"
                disabled={!clip || setup}
                aria-label={
                  playing && !setup ? tr("暂停", "Pause") : tr("播放", "Play")
                }
                onClick={() => setPlaying((v) => !v)}
              >
                {playing && !setup ? <Pause size={17} /> : <Play size={17} />}
              </button>
              <select
                aria-label={tr("当前动作", "Current animation")}
                value={clipId}
                disabled={busy || !project?.clips.length}
                onChange={(e) => {
                  setClipId(e.target.value);
                  setSetup(false);
                  setTime(0);
                }}
              >
                <option value="" disabled>
                  {tr("先生成一个动作", "Generate a motion first")}
                </option>
                {project?.clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <output>
                {time.toFixed(2)} / {(clip?.duration ?? 0).toFixed(2)}s
              </output>
              <button
                disabled={!clip || busy}
                aria-label={tr(
                  "删除当前动作（可撤销）",
                  "Delete animation (undoable)",
                )}
                title={tr(
                  "删除当前动作（可撤销）",
                  "Delete animation (undoable)",
                )}
                onClick={() => {
                  if (clip)
                    update((p) => ({
                      ...p,
                      clips: p.clips.filter((c) => c.id !== clip.id),
                    }));
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <div className="spine-time-track">
              <input
                aria-label={tr("动画时间", "Animation time")}
                type="range"
                min={0}
                max={clip?.duration ?? 2}
                step={0.001}
                value={time}
                disabled={!clip || setup}
                onChange={(e) => {
                  setPlaying(false);
                  setTime(Number(e.target.value));
                }}
              />
              <div className="spine-key-markers">
                {clip?.tracks[selected]?.map((k) => (
                  <button
                    key={k.time}
                    disabled={setup}
                    aria-label={tr(
                      `选择 ${k.time} 秒关键帧`,
                      `Select key at ${k.time} seconds`,
                    )}
                    title={`${k.time}s`}
                    style={{ left: `${(k.time / clip.duration) * 100}%` }}
                    className={Math.abs(time - k.time) < 0.001 ? "active" : ""}
                    onClick={() => {
                      setTime(k.time);
                      setPlaying(false);
                    }}
                  />
                ))}
              </div>
            </div>
            <p className="spine-hint">
              {tr(
                "预设生成骨骼曲线；可在右侧编辑关键帧，或在姿态研究中生成 RIFE 参考帧、识别并微调骨骼目标。",
                "Presets generate bone curves. Edit keys in the inspector, or generate RIFE reference frames and infer or refine bone targets in the pose study.",
              )}
            </p>
          </div>
        </main>
        <aside className="spine-inspector">
          <div className="spine-section-title">
            <span>03</span>
            <h2>{tr("部件与骨骼", "Part & bones")}</h2>
          </div>
          {part ? (
            <fieldset
              disabled={busy}
              onFocusCapture={() => {
                if (!setup) setPlaying(false);
              }}
            >
              <label className="spine-label">
                {tr("部件名称", "Part name")}
                <input
                  value={part.name}
                  maxLength={160}
                  onChange={(e) =>
                    changePart({ name: e.target.value || "part" })
                  }
                />
              </label>
              <label className="spine-label">
                {tr("动作角色", "Motion role")}
                <select
                  value={part.role}
                  onChange={(e) =>
                    changePart({ role: e.target.value as SpinePart["role"] })
                  }
                >
                  {SPINE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleName(r)}
                    </option>
                  ))}
                </select>
              </label>
              {setup ? (
                <>
                  <label className="spine-label">
                    {tr("父骨骼", "Parent bone")}
                    <select
                      value={part.parent ?? ""}
                      onChange={(e) =>
                        changePart({ parent: e.target.value || null })
                      }
                    >
                      <option value="">root</option>
                      {project?.parts
                        .filter((p) => {
                          if (p.id === part.id) return false;
                          try {
                            orderedSpineParts(
                              project.parts.map((item) =>
                                item.id === part.id
                                  ? { ...item, parent: p.id }
                                  : item,
                              ),
                            );
                            return true;
                          } catch {
                            return false;
                          }
                        })
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <h3>{tr("绑定位置 · Y 向上", "Setup position · Y up")}</h3>
                  <div className="spine-field-grid">
                    <NumberField
                      label="X"
                      value={part.x}
                      min={-4000}
                      max={4000}
                      onChange={(x) => changePart({ x })}
                    />
                    <NumberField
                      label="Y"
                      value={part.y}
                      min={-4000}
                      max={4000}
                      onChange={(y) => changePart({ y })}
                    />
                    <NumberField
                      label={tr("宽", "Width")}
                      value={part.width}
                      min={1}
                      max={2000}
                      onChange={(width) => changePart({ width })}
                    />
                    <NumberField
                      label={tr("高", "Height")}
                      value={part.height}
                      min={1}
                      max={2000}
                      onChange={(height) => changePart({ height })}
                    />
                    <NumberField
                      label={tr("枢轴 X", "Pivot X")}
                      value={part.pivotX}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(pivotX) => changePart({ pivotX })}
                    />
                    <NumberField
                      label={tr("枢轴 Y", "Pivot Y")}
                      value={part.pivotY}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(pivotY) => changePart({ pivotY })}
                    />
                  </div>
                  <p className="spine-hint">
                    {tr(
                      "枢轴按图片左上角归一化。修改父骨骼保持绑定位置。",
                      "Pivots use normalized image coordinates from the top left. Reparenting preserves setup placement.",
                    )}
                  </p>
                  <label className="spine-label">{tr("蒙皮延伸方向", "Skin direction")}
                    <select aria-label={tr("蒙皮延伸方向", "Skin direction")} value={part.skinDirection ?? "down"} onChange={(event) => changePart({ skinDirection: event.target.value as SpinePart["skinDirection"] })}>
                      {(["down", "up", "left", "right"] as const).map((direction, i) => <option key={direction} value={direction}>{[tr("向下", "Down"), tr("向上", "Up"), tr("向左", "Left"), tr("向右", "Right")][i]}</option>)}
                    </select>
                  </label>
                  <label className="spine-label">
                    {tr("蒙皮柔性权重", "Skin flexibility")} ·{" "}
                    {Math.round(part.flexibility * 100)}%
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={part.flexibility}
                      onChange={(e) =>
                        changePart({ flexibility: Number(e.target.value) })
                      }
                    />
                  </label>
                  <p className="spine-hint">
                    {tr(
                      "权重从枢轴沿所选方向递增。弯曲、局部伸缩和末端位移会改变网格形状；0% 为刚性贴图。",
                      "Weights increase from the pivot in the chosen direction. Bend, local scale and tip offsets deform the mesh; 0% stays rigid.",
                    )}
                  </p>
                </>
              ) : (
                clip && (
                  <>
                    <label className="spine-label">
                      {tr("动作名称", "Animation name")}
                      <input
                        key={clip.id}
                        defaultValue={clip.name}
                        maxLength={160}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (
                            !name ||
                            ["__proto__", "constructor", "prototype"].includes(
                              name,
                            ) ||
                            project?.clips.some(
                              (c) => c.id !== clip.id && c.name === name,
                            )
                          ) {
                            e.target.value = clip.name;
                            setError(
                              tr(
                                "动作名称不能为空或重复",
                                "Animation names must be nonempty and unique",
                              ),
                            );
                          } else if (name !== clip.name)
                            editClip((c) => ({ ...c, name }));
                        }}
                      />
                    </label>
                    <h3>
                      {tr("当前时间的关键帧", "Keyframe at current time")} ·{" "}
                      {time.toFixed(2)}s
                    </h3>
                    <div className="spine-field-grid">
                      <NumberField
                        label={tr("旋转 °", "Rotation °")}
                        value={key.rotation}
                        min={-360}
                        max={360}
                        onChange={(rotation) => editKey({ rotation })}
                      />
                      <NumberField
                        label={tr("弯曲 °", "Bend °")}
                        value={key.bend}
                        min={-360}
                        max={360}
                        onChange={(bend) => editKey({ bend })}
                      />
                      <NumberField label={tr("柔性宽度", "Flex width")} value={key.scaleX ?? 1} min={0.25} max={2} step={0.01} onChange={(scaleX) => editKey({ scaleX })} />
                      <NumberField label={tr("柔性高度", "Flex height")} value={key.scaleY ?? 1} min={0.25} max={2} step={0.01} onChange={(scaleY) => editKey({ scaleY })} />
                      <NumberField label={tr("末端位移 X", "Tip offset X")} value={key.tipX ?? 0} min={-1000} max={1000} onChange={(tipX) => editKey({ tipX })} />
                      <NumberField label={tr("末端位移 Y", "Tip offset Y")} value={key.tipY ?? 0} min={-1000} max={1000} onChange={(tipY) => editKey({ tipY })} />
                      <NumberField
                        label={tr("位移 X", "Offset X")}
                        value={key.x}
                        min={-1000}
                        max={1000}
                        onChange={(x) => editKey({ x })}
                      />
                      <NumberField
                        label={tr("位移 Y", "Offset Y")}
                        value={key.y}
                        min={-1000}
                        max={1000}
                        onChange={(y) => editKey({ y })}
                      />
                    </div>
                    <label className="spine-label">
                      {tr("到下一帧的插值", "Interpolation to next key")}
                      <select
                        value={key.curve}
                        onChange={(e) =>
                          editKey({
                            curve: e.target.value as SpineKey["curve"],
                          })
                        }
                      >
                        <option value="linear">{tr("线性", "Linear")}</option>
                        <option value="stepped">{tr("阶梯", "Stepped")}</option>
                      </select>
                    </label>
                    <div className="spine-button-row">
                      <button onClick={() => editKey({})}>
                        <Plus size={13} />
                        {tr("记录姿态", "Set key")}
                      </button>
                      <button
                        disabled={
                          !clip.tracks[part.id]?.some(
                            (k) => Math.abs(k.time - time) < 0.0005,
                          )
                        }
                        onClick={() =>
                          editClip((c) => ({
                            ...c,
                            tracks: {
                              ...c.tracks,
                              [part.id]: (c.tracks[part.id] ?? []).filter(
                                (k) => Math.abs(k.time - time) >= 0.0005,
                              ),
                            },
                          }))
                        }
                      >
                        {tr("删除关键帧", "Delete key")}
                      </button>
                    </div>
                    <NumberField
                      label={tr(
                        "动作时长（缩放关键帧）",
                        "Duration (scale keys)",
                      )}
                      value={clip.duration}
                      min={0.1}
                      max={30}
                      step={0.1}
                      onChange={(duration) => {
                        setPlaying(false);
                        setTime(0);
                        editClip((c) => ({
                          ...c,
                          duration,
                          tracks: Object.fromEntries(
                            Object.entries(c.tracks).map(([id, keys]) => [
                              id,
                              keys.map((k) => ({
                                ...k,
                                time: (k.time / c.duration) * duration,
                              })),
                            ]),
                          ),
                        }));
                      }}
                    />
                  </>
                )
              )}
              <h3>{tr("贴图与绘制顺序", "Texture & draw order")}</h3>
              <button className="spine-wide" onClick={() => setAssetTab("retouch")}><WandSparkles size={14} />{tr("打开贴图微调", "Open texture retouch")}</button>
              <button
                className="spine-wide"
                onClick={() => replaceInput.current?.click()}
              >
                <ImagePlus size={14} />
                {tr("替换贴图", "Replace texture")}
              </button>
              <button className="spine-wide" onClick={() => void run(async () => {
                const cutout = await removeSpineSolidBackground({
                  name: part.name, image: part.image, originalImage: part.image,
                  width: part.imageWidth, height: part.imageHeight,
                }, backgroundTolerance);
                const data = await normalizeSpineImage(cutout.image);
                update((current) => ({ ...current, parts: current.parts.map((item) => item.id === part.id
                  ? { ...item, image: data.image, imageWidth: data.width, imageHeight: data.height } : item) }));
                setNotice(tr("已去除纯色背景；可用撤销恢复原贴图", "Solid background removed; Undo restores the previous texture"));
              })}><WandSparkles size={14} />{tr("去纯色背景", "Remove solid background")}</button>
              <div className="spine-button-row">
                <button
                  disabled={project?.parts[0].id === part.id}
                  onClick={() => reorderPart(-1)}
                >
                  <ArrowDown size={13} />
                  {tr("向后", "Back")}
                </button>
                <button
                  disabled={
                    project?.parts[project.parts.length - 1].id === part.id
                  }
                  onClick={() => reorderPart(1)}
                >
                  <ArrowUp size={13} />
                  {tr("向前", "Front")}
                </button>
              </div>
              <button className="spine-wide spine-danger" onClick={removePart}>
                <Trash2 size={13} />
                {tr("删除部件（可撤销）", "Delete part (undoable)")}
              </button>
            </fieldset>
          ) : (
            <div className="spine-inspector-empty">
              <Bone size={28} />
              <p>
                {tr(
                  "选择一个部件，编辑骨骼、网格权重和关键帧。",
                  "Select a part to edit bones, mesh weights and keyframes.",
                )}
              </p>
            </div>
          )}
          <div className="spine-export-note">
            <strong>Spine 4.2</strong>
            <p>
              {tr(
                "导出包含 JSON、atlas、PNG 和可重新打开的工程。用 Spine「导入数据」新建骨架，再保存为 .spine。",
                "Export includes JSON, atlas, PNG and a reopenable project. Import Data as a new skeleton in Spine, then save as .spine.",
              )}
            </p>
          </div>
        </aside>
      </div>
      <SpineComfyPanel
        open={comfyOpen}
        active={active}
        initialSource={project?.sourceImage}
        onClose={() => setComfyOpen(false)}
        onReview={(initial) => setLayerImport({ initial })}
        onPendingCountChange={setComfyPending}
      />
      {project && clip && (
        <SpineMotionStudyPanel
          open={motionOpen}
          project={project}
          clip={clip}
          time={time}
          selectedPart={selected}
          modelAvailable={Boolean(model)}
          busy={busy}
          onClose={() => setMotionOpen(false)}
          onUpdate={updateMotionStudy}
          onGenerateImage={runGeneratePoseImage}
          onApply={applyMotionStudy}
        />
      )}
      {layerImport && (
        <SpineLayerImport
          initial={layerImport.initial}
          onClose={() => setLayerImport(null)}
          onImport={async (next) => {
            if (projectRef.current) await persist(projectRef.current);
            await persist(next);
            selectProject(next);
            setSaveState("saved");
          }}
        />
      )}
      {(busy || error || notice) && (
        <div
          className={`spine-status ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {busy && <LoaderCircle size={15} className="spine-spinner" />}
          <span>
            {error || (busy ? progress || tr("正在处理…", "Working…") : notice)}
          </span>
          {busy && progress.startsWith(tr("正在生成", "Generating")) ? (
            <button
              onClick={() => {
                stop.current = true;
                setNotice(
                  tr("当前图片完成后停止", "Stopping after the current image"),
                );
                setProgress(
                  tr(
                    "当前图片完成后停止…",
                    "Stopping after the current image…",
                  ),
                );
              }}
            >
              <Square size={12} />
              {tr("停止后续生成", "Stop after this image")}
            </button>
          ) : (
            !busy && (
              <button
                aria-label={tr("关闭提示", "Dismiss")}
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
              >
                <X size={14} />
              </button>
            )
          )}
        </div>
      )}
      {redrawCandidate && project && <SpineRedrawReview parts={project.parts} replacement={redrawCandidate.part} clip={clip}
        opaque={redrawCandidate.opaque} onApply={() => void applyRedraw()} onClose={() => setRedrawCandidate(undefined)} />}
      {history && (
        <div className="spine-modal-backdrop" onClick={() => setHistory(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={tr(
              "选择生图历史作为参考",
              "Choose generated reference",
            )}
            className="spine-history-dialog"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setHistory(null);
            }}
          >
            <div className="spine-section-title">
              <h2>
                {tr("选择生图历史作为角色参考", "Choose a character reference")}
              </h2>
              <button
                autoFocus
                aria-label={tr("关闭", "Close")}
                onClick={() => setHistory(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="spine-hint">
              {tr(
                "按选择顺序编号，最多 3 张。第一张用于约束角色身份。",
                "Up to three references, in selection order. The first anchors character identity.",
              )}
            </p>
            {historyLoading ? (
              <p>{tr("读取中…", "Loading…")}</p>
            ) : !history.length ? (
              <p>
                {tr(
                  "暂无完成的生图结果。可先去生图工作台创作。",
                  "No completed images. Create one in the image studio first.",
                )}
              </p>
            ) : (
              <div className="spine-history-grid">
                {history.map((a) => (
                  <button
                    key={a.id}
                    disabled={busy || references.length >= 3}
                    onClick={() =>
                      void run(async () => {
                        if (!a.filePath) return;
                        const imported = await importAttachments([a.filePath]);
                        setReferences((r) => [...r, ...imported].slice(0, 3));
                        setHistory(null);
                      })
                    }
                  >
                    <img src={mediaAssetUrl(a)} alt={a.prompt} />
                    <span>{a.prompt}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

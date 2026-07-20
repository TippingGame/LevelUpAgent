import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  Image,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Move,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Video,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  deleteImageAttachment,
  deleteMediaAsset,
  exportMediaAsset,
  generateMedia,
  getMediaCatalog,
  importAttachments,
  importClipboardImages,
  listMediaAssets,
  mediaAssetUrl,
  refreshMediaAsset,
  selectImageReferences,
} from "../lib/bridge";
import { tr } from "../lib/i18n";
import { copyText } from "../lib/clipboard";
import type {
  ImageAttachment,
  MediaAsset,
  MediaGenerationRequest,
  MediaKind,
  MediaModelInfo,
} from "../lib/types";
import { AttachmentChip } from "./AttachmentChip";

interface PromptDraft {
  id: string;
  prompt: string;
}

type StudioMediaAsset = MediaAsset & {
  pendingOutput?: { index: number; total: number };
};

interface PreviewPoint {
  x: number;
  y: number;
}

interface PreviewTransform extends PreviewPoint {
  zoom: number;
}

const MIN_PREVIEW_ZOOM = 0.05;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 1.2;

interface MediaStudioProps {
  active: boolean;
  locale: string;
  mediaCatalogRevision: number;
  dropActive: boolean;
  referenceDrop: { id: string; paths: string[] } | null;
  onReferenceDropHandled: (id: string) => void;
  onConfigureConnection: () => void;
  onPendingCountChange: (count: number) => void;
}

const KIND_TABS: Array<{ kind: MediaKind; icon: typeof Image }> = [
  { kind: "image", icon: Image },
  { kind: "video", icon: Video },
  { kind: "audio", icon: AudioLines },
];
interface ImageDimensionOption {
  value: string;
  ratio: string;
  experimental?: boolean;
}

const IMAGE_DIMENSION_OPTIONS: ImageDimensionOption[] = [
  { value: "1024x1024", ratio: "1:1" },
  { value: "1536x1024", ratio: "3:2" },
  { value: "1024x1536", ratio: "2:3" },
  { value: "2048x1152", ratio: "16:9" },
  { value: "1152x2048", ratio: "9:16" },
  { value: "2048x2048", ratio: "1:1", experimental: true },
  { value: "3840x2160", ratio: "16:9", experimental: true },
  { value: "2160x3840", ratio: "9:16", experimental: true },
];
const IMAGE_RATIO_OPTIONS = ["16:9", "9:16", "21:9", "9:21"];
const IMAGE_SIZE_OPTIONS = ["auto", ...IMAGE_DIMENSION_OPTIONS.map((option) => option.value), ...IMAGE_RATIO_OPTIONS];
const VIDEO_SIZE_OPTIONS = ["1280x720", "720x1280", "16:9", "9:16"];

export function MediaStudio({ active, locale, mediaCatalogRevision, dropActive, referenceDrop, onReferenceDropHandled, onConfigureConnection, onPendingCountChange }: MediaStudioProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<MediaKind>("image");
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getMediaCatalog>> | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [pendingAssets, setPendingAssets] = useState<StudioMediaAsset[]>([]);
  const [selectedModels, setSelectedModels] = useState<Partial<Record<MediaKind, string>>>({});
  const [prompts, setPrompts] = useState<PromptDraft[]>([
    { id: crypto.randomUUID(), prompt: "" },
  ]);
  const [references, setReferences] = useState<ImageAttachment[]>([]);
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [outputFormat, setOutputFormat] = useState("png");
  const [background, setBackground] = useState("auto");
  const [seconds, setSeconds] = useState(8);
  const [voice, setVoice] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pastingReferences, setPastingReferences] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
  const catalogRequestRef = useRef(0);

  const models = useMemo(
    () => (catalog?.models ?? []).filter((model) => model.kind === kind),
    [catalog, kind],
  );
  const selectedKey = selectedModels[kind];
  const selected = models.find((model) => modelKey(model) === selectedKey)
    ?? models.find((model) => model.recommended)
    ?? models[0];
  const transparentBackgroundSupported = !selected?.id.toLocaleLowerCase().includes("gpt-image-2");
  const visibleAssets = assets.filter((asset) => asset.kind === kind);
  const visiblePendingAssets = pendingAssets.filter((asset) => asset.kind === kind);
  const displayedAssets: StudioMediaAsset[] = [...visiblePendingAssets, ...visibleAssets];
  const previewableAssets = displayedAssets.filter(
    (asset) => asset.kind === "image" && asset.status === "completed" && Boolean(mediaAssetUrl(asset)),
  );
  const pendingVideoIds = assets
    .filter((asset) => asset.kind === "video" && (asset.status === "queued" || asset.status === "in_progress"))
    .map((asset) => asset.id);

  const load = async (showSpinner = true) => {
    const requestId = ++catalogRequestRef.current;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [nextCatalog, nextAssets] = await Promise.all([
        getMediaCatalog(),
        listMediaAssets(),
      ]);
      if (requestId !== catalogRequestRef.current) return;
      setCatalog(nextCatalog);
      setAssets(nextAssets);
    } catch (reason) {
      if (requestId === catalogRequestRef.current) setError(errorText(reason));
    } finally {
      if (requestId === catalogRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [active, mediaCatalogRevision]);

  useEffect(() => {
    if (!selected) return;
    const key = modelKey(selected);
    if (selectedModels[kind] !== key) {
      setSelectedModels((current) => ({ ...current, [kind]: key }));
    }
  }, [kind, selected?.id, selected?.profileId]);

  useEffect(() => {
    if (!transparentBackgroundSupported && background === "transparent") setBackground("auto");
  }, [transparentBackgroundSupported]);

  useEffect(() => {
    onPendingCountChange(pendingAssets.length);
  }, [onPendingCountChange, pendingAssets.length]);

  useEffect(() => {
    if (kind === "image") {
      setSize((current) => IMAGE_SIZE_OPTIONS.includes(current) ? current : "auto");
      setOutputFormat((current) => ["png", "webp", "jpeg"].includes(current) ? current : "png");
    } else if (kind === "video") {
      setSize((current) => VIDEO_SIZE_OPTIONS.includes(current) ? current : "1280x720");
    } else {
      setOutputFormat((current) => ["mp3", "wav", "aac", "flac", "opus"].includes(current) ? current : "mp3");
    }
  }, [kind]);

  useEffect(() => {
    if (pendingVideoIds.length === 0) return;
    let disposed = false;
    const refreshPending = async () => {
      const results = await Promise.allSettled(pendingVideoIds.map(refreshMediaAsset));
      if (disposed) return;
      setAssets((current) => mergeAssets(current, results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])));
    };
    const timer = window.setInterval(() => void refreshPending(), 5_000);
    void refreshPending();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pendingVideoIds.join("|")]);

  const addPrompt = () => {
    if (prompts.length >= 8) return;
    setPrompts((current) => [...current, { id: crypto.randomUUID(), prompt: "" }]);
  };

  const updatePrompt = (id: string, prompt: string) => {
    setPrompts((current) => current.map((item) => item.id === id ? { ...item, prompt } : item));
  };

  const removePrompt = (id: string) => {
    setPrompts((current) => current.length === 1 ? current : current.filter((item) => item.id !== id));
  };

  const addReferences = async () => {
    try {
      const selectedImages = await selectImageReferences();
      await acceptReferences(selectedImages);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const acceptReferences = async (incoming: ImageAttachment[]) => {
    const ids = new Set(references.map((item) => item.id));
    const available = Math.max(0, 8 - references.length);
    const accepted = incoming
      .filter((item) => item.kind === "image" && !ids.has(item.id))
      .slice(0, available);
    const acceptedIds = new Set(accepted.map((item) => item.id));
    const discarded = incoming.filter((item) => !acceptedIds.has(item.id));
    setReferences((current) => [...current, ...accepted].slice(0, 8));
    await Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
    if (incoming.some((item) => item.kind !== "image")) {
      setError(tr("创作空间的拖拽区域只接受图片参考", "The Media Studio drop zone accepts image references only"));
    } else if (accepted.length < incoming.length) {
      setError(tr("最多添加 8 张参考图", "You can add up to 8 reference images"));
    }
  };

  const importReferencePaths = async (paths: string[]) => {
    const available = Math.max(0, 8 - references.length);
    if (available === 0) {
      setError(tr("最多添加 8 张参考图", "You can add up to 8 reference images"));
      return;
    }
    const imported = await importAttachments(paths.slice(0, 12));
    await acceptReferences(imported);
  };

  const importPastedReferences = async (files: File[]) => {
    const available = Math.max(0, 8 - references.length);
    if (available === 0) {
      setError(tr("最多添加 8 张参考图", "You can add up to 8 reference images"));
      return;
    }
    const selected = files.slice(0, available);
    setPastingReferences(true);
    setError(null);
    try {
      const imported = await importClipboardImages(selected);
      await acceptReferences(imported);
      if (selected.length < files.length) {
        setError(tr("最多添加 8 张参考图，超出的图片未粘贴", "You can add up to 8 reference images; extra images were not pasted"));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPastingReferences(false);
    }
  };

  useEffect(() => {
    if (!active || !referenceDrop) return;
    setKind("image");
    setError(null);
    void importReferencePaths(referenceDrop.paths)
      .catch((reason) => setError(errorText(reason)))
      .finally(() => onReferenceDropHandled(referenceDrop.id));
  }, [active, referenceDrop?.id]);

  useEffect(() => {
    if (!active) return;
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target;
      const root = rootRef.current;
      const isStudioTarget = target instanceof Node && root?.contains(target);
      const isPageTarget = target === document.body || target === document.documentElement;
      if (!isStudioTarget && !isPageTarget) return;
      const files = clipboardImageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      setKind("image");
      if (pastingReferences) {
        setError(tr("正在处理上一批粘贴图片", "The previous pasted images are still being processed"));
        return;
      }
      void importPastedReferences(files);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [active, pastingReferences, references]);

  const removeReference = async (attachment: ImageAttachment) => {
    setReferences((current) => current.filter((item) => item.id !== attachment.id));
    await deleteImageAttachment(attachment.id).catch(() => undefined);
  };

  const generate = async () => {
    const activePrompts = prompts.map((item) => item.prompt.trim()).filter(Boolean);
    if (!selected || activePrompts.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const base: Omit<MediaGenerationRequest, "prompt"> = {
      kind,
      profileId: selected.profileId,
      model: selected.id,
      count,
      size: kind === "audio" ? undefined : size,
      quality: kind === "image" && quality !== "auto" ? quality : undefined,
      outputFormat: kind === "video" ? undefined : outputFormat,
      background: kind === "image" && background !== "auto" ? background : undefined,
      voice: kind === "audio" && voice.trim() ? voice.trim() : undefined,
      instructions: kind === "audio" && instructions.trim() ? instructions.trim() : undefined,
      seconds: kind === "video" ? seconds : undefined,
      referenceAttachmentIds: kind === "image" ? references.map((item) => item.id) : [],
    };
    const tasks = activePrompts.map((prompt) => {
      const pendingBatchId = `pending-${crypto.randomUUID()}`;
      const createdAt = Date.now();
      const placeholders: StudioMediaAsset[] = Array.from({ length: count }, (_, index) => ({
        id: `${pendingBatchId}-${index + 1}`,
        batchId: pendingBatchId,
        providerId: selected.profileId,
        providerName: selected.profileName,
        kind,
        status: "in_progress",
        prompt,
        model: selected.id,
        size: base.size,
        quality: base.quality,
        outputFormat: base.outputFormat,
        voice: base.voice,
        seconds: base.seconds,
        createdAt,
        updatedAt: createdAt,
        pendingOutput: { index: index + 1, total: count },
      }));
      return { pendingBatchId, prompt, placeholders };
    });
    setPendingAssets((current) => [...tasks.flatMap((task) => task.placeholders), ...current]);

    try {
      const results = await Promise.allSettled(tasks.map(async (task) => {
        try {
          const result = await generateMedia({ ...base, prompt: task.prompt });
          setAssets((current) => mergeAssets(current, result.assets));
          return result;
        } finally {
          setPendingAssets((current) => current.filter((asset) => asset.batchId !== task.pendingBatchId));
        }
      }));
      const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : result.value.errors);
      if (failures.length > 0) setError(failures.join(" · "));
    } finally {
      setBusy(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await load(false);
    setRefreshing(false);
  };

  const removeAsset = async (asset: MediaAsset) => {
    try {
      await deleteMediaAsset(asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <main
      ref={rootRef}
      className={`media-studio${dropActive ? " file-drag-active" : ""}`}
      hidden={!active}
      onDragEnter={(event) => event.preventDefault()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      {dropActive && (
        <div className="media-drop-overlay" role="status" aria-live="polite">
          <span><ImagePlus size={28} /></span>
          <strong>{tr("拖入即可作为参考图", "Drop to add image references")}</strong>
          <small>{tr("图片会添加到当前创作任务，不会进入会话附件", "Images are added to Media Studio, not to the conversation")}</small>
        </div>
      )}
      <header className="media-topbar" data-tauri-drag-region>
        <div>
          <span className="media-title-icon"><WandSparkles size={17} /></span>
          <span><strong>{tr("创作空间", "Media Studio")}</strong><small>{tr("独立于会话，所有生成结果全局保存", "Independent from conversations, with global history")}</small></span>
        </div>
        <div>
          <button className="media-icon-button" disabled={refreshing} onClick={() => void refreshAll()} title={tr("刷新模型和历史", "Refresh models and history")}>
            <RefreshCw className={refreshing ? "spin" : ""} size={16} />
          </button>
          <button className="media-icon-button" onClick={onConfigureConnection} title={tr("模型连接设置", "Model connection settings")}><Settings2 size={16} /></button>
        </div>
      </header>

      <div className="media-studio-body">
        <section className="media-compose-panel">
          <div className="media-kind-tabs" role="tablist">
            {KIND_TABS.map(({ kind: value, icon: Icon }) => (
              <button className={kind === value ? "active" : ""} role="tab" aria-selected={kind === value} key={value} onClick={() => setKind(value)}>
                <Icon size={15} /><span>{kindLabel(value)}</span>
              </button>
            ))}
          </div>

          <div className="media-model-row">
            <label>
              <span>{tr("生成模型", "Generation model")}</span>
              <select
                value={selected ? modelKey(selected) : ""}
                disabled={models.length === 0}
                onChange={(event) => setSelectedModels((current) => ({ ...current, [kind]: event.target.value }))}
              >
                {models.length === 0 && <option value="">{tr("未发现可用模型", "No model discovered")}</option>}
                {models.map((model) => (
                  <option value={modelKey(model)} key={modelKey(model)}>
                    {model.recommended ? `★ ${tr("推荐", "Recommended")} · ` : ""}{model.id} · {model.profileName}
                  </option>
                ))}
              </select>
            </label>
            {selected?.recommended && <span className="recommended-model"><Sparkles size={12} />{tr("已自动选择最新模型", "Newest model selected automatically")}</span>}
          </div>

          <div className="media-prompt-list">
            {prompts.map((item, index) => (
              <article className="media-prompt-card" key={item.id}>
                <div><span>{tr("提示词", "Prompt")} {prompts.length > 1 ? index + 1 : ""}</span>{prompts.length > 1 && <button onClick={() => removePrompt(item.id)} title={tr("删除提示词", "Remove prompt")}><X size={13} /></button>}</div>
                <textarea
                  value={item.prompt}
                  maxLength={32_000}
                  placeholder={promptPlaceholder(kind)}
                  onChange={(event) => updatePrompt(item.id, event.target.value)}
                />
              </article>
            ))}
          </div>
          <button className="add-media-prompt" disabled={prompts.length >= 8} onClick={addPrompt}><Plus size={14} />{tr("添加并行提示词", "Add parallel prompt")}</button>

          <div className="media-options-grid">
            {kind !== "audio" && (
              <label><span>{tr("尺寸 / 比例", "Size / ratio")}</span><select value={size} onChange={(event) => setSize(event.target.value)}>
                {kind === "image" ? (
                  <>
                    <option value="auto">{tr("auto（模型自动，推荐）", "auto (model decides, recommended)")}</option>
                    <optgroup label={tr("像素尺寸", "Pixel dimensions")}>
                      {IMAGE_DIMENSION_OPTIONS.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.value.replace("x", " × ")} · {option.ratio}{option.experimental ? tr(" · 实验性", " · Experimental") : ""}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={tr("仅指定构图比例", "Aspect ratio only")}>
                      {IMAGE_RATIO_OPTIONS.map((value) => <option value={value} key={value}>{value}</option>)}
                    </optgroup>
                  </>
                ) : VIDEO_SIZE_OPTIONS.map((value) => <option value={value} key={value}>{value}</option>)}
              </select></label>
            )}
            {kind === "image" && <label><span>{tr("质量", "Quality")}</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{["auto", "high", "medium", "2K", "4K"].map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "image" && <label><span>{tr("背景", "Background")}</span><select value={background} onChange={(event) => setBackground(event.target.value)}>
              <option value="auto">auto</option>
              <option value="transparent" disabled={!transparentBackgroundSupported}>{transparentBackgroundSupported ? "transparent" : tr("transparent（当前模型不支持）", "transparent (unsupported by this model)")}</option>
              <option value="opaque">opaque</option>
            </select></label>}
            {kind !== "video" && <label><span>{tr("格式", "Format")}</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>{(kind === "image" ? ["png", "webp", "jpeg"] : ["mp3", "wav", "aac", "flac", "opus"]).map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "video" && <label><span>{tr("时长", "Duration")}</span><select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>{[4, 8, 12].map((value) => <option value={value} key={value}>{value}s</option>)}</select></label>}
            <label><span>{tr("每条数量", "Outputs each")}</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{Array.from({ length: kind === "image" ? 8 : 4 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            {kind === "audio" && <label><span>{tr("声音", "Voice")}</span><input value={voice} placeholder={tr("留空自动选择", "Automatic when empty")} onChange={(event) => setVoice(event.target.value)} /></label>}
          </div>

          {kind === "audio" && <label className="media-wide-field"><span>{tr("演绎要求", "Delivery instructions")}</span><input value={instructions} placeholder={tr("例如：温暖、自然、稍慢", "For example: warm, natural, slightly slower")} onChange={(event) => setInstructions(event.target.value)} /></label>}

          {kind === "image" && (
            <div className="media-reference-row">
              <div className="media-reference-heading">
                <span>{tr("参考图", "References")}<small>{pastingReferences ? tr("正在粘贴图片…", "Pasting images…") : tr("可拖拽、选择，或按 Ctrl+V 粘贴外部图片", "Drop, choose, or press Ctrl+V to paste images")}</small></span>
                <button disabled={pastingReferences || references.length >= 8} onClick={() => void addReferences()}>{pastingReferences ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}{tr("选择图片", "Choose images")}</button>
              </div>
              <div>{references.map((attachment) => <AttachmentChip attachment={attachment} onRemove={() => void removeReference(attachment)} key={attachment.id} />)}</div>
            </div>
          )}

          {catalog && catalog.errors.length > 0 && <details className="media-catalog-warning"><summary><CircleAlert size={13} />{tr("部分连接无法读取模型", "Some connections could not list models")}</summary><p>{catalog.errors.join(" · ")}</p></details>}
          {error && <div className="media-error"><CircleAlert size={14} /><span>{error}</span><button onClick={() => setError(null)}><X size={13} /></button></div>}

          {models.length === 0 && !loading ? (
            <button className="media-configure-button" onClick={onConfigureConnection}><Settings2 size={15} />{tr("配置支持生成能力的模型连接", "Configure a media-capable model connection")}</button>
          ) : (
            <button className="media-generate-button" disabled={busy || pastingReferences || loading || !selected || !prompts.some((item) => item.prompt.trim())} onClick={() => void generate()}>
              {busy || pastingReferences ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {pastingReferences ? tr("正在添加参考图", "Adding references") : busy ? tr(`正在并行生成 ${pendingAssets.length} 个结果`, `Generating ${pendingAssets.length} outputs in parallel`) : tr("开始生成", "Generate")}
            </button>
          )}
        </section>

        <section className="media-gallery-panel">
          <div className="media-gallery-heading">
            <div>
              <strong>{tr("创作历史", "Creation history")}</strong><span>{visibleAssets.length}</span>
              {visiblePendingAssets.length > 0 && <em><LoaderCircle className="spin" size={12} />{tr(`${visiblePendingAssets.length} 个生成中`, `${visiblePendingAssets.length} generating`)}</em>}
            </div>
            <small>{tr("结果保存在本机应用数据目录", "Outputs are stored in local app data")}</small>
          </div>
          {loading ? <div className="media-empty"><LoaderCircle className="spin" size={24} /><span>{tr("正在读取模型和历史", "Loading models and history")}</span></div>
            : displayedAssets.length === 0 ? <div className="media-empty"><KindIcon kind={kind} /><strong>{tr("还没有作品", "No creations yet")}</strong><span>{tr("输入提示词后，结果会自动出现在这里", "Generated outputs will appear here automatically")}</span></div>
              : <div className="media-gallery-grid">{displayedAssets.map((asset) => <MediaAssetCard asset={asset} locale={locale} onDelete={asset.pendingOutput ? undefined : () => void removeAsset(asset)} onPreview={asset.kind === "image" && asset.status === "completed" ? () => setPreviewAsset(asset) : undefined} key={asset.id} />)}</div>}
        </section>
      </div>
      {active && previewAsset && <MediaImagePreview
        asset={previewAsset}
        locale={locale}
        previewAssets={previewableAssets}
        onNavigate={(nextAsset) => setPreviewAsset(nextAsset)}
        onClose={() => setPreviewAsset(null)}
      />}
    </main>
  );
}

export function MediaAssetCard({ asset, locale, onDelete, onPreview }: { asset: StudioMediaAsset; locale: string; onDelete?: () => void; onPreview?: () => void }) {
  const url = mediaAssetUrl(asset);
  const [exporting, setExporting] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptCopyStatus, setPromptCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [exportFeedback, setExportFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const canExport = asset.status === "completed" && Boolean(asset.filePath && asset.fileName);
  const canPreview = asset.status === "completed" && asset.kind === "image" && Boolean(url && onPreview);
  const canExpandPrompt = asset.prompt.trim().length > 42;

  const exportAsset = async () => {
    if (!canExport || exporting) return;
    setExporting(true);
    setExportFeedback(null);
    try {
      const destination = await exportMediaAsset(asset);
      if (destination) {
        setExportFeedback({ error: false, text: tr(`已保存到 ${destination}`, `Saved to ${destination}`) });
      }
    } catch (reason) {
      setExportFeedback({ error: true, text: errorText(reason) });
    } finally {
      setExporting(false);
    }
  };

  const copyPrompt = async () => {
    try {
      await copyText(asset.prompt);
      setPromptCopyStatus("copied");
    } catch {
      setPromptCopyStatus("error");
    }
    window.setTimeout(() => setPromptCopyStatus("idle"), 1_500);
  };

  return (
    <article className={`media-asset-card status-${asset.status} ${canExport || onDelete ? "has-actions" : ""}`}>
      <div className="media-preview">
        {asset.status === "completed" && url && asset.kind === "image" && (canPreview ? (
          <button className="media-preview-trigger" type="button" onClick={onPreview} aria-label={tr("打开大图预览", "Open large image preview")}>
            <img src={url} alt={asset.revisedPrompt || asset.prompt} />
            <span><Maximize2 size={14} />{tr("查看大图", "View large")}</span>
          </button>
        ) : <img src={url} alt={asset.revisedPrompt || asset.prompt} />)}
        {asset.status === "completed" && url && asset.kind === "video" && <video src={url} controls preload="metadata" />}
        {asset.status === "completed" && url && asset.kind === "audio" && <div className="audio-preview"><AudioLines size={28} /><audio src={url} controls preload="metadata" /></div>}
        {(asset.status === "queued" || asset.status === "in_progress") && <div className="pending-preview"><LoaderCircle className="spin" size={24} /><strong>{statusLabel(asset.status)}</strong><span>{pendingAssetDetail(asset)}</span></div>}
        {asset.status === "failed" && <div className="failed-preview"><CircleAlert size={24} /><strong>{tr("生成失败", "Generation failed")}</strong></div>}
      </div>
      <div className="media-asset-content">
        <div className={`media-asset-prompt${promptExpanded ? " expanded" : ""}`}>
          <p title={asset.prompt}>{asset.prompt}</p>
          {(canExpandPrompt || asset.kind === "image") && <div className="media-asset-prompt-actions">
            {canExpandPrompt && (
              <button type="button" onClick={() => setPromptExpanded((value) => !value)}>
                {promptExpanded ? tr("收起提示词", "Collapse prompt") : tr("展开完整提示词", "Show full prompt")}
              </button>
            )}
            {asset.kind === "image" && <button className={`media-copy-prompt status-${promptCopyStatus}`} type="button" onClick={() => void copyPrompt()} title={tr("复制完整提示词", "Copy full prompt")}>
              {promptCopyStatus === "copied" ? <Check size={11} /> : <Copy size={11} />}
              {promptCopyStatus === "copied" ? tr("已复制", "Copied") : promptCopyStatus === "error" ? tr("复制失败", "Copy failed") : tr("复制", "Copy")}
            </button>}
          </div>}
        </div>
        <div className="media-asset-meta"><span>{asset.model}</span><span>{asset.providerName}</span></div>
        <small><Clock3 size={11} />{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(asset.createdAt)}</small>
        {asset.error && <em title={asset.error}>{mediaErrorSummary(asset.error)}</em>}
        {exportFeedback && <em className={exportFeedback.error ? "media-export-error" : "media-export-success"} title={exportFeedback.text}>{exportFeedback.error ? <CircleAlert size={11} /> : <Check size={11} />}{exportFeedback.text}</em>}
      </div>
      {(canExport || onDelete) && <div className="media-asset-actions">
        {canExport && <button className="media-export-asset" disabled={exporting} onClick={() => void exportAsset()} title={tr("另存为", "Save as")} aria-label={tr("另存为", "Save as")}>{exporting ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}</button>}
        {onDelete && <button className="media-delete-asset" onClick={onDelete} title={tr("删除作品", "Delete creation")} aria-label={tr("删除作品", "Delete creation")}><Trash2 size={13} /></button>}
      </div>}
    </article>
  );
}

function MediaImagePreview({
  asset,
  locale,
  previewAssets,
  onNavigate,
  onClose,
}: {
  asset: MediaAsset;
  locale: string;
  previewAssets: MediaAsset[];
  onNavigate: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const url = mediaAssetUrl(asset);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<PreviewTransform>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const imageReady = imageSize.width > 0 && imageSize.height > 0;
  const currentIndex = previewAssets.findIndex((item) => item.id === asset.id);
  const previousAsset = currentIndex > 0 ? previewAssets[currentIndex - 1] : undefined;
  const nextAsset = currentIndex >= 0 && currentIndex < previewAssets.length - 1
    ? previewAssets[currentIndex + 1]
    : undefined;

  useEffect(() => {
    dragRef.current = null;
    setDragging(false);
    setImageSize({ width: 0, height: 0 });
    setView({ zoom: 1, x: 0, y: 0 });
    setExporting(false);
    setExportError(false);
  }, [asset.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleResize = () => {
      setView((current) => {
        const offset = constrainPreviewOffset(current, current.zoom, imageSize, canvasRef.current);
        return { ...current, ...offset };
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [imageSize.height, imageSize.width]);

  const applyZoom = (requestedZoom: number, anchor: PreviewPoint = { x: 0, y: 0 }) => {
    setView((current) => {
      const zoom = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, requestedZoom));
      const ratio = zoom / current.zoom;
      const candidate = {
        x: anchor.x - (anchor.x - current.x) * ratio,
        y: anchor.y - (anchor.y - current.y) * ratio,
      };
      const offset = constrainPreviewOffset(candidate, zoom, imageSize, canvasRef.current);
      return { zoom, ...offset };
    });
  };

  const showActualSize = () => {
    setView({ zoom: 1, x: 0, y: 0 });
  };

  const fitImage = () => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds || !imageReady) return;
    const zoom = Math.min(
      1,
      Math.max(
        MIN_PREVIEW_ZOOM,
        Math.min((bounds.width - 32) / imageSize.width, (bounds.height - 32) / imageSize.height),
      ),
    );
    setView({ zoom, x: 0, y: 0 });
  };

  const panBy = (x: number, y: number) => {
    setView((current) => {
      const offset = constrainPreviewOffset(
        { x: current.x + x, y: current.y + y },
        current.zoom,
        imageSize,
        canvasRef.current,
      );
      return { ...current, ...offset };
    });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !imageReady) return;
    if ((event.target as Element).closest(".media-image-lightbox-toolbar, .media-image-lightbox-nav")) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setView((current) => {
      const offset = constrainPreviewOffset(
        {
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        },
        current.zoom,
        imageSize,
        canvasRef.current,
      );
      return { ...current, ...offset };
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!imageReady || (event.target as Element).closest(".media-image-lightbox-toolbar, .media-image-lightbox-nav")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor = {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    };
    applyZoom(view.zoom * (event.deltaY < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP), anchor);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyZoom(view.zoom * PREVIEW_ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      applyZoom(view.zoom / PREVIEW_ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      showActualSize();
    } else if (event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      fitImage();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panBy(56, 0);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panBy(-56, 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      panBy(0, 56);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      panBy(0, -56);
    }
  };

  if (!url) return null;
  const navigateTo = (next: MediaAsset | undefined) => {
    if (!next) return;
    onNavigate(next);
  };
  const downloadImage = async () => {
    if (exporting || asset.status !== "completed" || !asset.fileName) return;
    setExporting(true);
    setExportError(false);
    try {
      await exportMediaAsset(asset);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  const createdAt = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(asset.createdAt);

  return createPortal(
    <div className="media-image-lightbox" role="dialog" aria-modal="true" aria-labelledby="media-image-preview-title" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="media-image-lightbox-dialog">
        <header>
          <div>
            <strong id="media-image-preview-title">{tr("图片预览", "Image preview")}</strong>
            <p title={asset.prompt}>{asset.prompt}</p>
          </div>
          <div className="media-image-lightbox-actions">
            <button
              className={`media-image-lightbox-download${exportError ? " error" : ""}`}
              type="button"
              disabled={exporting || !asset.fileName}
              onClick={() => void downloadImage()}
              aria-label={tr("下载图片", "Download image")}
              title={exportError ? tr("下载失败，点击重试", "Download failed, click to retry") : tr("下载图片", "Download image")}
            >
              {exporting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
            </button>
            <button className="media-image-lightbox-close" type="button" autoFocus onClick={onClose} aria-label={tr("关闭预览", "Close preview")} title={`${tr("关闭预览", "Close preview")} (Esc)`}><X size={19} /></button>
          </div>
        </header>
        <div
          ref={canvasRef}
          className={`media-image-lightbox-canvas${dragging ? " dragging" : ""}`}
          role="region"
          aria-label={tr("图片查看区域，可拖动图片并使用滚轮缩放", "Image viewer; drag the image and use the wheel to zoom")}
          tabIndex={0}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onWheel={handleWheel}
          onKeyDown={handleCanvasKeyDown}
          onDoubleClick={(event) => {
            if ((event.target as Element).closest(".media-image-lightbox-toolbar, .media-image-lightbox-nav")) return;
            if (Math.abs(view.zoom - 1) < 0.01) fitImage();
            else showActualSize();
          }}
        >
          <button
            className="media-image-lightbox-nav previous"
            type="button"
            disabled={!previousAsset}
            onClick={() => navigateTo(previousAsset)}
            aria-label={tr("上一张图片", "Previous image")}
            title={tr("上一张图片", "Previous image")}
          >
            <ArrowLeft size={21} />
          </button>
          <img
            key={asset.id}
            src={url}
            alt={asset.revisedPrompt || asset.prompt}
            draggable={false}
            onLoad={(event) => {
              setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              setView({ zoom: 1, x: 0, y: 0 });
            }}
            style={imageReady ? {
              width: imageSize.width * view.zoom,
              height: imageSize.height * view.zoom,
              left: `calc(50% + ${view.x}px)`,
              top: `calc(50% + ${view.y}px)`,
            } : undefined}
          />
          <button
            className="media-image-lightbox-nav next"
            type="button"
            disabled={!nextAsset}
            onClick={() => navigateTo(nextAsset)}
            aria-label={tr("下一张图片", "Next image")}
            title={tr("下一张图片", "Next image")}
          >
            <ArrowRight size={21} />
          </button>
          <div className="media-image-lightbox-toolbar" role="toolbar" aria-label={tr("图片缩放控制", "Image zoom controls")}>
            <button type="button" disabled={!imageReady} onClick={fitImage} title={`${tr("适应窗口", "Fit to window")} (F)`}><Maximize2 size={14} /><span>{tr("适应窗口", "Fit")}</span></button>
            <button type="button" disabled={!imageReady} onClick={() => showActualSize()} title={`${tr("原始大小", "Actual size")} (0)`}>1:1</button>
            <i aria-hidden="true" />
            <button type="button" disabled={!imageReady || view.zoom <= MIN_PREVIEW_ZOOM} onClick={() => applyZoom(view.zoom / PREVIEW_ZOOM_STEP)} aria-label={tr("缩小", "Zoom out")} title={tr("缩小", "Zoom out")}><ZoomOut size={15} /></button>
            <output aria-live="polite">{Math.round(view.zoom * 100)}%</output>
            <button type="button" disabled={!imageReady || view.zoom >= MAX_PREVIEW_ZOOM} onClick={() => applyZoom(view.zoom * PREVIEW_ZOOM_STEP)} aria-label={tr("放大", "Zoom in")} title={tr("放大", "Zoom in")}><ZoomIn size={15} /></button>
          </div>
          <div className="media-image-pan-hint" aria-hidden="true"><Move size={14} /><span>{tr("拖动查看 · 滚轮缩放 · 双击切换", "Drag to pan · wheel to zoom · double-click to toggle")}</span></div>
        </div>
        <footer>
          <div>
            {asset.size && <span>{asset.size}</span>}
            {asset.quality && <span>{asset.quality}</span>}
            {asset.outputFormat && <span>{asset.outputFormat.toUpperCase()}</span>}
          </div>
          <small>{asset.model} · {asset.providerName} · {createdAt}</small>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function constrainPreviewOffset(
  point: PreviewPoint,
  zoom: number,
  imageSize: { width: number; height: number },
  canvas: HTMLDivElement | null,
): PreviewPoint {
  if (!canvas || imageSize.width <= 0 || imageSize.height <= 0) return { x: 0, y: 0 };
  const bounds = canvas.getBoundingClientRect();
  const maxX = Math.max(0, (imageSize.width * zoom - bounds.width) / 2);
  const maxY = Math.max(0, (imageSize.height * zoom - bounds.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, point.x)),
    y: Math.min(maxY, Math.max(-maxY, point.y)),
  };
}

function modelKey(model: MediaModelInfo) {
  return `${model.profileId}::${model.id}`;
}

function mergeAssets(current: MediaAsset[], incoming: MediaAsset[]) {
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) byId.set(asset.id, asset);
  return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function kindLabel(kind: MediaKind) {
  if (kind === "image") return tr("图片", "Images");
  if (kind === "video") return tr("视频", "Video");
  return tr("语音", "Speech");
}

function statusLabel(status: MediaAsset["status"]) {
  if (status === "queued") return tr("正在排队", "Queued");
  if (status === "in_progress") return tr("正在生成", "Generating");
  if (status === "completed") return tr("已完成", "Completed");
  return tr("失败", "Failed");
}

function pendingAssetDetail(asset: StudioMediaAsset) {
  if (asset.pendingOutput) {
    const { index, total } = asset.pendingOutput;
    return total > 1 ? tr(`第 ${index} / ${total} 个结果`, `Output ${index} of ${total}`) : tr("请求已发送", "Request sent");
  }
  return asset.progress === undefined ? tr("请求已发送", "Request sent") : `${asset.progress}%`;
}

function promptPlaceholder(kind: MediaKind) {
  if (kind === "image") return tr("描述主体、构图、光线、材质、风格和需要避免的元素…", "Describe subject, composition, lighting, materials, style, and exclusions…");
  if (kind === "video") return tr("描述镜头、主体动作、环境变化、摄影机运动和节奏…", "Describe shot, subject motion, environment changes, camera movement, and timing…");
  return tr("输入要朗读的文本…", "Enter the exact text to speak…");
}

function KindIcon({ kind }: { kind: MediaKind }) {
  if (kind === "image") return <Image size={28} />;
  if (kind === "video") return <Video size={28} />;
  return <AudioLines size={28} />;
}

function clipboardImageFiles(clipboard: DataTransfer | null) {
  if (!clipboard) return [];
  const itemFiles = Array.from(clipboard.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (itemFiles.length > 0) return itemFiles;
  return Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mediaErrorSummary(error: string) {
  const compact = error.replace(/\s+/g, " ").trim();
  const status = compact.match(/\b[45]\d{2}(?: [A-Za-z][A-Za-z -]*)?/i)?.[0];
  const quotedMessage = compact.match(/"message"\s*:\s*"([^"]+)"/i)?.[1];
  const statusIndex = status ? compact.indexOf(status) + status.length : -1;
  const plainMessage = statusIndex >= 0
    ? compact.slice(statusIndex).replace(/^[\s):·-]+/, "").split(";")[0].trim()
    : compact;
  const detail = quotedMessage || plainMessage;
  const summary = status && detail ? `${status} · ${detail}` : detail;
  return summary.length > 220 ? `${summary.slice(0, 219)}…` : summary;
}

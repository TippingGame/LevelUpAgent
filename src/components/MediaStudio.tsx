import { useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Check,
  CircleAlert,
  Clock3,
  Download,
  Image,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import {
  deleteImageAttachment,
  deleteMediaAsset,
  exportMediaAsset,
  generateMedia,
  getMediaCatalog,
  listMediaAssets,
  mediaAssetUrl,
  refreshMediaAsset,
  selectImageReferences,
} from "../lib/bridge";
import { tr } from "../lib/i18n";
import type {
  ImageAttachment,
  MediaAsset,
  MediaGenerationRequest,
  MediaKind,
  MediaModelInfo,
} from "../lib/types";

interface PromptDraft {
  id: string;
  prompt: string;
}

interface MediaStudioProps {
  locale: string;
  onConfigureConnection: () => void;
}

const KIND_TABS: Array<{ kind: MediaKind; icon: typeof Image }> = [
  { kind: "image", icon: Image },
  { kind: "video", icon: Video },
  { kind: "audio", icon: AudioLines },
];

export function MediaStudio({ locale, onConfigureConnection }: MediaStudioProps) {
  const [kind, setKind] = useState<MediaKind>("image");
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getMediaCatalog>> | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selectedModels, setSelectedModels] = useState<Partial<Record<MediaKind, string>>>({});
  const [prompts, setPrompts] = useState<PromptDraft[]>([
    { id: crypto.randomUUID(), prompt: "" },
  ]);
  const [references, setReferences] = useState<ImageAttachment[]>([]);
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("1024x1024");
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

  const models = useMemo(
    () => (catalog?.models ?? []).filter((model) => model.kind === kind),
    [catalog, kind],
  );
  const selectedKey = selectedModels[kind];
  const selected = models.find((model) => modelKey(model) === selectedKey)
    ?? models.find((model) => model.recommended)
    ?? models[0];
  const visibleAssets = assets.filter((asset) => asset.kind === kind);
  const pendingVideoIds = assets
    .filter((asset) => asset.kind === "video" && (asset.status === "queued" || asset.status === "in_progress"))
    .map((asset) => asset.id);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const [nextCatalog, nextAssets] = await Promise.all([
        getMediaCatalog(),
        listMediaAssets(),
      ]);
      setCatalog(nextCatalog);
      setAssets(nextAssets);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const key = modelKey(selected);
    if (selectedModels[kind] !== key) {
      setSelectedModels((current) => ({ ...current, [kind]: key }));
    }
  }, [kind, selected?.id, selected?.profileId]);

  useEffect(() => {
    if (kind === "image") {
      setSize((current) => ["1024x1024", "1536x1024", "1024x1536", "16:9", "9:16"].includes(current) ? current : "1024x1024");
      setOutputFormat((current) => ["png", "webp", "jpeg"].includes(current) ? current : "png");
    } else if (kind === "video") {
      setSize((current) => ["1280x720", "720x1280", "16:9", "9:16"].includes(current) ? current : "1280x720");
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
      setReferences((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...selectedImages.filter((item) => item.kind === "image" && !ids.has(item.id))].slice(0, 8);
      });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

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
    const results = await Promise.allSettled(
      activePrompts.map((prompt) => generateMedia({ ...base, prompt })),
    );
    const generated = results.flatMap((result) => result.status === "fulfilled" ? result.value.assets : []);
    const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : result.value.errors);
    setAssets((current) => mergeAssets(current, generated));
    if (failures.length > 0) setError(failures.join(" · "));
    setBusy(false);
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
    <main className="media-studio">
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
                {(kind === "image" ? ["1024x1024", "1536x1024", "1024x1536", "16:9", "9:16"] : ["1280x720", "720x1280", "16:9", "9:16"]).map((value) => <option key={value}>{value}</option>)}
              </select></label>
            )}
            {kind === "image" && <label><span>{tr("质量", "Quality")}</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{["auto", "high", "medium", "2K", "4K"].map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "image" && <label><span>{tr("背景", "Background")}</span><select value={background} onChange={(event) => setBackground(event.target.value)}>{["auto", "transparent", "opaque"].map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind !== "video" && <label><span>{tr("格式", "Format")}</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>{(kind === "image" ? ["png", "webp", "jpeg"] : ["mp3", "wav", "aac", "flac", "opus"]).map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "video" && <label><span>{tr("时长", "Duration")}</span><select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>{[4, 8, 12].map((value) => <option value={value} key={value}>{value}s</option>)}</select></label>}
            <label><span>{tr("每条数量", "Outputs each")}</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{Array.from({ length: kind === "image" ? 8 : 4 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            {kind === "audio" && <label><span>{tr("声音", "Voice")}</span><input value={voice} placeholder={tr("留空自动选择", "Automatic when empty")} onChange={(event) => setVoice(event.target.value)} /></label>}
          </div>

          {kind === "audio" && <label className="media-wide-field"><span>{tr("演绎要求", "Delivery instructions")}</span><input value={instructions} placeholder={tr("例如：温暖、自然、稍慢", "For example: warm, natural, slightly slower")} onChange={(event) => setInstructions(event.target.value)} /></label>}

          {kind === "image" && (
            <div className="media-reference-row">
              <button onClick={() => void addReferences()}><ImagePlus size={14} />{tr("添加参考图", "Add references")}</button>
              <div>{references.map((attachment) => <span key={attachment.id}>{attachment.name}<button onClick={() => void removeReference(attachment)}><X size={11} /></button></span>)}</div>
            </div>
          )}

          {catalog && catalog.errors.length > 0 && <details className="media-catalog-warning"><summary><CircleAlert size={13} />{tr("部分连接无法读取模型", "Some connections could not list models")}</summary><p>{catalog.errors.join(" · ")}</p></details>}
          {error && <div className="media-error"><CircleAlert size={14} /><span>{error}</span><button onClick={() => setError(null)}><X size={13} /></button></div>}

          {models.length === 0 && !loading ? (
            <button className="media-configure-button" onClick={onConfigureConnection}><Settings2 size={15} />{tr("配置支持生成能力的模型连接", "Configure a media-capable model connection")}</button>
          ) : (
            <button className="media-generate-button" disabled={busy || loading || !selected || !prompts.some((item) => item.prompt.trim())} onClick={() => void generate()}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {busy ? tr(`正在并行生成 ${prompts.filter((item) => item.prompt.trim()).length} 个任务`, `Generating ${prompts.filter((item) => item.prompt.trim()).length} tasks in parallel`) : tr("开始生成", "Generate")}
            </button>
          )}
        </section>

        <section className="media-gallery-panel">
          <div className="media-gallery-heading">
            <div><strong>{tr("创作历史", "Creation history")}</strong><span>{visibleAssets.length}</span></div>
            <small>{tr("结果保存在本机应用数据目录", "Outputs are stored in local app data")}</small>
          </div>
          {loading ? <div className="media-empty"><LoaderCircle className="spin" size={24} /><span>{tr("正在读取模型和历史", "Loading models and history")}</span></div>
            : visibleAssets.length === 0 ? <div className="media-empty"><KindIcon kind={kind} /><strong>{tr("还没有作品", "No creations yet")}</strong><span>{tr("输入提示词后，结果会自动出现在这里", "Generated outputs will appear here automatically")}</span></div>
              : <div className="media-gallery-grid">{visibleAssets.map((asset) => <MediaAssetCard asset={asset} locale={locale} onDelete={() => void removeAsset(asset)} key={asset.id} />)}</div>}
        </section>
      </div>
    </main>
  );
}

export function MediaAssetCard({ asset, locale, onDelete }: { asset: MediaAsset; locale: string; onDelete?: () => void }) {
  const url = mediaAssetUrl(asset);
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const canExport = asset.status === "completed" && Boolean(asset.filePath && asset.fileName);

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

  return (
    <article className={`media-asset-card status-${asset.status} ${canExport || onDelete ? "has-actions" : ""}`}>
      <div className="media-preview">
        {asset.status === "completed" && url && asset.kind === "image" && <img src={url} alt={asset.revisedPrompt || asset.prompt} />}
        {asset.status === "completed" && url && asset.kind === "video" && <video src={url} controls preload="metadata" />}
        {asset.status === "completed" && url && asset.kind === "audio" && <div className="audio-preview"><AudioLines size={28} /><audio src={url} controls preload="metadata" /></div>}
        {(asset.status === "queued" || asset.status === "in_progress") && <div className="pending-preview"><LoaderCircle className="spin" size={24} /><strong>{statusLabel(asset.status)}</strong><span>{asset.progress ?? 0}%</span></div>}
        {asset.status === "failed" && <div className="failed-preview"><CircleAlert size={24} /><strong>{tr("生成失败", "Generation failed")}</strong></div>}
      </div>
      <div className="media-asset-content">
        <p title={asset.prompt}>{asset.prompt}</p>
        <div><span>{asset.model}</span><span>{asset.providerName}</span></div>
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

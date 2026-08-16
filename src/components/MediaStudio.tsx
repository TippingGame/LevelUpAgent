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
  BookOpen,
  Boxes,
  Brush,
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
  importMediaReferences,
  listMediaAssets,
  mediaAssetUrl,
  previewAttachment,
  refreshMediaAsset,
  selectImageReferences,
  selectSingleImageReference,
  selectVideoReference,
} from "../lib/bridge";
import { tr } from "../lib/i18n";
import {
  armorModeMediaInstructions,
  armorModeMediaPrompt,
  type ArmorModeLevel,
  type ArmorSkillState,
} from "../lib/armorMode";
import { copyText } from "../lib/clipboard";
import { mediaModelSupportsExplicitImageMask } from "../lib/mediaCapabilities";
import type {
  ImageAttachment,
  MediaAsset,
  MediaGenerationRequest,
  MediaKind,
  MediaModelInfo,
  VideoGenerationMode,
} from "../lib/types";
import { AttachmentChip } from "./AttachmentChip";
import {
  ConstellationCanvasEditor,
  type CanvasEditorSaveMeta,
} from "./ConstellationCanvasEditor";

interface PromptDraft {
  id: string;
  prompt: string;
}

interface MediaHistoryLoadState {
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
}

type StudioMediaAsset = MediaAsset & {
  pendingOutput?: { index: number; total: number };
};

type StudioImageMode = "generate" | "edit" | "outpaint" | "inpaint";

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
const MEDIA_HISTORY_PAGE_SIZE = 24;

interface MediaStudioProps {
  active: boolean;
  locale: string;
  armorMode: boolean;
  armorModeLevel: ArmorModeLevel;
  armorModeSkills: ArmorSkillState;
  mediaCatalogRevision: number;
  dropActive: boolean;
  referenceDrop: { id: string; paths: string[] } | null;
  onReferenceDropHandled: (id: string) => void;
  onConfigureConnection: () => void;
  onPendingCountChange: (count: number) => void;
  onWriting: () => void;
  onConstellation: () => void;
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
const GROK_VIDEO_ASPECT_OPTIONS = ["16:9", "9:16"];
const GROK_VIDEO_RESOLUTION_OPTIONS = ["480p", "720p"];
const GROK_VIDEO_MODES: VideoGenerationMode[] = ["text", "image", "reference", "video"];
const MEDIA_MODEL_ROUTES_KEY = "levelup-agent.media-model-routes.v1";
const STUDIO_IMAGE_MODES: Array<{ value: StudioImageMode; label: string; labelEn: string }> = [
  { value: "generate", label: "生成", labelEn: "Generate" },
  { value: "edit", label: "编辑", labelEn: "Edit" },
  { value: "outpaint", label: "扩图", labelEn: "Outpaint" },
  { value: "inpaint", label: "局部重绘", labelEn: "Inpaint" },
];

export function MediaStudio({ active, locale, armorMode, armorModeLevel, armorModeSkills, mediaCatalogRevision, dropActive, referenceDrop, onReferenceDropHandled, onConfigureConnection, onPendingCountChange, onWriting, onConstellation }: MediaStudioProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<MediaKind>("image");
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getMediaCatalog>> | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [pendingAssets, setPendingAssets] = useState<StudioMediaAsset[]>([]);
  const [selectedModels, setSelectedModels] = useState<Partial<Record<MediaKind, string>>>(loadMediaModelRoutes);
  const [prompts, setPrompts] = useState<PromptDraft[]>([
    { id: crypto.randomUUID(), prompt: "" },
  ]);
  const [imageReferences, setImageReferences] = useState<ImageAttachment[]>([]);
  const [imageMode, setImageMode] = useState<StudioImageMode>("generate");
  const [imageEditSource, setImageEditSource] = useState<ImageAttachment>();
  const [imageEditMask, setImageEditMask] = useState<ImageAttachment>();
  const [imageEditMeta, setImageEditMeta] = useState<CanvasEditorSaveMeta>();
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  const [videoReferences, setVideoReferences] = useState<ImageAttachment[]>([]);
  const [videoMode, setVideoMode] = useState<VideoGenerationMode>("text");
  const [videoResolution, setVideoResolution] = useState("720p");
  const [videoAspectRatio, setVideoAspectRatio] = useState("16:9");
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [outputFormat, setOutputFormat] = useState("png");
  const [background, setBackground] = useState("auto");
  const [seconds, setSeconds] = useState(8);
  const [voice, setVoice] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pastingReferences, setPastingReferences] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<MediaAsset | null>(null);
  const [historyState, setHistoryState] = useState<Record<MediaKind, MediaHistoryLoadState>>({
    image: { loaded: false, loading: false, loadingMore: false, hasMore: false },
    video: { loaded: false, loading: false, loadingMore: false, hasMore: false },
    audio: { loaded: false, loading: false, loadingMore: false, hasMore: false },
  });
  const catalogRequestRef = useRef(0);
  const catalogRevisionRef = useRef<number | null>(null);
  const historyRequestRef = useRef<Record<MediaKind, number>>({ image: 0, video: 0, audio: 0 });

  const models = useMemo(
    () => (catalog?.models ?? []).filter((model) => model.kind === kind),
    [catalog, kind],
  );
  const requiresImageMask = kind === "image" && imageMode !== "generate" && Boolean(imageEditMask);
  const eligibleModels = useMemo(
    () => requiresImageMask ? models.filter(mediaModelSupportsExplicitImageMask) : models,
    [models, requiresImageMask],
  );
  const selectedKey = selectedModels[kind];
  const selected = eligibleModels.find((model) => modelKey(model) === selectedKey)
    ?? eligibleModels.find((model) => model.recommended)
    ?? eligibleModels[0];
  const transparentBackgroundSupported = !selected?.id.toLocaleLowerCase().includes("gpt-image-2");
  const selectedModelId = selected?.id.toLocaleLowerCase() ?? "";
  const isGrokVideo = kind === "video" && selectedModelId.startsWith("grok-imagine-video");
  const isGrokVideo15 = isGrokVideo && selectedModelId.includes("grok-imagine-video-1.5");
  const activeVideoMode: VideoGenerationMode = isGrokVideo15 ? "image" : isGrokVideo ? videoMode : "text";
  const videoResolutionOptions = isGrokVideo15
    ? [...GROK_VIDEO_RESOLUTION_OPTIONS, "1080p"]
    : GROK_VIDEO_RESOLUTION_OPTIONS;
  const videoDurationOptions = activeVideoMode === "reference" ? [4, 8, 10] : [4, 8, 12];
  const videoReferenceReady = !isGrokVideo || activeVideoMode === "text" || (
    activeVideoMode === "reference"
      ? videoReferences.length > 0 && videoReferences.length <= 7 && videoReferences.every((item) => item.kind === "image")
      : videoReferences.length === 1 && videoReferences[0]?.kind === (activeVideoMode === "video" ? "video" : "image")
  );
  const imageEditReady = imageMode === "generate"
    || Boolean(imageEditSource
      && (imageMode !== "inpaint" || imageEditMask)
      && (imageMode !== "outpaint" || imageEditMask && imageEditMeta?.expanded));
  const visibleAssets = assets.filter((asset) => asset.kind === kind);
  const visiblePendingAssets = pendingAssets.filter((asset) => asset.kind === kind);
  const displayedAssets: StudioMediaAsset[] = [...visiblePendingAssets, ...visibleAssets];
  const currentHistoryState = historyState[kind];
  const previewableAssets = displayedAssets.filter(
    (asset) => asset.kind === "image" && asset.status === "completed" && Boolean(mediaAssetUrl(asset)),
  );
  const pendingVideoIds = assets
    .filter((asset) => asset.kind === "video" && (asset.status === "queued" || asset.status === "in_progress"))
    .map((asset) => asset.id);

  const rememberSelectedModel = (targetKind: MediaKind, key: string) => {
    setSelectedModels((current) => {
      const next = { ...current, [targetKind]: key };
      saveMediaModelRoutes(next);
      return next;
    });
  };

  const loadCatalog = async (showSpinner = true) => {
    const requestId = ++catalogRequestRef.current;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const nextCatalog = await getMediaCatalog();
      if (requestId !== catalogRequestRef.current) return;
      setCatalog(nextCatalog);
      catalogRevisionRef.current = mediaCatalogRevision;
    } catch (reason) {
      if (requestId === catalogRequestRef.current) setError(errorText(reason));
    } finally {
      if (requestId === catalogRequestRef.current) setLoading(false);
    }
  };

  const loadHistory = async (targetKind: MediaKind, reset = false) => {
    const requestId = ++historyRequestRef.current[targetKind];
    const offset = reset ? 0 : assets.filter((asset) => asset.kind === targetKind).length;
    setHistoryState((current) => ({
      ...current,
      [targetKind]: {
        ...current[targetKind],
        loading: reset,
        loadingMore: !reset,
      },
    }));
    try {
      const page = await listMediaAssets(targetKind, MEDIA_HISTORY_PAGE_SIZE, offset);
      if (requestId !== historyRequestRef.current[targetKind]) return;
      setAssets((current) => mergeAssets(
        reset ? current.filter((asset) => asset.kind !== targetKind) : current,
        page.assets,
      ));
      setHistoryState((current) => ({
        ...current,
        [targetKind]: {
          ...current[targetKind],
          loaded: true,
          hasMore: page.hasMore,
        },
      }));
    } catch (reason) {
      if (requestId === historyRequestRef.current[targetKind]) setError(errorText(reason));
    } finally {
      if (requestId === historyRequestRef.current[targetKind]) {
        setHistoryState((current) => ({
          ...current,
          [targetKind]: {
            ...current[targetKind],
            loading: false,
            loadingMore: false,
          },
        }));
      }
    }
  };

  useEffect(() => {
    if (!active || catalogRevisionRef.current === mediaCatalogRevision) return;
    void loadCatalog();
  }, [active, mediaCatalogRevision]);

  useEffect(() => {
    if (!active || historyState[kind].loaded || historyState[kind].loading) return;
    void loadHistory(kind, true);
  }, [active, kind]);

  useEffect(() => {
    if (!selected) return;
    const key = modelKey(selected);
    if (selectedModels[kind] !== key) {
      rememberSelectedModel(kind, key);
    }
  }, [kind, selected?.id, selected?.profileId]);

  useEffect(() => {
    if (!transparentBackgroundSupported && background === "transparent") setBackground("auto");
  }, [transparentBackgroundSupported]);

  useEffect(() => {
    if (kind !== "video") return;
    if (isGrokVideo15 && videoMode !== "image") setVideoMode("image");
    else if (!isGrokVideo && videoMode !== "text") setVideoMode("text");
    if (!videoResolutionOptions.includes(videoResolution)) setVideoResolution("720p");
  }, [kind, isGrokVideo, isGrokVideo15, selectedModelId]);

  useEffect(() => {
    if (kind === "video" && activeVideoMode === "reference" && !videoDurationOptions.includes(seconds)) {
      setSeconds(8);
    }
  }, [kind, activeVideoMode]);

  useEffect(() => {
    if (kind !== "video") return;
    const expectedKind = activeVideoMode === "video" ? "video" : "image";
    const maximum = activeVideoMode === "reference" ? 7 : activeVideoMode === "text" ? 0 : 1;
    setVideoReferences((current) => {
      const retained = current.filter((item) => item.kind === expectedKind).slice(0, maximum);
      const retainedIds = new Set(retained.map((item) => item.id));
      const discarded = current.filter((item) => !retainedIds.has(item.id));
      void Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
      return retained;
    });
  }, [kind, activeVideoMode]);

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

  const addImageReferences = async () => {
    try {
      const selectedImages = await selectImageReferences();
      await acceptImageReferences(selectedImages);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const acceptImageReferences = async (incoming: ImageAttachment[]) => {
    const ids = new Set(imageReferences.map((item) => item.id));
    const available = Math.max(0, 8 - imageReferences.length);
    const accepted = incoming
      .filter((item) => item.kind === "image" && !ids.has(item.id))
      .slice(0, available);
    const acceptedIds = new Set(accepted.map((item) => item.id));
    const discarded = incoming.filter((item) => !acceptedIds.has(item.id));
    setImageReferences((current) => [...current, ...accepted].slice(0, 8));
    await Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
    if (incoming.some((item) => item.kind !== "image")) {
      setError(tr("创作空间的拖拽区域只接受图片参考", "The Media Studio drop zone accepts image references only"));
    } else if (accepted.length < incoming.length) {
      setError(tr("最多添加 8 张参考图", "You can add up to 8 reference images"));
    }
  };

  const replaceImageEditSource = async (
    source: ImageAttachment | undefined,
    mask?: ImageAttachment,
    meta?: CanvasEditorSaveMeta,
  ) => {
    const retainedIds = new Set([source?.id, mask?.id].filter((id): id is string => Boolean(id)));
    const discarded = [imageEditSource, imageEditMask]
      .filter((item): item is ImageAttachment => item !== undefined)
      .filter((item) => !retainedIds.has(item.id));
    setImageEditSource(source);
    setImageEditMask(mask);
    setImageEditMeta(meta);
    await Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
  };

  const acceptImageEditSource = async (incoming: ImageAttachment[], openEditor = false) => {
    const source = incoming.find((item) => item.kind === "image");
    const discarded = incoming.filter((item) => item.id !== source?.id);
    await Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
    if (!source) {
      setError(tr("图片编辑需要一张有效图片", "Image editing needs a valid image"));
      return;
    }
    await replaceImageEditSource(source);
    setKind("image");
    setImageMode("edit");
    setError(null);
    if (openEditor) setImageEditorOpen(true);
  };

  const chooseImageEditSource = async () => {
    try {
      const selectedImage = await selectSingleImageReference();
      if (!selectedImage) return;
      await acceptImageEditSource([selectedImage], true);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const editImageAsset = async (asset: MediaAsset) => {
    if (asset.kind !== "image" || asset.status !== "completed" || !asset.filePath) return;
    setError(null);
    try {
      await acceptImageEditSource(await importMediaReferences([asset.filePath]), true);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const applyCanvasEdit = async (
    image: ImageAttachment,
    mask: ImageAttachment | undefined,
    meta: CanvasEditorSaveMeta,
  ) => {
    const labels = [...new Set([...(imageEditMeta?.labels ?? []), ...meta.labels])];
    const nextMeta = { ...meta, hasLabels: labels.length > 0, labels };
    await replaceImageEditSource(image, mask, nextMeta);
    setImageMode(meta.expanded ? "outpaint" : mask ? "inpaint" : "edit");
    setImageEditorOpen(false);
    setError(null);
  };

  const changeImageMode = (nextMode: StudioImageMode) => {
    setImageMode(nextMode);
    setError(null);
  };

  const changeVideoMode = (nextMode: VideoGenerationMode) => {
    if (isGrokVideo15 && nextMode !== "image") return;
    setVideoMode(nextMode);
    setError(null);
  };

  const addVideoReferences = async () => {
    try {
      const incoming = activeVideoMode === "video"
        ? await selectVideoReference()
        : await selectImageReferences();
      await acceptVideoReferences(incoming, activeVideoMode);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const acceptVideoReferences = async (incoming: ImageAttachment[], targetMode: VideoGenerationMode) => {
    const expectedKind = targetMode === "video" ? "video" : "image";
    const maximum = targetMode === "reference" ? 7 : targetMode === "text" ? 0 : 1;
    const compatibleCurrent = videoReferences.filter((item) => item.kind === expectedKind).slice(0, maximum);
    const ids = new Set(compatibleCurrent.map((item) => item.id));
    const available = Math.max(0, maximum - compatibleCurrent.length);
    const accepted = incoming
      .filter((item) => item.kind === expectedKind && !ids.has(item.id))
      .slice(0, available);
    const retainedIds = new Set([...compatibleCurrent, ...accepted].map((item) => item.id));
    const discarded = [...videoReferences, ...incoming].filter((item) => !retainedIds.has(item.id));
    setVideoMode(targetMode);
    setVideoReferences([...compatibleCurrent, ...accepted]);
    await Promise.all(discarded.map((item) => deleteImageAttachment(item.id).catch(() => false)));
    if (incoming.some((item) => item.kind !== expectedKind)) {
      setError(targetMode === "video"
        ? tr("视频编辑只接受一个 MP4 视频", "Video editing accepts one MP4 video only")
        : tr("当前视频模式只接受图片", "The current video mode accepts images only"));
    } else if (accepted.length < incoming.length) {
      setError(targetMode === "reference"
        ? tr("最多添加 7 张视频参考图", "You can add up to 7 video reference images")
        : tr("当前模式只能添加一个参考素材", "The current mode accepts one reference only"));
    }
  };

  const importReferencePaths = async (paths: string[]) => {
    if (kind === "video") {
      if (!isGrokVideo) {
        setError(tr("当前视频模型不支持本地参考素材", "The selected video model does not support local references"));
        return;
      }
      const imported = await importMediaReferences(paths.slice(0, 7));
      const containsVideo = imported.some((item) => item.kind === "video");
      const targetMode: VideoGenerationMode = containsVideo
        ? "video"
        : isGrokVideo15 || activeVideoMode === "image"
          ? "image"
          : activeVideoMode === "reference" || imported.length > 1
            ? "reference"
            : "image";
      if (isGrokVideo15 && targetMode !== "image") {
        await Promise.all(imported.map((item) => deleteImageAttachment(item.id).catch(() => false)));
        setError(tr("Grok 1.5 只支持单张首帧图", "Grok 1.5 supports one first-frame image only"));
        return;
      }
      await acceptVideoReferences(imported, targetMode);
      return;
    }
    if (kind === "image" && imageMode !== "generate") {
      await acceptImageEditSource(await importAttachments(paths.slice(0, 12)), true);
      return;
    }
    const available = Math.max(0, 8 - imageReferences.length);
    if (available === 0) {
      setError(tr("最多添加 8 张参考图", "You can add up to 8 reference images"));
      return;
    }
    const imported = await importAttachments(paths.slice(0, 12));
    await acceptImageReferences(imported);
  };

  const importPastedReferences = async (files: File[]) => {
    const targetVideoMode = kind === "video" && isGrokVideo
      ? isGrokVideo15 || !matchesImageVideoMode(activeVideoMode) ? "image" : activeVideoMode
      : null;
    const targetImageEdit = kind === "image" && imageMode !== "generate";
    const maximum = targetVideoMode === "reference" ? 7 : targetVideoMode || targetImageEdit ? 1 : 8;
    const existing = targetVideoMode ? videoReferences.length : targetImageEdit ? 0 : imageReferences.length;
    const available = Math.max(0, maximum - existing);
    if (available === 0) {
      setError(tr("当前参考素材数量已达上限", "The reference limit has been reached"));
      return;
    }
    const selectedFiles = files.slice(0, available);
    setPastingReferences(true);
    setError(null);
    try {
      const imported = await importClipboardImages(selectedFiles);
      if (targetVideoMode) await acceptVideoReferences(imported, targetVideoMode);
      else if (targetImageEdit) await acceptImageEditSource(imported, true);
      else await acceptImageReferences(imported);
      if (selectedFiles.length < files.length) {
        setError(tr("超出数量上限的图片未粘贴", "Images beyond the reference limit were not pasted"));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPastingReferences(false);
    }
  };

  useEffect(() => {
    if (!active || !referenceDrop) return;
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
      if (kind !== "video" || !isGrokVideo) setKind("image");
      if (pastingReferences) {
        setError(tr("正在处理上一批粘贴图片", "The previous pasted images are still being processed"));
        return;
      }
      void importPastedReferences(files);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [active, pastingReferences, kind, isGrokVideo, isGrokVideo15, activeVideoMode, imageMode, imageReferences, videoReferences]);

  const removeImageReference = async (attachment: ImageAttachment) => {
    setImageReferences((current) => current.filter((item) => item.id !== attachment.id));
    await deleteImageAttachment(attachment.id).catch(() => undefined);
  };

  const removeVideoReference = async (attachment: ImageAttachment) => {
    setVideoReferences((current) => current.filter((item) => item.id !== attachment.id));
    await deleteImageAttachment(attachment.id).catch(() => undefined);
  };

  const generate = async () => {
    const activePrompts = prompts.map((item) => item.prompt.trim()).filter(Boolean);
    if (activePrompts.length === 0) return;
    if (kind === "image" && imageMode !== "generate" && !imageEditSource) {
      setError(tr("请先选择一张编辑源图", "Choose an edit source image first"));
      return;
    }
    if (kind === "image" && imageMode === "inpaint" && !imageEditMask) {
      setError(tr("局部重绘需要先在画板涂抹蒙版", "Inpainting needs a mask painted in the canvas first"));
      return;
    }
    if (kind === "image" && imageMode === "outpaint" && (!imageEditMask || !imageEditMeta?.expanded)) {
      setError(tr("扩图需要先在画板设置扩边范围", "Outpainting needs an expanded canvas area first"));
      return;
    }
    if (!selected) {
      setError(requiresImageMask
        ? tr("当前没有支持 PNG 蒙版编辑的图像模型，请配置支持 OpenAI Images Edit 的模型", "No configured image model supports PNG mask editing. Configure a model with OpenAI Images Edit support")
        : tr("当前没有可用的生成模型", "No generation model is available"));
      return;
    }
    if (!videoReferenceReady) {
      setError(videoReferenceRequirement(activeVideoMode));
      return;
    }
    setError(null);
    const grokVideoHasOutputControls = isGrokVideo && activeVideoMode !== "video";
    const videoSizeLabel = grokVideoHasOutputControls ? `${videoResolution} · ${videoAspectRatio}` : undefined;
    const base: Omit<MediaGenerationRequest, "prompt"> = {
      kind,
      profileId: selected.profileId,
      model: selected.id,
      protocol: selected.protocol,
      count,
      size: kind === "image"
        ? size !== "auto" ? size : undefined
        : kind === "video" && !isGrokVideo ? size : undefined,
      quality: kind === "image" && quality !== "auto" ? quality : undefined,
      outputFormat: kind === "video" ? undefined : outputFormat,
      background: kind === "image" && background !== "auto" ? background : undefined,
      voice: kind === "audio" && voice.trim() ? voice.trim() : undefined,
      instructions: kind === "audio" && instructions.trim() ? instructions.trim() : undefined,
      seconds: kind === "video" && activeVideoMode !== "video" ? seconds : undefined,
      videoMode: kind === "video" && isGrokVideo ? activeVideoMode : "text",
      videoResolution: grokVideoHasOutputControls ? videoResolution : undefined,
      videoAspectRatio: grokVideoHasOutputControls ? videoAspectRatio : undefined,
      referenceAttachmentIds: kind === "image"
        ? imageMode === "generate"
          ? imageReferences.map((item) => item.id)
          : imageEditSource ? [imageEditSource.id] : []
        : kind === "video" && isGrokVideo && activeVideoMode !== "text"
          ? videoReferences.map((item) => item.id)
          : [],
      maskAttachmentId: kind === "image" && imageMode !== "generate" ? imageEditMask?.id : undefined,
    };
    const requestPrompts = kind === "image"
      ? activePrompts.map((prompt) => studioImagePrompt(prompt, imageMode, imageEditMeta))
      : activePrompts;
    const tasks = requestPrompts.map((prompt) => {
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
        size: videoSizeLabel ?? base.size,
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

    const results = await Promise.allSettled(tasks.map(async (task) => {
      try {
        const result = await generateMedia({
          ...base,
          prompt: armorModeMediaPrompt(armorMode, armorModeLevel, kind, task.prompt, {
            model: selected.id,
            protocol: selected.protocol,
            skills: armorModeSkills,
            surface: kind,
          }),
          instructions: armorModeMediaInstructions(armorMode, armorModeLevel, kind, base.instructions, {
            model: selected.id,
            protocol: selected.protocol,
            skills: armorModeSkills,
            surface: kind,
          }),
        });
        setAssets((current) => mergeAssets(current, result.assets));
        return result;
      } finally {
        setPendingAssets((current) => current.filter((asset) => asset.batchId !== task.pendingBatchId));
      }
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : result.value.errors);
    if (failures.length > 0) setError(failures.join(" · "));
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([loadCatalog(false), loadHistory(kind, true)]);
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

  const reuseImage = async (asset: MediaAsset) => {
    if (asset.kind !== "image" || asset.status !== "completed" || !asset.filePath) return;
    setError(null);
    try {
      const imported = await importMediaReferences([asset.filePath]);
      await acceptImageReferences(imported);

      setKind("image");
      setImageMode("generate");
      setPrompts((current) => [{ id: current[0]?.id ?? crypto.randomUUID(), prompt: asset.prompt }]);
      rememberSelectedModel("image", `${asset.providerId}::${asset.model}`);
      setCount(clampMediaCount(asset.count));
      setSize(normalizeImageSize(asset.size));
      setQuality(normalizeImageQuality(asset.quality));
      setOutputFormat(normalizeImageFormat(asset.outputFormat, asset.fileName));
      setBackground(normalizeImageBackground(asset.background));

      window.setTimeout(() => {
        rootRef.current?.querySelector<HTMLTextAreaElement>(".media-prompt-card textarea")?.focus();
      }, 0);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const armorClassName = armorMode ? ` armor-mode armor-level-${armorModeLevel}` : "";

  return (
    <main
      ref={rootRef}
      className={`media-studio${dropActive ? " file-drag-active" : ""}${armorClassName}`}
      data-armor-level={armorMode ? armorModeLevel : undefined}
      hidden={!active}
      onDragEnter={(event) => event.preventDefault()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      {dropActive && (
        <div className="media-drop-overlay" role="status" aria-live="polite">
          <span>{kind === "video" && activeVideoMode === "video" ? <Video size={28} /> : <ImagePlus size={28} />}</span>
          <strong>{mediaDropTitle(kind, activeVideoMode, imageMode)}</strong>
          <small>{tr("素材会添加到当前创作任务，不会进入会话附件", "References are added to Media Studio, not to the conversation")}</small>
        </div>
      )}
      <header className="media-topbar" data-tauri-drag-region>
        <div className="media-topbar-brand">
          <span className="media-title-icon"><WandSparkles size={17} /></span>
          <span><strong>{tr("创作空间", "Media Studio")}</strong><small>{tr("独立于会话，所有生成结果全局保存", "Independent from conversations, with global history")}</small></span>
        </div>
        <div className="creation-mode-switch" role="tablist" aria-label={tr("创作类型", "Creation mode")}>
          <button type="button" role="tab" aria-selected="true" className="active"><ImagePlus size={14} />{tr("图片 · 视频 · 语音", "Image · Video · Speech")}</button>
          <button type="button" role="tab" aria-selected="false" onClick={onWriting}><BookOpen size={14} />{tr("写作", "Writing")}</button>
          <button type="button" role="tab" aria-selected="false" onClick={onConstellation}><Boxes size={14} />{tr("星图", "Constellation")}</button>
        </div>
        <div className="media-topbar-actions">
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
                onChange={(event) => rememberSelectedModel(kind, event.target.value)}
              >
                {models.length === 0 && <option value="">{tr("未发现可用模型", "No model discovered")}</option>}
                {requiresImageMask && models.length > 0 && eligibleModels.length === 0 && <option value="">{tr("没有支持 PNG 蒙版的模型", "No model supports PNG masks")}</option>}
                {models.map((model) => (
                  <option value={modelKey(model)} disabled={requiresImageMask && !mediaModelSupportsExplicitImageMask(model)} key={modelKey(model)}>
                    {model.recommended ? `★ ${tr("推荐", "Recommended")} · ` : ""}{model.id} · {model.profileName}{requiresImageMask && !mediaModelSupportsExplicitImageMask(model) ? tr(" · 不支持蒙版", " · No mask support") : ""}
                  </option>
                ))}
              </select>
            </label>
            {requiresImageMask && selected
              ? <span className="recommended-model"><Check size={12} />{tr("当前模型支持 PNG 蒙版编辑", "The current model supports PNG mask editing")}</span>
              : selected?.recommended && <span className="recommended-model"><Sparkles size={12} />{tr("已自动选择推荐模型", "Recommended model selected automatically")}</span>}
          </div>

          {kind === "image" && <div className="media-image-mode-control">
            <span>{tr("创作方式", "Image mode")}</span>
            <div role="radiogroup" aria-label={tr("图片创作方式", "Image creation mode")}>{STUDIO_IMAGE_MODES.map((mode) => <button
              type="button"
              role="radio"
              aria-checked={imageMode === mode.value}
              className={imageMode === mode.value ? "active" : ""}
              onClick={() => changeImageMode(mode.value)}
              key={mode.value}
            >{tr(mode.label, mode.labelEn)}</button>)}</div>
            <small>{imageModeDescription(imageMode)}</small>
          </div>}

          {kind === "image" && imageMode !== "generate" && <section className="media-image-edit-panel">
            <header>
              <div><span><Brush size={15} /></span><div><strong>{tr("编辑源图", "Edit source")}</strong><small>{tr("可从本地选择，或点击右侧历史图片的画笔按钮", "Choose a local image or use the brush button on a history image")}</small></div></div>
              <em className={imageEditSource ? "ready" : ""}>{imageEditSource ? tr("源图已就绪", "Source ready") : tr("需要源图", "Source required")}</em>
            </header>
            {imageEditSource ? <div className="media-image-edit-source">
              <MediaImageEditSource attachment={imageEditSource} onOpen={() => setImageEditorOpen(true)} onRemove={() => void replaceImageEditSource(undefined)} />
              <div className="media-image-edit-actions">
                <button type="button" onClick={() => void chooseImageEditSource()}><ImagePlus size={13} />{tr("更换源图", "Replace source")}</button>
                <button type="button" className="primary" onClick={() => setImageEditorOpen(true)}><Brush size={13} />{tr("打开标注画板", "Open annotation canvas")}</button>
              </div>
            </div> : <button type="button" className="media-image-edit-empty" onClick={() => void chooseImageEditSource()}><ImagePlus size={21} /><span><strong>{tr("选择一张图片开始编辑", "Choose an image to edit")}</strong><small>{tr("支持标注标签、涂抹蒙版和向外扩图", "Add labels, paint a mask, or expand the canvas")}</small></span></button>}
            {imageEditSource && <div className="media-image-edit-status">
              <span className="ready">{tr("源图", "Source")}</span>
              {imageEditMeta?.hasLabels && <span className="ready">{tr("标签已合成", "Labels applied")}</span>}
              <span className={imageEditMask ? "ready" : ""}>{imageEditMask ? tr("PNG 蒙版已就绪", "PNG mask ready") : tr("尚无蒙版", "No mask")}</span>
              {imageEditMeta?.expanded && <span className="ready">{tr("扩边已设置", "Expansion set")}</span>}
            </div>}
            {requiresImageMask && eligibleModels.length === 0 && <p className="media-image-mask-warning"><CircleAlert size={13} />{tr("已生成 PNG 蒙版，但当前连接里没有兼容模型；请配置支持 OpenAI Images Edit 的模型", "A PNG mask is ready, but no compatible model is configured. Add a model with OpenAI Images Edit support")}</p>}
          </section>}

          {isGrokVideo && (
            <div className="media-video-mode-control">
              <span>{tr("生成方式", "Video mode")}</span>
              <div role="radiogroup" aria-label={tr("视频生成方式", "Video generation mode")}>
                {GROK_VIDEO_MODES.map((mode) => {
                  const unsupported = isGrokVideo15 && mode !== "image";
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={activeVideoMode === mode}
                      className={activeVideoMode === mode ? "active" : ""}
                      disabled={unsupported}
                      title={unsupported ? tr("Grok 1.5 仅支持首帧图生成", "Grok 1.5 supports first-frame generation only") : videoModeDescription(mode)}
                      onClick={() => changeVideoMode(mode)}
                      key={mode}
                    >
                      {videoModeLabel(mode)}
                    </button>
                  );
                })}
              </div>
              <small>{videoModeDescription(activeVideoMode)}</small>
            </div>
          )}

          <div className="media-prompt-list">
            {prompts.map((item, index) => (
              <article className="media-prompt-card" key={item.id}>
                <div><span>{kind === "image" && imageMode !== "generate" ? tr("修改要求", "Edit instruction") : tr("提示词", "Prompt")} {prompts.length > 1 ? index + 1 : ""}</span>{prompts.length > 1 && <button onClick={() => removePrompt(item.id)} title={tr("删除提示词", "Remove prompt")}><X size={13} /></button>}</div>
                <textarea
                  value={item.prompt}
                  maxLength={32_000}
                  placeholder={promptPlaceholder(kind, imageMode)}
                  onChange={(event) => updatePrompt(item.id, event.target.value)}
                />
              </article>
            ))}
          </div>
          <button className="add-media-prompt" disabled={prompts.length >= 8} onClick={addPrompt}><Plus size={14} />{tr("添加并行提示词", "Add parallel prompt")}</button>

          <div className="media-options-grid">
            {kind === "image" && (
              <label><span>{tr("尺寸 / 比例", "Size / ratio")}</span><select value={size} onChange={(event) => setSize(event.target.value)}>
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
              </select></label>
            )}
            {kind === "video" && !isGrokVideo && <label><span>{tr("尺寸 / 比例", "Size / ratio")}</span><select value={size} onChange={(event) => setSize(event.target.value)}>{VIDEO_SIZE_OPTIONS.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>}
            {kind === "video" && isGrokVideo && activeVideoMode !== "video" && <>
              <label><span>{tr("画面比例", "Aspect ratio")}</span><select value={videoAspectRatio} onChange={(event) => setVideoAspectRatio(event.target.value)}>{GROK_VIDEO_ASPECT_OPTIONS.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
              <label><span>{tr("清晰度", "Resolution")}</span><select value={videoResolution} onChange={(event) => setVideoResolution(event.target.value)}>{videoResolutionOptions.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            </>}
            {kind === "video" && isGrokVideo && activeVideoMode === "video" && <div className="media-inherited-video-size"><span>{tr("尺寸与时长", "Size and duration")}</span><strong>{tr("继承源视频 · 最高 720p", "Inherited from source · up to 720p")}</strong></div>}
            {kind === "image" && <label><span>{tr("质量", "Quality")}</span><select value={quality} onChange={(event) => setQuality(event.target.value)}>{["auto", "high", "medium", "2K", "4K"].map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "image" && <label><span>{tr("背景", "Background")}</span><select value={background} onChange={(event) => setBackground(event.target.value)}>
              <option value="auto">auto</option>
              <option value="transparent" disabled={!transparentBackgroundSupported}>{transparentBackgroundSupported ? "transparent" : tr("transparent（当前模型不支持）", "transparent (unsupported by this model)")}</option>
              <option value="opaque">opaque</option>
            </select></label>}
            {kind !== "video" && <label><span>{tr("格式", "Format")}</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>{(kind === "image" ? ["png", "webp", "jpeg"] : ["mp3", "wav", "aac", "flac", "opus"]).map((value) => <option key={value}>{value}</option>)}</select></label>}
            {kind === "video" && activeVideoMode !== "video" && <label><span>{tr("时长", "Duration")}</span><select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>{videoDurationOptions.map((value) => <option value={value} key={value}>{value}s</option>)}</select></label>}
            <label><span>{tr("每条数量", "Outputs each")}</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{Array.from({ length: kind === "image" ? 8 : 4 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            {kind === "audio" && <label><span>{tr("声音", "Voice")}</span><input value={voice} placeholder={tr("留空自动选择", "Automatic when empty")} onChange={(event) => setVoice(event.target.value)} /></label>}
          </div>

          {kind === "audio" && <label className="media-wide-field"><span>{tr("演绎要求", "Delivery instructions")}</span><input value={instructions} placeholder={tr("例如：温暖、自然、稍慢", "For example: warm, natural, slightly slower")} onChange={(event) => setInstructions(event.target.value)} /></label>}

          {kind === "image" && imageMode === "generate" && (
            <div className="media-reference-row">
              <div className="media-reference-heading">
                <span>{tr("参考图", "References")}<small>{pastingReferences ? tr("正在粘贴图片…", "Pasting images…") : tr("可拖拽、选择，或按 Ctrl+V 粘贴外部图片", "Drop, choose, or press Ctrl+V to paste images")}</small></span>
                <button disabled={pastingReferences || imageReferences.length >= 8} onClick={() => void addImageReferences()}>{pastingReferences ? <LoaderCircle className="spin" size={14} /> : <ImagePlus size={14} />}{tr("选择图片", "Choose images")}</button>
              </div>
              <div>{imageReferences.map((attachment) => <AttachmentChip attachment={attachment} onRemove={() => void removeImageReference(attachment)} key={attachment.id} />)}</div>
            </div>
          )}

          {kind === "video" && isGrokVideo && activeVideoMode !== "text" && (
            <div className="media-reference-row media-video-reference-row">
              <div className="media-reference-heading">
                <span>{videoReferenceTitle(activeVideoMode)}<small>{videoReferenceHint(activeVideoMode, pastingReferences)}</small></span>
                <button disabled={pastingReferences || videoReferences.length >= (activeVideoMode === "reference" ? 7 : 1)} onClick={() => void addVideoReferences()}>
                  {pastingReferences ? <LoaderCircle className="spin" size={14} /> : activeVideoMode === "video" ? <Video size={14} /> : <ImagePlus size={14} />}
                  {activeVideoMode === "video" ? tr("选择视频", "Choose video") : tr("选择图片", "Choose images")}
                </button>
              </div>
              <div>{videoReferences.map((attachment) => <AttachmentChip attachment={attachment} onRemove={() => void removeVideoReference(attachment)} key={attachment.id} />)}</div>
            </div>
          )}

          {catalog && catalog.errors.length > 0 && <details className="media-catalog-warning"><summary><CircleAlert size={13} />{tr("部分连接无法读取模型", "Some connections could not list models")}</summary><p>{catalog.errors.join(" · ")}</p></details>}
          {error && <div className="media-error"><CircleAlert size={14} /><span>{error}</span><button onClick={() => setError(null)}><X size={13} /></button></div>}

          {models.length === 0 && !loading ? (
            <button className="media-configure-button" onClick={onConfigureConnection}><Settings2 size={15} />{tr("配置支持生成能力的模型连接", "Configure a media-capable model connection")}</button>
          ) : (
            <button className="media-generate-button" disabled={pastingReferences || loading || !selected || !videoReferenceReady || !imageEditReady || !prompts.some((item) => item.prompt.trim())} onClick={() => void generate()}>
              {pastingReferences ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {pastingReferences ? tr("正在添加参考素材", "Adding references") : mediaGenerateLabel(kind, imageMode)}
            </button>
          )}
        </section>

        <section className="media-gallery-panel">
          <div className="media-gallery-heading">
            <div>
              <strong>{tr("创作历史", "Creation history")}</strong><span title={currentHistoryState.hasMore ? tr("还有更多历史未读取", "More history is available") : undefined}>{visibleAssets.length}{currentHistoryState.hasMore ? "+" : ""}</span>
              {visiblePendingAssets.length > 0 && <em><LoaderCircle className="spin" size={12} />{tr(`${visiblePendingAssets.length} 个生成中`, `${visiblePendingAssets.length} generating`)}</em>}
            </div>
            <small>{tr("结果保存在本机应用数据目录", "Outputs are stored in local app data")}</small>
          </div>
          {currentHistoryState.loading && !currentHistoryState.loaded ? <div className="media-empty"><LoaderCircle className="spin" size={24} /><span>{tr("正在读取首段历史", "Loading recent history")}</span></div>
            : displayedAssets.length === 0 ? <div className="media-empty"><KindIcon kind={kind} /><strong>{tr("还没有作品", "No creations yet")}</strong><span>{tr("输入提示词后，结果会自动出现在这里", "Generated outputs will appear here automatically")}</span></div>
              : <>
                <div className="media-gallery-grid">{displayedAssets.map((asset) => <MediaAssetCard asset={asset} locale={locale} onDelete={asset.pendingOutput ? undefined : () => void removeAsset(asset)} onPreview={asset.kind === "image" && asset.status === "completed" ? () => setPreviewAsset(asset) : undefined} onReuse={asset.kind === "image" && asset.status === "completed" && Boolean(asset.filePath) ? () => reuseImage(asset) : undefined} onEdit={asset.kind === "image" && asset.status === "completed" && Boolean(asset.filePath) ? () => editImageAsset(asset) : undefined} key={asset.id} />)}</div>
                {currentHistoryState.hasMore && <div className="media-history-pagination">
                  <button type="button" disabled={currentHistoryState.loadingMore} onClick={() => void loadHistory(kind)}>
                    {currentHistoryState.loadingMore && <LoaderCircle className="spin" size={14} />}
                    {currentHistoryState.loadingMore ? tr("正在读取下一段", "Loading next page") : tr(`继续读取 ${MEDIA_HISTORY_PAGE_SIZE} 条`, `Load ${MEDIA_HISTORY_PAGE_SIZE} more`)}
                  </button>
                </div>}
              </>}
        </section>
      </div>
      {active && previewAsset && <MediaImagePreview
        asset={previewAsset}
        locale={locale}
        previewAssets={previewableAssets}
        onNavigate={(nextAsset) => setPreviewAsset(nextAsset)}
        onEdit={(asset) => {
          setPreviewAsset(null);
          return editImageAsset(asset);
        }}
        armorMode={armorMode}
        armorModeLevel={armorModeLevel}
        onClose={() => setPreviewAsset(null)}
      />}
      {active && imageEditorOpen && imageEditSource && <ConstellationCanvasEditor
        source={imageEditSource}
        title={tr("图片编辑画板", "Image editing canvas")}
        saveLabel={tr("应用到图片编辑", "Apply to image edit")}
        onClose={() => setImageEditorOpen(false)}
        onSave={(image, mask, meta) => void applyCanvasEdit(image, mask, meta)}
      />}
    </main>
  );
}

function MediaImageEditSource({ attachment, onOpen, onRemove }: { attachment: ImageAttachment; onOpen: () => void; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    setUrl(undefined);
    setLoading(true);
    void previewAttachment(attachment).then((preview) => {
      if (!disposed && preview.kind === "image" && preview.dataBase64) {
        setUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      }
    }).catch(() => undefined).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [attachment.id]);
  return <div className="media-image-edit-source-card">
    <button type="button" className="media-image-edit-thumbnail" onClick={onOpen} title={tr("打开标注画板", "Open annotation canvas")}>
      {url ? <img src={url} alt={attachment.name} /> : loading ? <LoaderCircle className="spin" size={18} /> : <Image size={19} />}
      <span><Brush size={11} />{tr("编辑", "Edit")}</span>
    </button>
    <div><strong title={attachment.name}>{attachment.name}</strong><small>{attachment.mimeType.replace("image/", "").toUpperCase()} · {formatAttachmentBytes(attachment.sizeBytes)}</small></div>
    <button type="button" onClick={onRemove} aria-label={tr("移除编辑源图", "Remove edit source")} title={tr("移除编辑源图", "Remove edit source")}><X size={13} /></button>
  </div>;
}

export function MediaAssetCard({ asset, locale, onDelete, onPreview, onReuse, onEdit }: { asset: StudioMediaAsset; locale: string; onDelete?: () => void; onPreview?: () => void; onReuse?: () => Promise<void> | void; onEdit?: () => Promise<void> | void }) {
  const url = mediaAssetUrl(asset);
  const [exporting, setExporting] = useState(false);
  const [reusing, setReusing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptCopyStatus, setPromptCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [exportFeedback, setExportFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const canExport = asset.status === "completed" && Boolean(asset.filePath && asset.fileName);
  const canPreview = asset.status === "completed" && asset.kind === "image" && Boolean(url && onPreview);
  const canReuse = asset.status === "completed" && asset.kind === "image" && Boolean(onReuse);
  const canEdit = asset.status === "completed" && asset.kind === "image" && Boolean(onEdit);
  const canExpandPrompt = asset.prompt.trim().length > 42;
  const previewRatio = asset.kind === "video" ? videoRatio ?? mediaAssetAspectRatio(asset) ?? 16 / 9 : 4 / 3;

  useEffect(() => setVideoRatio(null), [asset.id]);

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

  const reuseAsset = async () => {
    if (!canReuse || !onReuse || reusing) return;
    setReusing(true);
    try {
      await onReuse();
    } finally {
      setReusing(false);
    }
  };

  const editAsset = async () => {
    if (!canEdit || !onEdit || editing) return;
    setEditing(true);
    try {
      await onEdit();
    } finally {
      setEditing(false);
    }
  };

  return (
    <article className={`media-asset-card kind-${asset.kind} status-${asset.status} ${canExport || canReuse || canEdit || onDelete ? "has-actions" : ""}`}>
      <div className="media-preview" style={{ aspectRatio: previewRatio }}>
        {asset.status === "completed" && url && asset.kind === "image" && (canPreview ? (
          <button className="media-preview-trigger" type="button" onClick={onPreview} aria-label={tr("打开大图预览", "Open large image preview")}>
            <img src={url} alt={asset.revisedPrompt || asset.prompt} />
            <span><Maximize2 size={14} />{tr("查看大图", "View large")}</span>
          </button>
        ) : <img src={url} alt={asset.revisedPrompt || asset.prompt} />)}
        {asset.status === "completed" && url && asset.kind === "video" && <video src={url} controls preload="metadata" onLoadedMetadata={(event) => {
          const { videoWidth, videoHeight } = event.currentTarget;
          if (videoWidth > 0 && videoHeight > 0) setVideoRatio(videoWidth / videoHeight);
        }} />}
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
        {asset.kind === "video" && (asset.size || asset.seconds) && <div className="media-asset-specs">{asset.size && <span>{asset.size}</span>}{asset.seconds && <span>{asset.seconds}s</span>}</div>}
        <small><Clock3 size={11} />{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(asset.createdAt)}</small>
        {asset.error && <em title={asset.error}>{mediaErrorSummary(asset.error)}</em>}
        {exportFeedback && <em className={exportFeedback.error ? "media-export-error" : "media-export-success"} title={exportFeedback.text}>{exportFeedback.error ? <CircleAlert size={11} /> : <Check size={11} />}{exportFeedback.text}</em>}
      </div>
      {(canExport || canReuse || canEdit || onDelete) && <div className="media-asset-actions">
        {canEdit && <button className="media-edit-asset" disabled={editing} onClick={() => void editAsset()} title={tr("编辑此图", "Edit this image")} aria-label={tr("编辑此图", "Edit this image")}>{editing ? <LoaderCircle className="spin" size={13} /> : <Brush size={13} />}</button>}
        {canReuse && <button className="media-reuse-asset" disabled={reusing} onClick={() => void reuseAsset()} title={tr("复用图片与参数", "Reuse image and parameters")} aria-label={tr("复用图片与参数", "Reuse image and parameters")}>{reusing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>}
        {canExport && <button className="media-export-asset" disabled={exporting} onClick={() => void exportAsset()} title={tr("另存为", "Save as")} aria-label={tr("另存为", "Save as")}>{exporting ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}</button>}
        {onDelete && <button className="media-delete-asset" onClick={onDelete} title={tr("删除作品", "Delete creation")} aria-label={tr("删除作品", "Delete creation")}><Trash2 size={13} /></button>}
      </div>}
    </article>
  );
}

export function MediaImagePreview({
  asset,
  locale,
  previewAssets,
  onNavigate,
  onEdit,
  armorMode = false,
  armorModeLevel,
  onClose,
}: {
  asset: MediaAsset;
  locale: string;
  previewAssets: MediaAsset[];
  onNavigate: (asset: MediaAsset) => void;
  onEdit?: (asset: MediaAsset) => Promise<void> | void;
  armorMode?: boolean;
  armorModeLevel?: ArmorModeLevel;
  onClose: () => void;
}) {
  const url = mediaAssetUrl(asset);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    bounds: { width: number; height: number };
  } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragPointRef = useRef<PreviewPoint | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<PreviewTransform>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
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
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    pendingDragPointRef.current = null;
    dragRef.current = null;
    setDragging(false);
    setImageSize({ width: 0, height: 0 });
    const resetView = { zoom: 1, x: 0, y: 0 };
    viewRef.current = resetView;
    setView(resetView);
    setExporting(false);
    setExportError(false);
  }, [asset.id]);

  useEffect(() => {
    viewRef.current = view;
    applyPreviewTransform(imageRef.current, view);
  }, [view]);

  useEffect(() => () => {
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

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
    const current = viewRef.current;
    const zoom = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, requestedZoom));
    const ratio = zoom / current.zoom;
    const candidate = {
      x: anchor.x - (anchor.x - current.x) * ratio,
      y: anchor.y - (anchor.y - current.y) * ratio,
    };
    const next = { zoom, ...constrainPreviewOffset(candidate, zoom, imageSize, canvasRef.current) };
    viewRef.current = next;
    setView(next);
  };

  const showActualSize = () => {
    const next = { zoom: 1, x: 0, y: 0 };
    viewRef.current = next;
    setView(next);
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
    const next = { zoom, x: 0, y: 0 };
    viewRef.current = next;
    setView(next);
  };

  const panBy = (x: number, y: number) => {
    const current = viewRef.current;
    const offset = constrainPreviewOffset(
      { x: current.x + x, y: current.y + y },
      current.zoom,
      imageSize,
      canvasRef.current,
    );
    const next = { ...current, ...offset };
    viewRef.current = next;
    setView(next);
  };

  const updateDragPosition = (drag: NonNullable<typeof dragRef.current>, point: PreviewPoint) => {
    const current = viewRef.current;
    const offset = constrainPreviewOffsetToBounds(
      {
        x: drag.originX + point.x - drag.startX,
        y: drag.originY + point.y - drag.startY,
      },
      current.zoom,
      imageSize,
      drag.bounds,
    );
    const next = { ...current, ...offset };
    viewRef.current = next;
    applyPreviewTransform(imageRef.current, next);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !imageReady) return;
    if ((event.target as Element).closest(".media-image-lightbox-toolbar, .media-image-lightbox-nav")) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    const current = viewRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
      bounds: { width: bounds.width, height: bounds.height },
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    pendingDragPointRef.current = { x: event.clientX, y: event.clientY };
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const latestDrag = dragRef.current;
      const point = pendingDragPointRef.current;
      pendingDragPointRef.current = null;
      if (latestDrag && point) updateDragPosition(latestDrag, point);
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    updateDragPosition(drag, { x: event.clientX, y: event.clientY });
    pendingDragPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setView({ ...viewRef.current });
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
    applyZoom(viewRef.current.zoom * (event.deltaY < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP), anchor);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyZoom(viewRef.current.zoom * PREVIEW_ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      applyZoom(viewRef.current.zoom / PREVIEW_ZOOM_STEP);
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

  const armorClassName = armorMode ? ` armor-mode armor-level-${armorModeLevel ?? "standard"}` : "";

  return createPortal(
    <div className={`media-image-lightbox${armorClassName}`} data-armor-level={armorMode ? armorModeLevel ?? "standard" : undefined} role="dialog" aria-modal="true" aria-labelledby="media-image-preview-title" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="media-image-lightbox-dialog">
        <header>
          <div>
            <strong id="media-image-preview-title">{tr("图片预览", "Image preview")}</strong>
            <p title={asset.prompt}>{asset.prompt}</p>
          </div>
          <div className="media-image-lightbox-actions">
            {onEdit && asset.filePath && <button
              className="media-image-lightbox-edit"
              type="button"
              onClick={() => void onEdit(asset)}
              aria-label={tr("编辑此图", "Edit this image")}
              title={tr("编辑此图", "Edit this image")}
            ><Brush size={17} /></button>}
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
            ref={imageRef}
            key={asset.id}
            src={url}
            alt={asset.revisedPrompt || asset.prompt}
            draggable={false}
            onLoad={(event) => {
              setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              const resetView = { zoom: 1, x: 0, y: 0 };
              viewRef.current = resetView;
              setView(resetView);
            }}
            style={imageReady ? {
              width: imageSize.width,
              height: imageSize.height,
              transform: previewTransform(view),
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
  return constrainPreviewOffsetToBounds(point, zoom, imageSize, bounds);
}

function constrainPreviewOffsetToBounds(
  point: PreviewPoint,
  zoom: number,
  imageSize: { width: number; height: number },
  bounds: { width: number; height: number },
): PreviewPoint {
  if (imageSize.width <= 0 || imageSize.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  const maxX = Math.max(0, (imageSize.width * zoom - bounds.width) / 2);
  const maxY = Math.max(0, (imageSize.height * zoom - bounds.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, point.x)),
    y: Math.min(maxY, Math.max(-maxY, point.y)),
  };
}

function previewTransform(view: PreviewTransform) {
  return `translate3d(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px), 0) scale(${view.zoom})`;
}

function applyPreviewTransform(image: HTMLImageElement | null, view: PreviewTransform) {
  if (image) image.style.transform = previewTransform(view);
}

function modelKey(model: MediaModelInfo) {
  return `${model.profileId}::${model.id}`;
}

function loadMediaModelRoutes(): Partial<Record<MediaKind, string>> {
  try {
    const value = JSON.parse(localStorage.getItem(MEDIA_MODEL_ROUTES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      (["image", "video", "audio"] as MediaKind[])
        .filter((kind) => typeof value[kind] === "string" && value[kind].length <= 512)
        .map((kind) => [kind, value[kind]]),
    );
  } catch {
    return {};
  }
}

function saveMediaModelRoutes(routes: Partial<Record<MediaKind, string>>) {
  try {
    localStorage.setItem(MEDIA_MODEL_ROUTES_KEY, JSON.stringify(routes));
  } catch {
    // Keep model switching available for the current session if WebView
    // storage is unavailable.
  }
}

function matchesImageVideoMode(mode: VideoGenerationMode): mode is "image" | "reference" {
  return mode === "image" || mode === "reference";
}

function videoModeLabel(mode: VideoGenerationMode) {
  if (mode === "image") return tr("首帧图", "First frame");
  if (mode === "reference") return tr("参考图", "References");
  if (mode === "video") return tr("视频编辑", "Edit video");
  return tr("纯文本", "Text");
}

function videoModeDescription(mode: VideoGenerationMode) {
  if (mode === "image") return tr("以一张图片作为视频起始画面", "Animate one image as the starting frame");
  if (mode === "reference") return tr("用 1–7 张图片引导人物、物体或服装一致性", "Guide people, objects, or clothing with 1–7 images");
  if (mode === "video") return tr("根据提示词编辑一个不超过 8.7 秒的 MP4 视频", "Edit one MP4 video up to 8.7 seconds");
  return tr("仅根据提示词生成视频", "Generate a video from the prompt only");
}

function videoReferenceTitle(mode: VideoGenerationMode) {
  if (mode === "video") return tr("源视频", "Source video");
  if (mode === "reference") return tr("视频参考图", "Video references");
  return tr("首帧图", "First-frame image");
}

function videoReferenceHint(mode: VideoGenerationMode, busy: boolean) {
  if (busy) return tr("正在添加参考素材…", "Adding references…");
  if (mode === "video") return tr("选择或拖入一个 MP4，最大 64 MiB", "Choose or drop one MP4, up to 64 MiB");
  if (mode === "reference") return tr("选择、拖入或粘贴 1–7 张图片", "Choose, drop, or paste 1–7 images");
  return tr("选择、拖入或粘贴一张图片", "Choose, drop, or paste one image");
}

function videoReferenceRequirement(mode: VideoGenerationMode) {
  if (mode === "video") return tr("请先添加一个 MP4 源视频", "Add one MP4 source video first");
  if (mode === "reference") return tr("请先添加 1–7 张视频参考图", "Add 1–7 video reference images first");
  return tr("请先添加一张首帧图", "Add one first-frame image first");
}

function imageModeDescription(mode: StudioImageMode) {
  if (mode === "edit") return tr("修改整张图片，可先在画板添加标签", "Modify the whole image and optionally add labels in the canvas");
  if (mode === "outpaint") return tr("在画板扩展边界后，让模型无缝补全新区域", "Expand the canvas and let the model seamlessly fill the new area");
  if (mode === "inpaint") return tr("在画板涂红需要修改的区域，再进行精准重绘", "Paint the area to change in red, then regenerate it precisely");
  return tr("从提示词生成新图片，参考图为可选", "Generate a new image from a prompt, with optional references");
}

function studioImagePrompt(prompt: string, mode: StudioImageMode, meta?: CanvasEditorSaveMeta) {
  const instructions: string[] = [];
  if (mode === "outpaint") {
    instructions.push(tr("扩展画面边界并无缝补全新增区域；保持原图主体、光线、透视、色彩和材质完全一致。", "Extend the image beyond its current boundaries and seamlessly complete the new area while preserving subject, lighting, perspective, color, and material."));
  }
  if (meta?.labels.length) {
    instructions.push(tr(
      `图中的彩色标签是编辑定位提示（${meta.labels.join("、")}），请理解其指向后在最终图片中移除这些标签文字和标记。`,
      `Colored labels in the source are editing guides (${meta.labels.join(", ")}); use their locations as guidance, then remove the label text and markers from the final image.`,
    ));
  }
  return instructions.length > 0 ? `${prompt}\n\n${instructions.join("\n")}` : prompt;
}

function mediaGenerateLabel(kind: MediaKind, imageMode: StudioImageMode) {
  if (kind !== "image" || imageMode === "generate") return tr("开始生成", "Generate");
  if (imageMode === "outpaint") return tr("开始扩图", "Start outpainting");
  if (imageMode === "inpaint") return tr("开始局部重绘", "Start inpainting");
  return tr("提交图片编辑", "Submit image edit");
}

function mediaDropTitle(kind: MediaKind, videoMode: VideoGenerationMode, imageMode: StudioImageMode) {
  if (kind === "image") return imageMode === "generate"
    ? tr("拖入即可作为参考图", "Drop to add image references")
    : tr("拖入图片并打开标注画板", "Drop an image and open the annotation canvas");
  if (kind !== "video") return tr("当前模式不使用图片参考", "This mode does not use image references");
  if (videoMode === "video") return tr("拖入 MP4 作为源视频", "Drop an MP4 source video");
  if (videoMode === "reference") return tr("拖入图片作为视频参考", "Drop image references for the video");
  return tr("拖入图片作为首帧", "Drop an image as the first frame");
}

function mediaAssetAspectRatio(asset: MediaAsset) {
  const size = asset.size?.toLocaleLowerCase() ?? "";
  if (size.includes("9:16")) return 9 / 16;
  if (size.includes("16:9")) return 16 / 9;
  const dimensions = size.match(/(\d+)\s*x\s*(\d+)/);
  if (!dimensions) return null;
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function clampMediaCount(value: number | undefined) {
  return Number.isFinite(value) ? Math.min(8, Math.max(1, Math.round(value as number))) : 1;
}

function normalizeImageSize(value: string | undefined) {
  return value && IMAGE_SIZE_OPTIONS.includes(value) ? value : "auto";
}

function normalizeImageQuality(value: string | undefined) {
  if (!value) return "auto";
  const normalized = value.toLocaleLowerCase();
  return ["auto", "high", "medium", "2k", "4k"].includes(normalized)
    ? normalized === "2k" ? "2K" : normalized === "4k" ? "4K" : normalized
    : "auto";
}

function normalizeImageFormat(value: string | undefined, fileName: string | undefined) {
  const candidate = value?.toLocaleLowerCase() || fileName?.split(".").pop()?.toLocaleLowerCase();
  if (candidate === "jpg") return "jpeg";
  return candidate && ["png", "webp", "jpeg"].includes(candidate) ? candidate : "png";
}

function normalizeImageBackground(value: string | undefined) {
  return value && ["auto", "transparent", "opaque"].includes(value) ? value : "auto";
}

function formatAttachmentBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
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

function promptPlaceholder(kind: MediaKind, imageMode: StudioImageMode) {
  if (kind === "image" && imageMode !== "generate") return tr("描述要修改什么，以及必须保留的主体、构图、光线与材质…", "Describe what to change and what subject, composition, lighting, and materials must remain…");
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

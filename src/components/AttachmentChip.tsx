import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  CircleAlert,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  Folder,
  ImagePlus,
  LoaderCircle,
  Presentation,
  X,
} from "lucide-react";
import { previewAttachment } from "../lib/bridge";
import { tr } from "../lib/i18n";
import type { AttachmentPreview, ImageAttachment } from "../lib/types";

const previewCache = new Map<string, Promise<AttachmentPreview>>();

interface AttachmentChipProps {
  attachment: ImageAttachment;
  detailed?: boolean;
  onRemove?: (attachment: ImageAttachment) => void;
}

export function AttachmentChip({ attachment, detailed = false, onRemove }: AttachmentChipProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const pendingPreview = useRef<Promise<AttachmentPreview> | null>(null);
  const details = attachmentFormatLabel(attachment) + (attachment.kind === "folder" ? "" : ` · ${formatBytes(attachment.sizeBytes)}`);

  const showPreview = () => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (bounds) {
      const width = Math.min(360, Math.max(240, window.innerWidth - 24));
      const left = Math.min(Math.max(12, bounds.left), Math.max(12, window.innerWidth - width - 12));
      const placeAbove = bounds.bottom + 330 > window.innerHeight && bounds.top > 330;
      setPosition(placeAbove
        ? { width, left, bottom: window.innerHeight - bounds.top + 8 }
        : { width, left, top: bounds.bottom + 8 });
    }
    setOpen(true);
    const liveResource = attachment.kind === "file" || attachment.kind === "folder";
    if (!liveResource && preview) return;
    if (attachment.kind === "video") {
      setPreview({ kind: attachment.kind, mimeType: attachment.mimeType });
      return;
    }
    if (pendingPreview.current) return;
    setError(null);
    const request = (!liveResource && previewCache.get(attachment.id)) || previewAttachment(attachment);
    pendingPreview.current = request;
    if (!liveResource) previewCache.set(attachment.id, request);
    void request
      .then(setPreview)
      .catch((reason) => {
        previewCache.delete(attachment.id);
        setPreview(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { pendingPreview.current = null; });
  };

  return (
    <>
      <div
        ref={rootRef}
        className={`attachment-chip${detailed ? " detailed" : ""}`}
        title={`${attachment.name} · ${details}`}
        onMouseEnter={showPreview}
        onMouseLeave={() => setOpen(false)}
      >
        <AttachmentGlyph attachment={attachment} />
        <span className="attachment-chip-copy">
          <strong>{attachment.name}</strong>
          {detailed && <small>{details}</small>}
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label={`${tr("移除", "Remove")} ${attachment.name}`}
            onClick={() => onRemove(attachment)}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {open && createPortal(
        <div className="attachment-hover-preview" style={position} role="tooltip">
          <div>
            <AttachmentGlyph attachment={attachment} />
            <span><strong>{attachment.name}</strong><small>{details}</small></span>
          </div>
          {!preview && !error && <div className="attachment-preview-loading"><LoaderCircle className="spin" size={18} />{tr("正在读取预览", "Loading preview")}</div>}
          {error && <div className="attachment-preview-error"><CircleAlert size={17} />{error}</div>}
          {preview?.kind === "image" && preview.dataBase64 && (
            <img src={`data:${preview.mimeType};base64,${preview.dataBase64}`} alt={attachment.name} />
          )}
          {preview?.kind === "video" && (
            <div className="attachment-video-preview"><FileVideo2 size={28} /><span>{tr("MP4 视频参考素材", "MP4 video reference")}</span></div>
          )}
          {preview?.kind === "file" && !preview.text && (
            <div className="attachment-video-preview"><File size={28} /><span>{tr("原始文件", "Original file")}</span></div>
          )}
          {preview && (preview.kind === "text" || preview.kind === "document" || preview.kind === "folder" || (preview.kind === "file" && preview.text)) && (
            <pre>{preview.text || tr("没有可预览的文本内容", "No text preview is available")}</pre>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function AttachmentGlyph({ attachment }: { attachment: ImageAttachment }) {
  if (attachment.kind === "image") return <ImagePlus size={14} />;
  if (attachment.kind === "video") return <FileVideo2 size={14} />;
  if (attachment.kind === "text") return <FileCode2 size={14} />;
  if (attachment.kind === "folder") return <Folder size={14} />;
  if (attachment.kind === "file") return <File size={14} />;
  if (attachment.mimeType.includes("spreadsheetml")) return <FileSpreadsheet size={14} />;
  if (attachment.mimeType.includes("presentationml")) return <Presentation size={14} />;
  return <FileText size={14} />;
}

function attachmentFormatLabel(attachment: ImageAttachment) {
  if (attachment.kind === "image") return tr("图片", "Image");
  if (attachment.kind === "video") return tr("视频", "Video");
  if (attachment.kind === "text") return tr("文本", "Text");
  if (attachment.kind === "folder") return tr("文件夹", "Folder");
  if (attachment.kind === "file") {
    if (attachment.mimeType === "application/vnd.autodesk.fbx") return "FBX";
    return attachmentExtension(attachment).toUpperCase() || tr("文件", "File");
  }
  if (attachment.mimeType === "application/pdf") return "PDF";
  if (attachment.mimeType.includes("wordprocessingml")) return "Word";
  if (attachment.mimeType.includes("spreadsheetml")) return "Excel";
  if (attachment.mimeType.includes("presentationml")) return "PowerPoint";
  return tr("文档", "Document");
}

function attachmentExtension(attachment: ImageAttachment) {
  const dot = attachment.name.lastIndexOf(".");
  const extension = dot > 0 ? attachment.name.slice(dot + 1) : "";
  return extension.length <= 16 ? extension.toLowerCase() : "";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

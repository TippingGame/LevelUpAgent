import { ArrowDown, ArrowUp, X } from "lucide-react";
import { tr } from "../lib/i18n";
import type { MediaReferenceUrl } from "../lib/mediaReferences";
import type { ImageAttachment, VideoGenerationMode } from "../lib/types";
import { AttachmentChip } from "./AttachmentChip";
import { IconButton } from "./IconButton";

interface ReferenceOrderProps {
  onMove: (id: string, direction: -1 | 1) => void;
  mode?: VideoGenerationMode;
}

function referenceLabel(index: number, mode?: VideoGenerationMode, referenceImages = false) {
  if (referenceImages) return tr(`参考图 ${index + 1}`, `Reference Image ${index + 1}`);
  return mode === "video" ? tr(`视频 ${index + 1}`, `Video ${index + 1}`) : tr(`图 ${index + 1}`, `Image ${index + 1}`);
}

export function MediaReferenceLabel({ index, mode, referenceImages }: { index: number; mode?: VideoGenerationMode; referenceImages?: boolean }) {
  const frame = mode === "first_last" ? index === 0 ? tr("首帧", "First frame") : tr("尾帧", "Last frame")
    : mode === "image" ? tr("首帧", "First frame") : null;
  return <span className="media-reference-label"><strong>{referenceLabel(index, mode, referenceImages)}</strong>{frame && <small>{frame}</small>}</span>;
}

function ReferenceOrderButtons({ index, total, onMove, mode, referenceImages }: {
  index: number;
  total: number;
  onMove: (direction: -1 | 1) => void;
  mode?: VideoGenerationMode;
  referenceImages?: boolean;
}) {
  const label = referenceLabel(index, mode, referenceImages);
  return <>
    <IconButton label={tr(`将${label}前移`, `Move ${label} earlier`)} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={14} /></IconButton>
    <IconButton label={tr(`将${label}后移`, `Move ${label} later`)} disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown size={14} /></IconButton>
  </>;
}

export function MediaReferenceOrderHint({ mode }: { mode?: VideoGenerationMode }) {
  if (mode === "video") return null;
  return <p className="media-reference-order-hint">{mode === "first_last"
    ? tr("图 1 为首帧，图 2 为尾帧；可用箭头交换顺序。", "Image 1 is the first frame and Image 2 is the last frame; use the arrows to swap them.")
    : tr("可在提示词中引用“图 1”“图 2”；前移、后移或移除后，编号会更新。", "Refer to “Image 1”, “Image 2”, etc. in your prompt. Numbers update when you move or remove images.")}</p>;
}

export function MediaReferenceList({ attachments, mode, referenceImages, onMove, onRemove }: ReferenceOrderProps & {
  attachments: ImageAttachment[];
  referenceImages?: boolean;
  onRemove: (attachment: ImageAttachment) => void;
}) {
  return <ol className="media-reference-list" aria-label={tr("参考素材顺序", "Reference order")}>
    {attachments.map((attachment, index) => <li className="media-reference-item" key={attachment.id}>
      <MediaReferenceLabel index={index} mode={mode} referenceImages={referenceImages} />
      <AttachmentChip attachment={attachment} onRemove={() => onRemove(attachment)} />
      <div className="media-reference-actions"><ReferenceOrderButtons index={index} total={attachments.length} mode={mode} referenceImages={referenceImages} onMove={(direction) => onMove(attachment.id, direction)} /></div>
    </li>)}
  </ol>;
}

export function MediaReferenceUrlList({ references, mode, onMove, onChange, onRemove }: ReferenceOrderProps & {
  references: MediaReferenceUrl[];
  onChange: (id: string, url: string) => void;
  onRemove: (id: string) => void;
}) {
  return <ol className="media-reference-list" aria-label={tr("参考图片地址顺序", "Reference URL order")}>
    {references.map((reference, index) => <li className="media-reference-item media-reference-url-item" key={reference.id}>
      <label htmlFor={`media-reference-${reference.id}`}><MediaReferenceLabel index={index} mode={mode} /></label>
      <input id={`media-reference-${reference.id}`} type="url" required value={reference.url} placeholder="https://…" onChange={(event) => onChange(reference.id, event.target.value)} />
      <div className="media-reference-actions">
        <ReferenceOrderButtons index={index} total={references.length} mode={mode} onMove={(direction) => onMove(reference.id, direction)} />
        <IconButton label={tr(`移除${referenceLabel(index, mode)}地址`, `Remove ${referenceLabel(index, mode)} URL`)} onClick={() => onRemove(reference.id)}><X size={14} /></IconButton>
      </div>
    </li>)}
  </ol>;
}

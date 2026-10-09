import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bone, Box, BookOpen, Ellipsis, ImagePlus, Star } from "lucide-react";
import { tr } from "../lib/i18n";
import "./CreationModeSwitch.css";

type CreativeMode = "media" | "writing" | "constellation" | "spine" | "model3d";

export function CreativeStudioHeader({ mode, className = "", subtitle, context, actions, onBrandClick, brandDisabled, onMedia, onWriting, onConstellation, onSpine, onModel3d }: {
  mode: CreativeMode;
  className?: string;
  subtitle?: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  onBrandClick?: () => void;
  brandDisabled?: boolean;
  onMedia?: () => void;
  onWriting?: () => void;
  onConstellation?: () => void;
  onSpine?: () => void;
  onModel3d?: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActionsOpen(false);
      actionsRef.current?.querySelector<HTMLButtonElement>(".creative-studio-overflow")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [actionsOpen]);
  useEffect(() => setActionsOpen(false), [mode]);
  const modes = [
    { id: "media", label: tr("图片 · 视频 · 语音", "Image · Video · Speech"), Icon: ImagePlus, onClick: onMedia },
    { id: "writing", label: tr("写作", "Writing"), Icon: BookOpen, onClick: onWriting },
    { id: "constellation", label: tr("星图", "Constellation"), Icon: Star, onClick: onConstellation },
    { id: "spine", label: "Spine", Icon: Bone, onClick: onSpine },
    { id: "model3d", label: "3D", Icon: Box, onClick: onModel3d },
  ] as const;
  const Icon = modes.find((item) => item.id === mode)!.Icon;
  const brand = <><span className="creative-studio-mark"><Icon size={19} fill={mode === "constellation" ? "currentColor" : "none"} strokeWidth={1.6} /></span><span className="creative-studio-brand-text"><strong>{mode === "constellation" ? tr("星图", "Constellation") : tr("创作空间", "Creative Studio")}</strong><small>{subtitle}</small></span></>;
  return <header className={`creative-studio-header ${className}`} data-creative-mode={mode} data-tauri-drag-region>
    <div className="creative-studio-identity">
      {onBrandClick ? <button type="button" className="creative-studio-brand" onClick={onBrandClick} disabled={brandDisabled} title={tr("返回星图总览", "Back to constellation overview")} aria-label={tr("返回星图总览", "Back to constellation overview")}>{brand}</button>
        : <div className="creative-studio-brand" data-tauri-drag-region>{brand}</div>}
      {context && <div className="creative-studio-context">{context}</div>}
    </div>
    <div className="creation-mode-switch" role="tablist" aria-label={tr("创作空间", "Creative Studio")}>
      {modes.map(({ id, label, Icon: ModeIcon, onClick }) => <button type="button" key={id} role="tab" data-creative-mode={id} className={id === mode ? "active" : undefined} aria-selected={id === mode} aria-label={label} title={label} onClick={id === mode ? undefined : onClick}
        onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!direction && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(event.currentTarget) + direction + tabs.length) % tabs.length;
          tabs[index].focus();
        }}><ModeIcon size={14} strokeWidth={1.6} /><span>{label}</span></button>)}
    </div>
    <div ref={actionsRef} className={`creative-studio-actions${actionsOpen ? " actions-open" : ""}`}>
      <button type="button" className="creative-studio-overflow" title={tr("更多操作", "More actions")} aria-label={tr("更多操作", "More actions")} aria-expanded={actionsOpen} onClick={() => setActionsOpen((value) => !value)}><Ellipsis size={18} /></button>
      <div className="creative-studio-action-content">{actions}</div>
    </div>
  </header>;
}

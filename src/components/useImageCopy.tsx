import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy } from "lucide-react";
import { copyImage } from "../lib/clipboard";
import { tr } from "../lib/i18n";

export function useImageCopy(url: string | undefined) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    generation.current++;
    busy.current = false;
    setStatus("idle");
    setMenu(null);
    return () => { generation.current++; };
  }, [url]);

  useEffect(() => {
    if (status !== "copied" && status !== "error") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
    const dismiss = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [menu]);

  const copy = async () => {
    if (!url || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setStatus("copying");
    setMenu(null);
    triggerRef.current?.focus();
    try {
      await copyImage(url);
      if (generation.current === current) setStatus("copied");
    } catch {
      if (generation.current === current) setStatus("error");
    } finally {
      if (generation.current === current) busy.current = false;
    }
  };

  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 60)) });
  };
  const label = status === "copied" ? tr("已复制图片", "Image copied")
    : status === "error" ? tr("复制失败，请重试", "Copy failed, please retry")
    : status === "copying" ? tr("正在复制图片…", "Copying image…") : tr("复制图片", "Copy image");

  return {
    status, label, copy, openMenu,
    contextMenu: menu && createPortal(
      <div ref={menuRef} className="media-image-context-menu" role="menu" aria-label={tr("图片操作", "Image actions")}
        style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" disabled={status === "copying"} onClick={() => void copy()}><Copy size={15} />{tr("复制图片", "Copy image")}</button>
      </div>, document.body),
  };
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, LoaderCircle, MessageSquareText, Search, X } from "lucide-react";
import { tr } from "../lib/i18n";
import type { AgentThread } from "../lib/types";
import { IconButton } from "./IconButton";

export interface PaletteCommand {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ query, onQuery, threads, commands, busy, hasMore, onMore, onOpen, onClose }: {
  query: string;
  onQuery: (query: string) => void;
  threads: AgentThread[];
  commands: PaletteCommand[];
  busy: boolean;
  hasMore: boolean;
  onMore: () => void;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);
  const options = [
    ...commands.filter((item) => item.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
    ...threads.map((thread) => ({
      id: thread.id,
      label: thread.title,
      detail: thread.workspace,
      icon: <MessageSquareText size={16} />,
      run: () => onOpen(thread.id),
    })),
  ];
  const active = Math.min(selected, Math.max(0, options.length - 1));
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onClose();
    option.run();
  };
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => {
    dialogRef.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return <div className="dialog-backdrop" onMouseDown={onClose}>
    <div className="quick-switch-dialog" ref={dialogRef} role="dialog" aria-modal="true"
      aria-label={tr("搜索与命令", "Search and commands")} onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length));
        }
        if (event.key === "Enter" && event.target === inputRef.current && !event.nativeEvent.isComposing) {
          event.preventDefault(); choose(active);
        }
        if (event.key === "Tab") {
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? []);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="quick-switch-input">
        <Search size={18} />
        <input ref={inputRef} value={query} maxLength={256} onChange={(event) => onQuery(event.target.value)}
          placeholder={tr("搜索会话与命令", "Search conversations and commands")}
          aria-label={tr("搜索会话与命令", "Search conversations and commands")}
          role="combobox" aria-expanded="true" aria-controls="quick-switch-options"
          aria-activedescendant={options.length ? `quick-switch-option-${active}` : undefined} />
        {busy && <LoaderCircle size={16} className="spin" />}
        <IconButton label={tr("关闭", "Close")} onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div className="quick-switch-options" id="quick-switch-options" role="listbox">
        {options.map((option, index) => <button key={option.id} id={`quick-switch-option-${index}`}
          role="option" aria-selected={active === index} data-option-index={index}
          onMouseMove={() => setSelected(index)} onClick={() => choose(index)}>
          {option.icon}<span><strong>{option.label}</strong>{"detail" in option && <small>{String(option.detail ?? "")}</small>}</span>
        </button>)}
        {!options.length && !busy && <div className="sidebar-empty-search">{tr("没有匹配结果", "No matches")}</div>}
      </div>
      {hasMore && <button className="catalog-load-more" onClick={onMore} disabled={busy}><ChevronDown size={14} />{tr("加载更多会话", "Load more conversations")}</button>}
    </div>
  </div>;
}

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { BookOpen, FileText, LoaderCircle, X } from "lucide-react";
import { isDesktop, scanSkills, searchWorkspaceFiles } from "../lib/bridge";
import { composerTrigger, fileReference, matchingSkills, replaceComposerTrigger, skillReference, type ComposerTrigger } from "../lib/composerReferences";
import { tr } from "../lib/i18n";

interface Choice { id: string; title: string; description: string; reference: string; path?: string }

export function ComposerInput({ inputRef, draft, workspace, disabled, running, style, onDraftChange, onPaste, onSend, onPickFile }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  workspace?: string;
  disabled: boolean;
  running: boolean;
  style?: CSSProperties;
  onDraftChange: (value: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onSend: () => void;
  onPickFile: (path: string) => Promise<boolean>;
}) {
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const composing = useRef(false);
  const dismissed = useRef<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const close = () => { dismissed.current = currentDraft.current; setTrigger(null); };
  const detect = (value: string, caret: number) => {
    if (composing.current || dismissed.current === value) return;
    const next = composerTrigger(value, caret);
    setTrigger((previous) => previous?.kind === next?.kind && previous?.start === next?.start && previous?.query === next?.query && previous?.end === next?.end ? previous : next);
  };

  useEffect(() => {
    if (!trigger) return;
    let cancelled = false;
    setChoices([]);
    setSelected(0);
    setError("");
    setTruncated(false);
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        if (!isDesktop()) throw new Error(tr("请在桌面应用中选择 Skill 和项目文件", "Use the desktop app to select Skills and project files"));
        if (trigger.kind === "skill") {
          const skills = matchingSkills(await scanSkills(workspace), trigger.query);
          if (!cancelled) setChoices(skills.map((skill) => ({ id: skill.id, title: skill.name, description: `${skill.source} · ${skill.description}`, reference: skillReference(skill) })));
        } else {
          if (!workspace) throw new Error(tr("请先打开一个项目文件夹", "Open a project folder first"));
          if (running) throw new Error(tr("任务完成后可添加文件引用", "Add file references after the running task finishes"));
          const result = await searchWorkspaceFiles(workspace, trigger.query);
          if (!cancelled) {
            setChoices(result.files.map((file) => ({ id: file.path, title: file.name, description: file.path, reference: fileReference(file.path), path: file.path })));
            setTruncated(result.truncated);
          }
        }
      } catch (reason) { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); }
      finally { if (!cancelled) setBusy(false); }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trigger?.kind, trigger?.query, workspace, running]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!trigger) return;
    const onClick = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [Boolean(trigger)]);

  const pick = async (choice: Choice) => {
    if (!trigger || picking || busy) return;
    const before = draft;
    const replacement = replaceComposerTrigger(before, trigger, choice.reference);
    setPicking(true);
    try {
      if (choice.path && !await onPickFile(choice.path)) return;
      if (!mounted.current || currentDraft.current !== before) return;
      dismissed.current = replacement.text;
      onDraftChange(replacement.text);
      setTrigger(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(replacement.caret, replacement.caret);
      });
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setPicking(false); }
  };

  return <div className="composer-input" ref={container}>
    {trigger && <div className="composer-reference-menu">
      <div className="composer-reference-heading"><strong>{trigger.kind === "skill" ? tr("选择 Skill", "Choose a Skill") : tr("引用项目文件", "Reference a project file")}</strong><button type="button" aria-label={tr("关闭引用列表", "Close references")} onClick={close}><X size={14} /></button></div>
      <div id="composer-reference-list" className="composer-reference-list" role="listbox" aria-label={trigger.kind === "skill" ? tr("Skills", "Skills") : tr("项目文件", "Project files")} ref={list}>
        {busy || picking ? <div className="composer-reference-empty" role="status"><LoaderCircle size={15} className="spin" />{tr("正在读取…", "Loading…")}</div>
          : error ? <div className="composer-reference-empty" role="status">{error}</div>
          : !choices.length ? <div className="composer-reference-empty" role="status">{trigger.kind === "skill" ? tr("没有匹配的已启用 Skill，可在设置 → Skills 中管理", "No matching enabled Skills. Manage them in Settings → Skills.") : tr("没有匹配的项目文件", "No matching project files")}</div>
          : choices.map((choice, index) => <button type="button" role="option" id={`composer-reference-${index}`} aria-selected={index === selected} key={choice.id} onMouseDown={(event) => event.preventDefault()} onClick={() => void pick(choice)} onMouseEnter={() => setSelected(index)}>
            {trigger.kind === "skill" ? <BookOpen size={16} /> : <FileText size={16} />}<span><strong>{choice.title}</strong><small>{choice.description}</small></span>
          </button>)}
      </div>
      {truncated && <div className="composer-reference-empty">{tr("仅显示部分匹配文件", "Showing a subset of matching files")}</div>}
    </div>}
    <textarea ref={inputRef} value={draft} style={style} disabled={disabled || picking} rows={2}
      aria-label={tr("消息输入框", "Message input")}
      aria-autocomplete="list" aria-controls={trigger ? "composer-reference-list" : undefined}
      aria-expanded={Boolean(trigger)} aria-activedescendant={trigger && !busy && !picking && choices[selected] ? `composer-reference-${selected}` : undefined}
      placeholder={tr("输入消息，Ctrl+V 粘贴文件，/ 选择 Skill，@ 引用项目文件…", "Message, Ctrl+V to paste files, / for Skills, @ for project files…")}
      onChange={(event) => { dismissed.current = null; onDraftChange(event.target.value); detect(event.target.value, event.target.selectionStart); }}
      onSelect={(event) => detect(event.currentTarget.value, event.currentTarget.selectionStart)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => { composing.current = false; detect(event.currentTarget.value, event.currentTarget.selectionStart); }}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (trigger && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          if (choices.length) setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
          return;
        }
        if (trigger && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
          event.preventDefault();
          if (!busy && choices[selected]) void pick(choices[selected]);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} />
  </div>;
}

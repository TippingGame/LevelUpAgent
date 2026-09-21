import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, BookOpen, ChevronRight, FileText, Folder, LoaderCircle, Paperclip, X } from "lucide-react";
import { isDesktop, scanSkills, searchWorkspaceFiles } from "../lib/bridge";
import { composerTrigger, fileReference, matchingSkills, replaceComposerTrigger, skillReference, type ComposerTrigger } from "../lib/composerReferences";
import { tr } from "../lib/i18n";

interface ReferenceChoice { id: string; title: string; description: string; reference: string; path?: string; kind?: "file" | "folder" }
interface ResourceChoice { id: string; title: string; action: "browse" | "files" | "folders" }
type Choice = ReferenceChoice | ResourceChoice;

export function ComposerInput({ inputRef, draft, workspace, disabled, running, style, onDraftChange, onPaste, onPasteShortcut, onSend, onPickFile, onSelectResources }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  workspace?: string;
  disabled: boolean;
  running: boolean;
  style?: CSSProperties;
  onDraftChange: (value: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onPasteShortcut?: () => void;
  onSend: () => void;
  onPickFile: (path: string) => Promise<boolean>;
  onSelectResources: (directory: boolean) => Promise<boolean>;
}) {
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [choices, setChoices] = useState<ReferenceChoice[]>([]);
  const [resourceMenu, setResourceMenu] = useState(false);
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

  const close = () => { dismissed.current = currentDraft.current; setTrigger(null); setResourceMenu(false); };
  const detect = (value: string, caret: number) => {
    if (composing.current || dismissed.current === value) return;
    const next = composerTrigger(value, caret);
    if (trigger?.kind !== next?.kind || trigger?.start !== next?.start || trigger?.query !== next?.query || trigger?.end !== next?.end) {
      setResourceMenu(false);
      setSelected(0);
    }
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
          if (running) throw new Error(tr("任务完成后可添加文件引用", "Add file references after the running task finishes"));
          if (!workspace) return;
          const result = await searchWorkspaceFiles(workspace, trigger.query);
          if (!cancelled) {
            setChoices(result.files.map((file) => ({ id: file.path, title: file.name, description: file.path, reference: fileReference(file.path), path: file.path, kind: file.kind })));
            setTruncated(result.truncated);
          }
        }
      } catch (reason) { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); }
      finally { if (!cancelled) setBusy(false); }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trigger?.kind, trigger?.query, workspace, running]);

  const references = busy || picking || error ? [] : choices;
  const browse: ResourceChoice = { id: "local-resources", title: tr("添加文件或文件夹", "Add files or folders"), action: "browse" };
  const menuChoices: Choice[] = trigger?.kind === "file"
    ? resourceMenu ? [
      { id: "local-files", title: tr("选择文件", "Choose files"), action: "files" },
      { id: "local-folders", title: tr("选择文件夹", "Choose folders"), action: "folders" },
    ] : trigger.query && references.length ? [...references, browse] : [browse, ...references]
    : references;

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, busy, resourceMenu]);

  useEffect(() => {
    if (!trigger) return;
    const onClick = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [Boolean(trigger)]);

  const pick = async (choice: Choice) => {
    if (!trigger || disabled || picking) return;
    if ("action" in choice) {
      if (running) return;
      if (choice.action === "browse") { setResourceMenu(true); setSelected(0); return; }
    } else if (busy || (choice.path && running)) return;
    const before = draft;
    const replacement = "action" in choice
      ? { text: before.slice(0, trigger.start) + before.slice(trigger.end), caret: trigger.start }
      : replaceComposerTrigger(before, trigger, choice.reference);
    setPicking(true);
    try {
      if ("action" in choice) {
        if (!await onSelectResources(choice.action === "folders")) return;
      } else if (choice.path && !await onPickFile(choice.path)) return;
      if (!mounted.current || currentDraft.current !== before) return;
      dismissed.current = replacement.text;
      onDraftChange(replacement.text);
      setTrigger(null);
      setResourceMenu(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(replacement.caret, replacement.caret);
      });
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setPicking(false); }
  };

  return <div className="composer-input" ref={container}>
    {trigger && <div className="composer-reference-menu">
      <div className="composer-reference-heading">
        {resourceMenu && <button type="button" aria-label={tr("返回引用列表", "Back to references")} onMouseDown={(event) => event.preventDefault()} onClick={() => { setResourceMenu(false); setSelected(0); inputRef.current?.focus(); }}><ArrowLeft size={14} /></button>}
        <strong>{resourceMenu ? browse.title : trigger.kind === "skill" ? tr("选择 Skill", "Choose a Skill") : tr("引用文件或文件夹", "Reference a file or folder")}</strong>
        <button type="button" aria-label={tr("关闭引用列表", "Close references")} onClick={close}><X size={14} /></button>
      </div>
      <div id="composer-reference-list" className="composer-reference-list" role="listbox" aria-label={resourceMenu ? browse.title : trigger.kind === "skill" ? tr("Skills", "Skills") : tr("文件和文件夹", "Files and folders")} ref={list}>
        {menuChoices.map((choice, index) => <button type="button" role="option" id={`composer-reference-${index}`} aria-selected={index === selected} disabled={disabled || picking || ("action" in choice && running)} key={`${"action" in choice ? "action" : "reference"}:${choice.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => void pick(choice)} onMouseEnter={() => setSelected(index)}>
          {"action" in choice ? choice.action === "browse" ? <Paperclip size={16} /> : choice.action === "folders" ? <Folder size={16} /> : <FileText size={16} /> : trigger.kind === "skill" ? <BookOpen size={16} /> : choice.kind === "folder" ? <Folder size={16} /> : <FileText size={16} />}
          <span><strong>{choice.title}</strong>{"description" in choice && <small>{choice.description}</small>}</span>
          {"action" in choice && choice.action === "browse" && <ChevronRight className="composer-reference-chevron" size={14} />}
        </button>)}
        {picking || (busy && !resourceMenu) ? <div className="composer-reference-empty" role="status"><LoaderCircle size={15} className="spin" />{tr("正在读取…", "Loading…")}</div>
          : resourceMenu ? null
          : error ? <div className="composer-reference-empty" role="status">{error}</div>
          : !choices.length && (trigger.kind === "skill" || workspace) ? <div className="composer-reference-empty" role="status">{trigger.kind === "skill" ? tr("没有匹配的已启用 Skill，可在设置 → Skills 中管理", "No matching enabled Skills. Manage them in Settings → Skills.") : tr("没有匹配的项目文件", "No matching project files")}</div>
          : null}
      </div>
      {truncated && !resourceMenu && <div className="composer-reference-empty">{tr("仅显示部分匹配文件", "Showing a subset of matching files")}</div>}
    </div>}
    <textarea ref={inputRef} value={draft} style={style} disabled={disabled || picking} rows={2}
      aria-label={tr("消息输入框", "Message input")}
      aria-autocomplete="list" aria-controls={trigger ? "composer-reference-list" : undefined}
      aria-expanded={Boolean(trigger)} aria-activedescendant={trigger && !picking && menuChoices[selected] ? `composer-reference-${selected}` : undefined}
      placeholder={tr("输入消息，/ 选择 Skill，@ 添加文件或文件夹…", "Message, / for Skills, @ to add files or folders…")}
      onChange={(event) => { dismissed.current = null; onDraftChange(event.target.value); detect(event.target.value, event.target.selectionStart); }}
      onSelect={(event) => detect(event.currentTarget.value, event.currentTarget.selectionStart)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => { composing.current = false; detect(event.currentTarget.value, event.currentTarget.selectionStart); }}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert")) {
          if (!event.repeat) onPasteShortcut?.();
          return;
        }
        if (trigger && event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (resourceMenu) { setResourceMenu(false); setSelected(0); } else close();
          return;
        }
        if (trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          if (menuChoices.length) setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : menuChoices.length - 1)) % menuChoices.length);
          return;
        }
        if (trigger && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
          event.preventDefault();
          if (busy && trigger.query && !resourceMenu) return;
          if (menuChoices[selected]) void pick(menuChoices[selected]);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} />
  </div>;
}

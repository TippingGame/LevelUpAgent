import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Pause, Play, X } from "lucide-react";
import type { SpineClip, SpinePart } from "../lib/spine";
import { tr } from "../lib/i18n";
import { SpineCanvas } from "./SpineCanvas";

export function SpineRedrawReview({ parts, replacement, clip, opaque, onApply, onClose }: {
  parts: SpinePart[];
  replacement: SpinePart;
  clip?: SpineClip;
  opaque: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const original = parts.find((part) => part.id === replacement.id)!;
  const revised = useMemo(() => parts.map((part) => part.id === replacement.id ? replacement : part), [parts, replacement]);
  const [mode, setMode] = useState<"texture" | "setup" | "motion">("setup");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const reportError = useCallback((message: string) => setError(message), []);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (focus?.isConnected) focus.focus(); };
  }, []);
  useEffect(() => {
    if (!playing || mode !== "motion" || !clip) return;
    let frame = 0, previous = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      setTime((value) => (value + elapsed) % clip.duration);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, mode, clip]);
  return <div className="spine-modal-backdrop">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={tr("重绘结果审阅", "Review replacement texture")}
      className="spine-motion-dialog spine-redraw-review" onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
          if (!nodes?.length) return;
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="spine-section-title"><h2>{tr("重绘结果", "Replacement texture")} · {original.name}</h2>
        <button onClick={onClose} aria-label={tr("放弃重绘结果", "Discard replacement")}><X size={18} /></button></div>
      <p className="spine-hint">{tr("先检查贴图、装配和动作；采纳后替换贴图，骨骼与动作保持，可撤销。", "Review the texture, assembly and motion before applying. Rig and motion stay unchanged; Undo is available.")}</p>
      <div className="spine-button-row">
        {(["texture", "setup", ...(clip ? ["motion"] : [])] as const).map((value) => <button key={value} aria-pressed={mode === value}
          onClick={() => { setMode(value as typeof mode); setPlaying(false); }}>
          {value === "texture" ? tr("贴图对照", "Textures") : value === "setup" ? tr("装配对照", "Assembly") : tr("动作对照", "Motion")}
        </button>)}
      </div>
      <div className="spine-pose-review-images">
        {[false, true].map((after) => <figure key={String(after)}>
          <figcaption>{after ? tr("重绘候选", "Replacement candidate") : tr("当前工程", "Current project")}</figcaption>
          {mode === "texture" ? <img src={after ? replacement.image : original.image} alt={after ? tr("重绘贴图", "Replacement texture") : tr("原贴图", "Original texture")} />
            : <SpineCanvas parts={after ? revised : parts} clip={clip} time={time} selected="" bones={false} mesh={false} zoom={1}
              setup={mode === "setup"} disabled onSelect={() => {}} onMove={() => {}} onError={reportError} />}
        </figure>)}
      </div>
      {mode === "motion" && clip && <div className="spine-redraw-timeline">
        <button onClick={() => setPlaying((value) => !value)} aria-label={playing ? tr("暂停对照", "Pause comparison") : tr("播放对照", "Play comparison")}>
          {playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <input type="range" aria-label={tr("重绘对照时间", "Replacement comparison time")} min={0} max={clip.duration} step={0.001} value={time}
          onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} />
        <span>{time.toFixed(2)} / {clip.duration.toFixed(2)}s</span>
      </div>}
      {opaque && <p className="spine-hint">{tr("候选仍含不透明背景，请检查后再采纳或重新生成。", "The candidate still has an opaque background; inspect it before applying or regenerate.")}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="spine-motion-footer"><button onClick={onClose}>{tr("放弃结果", "Discard")}</button>
        <button disabled={!!error} onClick={onApply}><Check size={16} />{tr("采纳重绘贴图", "Apply replacement texture")}</button></div>
    </div>
  </div>;
}

import { useEffect, useState } from "react";
import { RotateCcw, WandSparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { prepareSpineSource, removeSpineSolidBackground } from "../lib/spineSource";
import { tr } from "../lib/i18n";

export function ModelReferenceEditor({ projectId, originalUrl, currentUrl, busy, onBusy, onSaved }: {
  projectId: string; originalUrl: string; currentUrl: string; busy: boolean;
  onBusy: (value: boolean) => void; onSaved: () => Promise<void>;
}) {
  const [tolerance, setTolerance] = useState(60);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => { setDraft(undefined); setError(""); }, [projectId, currentUrl]);
  async function remove() {
    onBusy(true); setError("");
    try {
      const source = await prepareSpineSource(originalUrl, "reference.png");
      const result = await removeSpineSolidBackground(source, tolerance);
      setDraft(result.image);
    } catch {
      setError(tr("未能识别纯色背景，请调整容差或使用透明 PNG。", "Could not isolate a solid background. Adjust tolerance or use a transparent PNG."));
    } finally { onBusy(false); }
  }
  async function save(restore = false) {
    if (!restore && !draft) return;
    onBusy(true); setError("");
    try {
      await invoke("model3d_reference", { projectId, image: restore ? null : draft });
      await onSaved(); setDraft(undefined);
    } catch (err) { setError(String(err)); }
    finally { onBusy(false); }
  }
  return <details className="model-reference-editor">
    <summary>{tr("参考图抠底", "Reference cutout")}</summary>
    <img className="model-cutout-preview" src={draft ?? currentUrl} alt={tr("抠底预览", "Cutout preview")} />
    <label>{tr("背景容差", "Background tolerance")} {tolerance}<input type="range" min={10} max={100} value={tolerance} disabled={busy}
      onChange={(event) => setTolerance(Number(event.target.value))}/></label>
    <div className="model-reference-actions">
      <button disabled={busy || !originalUrl} onClick={() => void remove()}><WandSparkles size={14}/>{tr("去纯色背景", "Remove solid background")}</button>
      <button disabled={busy} onClick={() => void save(true)}><RotateCcw size={14}/>{tr("还原原图", "Restore original")}</button>
      {draft && <button disabled={busy} onClick={() => void save()}>{tr("应用参考图", "Apply reference")}</button>}
      {draft && <button disabled={busy} onClick={() => setDraft(undefined)}>{tr("取消预览", "Discard preview")}</button>}
    </div>
    <small>{tr("与 Spine 使用相同的抠底。先检查预览再应用；原图保留，形状和贴图在下次生成时使用新参考图。", "Uses the same cutout as Spine. Check the preview before applying. The original is retained; new shape and texture runs use the applied reference.")}</small>
    {error && <p className="model-error" role="alert">{error}</p>}
  </details>;
}

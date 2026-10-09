import { createElement, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { tr } from "../lib/i18n";
import type { ModelJoint } from "../lib/modelWorkbench";

type ViewerElement = HTMLElement & {
  availableAnimations: string[]; animationName: string; currentTime: number; loaded: boolean; src: string;
  play: () => void; pause: () => void; jumpCameraToGoal: () => void;
  getDimensions: () => { x: number; y: number; z: number };
  getBoundingBoxCenter: () => { x: number; y: number; z: number };
};
let loading: Promise<void> | undefined;
function loadViewer() {
  return loading ??= new Promise<void>((resolve, reject) => {
    if (customElements.get("model-viewer")) { resolve(); return; }
    const script = document.createElement("script");
    script.type = "module"; script.src = "/model-viewer.min.js";
    script.onload = () => { void customElements.whenDefined("model-viewer").then(() => resolve()); };
    script.onerror = () => { loading = undefined; script.remove(); reject(new Error("3D viewer could not load")); };
    document.head.append(script);
  });
}

export function ModelViewer({ src, sourceError, joints, active = true, heading }: { src: string; sourceError?: string; joints?: Record<string, ModelJoint>; active?: boolean; heading?: ReactNode }) {
  const ref = useRef<ViewerElement>(null);
  const [ready, setReady] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [animations, setAnimations] = useState<string[]>([]), [animation, setAnimation] = useState("");
  const [playing, setPlaying] = useState(false), [rotating, setRotating] = useState(false);
  const [bounds, setBounds] = useState<{ height: number; center: { x: number; y: number; z: number } }>();
  useEffect(() => {
    let ignore = false;
    void loadViewer().then(() => { if (!ignore) setReady(true); }).catch((e) => { if (!ignore) setError(String(e)); });
    return () => { ignore = true; };
  }, []);
  useLayoutEffect(() => {
    setLoaded(false); setError(""); setPlaying(false); setAnimations([]); setBounds(undefined);
    const viewer = ref.current;
    if (!viewer || !src) return;
    let settled = false;
    const load = () => {
      if (settled) return;
      settled = true;
      setLoaded(true); setAnimations(viewer.availableAnimations); setAnimation(viewer.availableAnimations[0] ?? "");
      setBounds({ height: viewer.getDimensions().y, center: viewer.getBoundingBoxCenter() });
    };
    const fail = () => setError(tr("模型预览加载失败，可重新选择阶段或导出查看。", "Preview failed. Reselect the stage or export the model."));
    viewer.addEventListener("load", load); viewer.addEventListener("error", fail);
    // Subscribe before starting even a cached load. Also reconcile the flag
    // when React reconnects to a viewer whose load event has already fired.
    viewer.src = src;
    if (viewer.loaded) load();
    return () => { viewer.pause(); viewer.removeEventListener("load", load); viewer.removeEventListener("error", fail); };
  }, [src, ready]);
  useEffect(() => {
    const viewer = ref.current;
    if (!viewer) return;
    viewer.animationName = animation;
    if (playing && active) viewer.play(); else viewer.pause();
  }, [animation, playing, active, loaded]);
  return <div className="model-viewer-shell">
    <div className="model-viewer-stage">
    {ready && src && createElement("model-viewer", {
      // Each source owns its events, animation state and joint bounds.
      // Set src in the layout effect after the load/error listeners exist.
      key: src, ref, loading: "eager", alt: tr("三维模型预览，拖动旋转，滚轮缩放", "3D model. Drag to orbit and scroll to zoom."),
      "camera-controls": true, "auto-rotate": rotating && active || undefined,
      "shadow-intensity": "0.5", "environment-image": "neutral", "tone-mapping": "neutral", exposure: "0.85", "interaction-prompt": "none",
    }, <><div slot="progress-bar" className="model-viewer-hidden-progress" aria-hidden="true"/>{joints && bounds ? Object.entries(joints).map(([name, point]) => <button key={name} type="button" className="model-joint-hotspot"
      slot={`hotspot-${name}`} title={name} aria-label={name}
      data-position={`${bounds.center.x + point[0]*bounds.height}m ${bounds.center.y + (point[1]-.5)*bounds.height}m ${bounds.center.z + point[2]*bounds.height}m`}>
      <span>{name}</span></button>) : undefined}</>)}
    {heading && <div className="model-viewer-heading">{heading}</div>}
    {!loaded && !error && !sourceError && <div className="model-viewer-message" role="status">{tr("加载模型预览…", "Loading preview…")}</div>}
    {(error || sourceError) && <div className="model-viewer-message model-error" role="alert">{sourceError || error}</div>}
    <div className="model-viewer-controls">
      <span>{tr("拖动旋转 · 滚轮缩放", "Drag to orbit · Scroll to zoom")}</span>
      <button type="button" onClick={() => setRotating(!rotating)} aria-pressed={rotating} title={tr("自动旋转", "Auto rotate")}><RotateCcw size={14} /></button>
      {animations.length > 0 && <><select aria-label={tr("预览动作", "Animation")} value={animation} onChange={(e) => setAnimation(e.target.value)}>
        {animations.map((name) => <option key={name}>{name}</option>)}</select>
        <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? tr("暂停动作", "Pause animation") : tr("播放动作", "Play animation")}>
          {playing ? <Pause size={14}/> : <Play size={14}/>}</button></>}
    </div>
    </div>
  </div>;
}

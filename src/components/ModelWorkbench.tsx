import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Check, ChevronRight, Download, FolderOpen, HardDrive, ImagePlus, LoaderCircle, RotateCcw, Settings2, Square, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CreativeStudioHeader } from "./CreativeStudioHeader";
import { ModelViewer } from "./ModelViewer";
import { tr } from "../lib/i18n";
import { isDesktop } from "../lib/bridge";
import { MODEL_COMPONENTS, MODEL_NEEDS, defaultModelJoints, modelArtifact, modelBytes, modelProgress,
  type ModelComponent, type ModelManifest, type ModelProject, type ModelStage, type ModelStatus } from "../lib/modelWorkbench";
import "./ModelWorkbench.css";

const stages: ModelStage[] = ["shape", "texture", "rig"];
const stageName = (stage: ModelStage) => ({ shape: tr("生成形状", "Shape"), texture: tr("独立贴图", "Texture"), rig: tr("蒙皮与动画", "Rig & animate") })[stage];
const componentName = (name: ModelComponent) => ({ runtime: tr("Python 与 CUDA 运行环境", "Python & CUDA runtime"), triposg: "TripoSG", texture: "SD2.1 + MV-Adapter", blender: "Blender" })[name];
const phaseName = (phase?: string) => ({ prepare: "准备参考图", shape: "TripoSG 生成形状", export: "减面与检查", uv: "展开 UV", paint: "SD2.1 生成六视角颜色", bake: "烘焙颜色贴图", validate_texture: "检查贴图模型", rig: "蒙皮与动画", download: "下载资源", verify: "校验文件", extract: "安装资源" })[phase ?? ""] ?? phase;

export function ModelWorkbench({ active, onMedia, onWriting, onConstellation, onSpine, onPendingCountChange }: {
  active: boolean; onMedia: () => void; onWriting: () => void; onConstellation: () => void; onSpine: () => void;
  onPendingCountChange: (count: number) => void;
}) {
  const [status, setStatus] = useState<ModelStatus>(), [error, setError] = useState("");
  const [selected, setSelected] = useState(() => localStorage.getItem("levelup.model3d.project") ?? "");
  const [stage, setStage] = useState<ModelStage>("shape"), [pending, setPending] = useState(false);
  const [environment, setEnvironment] = useState(false), [checking, setChecking] = useState(false);
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [components, setComponents] = useState<ModelComponent[]>(["runtime", "triposg"]);
  const [background, setBackground] = useState("alpha"), [quality, setQuality] = useState("standard");
  const [prompt, setPrompt] = useState(""), [textureSize, setTextureSize] = useState(2048), [memoryMode, setMemoryMode] = useState("sequential");
  const [joints, setJoints] = useState(defaultModelJoints), [clips, setClips] = useState(["Idle", "Walk", "Wave"]);
  const [skeletonPreset, setSkeletonPreset] = useState("standard");
  const [showJoints, setShowJoints] = useState(true), [inputUrl, setInputUrl] = useState("");
  const [preview, setPreview] = useState<{ key: string; url: string; error?: string }>();
  const dialog = useRef<HTMLDialogElement>(null), polling = useRef(false), mounted = useRef(true);
  const operation = status?.operation, busy = pending || operation?.status === "running";
  const project = status?.projects.find((item) => item.id === selected);
  const current = project?.stages[stage];
  const previewStage = current ? stage : stage === "rig" && project?.stages.texture ? "texture" : project?.stages.shape ? "shape" : undefined;
  const previewDirectory = previewStage && project?.stages[previewStage]?.directory;
  const previewRevision = previewStage && project?.stages[previewStage]?.completedAt;
  const previewKey = JSON.stringify([project?.id, previewStage, previewDirectory, previewRevision]);
  const modelUrl = preview?.key === previewKey ? preview.url : "";
  const ready = status && MODEL_NEEDS[stage].every((name) => status.components[name]);
  const prior = stage === "shape" || Boolean(project?.stages[stage === "texture" ? "shape" : "texture"]);
  const estimate = stage === "shape" ? { vramMiB: quality === "standard" ? 10500 : 4500, ramMiB: 18000 }
    : status?.estimates[stage] ?? { vramMiB: stage === "texture" ? 6000 : 0, ramMiB: stage === "texture" ? 14000 : 4000 };
  const gpu = status?.system.gpus[0];
  const lowMemory = Boolean(status && ((stage !== "rig" && gpu && gpu.freeMiB < estimate.vramMiB) || (status.system.ramAvailableMiB != null && status.system.ramAvailableMiB < estimate.ramMiB)));

  const refresh = useCallback(async () => {
    if (!isDesktop() || polling.current) return;
    polling.current = true;
    try {
      const next = await invoke<ModelStatus>("model3d_status");
      if (mounted.current) { setStatus(next); setManifest(next.manifest); }
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { polling.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => void refresh(), active || busy ? 2500 : 10000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [active, busy, refresh]);
  useEffect(() => onPendingCountChange(busy ? 1 : 0), [busy, onPendingCountChange]);
  useEffect(() => {
    if (!selected && status?.projects.length) setSelected(status.projects[0].id);
  }, [selected, status?.projects]);
  useEffect(() => {
    if (selected) localStorage.setItem("levelup.model3d.project", selected);
    try {
      const saved = JSON.parse(localStorage.getItem(`levelup.model3d.settings.${selected}`) ?? "null");
      setJoints(saved?.joints ?? defaultModelJoints()); setPrompt(saved?.prompt ?? "");
      setSkeletonPreset(saved?.skeletonPreset ?? (saved?.joints ? "custom" : "standard"));
      setBackground(saved?.background ?? "alpha"); setQuality(saved?.quality ?? "standard");
      setTextureSize(saved?.textureSize ?? 2048); setMemoryMode(saved?.memoryMode ?? "sequential");
      setClips(saved?.clips?.length ? saved.clips : ["Idle", "Walk", "Wave"]);
    } catch { setJoints(defaultModelJoints()); setSkeletonPreset("standard"); }
  }, [selected]);
  useEffect(() => {
    let ignore = false;
    setInputUrl("");
    if (project) void modelArtifact(project.id, "input", "input.png").then((url) => { if (!ignore) setInputUrl(url); }).catch((e) => { if (!ignore) setError(String(e)); });
    return () => { ignore = true; };
  }, [project?.id]);
  useEffect(() => {
    let ignore = false;
    if (project && previewStage) void modelArtifact(project.id, previewStage, "model.glb", previewRevision)
      .then((url) => { if (!ignore) setPreview({ key: previewKey, url }); })
      .catch((e) => { if (!ignore) setPreview({ key: previewKey, url: "", error: String(e) }); });
    return () => { ignore = true; };
  }, [previewKey]);
  useEffect(() => { if (environment) dialog.current?.showModal(); else dialog.current?.close(); }, [environment]);

  async function runAction(action: string, request: unknown) {
    setPending(true); setError("");
    try { await invoke("model3d_start", { action, request }); await refresh(); }
    catch (err) { setError(String(err)); }
    finally { setPending(false); }
  }
  async function importImage() {
    setError("");
    try {
      const source = await open({ multiple: false, filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }] });
      if (!source) return;
      const created = await invoke<ModelProject>("model3d_import", { source });
      setSelected(created.id); setStage("shape"); await refresh();
    } catch (err) { setError(String(err)); }
  }
  async function generate() {
    if (!project) return;
    localStorage.setItem(`levelup.model3d.settings.${selected}`, JSON.stringify({ joints, prompt, clips, skeletonPreset, background, quality, textureSize, memoryMode }));
    await runAction("generate", { projectId: project.id, stage, settings: { background, preset: quality, prompt,
      textureSize, memoryMode, joints, clips, steps: stage === "shape" && quality === "standard" ? 50 : 30 } });
  }
  async function exportFile(name: string) {
    if (!project || !current) return;
    try {
      const extension = name.split(".").pop()!;
      const destination = await save({ defaultPath: `${project.name}-${stage}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
      if (destination) await invoke("model3d_export", { projectId: project.id, stage, name, destination });
    } catch (err) { setError(String(err)); }
  }
  async function checkManifest() {
    setChecking(true); setError("");
    try { setManifest(await invoke<ModelManifest>("model3d_manifest")); }
    catch (err) { setError(String(err)); }
    finally { setChecking(false); }
  }
  async function offlineInstall() {
    try {
      const directory = await open({ directory: true, multiple: false });
      if (directory) await runAction("install", { offlineDirectory: directory, components });
    } catch (err) { setError(String(err)); }
  }
  const downloadBytes = manifest && components.filter((name) => !status?.components[name]).reduce((sum, name) => sum+manifest.components[name].parts.reduce((bytes, part) => bytes+part.bytes, 0),0);
  const diskBytes = manifest && components.filter((name) => !status?.components[name]).reduce((sum, name) => sum+manifest.components[name].unpackedBytes,0);
  const progress = operation ? modelProgress(operation) : 0;
  const progressView = operation && <div className={`model-progress ${operation.status}`} role="status" aria-live="polite">
    <div><strong>{operation.status === "running" ? phaseName(operation.phase) ?? tr("正在准备", "Preparing") : ({ completed: tr("已完成", "Completed"), failed: tr("运行失败", "Failed"), cancelled: tr("已取消", "Cancelled"), interrupted: tr("已中断", "Interrupted") })[operation.status]}</strong>
      {operation.status === "running" && <button onClick={() => void invoke("model3d_cancel").catch((err) => setError(String(err)))}><Square size={12}/>{tr("取消", "Cancel")}</button>}</div>
    {operation.status === "running" && <progress max={1} value={progress} aria-label={tr("任务进度", "Task progress")}/>}
    <small>{operation.worker?.phase === operation.phase && operation.status === "running" ? operation.worker?.detail : operation.detail}</small>
    {operation.totalBytes != null && operation.status === "running" && <small>{modelBytes(operation.downloadedBytes)} / {modelBytes(operation.totalBytes)} · {Math.round(progress*100)}%
      {operation.bytesPerSecond ? ` · ${modelBytes(operation.bytesPerSecond)}/s · ${tr("剩余约", "About")} ${Math.ceil((operation.totalBytes-(operation.downloadedBytes ?? 0))/operation.bytesPerSecond/60)} ${tr("分钟", "min")}` : ""}</small>}
  </div>;

  return <section className="model-workbench creative-studio" hidden={!active} aria-label={tr("3D 模型工作台", "3D Model Workbench")}>
    <CreativeStudioHeader mode="model3d" subtitle={tr("从一张图，到可动的模型", "From an image to a moving model")} onMedia={onMedia} onWriting={onWriting} onConstellation={onConstellation} onSpine={onSpine}
      actions={<button onClick={() => setEnvironment(true)}><Settings2 size={14}/>{tr("环境与下载", "Setup & downloads")}</button>}/>
    <div className="model-stagebar" aria-label={tr("制作阶段", "Workflow stages")}>
      {stages.map((item, index) => <button key={item} className={stage === item ? "selected" : ""} onClick={() => setStage(item)} aria-current={stage === item ? "step" : undefined}>
        <span className="model-step-number">{project?.stages[item] ? <Check size={14}/> : index+1}</span><span><strong>{stageName(item)}</strong><small>{["TripoSG", "SD2.1 · MV-Adapter", tr("人形骨架 · 基础动作", "Humanoid · Motion clips")][index]}</small></span>{index<2 && <ChevronRight size={15}/>}</button>)}
    </div>
    <div className="model-body">
      <aside className="model-sidebar">
        <button className="model-import" disabled={busy || !isDesktop()} onClick={() => void importImage()}><ImagePlus size={18}/>{tr("添加参考图", "Add reference image")}</button>
        {status?.projects.length ? <label>{tr("作品", "Projects")}<select value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setStage("shape"); }}>
          {status.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
        {inputUrl && <div className="model-reference"><img src={inputUrl} alt={tr("参考图片", "Reference image")}/><span>{project?.name}</span></div>}
        <div className="model-settings">
          <h3>{stageName(stage)}</h3>
          {stage === "shape" && <><p>{tr("主体完整、背景干净、肢体分开的参考图更适合后续蒙皮。", "Use a complete subject, clean background and separated limbs for easier rigging.")}</p>
            <label>{tr("参考图背景", "Reference background")}<select value={background} disabled={busy} onChange={(e) => setBackground(e.target.value)}><option value="alpha">{tr("透明 PNG", "Transparent PNG")}</option><option value="white">{tr("纯白背景", "Plain white background")}</option></select></label>
            <label>{tr("生成质量", "Quality")}<select value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value)}><option value="draft">{tr("快速 · 30 步", "Draft · 30 steps")}</option><option value="standard">{tr("精细 · 50 步", "Fine · 50 steps")}</option></select></label>
            <small>{tr("默认保留 30,000 三角面，同时保存原始高精度网格。", "Keeps 30,000 triangles and saves the original detailed mesh.")}</small></>}
          {stage === "texture" && <><p>{tr("沿用形状，独立生成颜色贴图。可以反复尝试不同材质描述。", "Keep the shape and generate its color texture independently. Try different material descriptions.")}</p>
            <label>{tr("颜色与材质描述", "Colors & materials")}<textarea value={prompt} maxLength={2000} disabled={busy} onChange={(e) => setPrompt(e.target.value)} placeholder={tr("例如：蓝色布衣，棕色皮靴，柔和的手绘风格", "Blue fabric, brown leather boots, soft hand-painted style")}/></label>
            <label>{tr("贴图分辨率", "Texture size")}<select value={textureSize} disabled={busy} onChange={(e) => setTextureSize(Number(e.target.value))}><option value={1024}>1024 × 1024</option><option value={2048}>2048 × 2048</option></select></label>
            <label>{tr("显存策略", "Memory mode")}<select value={memoryMode} disabled={busy} onChange={(e) => setMemoryMode(e.target.value)}><option value="model">{tr("均衡 · 速度较快", "Balanced · Faster")}</option><option value="sequential">{tr("节省显存 · 速度较慢", "Low VRAM · Slower")}</option></select></label>
            <small>{memoryMode === "model"
              ? tr("暂时不用的模型转存到系统内存，兼顾速度和显存占用。", "Temporarily inactive models move to system RAM, balancing speed and VRAM use.")
              : tr("分批将模型的小部分载入显存，显存占用更低，但生成速度较慢。", "Small portions of the model load into VRAM as needed, reducing VRAM use at the cost of speed.")}</small>
            <small>{tr("输出颜色贴图；未生成法线、金属度或粗糙度贴图。", "Produces base color; no generated normal, metallic or roughness maps.")}</small></>}
          {stage === "rig" && <><p>{tr("适用于直立人形。先调整关节，再生成蒙皮；粘连肢体需要先修模。", "For upright humanoids. Fit joints before skinning; fused limbs need mesh repair.")}</p>
            <label>{tr("骨架起点", "Starting proportions")}<select value={skeletonPreset} disabled={busy} onChange={(e) => { setSkeletonPreset(e.target.value); setJoints(defaultModelJoints(e.target.value as "standard" | "chibi")); }}><option value="standard">{tr("常规人形", "Standard humanoid")}</option><option value="chibi">{tr("大头 Q 版", "Chibi character")}</option><option value="custom" disabled>{tr("已调整关节", "Custom joints")}</option></select></label>
            <label className="model-checkbox"><input type="checkbox" checked={showJoints} onChange={(e) => setShowJoints(e.target.checked)}/>{tr("显示关节位置", "Show joints")}</label>
            <details><summary>{tr("调整关节位置", "Adjust joint positions")}</summary><small>{tr("X 左右、Y 高度、Z 前后；数值以模型高度为单位，Y 从脚底起算。", "X horizontal, Y height from feet, Z depth; measured in model heights.")}</small>
              <div className="model-joints">{Object.entries(joints).map(([name, point]) => <label key={name}><span>{name}</span>{point.map((value, axis) => <input key={axis} type="number" step="0.01" min={-2} max={2} value={value} disabled={busy}
                aria-label={`${name} ${["X","Y","Z"][axis]}`} onChange={(e) => { setSkeletonPreset("custom"); setJoints({ ...joints, [name]: point.map((n, i) => i === axis ? Number(e.target.value) : n) as [number,number,number] }); }}/>)}</label>)}</div>
              <button disabled={busy} onClick={() => { setSkeletonPreset("standard"); setJoints(defaultModelJoints()); }}><RotateCcw size={13}/>{tr("恢复默认关节", "Reset joints")}</button></details>
            <div className="model-clips">{["Idle","Walk","Wave"].map((clip, index) => <label className="model-checkbox" key={clip}><input type="checkbox" disabled={busy} checked={clips.includes(clip)} onChange={(e) => setClips(e.target.checked ? [...clips, clip] : clips.filter((name) => name !== clip))}/>{[tr("待机", "Idle"), tr("行走", "Walk"), tr("挥手", "Wave")][index]}</label>)}</div>
            <small>{tr("基础程序动作可在 Blender 中继续编辑，生成后请检查关节变形。", "Edit these procedural clips in Blender and check joint deformation after generation.")}</small></>}
        </div>
        <div className="model-budget"><HardDrive size={14}/><div><strong>{tr("本阶段参考占用", "Estimated stage memory")}</strong><small>{tr("显存", "VRAM")} {modelBytes(estimate.vramMiB*1024**2)} · {tr("内存", "RAM")} {modelBytes(estimate.ramMiB*1024**2)}</small><small>{tr("仅作预算，实际峰值随模型与质量变化。", "Estimates only; peaks vary with input and quality.")}</small></div></div>
        {lowMemory && <p className="model-warning">{stage === "shape"
          ? tr("当前可用资源低于参考预算，建议先释放显存／内存，或选择快速档。", "Available memory is below the estimate. Free memory or select Draft quality.")
          : tr("当前可用资源低于参考预算，建议先释放显存／内存，或使用节省显存模式。", "Available memory is below the estimate. Free memory or use low VRAM mode.")}</p>}
        {!ready && <button className="model-setup-link" onClick={() => { setComponents(MODEL_NEEDS[stage]); setEnvironment(true); }}>{tr("先准备本阶段依赖", "Set up this stage")}</button>}
        <button className="model-primary" disabled={busy || !project || !ready || !prior || (stage === "rig" && !clips.length)} onClick={() => void generate()}>
          {busy ? <LoaderCircle size={16} className="model-spinner"/> : <Box size={16}/>}{current ? tr("重新生成本阶段", "Regenerate stage") : stageName(stage)}</button>
        {!prior && <small>{tr("请先完成上一个阶段。", "Complete the previous stage first.")}</small>}
        {current && stage !== "rig" && <small>{tr("重新生成成功后，后续阶段需重新制作。原文件仍保留。", "After regeneration, later stages need rebuilding. Previous files are retained.")}</small>}
      </aside>
      <main className="model-canvas">
        {previewStage ? <ModelViewer src={modelUrl} sourceError={preview?.key === previewKey ? preview.error : undefined} active={active} joints={stage === "rig" && showJoints ? joints : undefined} heading={<><div><strong>{project?.name ?? tr("新的 3D 作品", "A new 3D creation")}</strong><small>{current ? `${stageName(stage)} · ${current.validation.triangles?.toLocaleString() ?? ""} ${current.validation.triangles ? tr("三角面", "triangles") : ""} · ${modelBytes(current.validation.bytes)}` : tr("每个阶段自动保存，随时继续创作", "Every stage is saved so you can continue anytime")}</small></div>
          {current && <div className="model-export-actions"><button onClick={() => void exportFile("model.glb")}><Download size={14}/>GLB</button>{stage === "rig" && <><button onClick={() => void exportFile("character.fbx")}><Download size={14}/>FBX</button><button onClick={() => void exportFile("delivery.zip")}><Download size={14}/>{tr("完整工程", "Full project")}</button></>}</div>}</>}/> : <div className="model-empty"><div className="model-empty-icon"><Box size={56} strokeWidth={1}/></div><h2>{project ? tr("准备好，让它立体起来", "Ready to bring it into 3D") : tr("从一张参考图开始", "Start with a reference image")}</h2><p>{tr("生成形状、赋予颜色，再让角色动起来。", "Build the shape, add color, then bring your character to life.")}</p><span>TripoSG <ChevronRight size={12}/> SD2.1 <ChevronRight size={12}/> {tr("蒙皮与动画", "Rig & animate")}</span>{!project && <button disabled={!isDesktop()} onClick={() => void importImage()}><ImagePlus size={15}/>{tr("选择参考图", "Choose an image")}</button>}</div>}
        {current?.validation.resources && current.validation.resources.seconds > 0 && <p className="model-actual-resources">{tr("本次用时", "Run time")} {Math.round(current.validation.resources.seconds)}s · {tr("PyTorch 显存保留峰值", "Peak PyTorch reserved VRAM")} {modelBytes(current.validation.resources.peakTorchReservedMiB*1024**2)}</p>}
        {!isDesktop() && <p className="model-warning">{tr("请在桌面应用中使用本地 3D 生成。需要 NVIDIA GPU；Windows 使用 WSL2。", "Use the desktop app for local 3D generation. NVIDIA GPU required; Windows uses WSL2.")}</p>}
        {!environment && error && <p className="model-error" role="alert">{error}<button aria-label={tr("关闭提示", "Dismiss")} onClick={() => setError("")}><X size={14}/></button></p>}
        {!environment && progressView}
        <footer className="model-hardware"><span>{gpu?.name ?? tr("NVIDIA GPU · 等待检测", "NVIDIA GPU · Checking")}</span><span>{tr("可用显存", "Free VRAM")} {gpu ? `${modelBytes(gpu.freeMiB*1024**2)} / ${modelBytes(gpu.totalMiB*1024**2)}` : "—"}</span><span>{tr("可用内存", "Free RAM")} {status?.system.ramAvailableMiB != null ? modelBytes(status.system.ramAvailableMiB*1024**2) : "—"}</span></footer>
      </main>
    </div>
    <dialog className="model-environment" ref={dialog} onCancel={() => setEnvironment(false)} onClose={() => setEnvironment(false)}>
      <div className="model-dialog-heading"><div><h2>{tr("环境与下载", "Setup & downloads")}</h2><small>{tr("通用资源独立安装，应用升级可继续复用", "Shared resources install once and remain available after app updates")}{status?.resourceVersion ? ` · ${status.resourceVersion}` : ""}</small></div><button onClick={() => setEnvironment(false)} aria-label={tr("关闭环境设置", "Close setup")}><X size={18}/></button></div>
      <p>{tr("Windows 需要 WSL2 与已安装的 Linux Python 3，Linux 需要 x64 系统。CUDA 11.8 随运行环境安装；NVIDIA 显卡驱动由系统提供。", "Windows requires WSL2 with Linux Python 3; Linux requires x64. CUDA 11.8 installs with the runtime. The NVIDIA driver comes from your system.")}</p>
      <p>{tr("建议 12 GiB 显存、32 GiB 内存。下方内存与磁盘是生成环境实际可用的资源；WSL 内存限额也会影响生成。", "Recommended: 12 GiB VRAM and 32 GiB RAM. Reported RAM and disk belong to the generation environment; WSL limits also affect generation.")}</p>
      <div className="model-download-list">{MODEL_COMPONENTS.map((name) => <label key={name}><input type="checkbox" checked={components.includes(name)} disabled={busy || status?.components[name]} onChange={(e) => setComponents(e.target.checked ? [...components, name] : components.filter((id) => id !== name))}/><span><strong>{componentName(name)}</strong><small>{status?.components[name] ? tr("已安装并校验", "Installed & verified") : manifest ? `${tr("下载", "Download")} ${modelBytes(manifest.components[name].parts.reduce((n,p) => n+p.bytes,0))} · ${tr("安装", "Installed")} ${modelBytes(manifest.components[name].unpackedBytes)}` : tr("检查通用资源后显示大小", "Check shared resources for size")}</small>{manifest && <small>{manifest.components[name].license}</small>}</span>{status?.components[name] && <Check size={16}/>}</label>)}</div>
      {manifest && <p>{tr("所选下载", "Selected download")} {modelBytes(downloadBytes ?? undefined)} · {tr("安装后占用", "Installed size")} {modelBytes(diskBytes ?? undefined)} · {tr("安装临时空间约", "Temporary install space")} {modelBytes((downloadBytes ?? 0)*2+(diskBytes ?? 0))}</p>}
      <small className="model-runtime-path">{status?.runtimeRoot}</small>
      {status && <small>{tr("可用磁盘", "Free disk")} {modelBytes(status.system.diskFreeBytes)} · {tr("可用内存", "Free RAM")} {modelBytes((status.system.ramAvailableMiB ?? 0)*1024**2)}</small>}
      {error && <p className="model-error" role="alert">{error}</p>}
      {progressView}
      <div className="model-dialog-actions"><button disabled={checking || busy || !isDesktop()} onClick={() => void checkManifest()}><RotateCcw size={14}/>{checking ? tr("正在检查…", "Checking…") : tr("检查通用资源", "Check resources")}</button><button disabled={busy || !components.length || !isDesktop()} onClick={() => void offlineInstall()}><FolderOpen size={14}/>{tr("离线导入", "Import offline")}</button><button className="model-primary" disabled={busy || !components.length || !manifest || !isDesktop()} onClick={() => void runAction("install", { components })}><Download size={14}/>{tr("下载并安装", "Download & install")}</button></div>
    </dialog>
  </section>;
}

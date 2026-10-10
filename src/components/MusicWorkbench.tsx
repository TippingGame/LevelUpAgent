import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, LoaderCircle, Music2, RefreshCw, Settings2, Sparkles, Square, Star, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CreativeStudioHeader } from "./CreativeStudioHeader";
import { isDesktop } from "../lib/bridge";
import { tr } from "../lib/i18n";
import { loadMusicDraft, musicArtifact, musicBusy, musicBytes, musicRequest, type MusicHardware, type MusicJob, type MusicManifest, type MusicStatus } from "../lib/musicWorkbench";
import "./MusicWorkbench.css";

const presets = [
  ["温暖钢琴", "Warm piano", "Soft piano, warm ambient pads, calm and spacious, instrumental, no vocals"],
  ["轻快节奏", "Upbeat", "Upbeat lo-fi hip hop, mellow bass, soft drums, playful and relaxed, instrumental, no vocals"],
  ["游戏氛围", "Game ambience", "Fantasy game ambience, ethereal strings, gentle harp, mysterious forest, instrumental, no vocals"],
];
const statusName = (s: string) => ({ queued: tr("排队中", "Queued"), running: tr("正在生成", "Generating"), succeeded: tr("已完成", "Completed"), failed: tr("失败", "Failed"), cancelled: tr("已取消", "Cancelled"), interrupted: tr("已中断", "Interrupted") })[s] ?? s;

export function MusicWorkbench({ active, onPendingCountChange, ...navigation }: {
  active: boolean; onPendingCountChange: (n: number) => void;
  onMedia: () => void; onWriting: () => void; onConstellation: () => void; onSpine: () => void; onModel3d: () => void;
}) {
  const [status, setStatus] = useState<MusicStatus>();
  const [hardware, setHardware] = useState<MusicHardware>();
  const [params, setParams] = useState(loadMusicDraft);
  const [selectedId, setSelectedId] = useState("");
  const [audio, setAudio] = useState<{ id: string; url: string }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [environment, setEnvironment] = useState(false);
  const [checking, setChecking] = useState(false);
  const [manifest, setManifest] = useState<MusicManifest>();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [position, setPosition] = useState(0);
  const [trim, setTrim] = useState({ start: 0, end: 1, fade: 0.1 });
  const dialog = useRef<HTMLDialogElement>(null), player = useRef<HTMLAudioElement>(null);
  const polling = useRef(false), mounted = useRef(true);
  const installing = status?.operation?.status === "running";
  const jobs = status?.jobs ?? [];
  const running = jobs.filter(musicBusy);
  const selected = jobs.find(j => j.id === selectedId);
  const visible = jobs.filter(j => Boolean(j.archived) === archived && `${j.params.title} ${j.params.prompt}`.toLowerCase().includes(search.toLowerCase()));
  const gpu = hardware?.gpus[0];
  const availableRam = status?.memory.availableMiB;
  const lowMemory = (gpu != null && gpu.freeMiB < 4096) || (availableRam != null && availableRam < 8192);

  const refresh = useCallback(async () => {
    if (!isDesktop() || polling.current) return;
    polling.current = true;
    try { const next = await invoke<MusicStatus>("music_status"); if (mounted.current) setStatus(next); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { polling.current = false; }
  }, []);
  const refreshHardware = useCallback(async () => {
    if (!isDesktop()) return;
    try { const next = await invoke<MusicHardware>("music_hardware"); if (mounted.current) setHardware(next); }
    catch (e) { if (mounted.current) setError(String(e)); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => void refresh(), active || running.length || installing ? 1500 : 10000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [active, Boolean(running.length), installing, refresh]);
  useEffect(() => { if (!active && !running.length) return; void refreshHardware(); const timer = setInterval(() => void refreshHardware(), 10000); return () => clearInterval(timer); }, [active, Boolean(running.length), refreshHardware]);
  useEffect(() => onPendingCountChange(running.length + (installing ? 1 : 0)), [running.length, installing, onPendingCountChange]);
  useEffect(() => { localStorage.setItem("levelup.music.draft", JSON.stringify(params)); }, [params]);
  useEffect(() => { if (!selectedId && jobs.length) setSelectedId(jobs[0].id); }, [jobs, selectedId]);
  useEffect(() => {
    let ignore = false; setPosition(0);
    setTrim({ start: 0, end: selected?.audio?.duration ?? 1, fade: 0.1 });
    if (selected?.audio && isDesktop()) void musicArtifact(selected.id).then(url => { if (!ignore) setAudio({ id: selected.id, url }); }).catch(e => { if (!ignore) setError(String(e)); });
    return () => { ignore = true; };
  }, [selected?.id, selected?.audio?.duration]);
  useEffect(() => { if (!active) player.current?.pause(); }, [active]);
  useEffect(() => { if (environment && active) dialog.current?.showModal(); else dialog.current?.close(); }, [environment, active]);

  async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true); setError("");
    try { const result = await fn(); await refresh(); return result; } catch (e) { setError(String(e)); } finally { setPending(false); }
  }
  async function generate() {
    const job = await action(() => musicRequest<MusicJob>("generate", { ...params, title: params.title.trim() || tr("未命名灵感", "Untitled idea") }));
    if (job) { setSelectedId(job.id); setArchived(false); }
  }
  async function exportAudio() {
    if (!selected?.audio) return;
    await action(async () => { const destination = await save({ defaultPath: `${selected.params.title.replace(/[<>:"/\\|?*]/g, "_")}.wav`, filters: [{ name: "WAV", extensions: ["wav"] }] }); if (destination) await invoke("music_export", { id: selected.id, destination }); });
  }
  async function install(offline = false) {
    await action(async () => {
      const directory = offline ? await open({ directory: true, multiple: false }) : null;
      if (offline && !directory) return;
      await invoke("music_install", { offlineDirectory: directory });
    });
  }
  async function checkManifest() {
    setChecking(true); setError("");
    try { setManifest(await invoke<MusicManifest>("music_manifest")); } catch (e) { setError(String(e)); } finally { setChecking(false); }
  }
  const op = status?.operation;
  const progress = op?.totalBytes ? (op.downloadedBytes ?? 0) / op.totalBytes : op?.progress;
  const downloadSize = manifest && Object.entries(manifest.components).filter(([name]) => !(name === "runtime" ? status?.runtimeReady : status?.modelReady)).reduce((n, [, c]) => n + c.parts.reduce((b, p) => b + p.bytes, 0), 0);
  const progressView = op && <div className="music-progress" role="status" aria-live="polite">
    <div><strong>{installing ? ({ prepare: tr("准备下载", "Preparing"), download: tr("下载模型与依赖", "Downloading resources"), verify: tr("校验资源", "Verifying"), extract: tr("安装资源", "Installing") })[op.phase ?? ""] : op.status === "completed" ? tr("安装完成", "Installed") : op.status === "cancelled" ? tr("下载已取消", "Download cancelled") : tr("安装失败", "Installation failed")}</strong>
      {installing && <button onClick={() => void action(() => invoke("music_cancel_install"))}><Square size={12}/>{tr("取消下载", "Cancel download")}</button>}</div>
    {installing && <progress max={1} value={progress} aria-label={tr("下载与安装进度", "Download and installation progress")}/>}
    <small>{op.detail}</small>
    {installing && op.totalBytes != null && <small>{musicBytes(op.downloadedBytes ?? 0)} / {musicBytes(op.totalBytes)}{op.bytesPerSecond ? ` · ${musicBytes(op.bytesPerSecond)}/s · ${tr("剩余约", "About")} ${Math.ceil((op.totalBytes - (op.downloadedBytes ?? 0)) / op.bytesPerSecond / 60)} ${tr("分钟", "min")}` : ""}</small>}
  </div>;

  return <section hidden={!active} className="music-workbench creative-studio" aria-label={tr("音频工作台", "Audio workbench")}>
    <CreativeStudioHeader mode="music" {...navigation} subtitle={tr("写下灵感，听见音乐", "Turn an idea into music")} actions={<button onClick={() => setEnvironment(true)}><Settings2 size={14}/>{tr("环境与下载", "Setup & downloads")}</button>}/>
    <div className="music-body">
      <div className="music-compose">
        <div className="music-intro"><Music2 size={22}/><div><h2>{tr("创作一段音乐", "Create a piece of music")}</h2><p>{tr("描述风格、乐器和氛围，生成 4–30 秒纯音乐。", "Describe a style, instruments and mood. Create 4–30 seconds of instrumental music.")}</p></div></div>
        <label>{tr("音乐描述", "Music description")}<textarea aria-label={tr("音乐描述", "Music description")} value={params.prompt} maxLength={2000} rows={5} placeholder={tr("例如：温暖的钢琴、柔和的鼓点，适合雨天阅读的背景音乐。英文描述通常更稳定。", "Warm piano, soft drums, relaxing background music for a rainy day.")} onChange={e => setParams(p => ({ ...p, prompt: e.target.value }))}/></label>
        <div className="music-presets">{presets.map(([zh, en, prompt]) => <button key={en} onClick={() => setParams(p => ({ ...p, prompt }))}>{tr(zh, en)}</button>)}</div>
        <div className="music-fields"><label>{tr("作品名（选填）", "Title (optional)")}<input value={params.title} maxLength={80} placeholder={tr("为这段灵感起个名字", "Name this idea")} onChange={e => setParams(p => ({ ...p, title: e.target.value }))}/></label><label>{tr("时长（秒）", "Duration (s)")}<input aria-label={tr("时长（秒）", "Duration (s)")} type="number" min={4} max={30} value={params.duration} onChange={e => setParams(p => ({ ...p, duration: Number(e.target.value) }))}/></label></div>
        <details className="music-details"><summary>{tr("更多参数", "More settings")}</summary><div className="music-fields"><label>{tr("种子", "Seed")}<input aria-label={tr("种子", "Seed")} type="number" min={0} max={2147483647} value={params.seed} onChange={e => setParams(p => ({ ...p, seed: Number(e.target.value) }))}/></label><label>{tr("描述强度", "Guidance")}<input aria-label={tr("描述强度", "Guidance")} type="number" min={1} max={8} step={0.5} value={params.guidance} onChange={e => setParams(p => ({ ...p, guidance: Number(e.target.value) }))}/></label></div><small>{tr("保留种子可复用参数；更换种子可探索变化。", "Keep the seed to reuse settings, or change it for a variation.")}</small></details>
        <div className="music-resources"><strong>MusicGen Small <span>{tr("本地运行", "Local")}</span></strong><p>{tr("建议可用显存 ≥ 4 GiB、可用内存 ≥ 8 GiB；长片段可能占用更多。任务结束后释放模型。", "Recommended free VRAM ≥ 4 GiB and RAM ≥ 8 GiB; longer clips may use more. The model unloads after each job.")}</p>
          <small>{gpu ? `${gpu.name} · ${tr("可用显存", "Free VRAM")} ${musicBytes(gpu.freeMiB * 1048576)}` : hardware ? tr("未检测到 NVIDIA 显卡，将使用 CPU，生成会较慢。", "No NVIDIA GPU detected. CPU generation will be slower.") : tr("正在检测显卡…", "Checking GPU…")}</small>
          <small>{tr("可用内存", "Free RAM")} {musicBytes(availableRam == null ? null : availableRam * 1048576)} · {tr("整机实时数据", "Current system usage")}</small>
          {lowMemory && <p className="music-warning">{tr("当前可用资源偏低，建议关闭其他生成任务并先尝试 4 秒。", "Available memory is low. Close other generation tasks and try 4 seconds first.")}</p>}
          <small>{tr("CC-BY-NC-4.0 · 仅限非商业用途 · 不支持按歌词演唱", "CC-BY-NC-4.0 · Non-commercial use · No lyric-conditioned vocals")}</small>
        </div>
        {!isDesktop() ? <p className="music-warning">{tr("请在桌面应用中使用本地音频生成。", "Open the desktop app to generate local audio.")}</p> : status && !status.supported ? <p className="music-warning">{tr("本地音频生成目前支持 Windows x64。", "Local audio generation currently supports Windows x64.")}</p> : !status?.ready && <button className="music-setup" onClick={() => setEnvironment(true)}><Download size={15}/>{tr("首次使用：准备音频环境", "First use: set up audio resources")}</button>}
        <button className="music-primary" disabled={!status?.ready || pending || installing || params.prompt.trim().length < 3 || params.duration < 4 || params.duration > 30} onClick={() => void generate()}>{pending ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>} {tr("生成音乐", "Generate music")}</button>
        {running.length > 0 && <small>{tr(`${running.length} 个任务处理中 · 按顺序生成，避免同时占用显存`, `${running.length} jobs in queue · Generated one at a time`)}</small>}
        {(error || status?.serviceError) && !environment && <div className="music-error" role="alert">{error || status?.serviceError}<button onClick={() => void refresh()}>{tr("重试", "Retry")}</button></div>}
        {!environment && op?.status !== "completed" && progressView}
      </div>
      <div className="music-results">
        <div className="music-list-header"><h2>{tr("我的音频", "My audio")}</h2><span>{jobs.filter(j => j.audio && !j.archived).length}</span><button title={tr("刷新", "Refresh")} aria-label={tr("刷新", "Refresh")} onClick={() => void refresh()}><RefreshCw size={14}/></button></div>
        <div className="music-library-tools"><input aria-label={tr("搜索音频", "Search audio")} placeholder={tr("搜索作品…", "Search audio…")} value={search} onChange={e => setSearch(e.target.value)}/><label><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)}/>{tr("已归档", "Archived")}</label></div>
        <div className="music-library" aria-label={tr("音频作品列表", "Audio library")}>
          {visible.length ? visible.map(job => <button key={job.id} className={`music-track ${selectedId === job.id ? "selected" : ""}`} aria-pressed={selectedId === job.id} onClick={() => setSelectedId(job.id)}><Music2 size={17}/><span><strong>{job.params.title}{job.favorite ? " ★" : ""}</strong><small>{statusName(job.status)} · {job.audio ? `${job.audio.duration.toFixed(1)} s` : `${job.params.duration} s`}{job.parent_id ? ` · ${tr("新版本", "Version")}` : ""}</small></span>{musicBusy(job) ? <LoaderCircle size={14} className="spin"/> : <small>{new Date(job.created_at * 1000).toLocaleDateString()}</small>}</button>) : <div className="music-empty"><Music2 size={32}/><strong>{search || archived ? tr("没有符合条件的作品", "No matching audio") : tr("第一段灵感，从这里开始", "Your first idea starts here")}</strong><p>{tr("生成的音频会自动保存在本机，可随时试听和导出 WAV。", "Generated audio is saved locally. Listen and export WAV at any time.")}</p></div>}
        </div>
        {selected && <div className="music-player">
          <div className="music-player-title"><strong>{selected.params.title}</strong><small>{statusName(selected.status)}</small></div>
          {musicBusy(selected) && <div className="music-progress" role="status"><progress value={selected.progress} max={100}/><small>{selected.phase} · {selected.progress}%</small><button disabled={pending} onClick={() => void action(() => musicRequest("cancel", { id: selected.id }))}><Square size={12}/>{tr("取消生成", "Cancel generation")}</button></div>}
          {selected.error && <p className="music-error" role="alert">{selected.error}</p>}
          {selected.audio && <><svg className="music-waveform" viewBox="0 0 720 64" preserveAspectRatio="none" role="img" aria-label={tr("音频波形", "Audio waveform")}>{selected.audio.peaks.map((p, i) => <rect key={i} x={i * 720 / selected.audio!.peaks.length} y={32 - Math.max(1, p * 30)} width={Math.max(1, 720 / selected.audio!.peaks.length - 1)} height={Math.max(2, p * 60)} className={i / selected.audio!.peaks.length <= position / selected.audio!.duration ? "played" : undefined}/>)}</svg>
            <audio ref={player} key={selected.id} controls preload="metadata" src={audio?.id === selected.id ? audio.url : undefined} onTimeUpdate={e => setPosition(e.currentTarget.currentTime)} onError={() => setError(tr("音频读取失败，请刷新或重新导出。", "Audio could not be loaded. Refresh or export it again."))}/>
            <small>{selected.audio.sample_rate / 1000} kHz · WAV · {musicBytes(selected.audio.bytes)}{selected.metrics ? ` · ${selected.metrics.seconds}s · ${tr("推理显存峰值", "Inference VRAM peak")} ${selected.metrics.peak_gpu_gb} GiB` : ""}</small></>}
          <p className="music-prompt-preview">{selected.params.prompt}</p>
          <div className="music-track-actions"><button disabled={pending} onClick={() => setParams({ ...selected.params })}><RefreshCw size={13}/>{tr("复用参数", "Reuse settings")}</button>{selected.audio && <><button disabled={pending} onClick={() => void exportAudio()}><Download size={13}/>{tr("保存 WAV", "Save WAV")}</button><button disabled={pending} aria-pressed={selected.favorite} onClick={() => void action(() => musicRequest("favorite", { id: selected.id, favorite: !selected.favorite }))}><Star size={13}/>{selected.favorite ? tr("已收藏", "Saved") : tr("收藏", "Favorite")}</button></>}{!musicBusy(selected) && <button disabled={pending} onClick={() => void action(() => musicRequest("archive", { id: selected.id, archived: !selected.archived }))}>{selected.archived ? tr("恢复", "Restore") : tr("归档", "Archive")}</button>}</div>
          {selected.audio && <details className="music-details"><summary>{tr("裁剪与淡入淡出", "Trim & fade")}</summary><div className="music-trim-fields">{(["start", "end", "fade"] as const).map((key, i) => <label key={key}>{[tr("开始（秒）", "Start (s)"), tr("结束（秒）", "End (s)"), tr("淡入淡出（秒）", "Fade (s)")][i]}<input aria-label={[tr("开始（秒）", "Start (s)"), tr("结束（秒）", "End (s)"), tr("淡入淡出（秒）", "Fade (s)")][i]} type="number" min={0} max={selected.audio!.duration} step={0.1} value={trim[key]} onChange={e => setTrim(t => ({ ...t, [key]: Number(e.target.value) }))}/></label>)}</div><button disabled={pending || trim.end - trim.start < 0.1 || trim.fade > (trim.end - trim.start) / 2} onClick={() => void action(async () => { const job = await musicRequest<MusicJob>("trim", { id: selected.id, ...trim }); setSelectedId(job.id); })}>{tr("另存为新版本", "Save as new version")}</button><small>{tr("原始音频会保留。", "The original audio is preserved.")}</small></details>}
        </div>}
      </div>
    </div>
    <dialog ref={dialog} className="music-environment" onCancel={() => setEnvironment(false)} onClose={() => setEnvironment(false)} aria-labelledby="music-environment-title">
      <div className="music-dialog-header"><h2 id="music-environment-title">{tr("音频环境与下载", "Audio setup & downloads")}</h2><button aria-label={tr("关闭", "Close")} onClick={() => setEnvironment(false)}><X size={18}/></button></div>
      <p>{tr("首次下载后即可离线生成。Python、CUDA 依赖与模型独立存放，应用升级时可继续使用。", "Download once, then generate offline. Python, CUDA dependencies and models are stored separately and reused across app updates.")}</p>
      <div className="music-component"><strong>{tr("运行环境", "Runtime")}</strong><span>Python 3.10 · PyTorch 2.8 · CUDA 12.8</span><small>{status?.runtimeReady ? tr("已安装", "Installed") : tr("待下载", "Download required")}</small></div>
      <div className="music-component"><strong>MusicGen Small</strong><span>{tr("约 2.2 GiB 权重 · CC-BY-NC-4.0 非商业用途", "~2.2 GiB weights · CC-BY-NC-4.0, non-commercial")}</span><small>{status?.modelReady ? tr("已安装", "Installed") : tr("待下载", "Download required")}</small></div>
      <p>{tr("建议预留 20 GiB 磁盘空间（含临时解压）。支持断点续传和 SHA256 校验，取消后重试会复用已下载内容。", "Reserve 20 GiB of disk space including temporary extraction. Downloads resume and are verified with SHA256.")}</p>
      <small>{tr("可用磁盘", "Free disk")} {musicBytes(status?.diskFreeBytes)}{downloadSize != null ? ` · ${tr("本次下载", "Download size")} ${musicBytes(downloadSize)}` : ""}</small>
      <small className="music-storage-path">{status?.root}</small>
      <p>{tr("需要兼容 CUDA 12.8 的 NVIDIA 驱动；无可用 GPU 时使用 CPU，速度较慢。生成中若显存不足，请关闭其他 GPU 任务并缩短时长。", "A CUDA 12.8 compatible NVIDIA driver is recommended. CPU generation is slower. If GPU memory runs out, close other GPU tasks and shorten the clip.")}</p>
      <div className="music-dialog-actions"><button className="music-primary" disabled={!status?.supported || installing || pending || running.length > 0 || status?.ready} onClick={() => void install()}><Download size={14}/>{tr("下载并安装", "Download & install")}</button><button disabled={!status?.supported || installing || pending || running.length > 0} onClick={() => void install(true)}><FolderOpen size={14}/>{tr("导入离线资源", "Import offline resources")}</button><button disabled={checking || installing || !isDesktop()} onClick={() => void checkManifest()}>{checking ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>} {tr("检查下载大小", "Check download size")}</button></div>
      {progressView}{(error || status?.serviceError) && <div className="music-error" role="alert">{error || status?.serviceError}</div>}
    </dialog>
  </section>;
}

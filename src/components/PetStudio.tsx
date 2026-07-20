import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  BrainCircuit,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  PawPrint,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { IconButton } from "./IconButton";
import { getPixelAlignedPetSize, PetAvatar, PetSprite, type PetSpriteState } from "./PetSprite";
import {
  configurePetHatch,
  deleteImageAttachment,
  deletePetMemory,
  getPetRuntime,
  importHatchedPets,
  removePet,
  selectAndInstallPet,
  selectImageReferences,
  selectPet,
  setPetOverlayVisible,
  setPetScale,
} from "../lib/bridge";
import type {
  HatchEnvironment,
  ImageAttachment,
  PetActivity,
  PetDashboard,
  PetProfile,
} from "../lib/types";
import type { AppLocale } from "../lib/i18n";
import "./PetStudio.css";

export interface PetGenerationRequest {
  name: string;
  description: string;
  references: ImageAttachment[];
  environment: HatchEnvironment;
}

interface PetStudioProps {
  active: boolean;
  locale: AppLocale;
  activities: PetActivity[];
  connectionReady: boolean;
  revision: number;
  onActivePetChange: (petId: string) => void;
  onOpenConversation: (petId: string) => void;
  onGenerate: (request: PetGenerationRequest) => Promise<void>;
  onNotice: (message: string) => void;
}

type PetStageStyle = CSSProperties & Record<`--${string}`, string | number>;

export function PetStudio({
  active,
  locale,
  activities,
  connectionReady,
  revision,
  onActivePetChange,
  onOpenConversation,
  onGenerate,
  onNotice,
}: PetStudioProps) {
  const [dashboard, setDashboard] = useState<PetDashboard | null>(null);
  const [environment, setEnvironment] = useState<HatchEnvironment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<"hatch" | "memory">("hatch");
  const [petName, setPetName] = useState("");
  const [description, setDescription] = useState("");
  const [references, setReferences] = useState<ImageAttachment[]>([]);
  const scaleTimerRef = useRef<number | null>(null);
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;

  const refresh = async (scanCodexPets = false) => {
    setLoading(true);
    try {
      if (scanCodexPets) await importHatchedPets(0);
      const [runtime, hatch] = await Promise.all([getPetRuntime(), configurePetHatch()]);
      setDashboard(runtime.dashboard);
      setEnvironment(hatch);
      onActivePetChange(runtime.dashboard.activePetId);
    } catch (error) {
      onNotice(`${text("无法加载摇光残影", "Could not load Starlight Echoes")}: ${formatError(error)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void refresh(true);
  }, [active, revision]);

  useEffect(() => () => {
    if (scaleTimerRef.current !== null) window.clearTimeout(scaleTimerRef.current);
  }, []);

  const activePet = dashboard?.pets.find((pet) => pet.id === dashboard.activePetId) ?? dashboard?.pets[0];
  const spriteState = useMemo<PetSpriteState>(() => {
    if (activities.some((item) => item.state === "waiting")) return "waiting";
    if (activities.some((item) => item.state === "generating")) return "running";
    if (activities.length > 0) return "review";
    return "idle";
  }, [activities]);
  const missing = [
    ...(environment?.missing ?? []),
    ...(!connectionReady ? [{ id: "connection", detail: text("模型连接", "Model connection") }] : []),
  ];
  const canGenerate = Boolean(environment?.configured && connectionReady && description.trim());

  const activate = async (pet: PetProfile) => {
    setBusy(`select:${pet.id}`);
    try {
      const next = await selectPet(pet.id);
      setDashboard(next);
      onActivePetChange(next.activePetId);
    } catch (error) {
      onNotice(`${text("无法切换摇光残影", "Could not switch Starlight Echo")}: ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleOverlay = async () => {
    if (!dashboard) return;
    setBusy("overlay");
    try {
      setDashboard(await setPetOverlayVisible(!dashboard.overlayVisible));
    } catch (error) {
      onNotice(`${text("无法更新残影窗口", "Could not update the echo window")}: ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const importPackage = async () => {
    setBusy("import");
    try {
      const imported = await selectAndInstallPet();
      if (!imported) return;
      await refresh();
      onNotice(`${text("已导入摇光残影", "Starlight Echo imported")}: ${imported.displayName}`);
    } catch (error) {
      onNotice(`${text("无法导入摇光残影", "Could not import Starlight Echo")}: ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const removePackage = async (pet: PetProfile) => {
    const confirmed = window.confirm(text(`删除摇光残影“${pet.displayName}”？她的经验和长期记忆会保留，以便以后重新导入。`, `Remove ${pet.displayName}? This echo's XP and long-term memory will be kept for a future re-import.`));
    if (!confirmed) return;
    setBusy(`remove:${pet.id}`);
    try {
      await removePet(pet.id);
      await refresh();
    } catch (error) {
      onNotice(`${text("无法删除摇光残影", "Could not remove Starlight Echo")}: ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const resizePet = (value: number) => {
    if (!dashboard) return;
    const petId = dashboard.activePetId;
    const scale = Math.min(1.45, Math.max(0.55, value));
    setDashboard((current) => current ? { ...current, scale } : current);
    if (scaleTimerRef.current !== null) window.clearTimeout(scaleTimerRef.current);
    scaleTimerRef.current = window.setTimeout(() => {
      scaleTimerRef.current = null;
      void setPetScale(petId, scale)
        .then((next) => setDashboard((current) => current?.activePetId === petId ? next : current))
        .catch((error) => onNotice(`${text("无法保存残影大小", "Could not save echo size")}: ${formatError(error)}`));
    }, 160);
  };

  const addReferences = async () => {
    try {
      const selected = await selectImageReferences();
      setReferences((current) => [...current, ...selected].slice(0, 6));
    } catch (error) {
      onNotice(`${text("无法添加参考图", "Could not add references")}: ${formatError(error)}`);
    }
  };

  const removeReference = async (attachment: ImageAttachment) => {
    setReferences((current) => current.filter((item) => item.id !== attachment.id));
    await deleteImageAttachment(attachment.id).catch(() => undefined);
  };

  const generate = async () => {
    if (!environment || !canGenerate) return;
    setBusy("generate");
    try {
      const configuredEnvironment = await configurePetHatch();
      setEnvironment(configuredEnvironment);
      if (!configuredEnvironment.configured) {
        throw new Error(text("孵化环境仍有缺项", "The hatch setup still has missing requirements"));
      }
      await onGenerate({
        name: petName.trim(),
        description: description.trim(),
        references,
        environment: configuredEnvironment,
      });
      setPetName("");
      setDescription("");
      setReferences([]);
    } catch (error) {
      onNotice(`${text("无法启动残影孵化", "Could not start echo hatching")}: ${formatError(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const forget = async (memoryId: string) => {
    if (!dashboard) return;
    try {
      await deletePetMemory(dashboard.activePetId, memoryId);
      await refresh();
    } catch (error) {
      onNotice(`${text("无法删除记忆", "Could not remove memory")}: ${formatError(error)}`);
    }
  };

  if (!active) return null;
  if (loading && !dashboard) {
    return <main className="pet-studio pet-studio-loading"><LoaderCircle className="spin" size={24} /></main>;
  }
  if (!dashboard || !activePet) {
    return (
      <main className="pet-studio pet-studio-loading">
        <CircleAlert size={24} />
        <button className="secondary-button" type="button" onClick={() => void refresh()}>{text("重试", "Retry")}</button>
      </main>
    );
  }

  const previewScale = 0.9 + ((Math.min(1.45, Math.max(0.55, dashboard.scale)) - 0.55) / 0.9) * 0.45;
  const previewSize = getPixelAlignedPetSize(previewScale);
  const stageStyle: PetStageStyle = {
    "--pet-preview-width": `${previewSize.width}px`,
    "--pet-preview-height": `${previewSize.height}px`,
    "--pet-stage-head-offset": `${18 + previewSize.height}px`,
  };

  return (
    <main className="pet-studio">
      <header className="pet-studio-header" data-tauri-drag-region>
        <div>
          <span className="pet-studio-mark"><PawPrint size={18} /></span>
          <div><strong>{text("摇光残影", "Starlight Echoes")}</strong><small>{activePet.displayName} · Lv.{dashboard.progress.level}</small></div>
        </div>
        <div className="pet-studio-actions">
          <IconButton label={dashboard.overlayVisible ? text("隐藏桌面残影", "Hide Starlight Echo") : text("显示桌面残影", "Show Starlight Echo")} onClick={() => void toggleOverlay()} disabled={busy === "overlay"}>
            {dashboard.overlayVisible ? <Eye size={17} /> : <EyeOff size={17} />}
          </IconButton>
          <IconButton label={text("导入残影包", "Import echo package")} onClick={() => void importPackage()} disabled={busy === "import"}>
            <Upload size={17} />
          </IconButton>
          <button className="primary-button pet-chat-button" type="button" onClick={() => onOpenConversation(activePet.id)}>
            <MessageCircle size={15} />{text("残影会话", "Echo chat")}
          </button>
        </div>
      </header>

      <div className="pet-studio-body">
        <aside className="pet-roster" aria-label={text("摇光残影列表", "Starlight Echo list")}>
          <div className="pet-panel-heading"><strong>{text("残影", "Echoes")}</strong><span>{dashboard.pets.length}</span></div>
          <div className="pet-roster-list">
            {dashboard.pets.map((pet) => (
              <div className={`pet-roster-row${pet.id === activePet.id ? " active" : ""}`} key={pet.id}>
                <button type="button" onClick={() => void activate(pet)} aria-pressed={pet.id === activePet.id}>
                  <PetAvatar profile={pet} />
                  <span><strong>{pet.displayName}</strong><small>{pet.id === activePet.id ? text("正在陪伴", "Active") : pet.id}</small></span>
                  {busy === `select:${pet.id}` ? <LoaderCircle className="spin" size={14} /> : pet.id === activePet.id ? <Check size={14} /> : null}
                </button>
                {pet.removable && (
                  <IconButton label={text(`删除 ${pet.displayName}`, `Remove ${pet.displayName}`)} onClick={() => void removePackage(pet)} disabled={busy === `remove:${pet.id}`}>
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
          <button className="pet-import-row" type="button" onClick={() => void importPackage()}>
            <Plus size={15} /><span>{text("导入已有残影", "Import an echo")}</span>
          </button>
        </aside>

        <section className="pet-stage-section">
          <div className="pet-stage-toolbar">
            <div><strong>{activePet.displayName}</strong><small>{activePet.description}</small></div>
            <span className={`pet-live-status${activities.length ? " busy" : ""}`}><i />{activities.length ? text("工作中", "Working") : text("空闲", "Idle")}</span>
          </div>
          <div className="pet-stage" style={stageStyle} onDoubleClick={() => onOpenConversation(activePet.id)}>
            <div className="pet-activity-stack" aria-live="polite">
              {activities.slice(0, 4).map((activity) => (
                <article className={`pet-activity-bubble ${activity.state}`} key={activity.id}>
                  <span>{activity.state === "generating" ? <Sparkles size={14} /> : activity.state === "waiting" ? <CircleAlert size={14} /> : <LoaderCircle className="spin" size={14} />}</span>
                  <div><strong>{activity.title}</strong><small>{activity.detail}</small></div>
                </article>
              ))}
              {activities.length > 4 && <div className="pet-activity-more">+{activities.length - 4}</div>}
            </div>
            <div className="pet-sprite-stage"><PetSprite profile={activePet} state={spriteState} scale={previewScale} /></div>
          </div>
          <div className="pet-progress-band">
            <div><strong>Lv.{dashboard.progress.level}</strong><span>{dashboard.progress.currentXp} / {dashboard.progress.requiredXp} XP</span></div>
            <div className="pet-xp-track" role="progressbar" aria-valuemin={0} aria-valuemax={dashboard.progress.requiredXp} aria-valuenow={dashboard.progress.currentXp}>
              <span style={{ width: `${Math.round(dashboard.progress.progress * 100)}%` }} />
            </div>
            <small>{formatNumber(dashboard.progress.totalTokens)} Tokens · {formatNumber(dashboard.progress.requests)} {text("次请求", "requests")}</small>
            <div className="pet-scale-control" role="group" aria-label={text("调节当前残影大小", "Resize this echo")}>
              <button type="button" aria-label={text("缩小残影", "Make echo smaller")} onClick={() => resizePet(dashboard.scale - 0.05)}><ZoomOut size={13} /></button>
              <input
                type="range"
                min={55}
                max={145}
                step={5}
                value={Math.round(dashboard.scale * 100)}
                aria-label={text("残影大小", "Echo size")}
                onChange={(event) => resizePet(Number(event.target.value) / 100)}
              />
              <button type="button" aria-label={text("放大残影", "Make echo larger")} onClick={() => resizePet(dashboard.scale + 0.05)}><ZoomIn size={13} /></button>
              <output>{Math.round(dashboard.scale * 100)}%</output>
            </div>
          </div>
        </section>

        <aside className="pet-control-panel">
          <div className="pet-control-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={panel === "hatch"} className={panel === "hatch" ? "active" : ""} onClick={() => setPanel("hatch")}><Sparkles size={14} />{text("孵化", "Hatch")}</button>
            <button type="button" role="tab" aria-selected={panel === "memory"} className={panel === "memory" ? "active" : ""} onClick={() => setPanel("memory")}><BrainCircuit size={14} />{text("记忆", "Memory")}</button>
          </div>

          {panel === "hatch" ? (
            <div className="pet-hatch-panel">
              <div className="pet-hatch-status">
                <span className={missing.length === 0 ? "ready" : "needs-attention"}>{missing.length === 0 ? <Check size={15} /> : <CircleAlert size={15} />}</span>
                <div><strong>{missing.length === 0 ? text("包内孵化工具已就绪", "Built-in hatch tools ready") : text("还缺少运行条件", "A runtime requirement is missing")}</strong><small>{environment?.bundled ? text("随 LevelUpAgent 自动加载，无需指定路径", "Loaded from LevelUpAgent; no path setup needed") : text("正在校验包内工具", "Checking bundled tools")}</small></div>
              </div>
              {missing.length > 0 && (
                <div className="pet-hatch-missing">
                  {missing.map((item) => <p key={item.id}><CircleAlert size={13} /><span><strong>{requirementLabel(item.id, locale)}</strong><small>{item.detail}</small></span></p>)}
                </div>
              )}
              <label className="pet-field"><span>{text("名字", "Name")} <small>{text("可选", "Optional")}</small></span><input value={petName} maxLength={80} placeholder={text("留空自动命名", "Infer from the concept")} onChange={(event) => setPetName(event.target.value)} /></label>
              <label className="pet-field pet-brief"><span>{text("残影设定", "Echo concept")}</span><textarea value={description} maxLength={1_200} placeholder={text("外观、性格、配色和标志性细节", "Appearance, personality, palette, and signature details")} onChange={(event) => setDescription(event.target.value)} /></label>
              <div className="pet-reference-field">
                <div><span>{text("参考图", "References")}</span><IconButton label={text("添加参考图", "Add reference images")} onClick={() => void addReferences()} disabled={references.length >= 6}><ImagePlus size={14} /></IconButton></div>
                {references.length > 0 ? (
                  <div className="pet-reference-list">{references.map((attachment) => <span key={attachment.id}><ImagePlus size={12} /><b>{attachment.name}</b><button type="button" aria-label={text(`移除 ${attachment.name}`, `Remove ${attachment.name}`)} onClick={() => void removeReference(attachment)}><X size={11} /></button></span>)}</div>
                ) : <small>{text("文本设定也可以直接生成", "A text-only concept works too")}</small>}
              </div>
              <button className="primary-button pet-generate-button" type="button" disabled={!canGenerate || busy === "generate"} onClick={() => void generate()}>
                {busy === "generate" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{text("孵化并自动导入", "Hatch and auto-import")}
              </button>
            </div>
          ) : (
            <div className="pet-memory-panel">
              <div className="pet-memory-summary"><BrainCircuit size={18} /><div><strong>{text(`${activePet.displayName} 的独立长期记忆`, `${activePet.displayName}'s independent memory`)}</strong><small>{text("只属于当前残影，可单独审查和删除", "Stored only for this echo; reviewable and removable")}</small></div></div>
              {dashboard.memories.length === 0 ? (
                <div className="pet-memory-empty"><PawPrint size={24} /><span>{text("还没有长期记忆", "No long-term memories yet")}</span></div>
              ) : (
                <div className="pet-memory-list">{[...dashboard.memories].reverse().map((memory) => (
                  <article key={memory.id}><span>{memory.kind}</span><p>{memory.text}</p><IconButton label={text("删除记忆", "Remove memory")} onClick={() => void forget(memory.id)}><Trash2 size={12} /></IconButton></article>
                ))}</div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function requirementLabel(id: string, locale: AppLocale) {
  const labels: Record<string, [string, string]> = {
    hatch_skill: ["Hatch Pet Skill", "Hatch Pet skill"],
    imagegen_skill: ["图像生成 Skill", "Image generation skill"],
    python: ["Python 3", "Python 3"],
    connection: ["模型连接", "Model connection"],
    desktop: ["桌面应用", "Desktop app"],
  };
  const label = labels[id] ?? [id, id];
  return locale === "zh-CN" ? label[0] : label[1];
}

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

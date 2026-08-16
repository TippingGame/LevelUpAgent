import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  Copy,
  Image,
  Mic,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Video,
  X,
} from "lucide-react";
import { copyText } from "../lib/clipboard";
import { tr } from "../lib/i18n";
import {
  ARMOR_MODE_LEVELS,
  ARMOR_MODE_PROFILES,
  ARMOR_SKILLS,
  ARMOR_WRITING_INTENSITIES,
  ARMOR_WRITING_INTENSITY_PROFILES,
  armorModeCoverage,
  armorModeHealthChecks,
  armorModeMediaInstructions,
  armorModeMediaPrompt,
  type ArmorModeLevel,
  type ArmorSkillId,
  type ArmorSkillState,
  type ArmorWritingIntensity,
} from "../lib/armorMode";
import type { MediaKind, ProviderProtocol } from "../lib/types";

const MEDIA_KIND_OPTIONS: Array<{ id: MediaKind; labelZh: string; labelEn: string; icon: typeof Image }> = [
  { id: "image", labelZh: "图片", labelEn: "Image", icon: Image },
  { id: "video", labelZh: "视频", labelEn: "Video", icon: Video },
  { id: "audio", labelZh: "语音", labelEn: "Audio", icon: Mic },
];

export function ArmorStudio({
  armorMode,
  armorModeLevel,
  armorModeSkills,
  armorWritingIntensity,
  model,
  protocol,
  onArmorModeChange,
  onArmorModeLevelChange,
  onArmorModeSkillsChange,
  onArmorWritingIntensityChange,
  onClose,
}: {
  armorMode: boolean;
  armorModeLevel: ArmorModeLevel;
  armorModeSkills: ArmorSkillState;
  armorWritingIntensity: ArmorWritingIntensity;
  model?: string;
  protocol?: ProviderProtocol;
  onArmorModeChange: (value: boolean) => void;
  onArmorModeLevelChange: (value: ArmorModeLevel) => void;
  onArmorModeSkillsChange: (value: ArmorSkillState) => void;
  onArmorWritingIntensityChange: (value: ArmorWritingIntensity) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [mediaPrompt, setMediaPrompt] = useState("一位角色站在雨夜霓虹街道，电影感");
  const [copied, setCopied] = useState(false);
  const [healthRuns, setHealthRuns] = useState(0);
  const options = useMemo(() => ({ model, protocol, skills: armorModeSkills }), [armorModeSkills, model, protocol]);
  const coverage = useMemo(() => armorModeCoverage(armorMode, armorModeSkills), [armorMode, armorModeSkills]);
  const health = useMemo(
    () => armorModeHealthChecks(armorMode, armorModeLevel, options),
    [armorMode, armorModeLevel, options],
  );
  const compiledMediaPrompt = useMemo(
    () => armorModeMediaPrompt(armorMode, armorModeLevel, mediaKind, mediaPrompt, options),
    [armorMode, armorModeLevel, mediaKind, mediaPrompt, options],
  );
  const compiledMediaInstructions = useMemo(
    () => armorModeMediaInstructions(armorMode, armorModeLevel, mediaKind, undefined, options) ?? "",
    [armorMode, armorModeLevel, mediaKind, options],
  );

  useEffect(() => {
    dialogRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const toggleSkill = (id: ArmorSkillId) => {
    onArmorModeSkillsChange({ ...armorModeSkills, [id]: !armorModeSkills[id] });
  };

  const copyCompiledPrompt = async () => {
    try {
      await copyText([compiledMediaPrompt, compiledMediaInstructions].filter(Boolean).join("\n\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="dialog-backdrop armor-studio-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog armor-studio-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("一键破甲控制台", "Armor Mode control center")}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header armor-studio-header">
          <div>
            <strong><TerminalSquare size={19} />{tr("一键破甲控制台", "Armor Mode control center")}</strong>
            <span>{tr("原生 Skill manifest、写作强度、媒体编译与本地健康检查", "Native Skill manifest, writing intensity, media compilation, and local health checks")}</span>
          </div>
          <button className="armor-studio-close" type="button" aria-label={tr("关闭", "Close")} onClick={onClose}><X size={18} /></button>
        </div>

        <div className="armor-studio-body">
          <section className={`armor-studio-overview${armorMode ? " active" : ""}`}>
            <span className="armor-studio-status-icon">{armorMode ? <ShieldCheck size={23} /> : <ShieldAlert size={23} />}</span>
            <div>
              <strong>{armorMode ? tr("执行 Profile 已开启", "Execution profile enabled") : tr("执行 Profile 待机", "Execution profile standby")}</strong>
              <small>{armorMode
                ? tr(`${ARMOR_MODE_PROFILES[armorModeLevel].labelZh}档 · ${coverage.filter((item) => item.active).length}/${coverage.length} 表面已覆盖`, `${ARMOR_MODE_PROFILES[armorModeLevel].labelEn} · ${coverage.filter((item) => item.active).length}/${coverage.length} surfaces covered`)
                : tr("开启后才会把当前 manifest 注入 LevelUpAgent 自己的请求链路", "Enable to inject the current manifest into LevelUpAgent's own request paths")}</small>
            </div>
            <button className={`armor-studio-master-toggle${armorMode ? " active" : ""}`} type="button" aria-pressed={armorMode} onClick={() => onArmorModeChange(!armorMode)}>
              <span>{armorMode ? tr("已开启", "Enabled") : tr("开启", "Enable")}</span><i aria-hidden="true" />
            </button>
          </section>

          <section className="armor-studio-section">
            <header><span><SlidersHorizontal size={16} /><strong>{tr("执行档位", "Execution profile")}</strong></span><small>{tr("下一次请求即生效", "Applies on the next request")}</small></header>
            <div className="armor-profile-grid">
              {ARMOR_MODE_LEVELS.map((level) => {
                const profile = ARMOR_MODE_PROFILES[level];
                return (
                  <button
                    type="button"
                    key={level}
                    className={armorModeLevel === level ? "active" : ""}
                    aria-pressed={armorModeLevel === level}
                    onClick={() => onArmorModeLevelChange(level)}
                  >
                    <strong>{tr(profile.labelZh, profile.labelEn)}</strong>
                    <small>{tr(profile.descriptionZh, profile.descriptionEn)}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="armor-studio-section">
            <header><span><Activity size={16} /><strong>{tr("全功能覆盖", "Surface coverage")}</strong></span><small>{tr("只显示当前 manifest 实际启用的表面", "Shows surfaces enabled by the current manifest")}</small></header>
            <div className="armor-coverage-grid">
              {coverage.map((item) => (
                <div className={item.active ? "active" : ""} key={item.id}>
                  <span>{item.active ? <Check size={13} /> : <X size={13} />}</span>
                  <strong>{tr(item.labelZh, item.labelEn)}</strong>
                  <small>{tr(item.descriptionZh, item.descriptionEn)}</small>
                </div>
              ))}
            </div>
          </section>

          <section className="armor-studio-section armor-skill-section">
            <header><span><TerminalSquare size={16} /><strong>{tr("Armor Skill Manager", "Armor Skill Manager")}</strong></span><small>{tr(`${ARMOR_SKILLS.filter((skill) => armorModeSkills[skill.id]).length}/${ARMOR_SKILLS.length} 已启用`, `${ARMOR_SKILLS.filter((skill) => armorModeSkills[skill.id]).length}/${ARMOR_SKILLS.length} enabled`)}</small></header>
            <div className="armor-skill-list">
              {ARMOR_SKILLS.map((skill) => (
                <button
                  className={armorModeSkills[skill.id] ? "active" : ""}
                  type="button"
                  aria-pressed={armorModeSkills[skill.id]}
                  key={skill.id}
                  onClick={() => toggleSkill(skill.id)}
                >
                  <span className="armor-skill-switch"><i aria-hidden="true" /></span>
                  <span>
                    <strong>{tr(skill.labelZh, skill.labelEn)}</strong>
                    <small>{tr(skill.descriptionZh, skill.descriptionEn)}</small>
                    <em>{skill.surfaces.map((surface) => ({
                      chat: "Chat",
                      writing: "Writing",
                      image: "Image",
                      video: "Video",
                      audio: "Audio",
                      constellation: "Constellation",
                    })[surface]).join(" · ")}</em>
                  </span>
                  {armorModeSkills[skill.id] && <Check className="armor-skill-check" size={15} />}
                </button>
              ))}
            </div>
          </section>

          <section className="armor-studio-section">
            <header><span><SlidersHorizontal size={16} /><strong>{tr("写作空间强度", "Writing Studio intensity")}</strong></span><small>{tr("仅影响 WritingStudio 和星图 Writing 节点", "Only affects WritingStudio and Constellation Writing nodes")}</small></header>
            <div className="armor-writing-intensity">
              {ARMOR_WRITING_INTENSITIES.map((intensity) => {
                const profile = ARMOR_WRITING_INTENSITY_PROFILES[intensity];
                return (
                  <button
                    className={armorWritingIntensity === intensity ? "active" : ""}
                    type="button"
                    aria-pressed={armorWritingIntensity === intensity}
                    key={intensity}
                    onClick={() => onArmorWritingIntensityChange(intensity)}
                  >
                    <strong>{tr(profile.labelZh, profile.labelEn)}</strong>
                    <small>{tr(profile.descriptionZh, profile.descriptionEn)}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="armor-studio-section armor-media-compiler">
            <header><span><Image size={16} /><strong>{tr("媒体 Prompt 编译器", "Media Prompt Compiler")}</strong></span><small>{tr("本地预览，不会发起模型请求", "Local preview; does not send a model request")}</small></header>
            <div className="armor-media-kind-picker" role="tablist" aria-label={tr("媒体类型", "Media type")}>
              {MEDIA_KIND_OPTIONS.map((item) => {
                const Icon = item.icon;
                return <button key={item.id} className={mediaKind === item.id ? "active" : ""} type="button" role="tab" aria-selected={mediaKind === item.id} onClick={() => setMediaKind(item.id)}><Icon size={14} />{tr(item.labelZh, item.labelEn)}</button>;
              })}
            </div>
            <textarea value={mediaPrompt} onChange={(event) => setMediaPrompt(event.target.value)} rows={2} aria-label={tr("原始媒体提示", "Original media prompt")} />
            <div className="armor-compiled-preview">
              <div><strong>{tr("编译结果", "Compiled output")}</strong><button type="button" onClick={() => void copyCompiledPrompt()}><Copy size={13} />{copied ? tr("已复制", "Copied") : tr("复制", "Copy")}</button></div>
              <pre>{[compiledMediaPrompt, compiledMediaInstructions].filter(Boolean).join("\n\n")}</pre>
            </div>
          </section>

          <section className="armor-studio-section armor-health-section">
            <header>
              <span><ShieldCheck size={16} /><strong>{tr("一键破甲健康检查", "Armor Mode health check")}</strong></span>
              <button className="secondary-button" type="button" onClick={() => setHealthRuns((value) => value + 1)}><Activity size={14} />{tr("运行本地自检", "Run local check")}</button>
            </header>
            {healthRuns === 0 ? (
              <p>{tr("检查会编译当前 Profile、Skill Pack、写作链路、媒体链路和表面覆盖，不会伪造 provider 成功状态。", "The check compiles the current profile, Skill Pack, writing path, media path, and coverage. It does not fake a provider success state.")}</p>
            ) : (
              <div className="armor-health-list">
                {health.map((check) => (
                  <div className={check.state} key={check.id}>
                    <span>{check.state === "ready" ? <Check size={14} /> : check.state === "failed" ? <ShieldAlert size={14} /> : <X size={14} />}</span>
                    <strong>{tr(check.labelZh, check.labelEn)}</strong>
                    <small>{tr(check.detailZh, check.detailEn)}</small>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

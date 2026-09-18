import { MessageSquareText } from "lucide-react";
import type { CSSProperties } from "react";
import { chatAppearanceStyle, COMFORTABLE_CHAT_APPEARANCE, DEFAULT_CHAT_APPEARANCE, type ChatAppearance } from "../lib/chatAppearance";
import { tr } from "../lib/i18n";

export function ChatAppearanceSettings({ value, onChange }: { value: ChatAppearance; onChange: (value: ChatAppearance) => void }) {
  return <section className="general-settings-section chat-reading-settings wide">
    <div className="general-settings-heading">
      <span><MessageSquareText size={16} /><span><strong>{tr("聊天阅读", "Chat reading")}</strong></span></span>
    </div>
    <div className="chat-appearance-presets">
      <button className="secondary-button" type="button" onClick={() => onChange({ ...DEFAULT_CHAT_APPEARANCE })}>{tr("紧凑（默认）", "Compact (default)")}</button>
      <button className="secondary-button" type="button" onClick={() => onChange({ ...COMFORTABLE_CHAT_APPEARANCE })}>{tr("舒适", "Comfortable")}</button>
    </div>
    <div className="chat-appearance-controls">
      <label className="field"><span>{tr("聊天字号", "Chat font size")} <output>{value.fontSize} px</output></span>
        <input aria-label={tr("聊天字号", "Chat font size")} type="range" min="12" max="24" step="1" value={value.fontSize} onChange={(event) => onChange({ ...value, fontSize: Number(event.target.value) })} />
      </label>
      <label className="field"><span>{tr("行距", "Line height")} <output>{value.lineHeight.toFixed(2)}×</output></span>
        <input aria-label={tr("行距", "Line height")} type="range" min="1.2" max="2.2" step="0.05" value={value.lineHeight} onChange={(event) => onChange({ ...value, lineHeight: Number(event.target.value) })} />
      </label>
      <label className="field"><span>{tr("段距", "Paragraph spacing")} <output>{value.paragraphSpacing} px</output></span>
        <input aria-label={tr("段距", "Paragraph spacing")} type="range" min="0" max="24" step="1" value={value.paragraphSpacing} onChange={(event) => onChange({ ...value, paragraphSpacing: Number(event.target.value) })} />
      </label>
    </div>
    <div className="chat-appearance-preview" style={chatAppearanceStyle(value) as CSSProperties} aria-label={tr("聊天排版预览", "Chat typography preview")}>
      <div className="markdown-body">
        <p>{tr("已检查项目中的相关文件，问题出在配置没有传递到正文组件。修改后，已有消息与新回复会使用相同的阅读设置。", "I checked the project files. The settings were not reaching the message component. Existing messages and new replies now share the same reading settings.")}</p>
        <p>{tr("构建已通过，测试结果正常。", "The build and tests passed.")}</p>
      </div>
    </div>
  </section>;
}

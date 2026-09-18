export interface ChatAppearance {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearance = { fontSize: 15, lineHeight: 1.55, paragraphSpacing: 8 };
export const COMFORTABLE_CHAT_APPEARANCE: ChatAppearance = { fontSize: 16, lineHeight: 1.75, paragraphSpacing: 14 };
const STORAGE_KEY = "levelup-agent.chat-appearance.v1";

export function normalizeChatAppearance(value: unknown): ChatAppearance {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<ChatAppearance>;
  const clamp = (input: unknown, fallback: number, min: number, max: number, precision = 1) =>
    typeof input === "number" && Number.isFinite(input)
      ? Math.round(Math.min(max, Math.max(min, input)) * precision) / precision : fallback;
  return {
    fontSize: clamp(stored.fontSize, DEFAULT_CHAT_APPEARANCE.fontSize, 12, 24),
    lineHeight: clamp(stored.lineHeight, DEFAULT_CHAT_APPEARANCE.lineHeight, 1.2, 2.2, 100),
    paragraphSpacing: clamp(stored.paragraphSpacing, DEFAULT_CHAT_APPEARANCE.paragraphSpacing, 0, 24),
  };
}

export function loadChatAppearance(): ChatAppearance {
  try { return normalizeChatAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")); }
  catch { return { ...DEFAULT_CHAT_APPEARANCE }; }
}

export function saveChatAppearance(settings: ChatAppearance) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeChatAppearance(settings)));
}

export function chatAppearanceStyle(settings: ChatAppearance) {
  return {
    "--chat-font-size": `${settings.fontSize}px`,
    "--chat-line-height": String(settings.lineHeight),
    "--chat-paragraph-spacing": `${settings.paragraphSpacing}px`,
  };
}

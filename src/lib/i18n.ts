export type AppLocale = "zh-CN" | "en-US";

const STORAGE_KEY = "levelup-agent-locale";

function detectLocale(): AppLocale {
  if (typeof window === "undefined") return "zh-CN";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en-US") return saved;
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

let currentLocale = detectLocale();

export function getAppLocale(): AppLocale {
  return currentLocale;
}

export function setAppLocale(locale: AppLocale) {
  currentLocale = locale;
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, locale);
}

export function tr(chinese: string, english: string): string {
  return currentLocale === "zh-CN" ? chinese : english;
}

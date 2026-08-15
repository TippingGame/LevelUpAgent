import type { AppLocale } from "./i18n";
import type { ImageAttachment } from "./types";

export const THEME_GENERATION_BOOTSTRAP_MARKER = "[LEVELUP_THEME_GENERATION_BOOTSTRAP_COMPLETE]";
export const THEME_GENERATION_TARGET_MARKER = "[LEVELUP_THEME_GENERATION_TARGET]";

export type ThemeGenerationAppearance = "auto" | "light" | "dark";
export type ThemeGenerationStyle = "auto" | "minimal" | "glass" | "retro" | "futuristic" | "editorial" | "playful";
export type ThemeGenerationDensity = "compact" | "comfortable" | "spacious";
export type ThemeGenerationContrast = "soft" | "balanced" | "high";
export type ThemeGenerationCorners = "sharp" | "balanced" | "rounded";
export type ThemeGenerationSurfaceStyle = "flat" | "glass" | "outlined" | "floating";
export type ThemeGenerationControlStyle = "solid" | "soft" | "outline" | "glow";
export type ThemeGenerationMessageStyle = "plain" | "bubble" | "card";
export type ThemeGenerationSidebarStyle = "solid" | "glass" | "gradient";
export type ThemeGenerationComposerStyle = "minimal" | "panel" | "floating";
export type ThemeGenerationDecoration = "restrained" | "balanced" | "rich";
export type ThemeGenerationBackgroundMode = "css" | "ai";
export type ThemeGenerationBackgroundArtStyle = "auto" | "illustration" | "cinematic" | "abstract" | "pattern";
export type ThemeGenerationBackgroundFit = "cover" | "contain" | "tile";
export type ThemeGenerationBackgroundFocus = "left" | "center" | "right";
export type ThemeGenerationBackgroundReadability = "soft" | "balanced" | "strong";

export interface ThemeGenerationPreferences {
  appearance: ThemeGenerationAppearance;
  style: ThemeGenerationStyle;
  density: ThemeGenerationDensity;
  contrast: ThemeGenerationContrast;
  corners: ThemeGenerationCorners;
  accentColor: string;
  surfaceStyle: ThemeGenerationSurfaceStyle;
  controlStyle: ThemeGenerationControlStyle;
  messageStyle: ThemeGenerationMessageStyle;
  sidebarStyle: ThemeGenerationSidebarStyle;
  composerStyle: ThemeGenerationComposerStyle;
  decoration: ThemeGenerationDecoration;
  backgroundMode: ThemeGenerationBackgroundMode;
  backgroundArtStyle: ThemeGenerationBackgroundArtStyle;
  backgroundFit: ThemeGenerationBackgroundFit;
  backgroundFocus: ThemeGenerationBackgroundFocus;
  backgroundReadability: ThemeGenerationBackgroundReadability;
  backgroundBrief: string;
}

export interface ThemeGenerationRequest extends ThemeGenerationPreferences {
  brief: string;
  references: ImageAttachment[];
  /** Host-generated once before Harness starts; the model may inspect but must not recreate it. */
  generatedBackground?: ImageAttachment;
}

export interface ThemeGenerationJob {
  threadId: string;
  sourcePath: string;
  phase: "preparing" | "starting" | "running";
}

export interface ThemeGenerationActivity {
  running: boolean;
  pendingApproval: boolean;
  ownsOperation: boolean;
}

export function themeGenerationReadyForImport(
  job: ThemeGenerationJob,
  activity: ThemeGenerationActivity,
) {
  return job.phase === "running"
    && !activity.running
    && !activity.pendingApproval
    && !activity.ownsOperation;
}

export function themeGenerationAttachmentIds(request: ThemeGenerationRequest) {
  return [...new Set(themeGenerationAttachments(request)
    .map((attachment) => attachment.id.trim())
    .filter(Boolean))]
    .slice(0, 7);
}

export function themeGenerationAttachments(request: ThemeGenerationRequest) {
  const attachments = request.generatedBackground
    ? [...request.references, request.generatedBackground]
    : request.references;
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const id = attachment.id.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 7);
}

export function themeGenerationBootstrap(guidance: string, relativePath: string, locale: AppLocale) {
  const instructions = guidance.trim();
  return [
    THEME_GENERATION_BOOTSTRAP_MARKER,
    `${THEME_GENERATION_TARGET_MARKER} ${relativePath}`,
    locale === "zh-CN"
      ? "这是 LevelUpAgent 为本次主题生成一次性加载的内置规范及其布局参考。后续轮次直接使用这些内容，不要调用任何 Skill 读取工具，不要在临时工作区查找 Skill 文件，也不要执行规范中提到的源码仓库验证脚本；应用会在自动导入时执行最终校验。"
      : "LevelUpAgent has loaded the packaged theme instructions and layout reference exactly once for this generation task. Use this attached content in later turns. Do not call any Skill-reading tool, search the temporary workspace for Skill files, or run source-repository validator scripts mentioned by the generic workflow; the app performs final validation during automatic import.",
    instructions,
  ].filter(Boolean).join("\n\n");
}

export function themeGenerationBootstrapAcknowledgement(locale: AppLocale) {
  return locale === "zh-CN"
    ? "主题生成规范和布局参考已经加载。应用需要的图片素材也会预先准备好；我只会直接写入目标主题包，不再读取 Skill，也不会生成新的图片。"
    : "The theme instructions and layout reference are loaded. The app will also prepare any requested image asset in advance. I will only write the target theme package, without rereading the Skill or generating new images.";
}

export function themeGenerationThreadTitle(request: ThemeGenerationRequest, locale: AppLocale) {
  const base = locale === "zh-CN" ? "生成主题" : "Generate theme";
  const detail = request.brief.trim().replace(/\s+/g, " ").slice(0, 32);
  return detail ? `${base} · ${detail}` : base;
}

export function themeGenerationPrompt(relativePath: string, options: ThemeGenerationRequest, locale: AppLocale) {
  const request = options.brief.trim().slice(0, 2_000) || (locale === "zh-CN"
    ? "请基于当前 LevelUpAgent 界面生成一套精致、易读、适合长时间工作的标准视觉主题。"
    : "Create a polished, readable standard visual theme for the current LevelUpAgent interface, optimized for long work sessions.");
  const referenceCount = options.references.length;
  const hasGeneratedBackground = Boolean(options.generatedBackground);
  const preferences = themePreferenceSummary(options, locale);
  const referenceGuidance = locale === "zh-CN"
    ? referenceCount > 0
      ? `本条消息附带 ${referenceCount} 张参考图。请分析并抽象提取其中的配色关系、信息层级、材质、形状语言、间距和视觉节奏；不要照搬品牌标识、人物身份、可识别文字或其他不属于界面主题的内容。参考图与文字冲突时，以用户文字要求为准。`
      : "本条消息未附带参考图，请根据文字要求和以下视觉参数独立设计。"
    : referenceCount > 0
      ? `This message includes ${referenceCount} reference image${referenceCount === 1 ? "" : "s"}. Analyze and abstract their palette relationships, hierarchy, material, shape language, spacing, and visual rhythm. Do not copy branding, personal identity, recognizable text, or content unrelated to an interface theme. When an image conflicts with the written brief, follow the written brief.`
      : "No reference images are attached; design from the written brief and visual parameters below.";
  const backgroundGuidance = locale === "zh-CN"
    ? hasGeneratedBackground
      ? "应用已经按用户选择单次生成了最终会话背景，并将它作为本条消息最后一张图片附件提供。它会由宿主安全内嵌并强制应用到 .conversation-stage；不要重新生成、复制为 data URL 或在 CSS 中引用本地路径。请从这张成品背景提取配色，为消息、输入区和浮层设置足够的不透明度、阴影与边界，保证正文可读；不要用 CSS 覆盖掉宿主背景。"
      : "本次不使用 AI 成品背景。请根据“会话背景”参数，用纯 CSS 渐变、纹理、光晕或内嵌 SVG 营造背景，并确保内容区域可读。"
    : hasGeneratedBackground
      ? "The app generated the final conversation background exactly once and attached it as the last image on this message. The host will safely embed it and force it onto .conversation-stage. Do not regenerate it, copy it into a data URL, or reference a local path from CSS. Derive the control palette from the finished background and give messages, the composer, and overlays enough opacity, shadow, and edge contrast for readability. Do not override the host background."
      : "No finished AI background is used. Build the requested conversation atmosphere with CSS gradients, texture, glow, or an embedded SVG, while preserving content readability.";
  const controlCoverage = locale === "zh-CN"
    ? "这不是只换主色的任务。必须为标准布局建立完整、协调的视觉系统，并实际覆盖：① .app-shell、.sidebar、.sidebar-header、.project-row、.thread-row；② .topbar、.model-pill、.model-menu、.thread-menu-popover；③ .conversation-stage、.message、.message-avatar、.markdown-body、.tool-call；④ .composer-wrap、.composer、.composer-toolbar、.mode-switch 和 .permission-*；⑤ .inspector、.inspector-tabs、.dialog、.field、button、input、textarea、select；⑥ hover、focus-visible、active、selected、disabled 状态、代码块与滚动条。统一定义画布、侧栏、表面、面板、正文、弱化文字、边线、强调色、阴影和圆角变量，避免未覆盖控件落回默认暖色外观。"
    : "This is not merely an accent-color swap. Build a complete, coherent visual system for the standard layout and actually cover: (1) .app-shell, .sidebar, .sidebar-header, .project-row, and .thread-row; (2) .topbar, .model-pill, .model-menu, and .thread-menu-popover; (3) .conversation-stage, .message, .message-avatar, .markdown-body, and .tool-call; (4) .composer-wrap, .composer, .composer-toolbar, .mode-switch, and .permission-*; (5) .inspector, .inspector-tabs, .dialog, .field, button, input, textarea, and select; and (6) hover, focus-visible, active, selected, disabled states, code blocks, and scrollbars. Define a consistent set of canvas, sidebar, surface, panel, text, muted text, line, accent, shadow, and radius variables so uncovered controls do not fall back to the warm default appearance.";
  if (locale === "zh-CN") {
    return [
      "请在当前工作区完成一次“生成主题”任务。",
      "用户的视觉要求：" + request,
      "用户选择的视觉参数：" + preferences,
      referenceGuidance,
      backgroundGuidance,
      "所有图片附件都只是已经准备好的视觉输入。不得调用图片、视频或音频生成工具，不得重新生成附件；除宿主准备的会话背景外，优先使用颜色、渐变、阴影、边框、排版和安全内嵌 SVG 表达主题。",
      controlCoverage,
      "主题规范和布局参考已由应用在本会话启动时一次性附加，直接使用已经提供的内容，不要再次读取 Skill，也不要尝试从临时工作区查找额外的源码规范文档。只创建本任务的目标文件，不要修改 LevelUpAgent 源码、Provider 设置、API Key、会话数据库或其他无关文件。",
      "输出目录已由应用安全创建。不要先浏览或读取目标目录和目标文件，必须直接使用 write_file 写出一个 UTF-8 JSON 主题包到：" + relativePath,
      "主题包必须是一个扁平的顶层 JSON 对象，不能把字段嵌套在 manifest 中。以下 7 个字段全部必填，字段名和类型必须完全一致：\n{\n  \"schemaVersion\": 1,\n  \"id\": \"theme-id\",\n  \"name\": \"Theme Name\",\n  \"version\": \"1.0.0\",\n  \"author\": \"LevelUpAgent\",\n  \"description\": \"Theme description\",\n  \"css\": \"html[data-levelup-theme=\\\"theme-id\\\"] { /* scoped theme CSS */ }\"\n}",
      "css 必须是合法的 JSON 字符串。最稳妥的方式是输出单行 CSS；如果需要多行，字符串内部的换行、回车和制表符必须分别写成 JSON 转义 \\n、\\r 和 \\t，绝不能在开始和结束双引号之间直接插入物理换行。",
      "本任务固定使用 schemaVersion 1 和标准布局，不要添加 layout 或 layoutFile。schemaVersion 1 仍允许通过 CSS 深度定制全部现有控件，只是不重排 DOM。主题必须满足现有校验器：CSS 全部使用 html[data-levelup-theme=\"主题ID\"] 作用域，不得包含 JavaScript、@import、远程资源或未内嵌的图片；素材必须使用 data URL；SVG data URL 的标准命名空间必须写成 xmlns='http%3A//www.w3.org/2000/svg'（xlink 同样编码冒号），CSS 中不能出现字面量 http: 或 https:；不能引入可执行代码、凭据或远程网络依赖。",
      "完成前检查 JSON、主题 ID、作用域和文件路径。不要只把代码放在回复中，必须先写入目标文件。目标第一次通过应用校验后，Harness 会立即结束并自动导入；不要继续覆写或尝试改进同一文件。",
    ].join("\n\n");
  }
  return [
    "Complete a “generate theme” task in the current workspace.",
    "Visual brief: " + request,
    "Selected visual parameters: " + preferences,
    referenceGuidance,
    backgroundGuidance,
    "Every image attachment is already-prepared visual input. Do not call image, video, or audio generation tools and do not regenerate an attachment. Apart from the host-prepared conversation background, express the theme with CSS colors, gradients, shadows, borders, typography, spacing, and safe embedded SVG.",
    controlCoverage,
    "The app attached the authoritative theme instructions and layout reference once when this conversation started. Use that attached content directly; do not read the Skill again or search the temporary workspace for source-repository documentation. Create only the target file for this task. Do not modify LevelUpAgent source code, provider settings, API keys, conversation databases, or unrelated files.",
    "The app has safely created the output directory. Do not list or read the target directory or target file first. Use write_file directly to create a UTF-8 JSON theme package at: " + relativePath,
    "The package must be one flat top-level JSON object; do not nest these fields under manifest. All seven fields below are required, with these exact names and types:\n{\n  \"schemaVersion\": 1,\n  \"id\": \"theme-id\",\n  \"name\": \"Theme Name\",\n  \"version\": \"1.0.0\",\n  \"author\": \"LevelUpAgent\",\n  \"description\": \"Theme description\",\n  \"css\": \"html[data-levelup-theme=\\\"theme-id\\\"] { /* scoped theme CSS */ }\"\n}",
    "The css value must be a valid JSON string. A single-line CSS value is safest. If it must span lines, represent newline, carriage return, and tab inside the string with the JSON escapes \\n, \\r, and \\t; never place a physical line break between the opening and closing JSON quotes.",
    "This task must use schemaVersion 1 with the standard layout; do not add layout or layoutFile. Schema version 1 still permits deep CSS customization of every existing control—it only keeps the DOM arrangement unchanged. Follow the existing validator: scope every CSS rule under html[data-levelup-theme=\"THEME_ID\"], and do not use JavaScript, @import, remote resources, or unresolved image URLs. Embed assets as data URLs. In SVG data URLs, write the standard namespace as xmlns='http%3A//www.w3.org/2000/svg' (and percent-encode the xlink namespace colon too), so literal http: or https: never appears in CSS. Do not add executable code, credentials, or network dependencies.",
    "Validate the JSON, theme ID, scope, and paths before finishing. Do not only paste code in the response: write the target file first. As soon as the target passes application validation, Harness will finish and import it automatically; do not rewrite or keep refining the same file afterward.",
  ].join("\n\n");
}

export function themeGenerationBackgroundPrompt(options: ThemeGenerationRequest, locale: AppLocale) {
  const request = options.brief.trim().slice(0, 2_000);
  const background = options.backgroundBrief.trim().slice(0, 1_000);
  const artStyle = locale === "zh-CN"
    ? zhPreference(options.backgroundArtStyle, { auto: "自动判断", illustration: "精致插画", cinematic: "电影感场景", abstract: "抽象艺术", pattern: "图案纹理" })
    : options.backgroundArtStyle;
  const focus = locale === "zh-CN"
    ? zhPreference(options.backgroundFocus, { left: "左侧", center: "中央", right: "右侧" })
    : options.backgroundFocus;
  const references = options.references.length > 0
    ? locale === "zh-CN"
      ? `使用随请求提供的 ${Math.min(options.references.length, 3)} 张参考图来提取配色、光影、材质和构图语言，但不要复制水印、可识别文字或界面控件。`
      : `Use the ${Math.min(options.references.length, 3)} supplied reference image(s) for palette, lighting, material, and composition language, without copying watermarks, legible text, or interface chrome.`
    : locale === "zh-CN"
      ? "没有参考图，请根据文字设定独立完成视觉设计。"
      : "No reference image is supplied; design directly from the written direction.";
  if (locale === "zh-CN") {
    return [
      "生成一张 LevelUpAgent 会话窗口使用的最终宽幅背景图，只生成一个完整画面。",
      `整体主题设定：${request || "精致、易读、适合长时间工作的 Agent 工作空间"}`,
      `背景画面描述：${background || "根据整体设定创作一张有层次但不过度抢夺正文注意力的环境背景"}`,
      `艺术风格：${artStyle}；视觉焦点放在${focus}；适配方式=${options.backgroundFit}；整体明暗=${options.appearance}。`,
      references,
      "这是应用内容层背后的纯背景艺术，不要绘制聊天气泡、输入框、按钮、侧栏、窗口边框或任何 UI 截图；不要添加水印、Logo 或可识别文字。可以在用户明确要求时使用人物、场景和象征性装饰元素。保留足够的低细节与低对比区域，让覆盖其上的正文、卡片和工具调用保持清晰。输出横向 3:2 构图。",
    ].join("\n\n");
  }
  return [
    "Generate exactly one finished wide background artwork for the LevelUpAgent conversation window.",
    `Overall theme direction: ${request || "a polished, readable agent workspace suitable for long sessions"}`,
    `Background art direction: ${background || "derive a layered environmental background that supports rather than competes with written content"}`,
    `Art style: ${artStyle}; visual focus: ${focus}; fit=${options.backgroundFit}; appearance=${options.appearance}.`,
    references,
    "This is pure background art behind application content. Do not draw chat bubbles, composers, buttons, sidebars, window frames, or any UI screenshot. Do not add watermarks, logos, or legible text. Characters, scenery, and symbolic decoration are allowed when the user explicitly asks for them. Preserve sufficiently quiet, low-contrast regions so overlaid text, cards, and tool calls remain readable. Use a landscape 3:2 composition.",
  ].join("\n\n");
}

function themePreferenceSummary(options: ThemeGenerationPreferences, locale: AppLocale) {
  const accentColor = /^#[0-9a-f]{6}$/i.test(options.accentColor.trim())
    ? options.accentColor.trim().toUpperCase()
    : locale === "zh-CN" ? "自动" : "automatic";
  const backgroundBrief = options.backgroundBrief.trim().replace(/\s+/g, " ").slice(0, 1_000);
  if (locale === "zh-CN") {
    return [
      `明暗模式=${zhPreference(options.appearance, { auto: "自动", light: "浅色", dark: "深色" })}`,
      `视觉风格=${zhPreference(options.style, { auto: "自动", minimal: "极简", glass: "玻璃拟态", retro: "复古", futuristic: "未来科技", editorial: "杂志编辑", playful: "活泼" })}`,
      `界面密度=${zhPreference(options.density, { compact: "紧凑", comfortable: "舒适", spacious: "宽松" })}`,
      `对比度=${zhPreference(options.contrast, { soft: "柔和", balanced: "均衡", high: "高对比" })}`,
      `圆角=${zhPreference(options.corners, { sharp: "利落", balanced: "适中", rounded: "圆润" })}`,
      `主色=${accentColor}`,
      `表面=${zhPreference(options.surfaceStyle, { flat: "平面", glass: "玻璃", outlined: "描边", floating: "悬浮" })}`,
      `控件=${zhPreference(options.controlStyle, { solid: "实心", soft: "柔和", outline: "描边", glow: "发光" })}`,
      `消息=${zhPreference(options.messageStyle, { plain: "纯文本", bubble: "气泡", card: "卡片" })}`,
      `侧栏=${zhPreference(options.sidebarStyle, { solid: "纯色", glass: "玻璃", gradient: "渐变" })}`,
      `输入区=${zhPreference(options.composerStyle, { minimal: "简洁", panel: "面板", floating: "悬浮" })}`,
      `装饰=${zhPreference(options.decoration, { restrained: "克制", balanced: "均衡", rich: "丰富" })}`,
      `会话背景=${zhPreference(options.backgroundMode, { css: "CSS 氛围", ai: "AI 成品图" })}`,
      `背景艺术=${zhPreference(options.backgroundArtStyle, { auto: "自动", illustration: "插画", cinematic: "电影感", abstract: "抽象", pattern: "图案" })}`,
      `背景适配=${options.backgroundFit}`,
      `背景焦点=${zhPreference(options.backgroundFocus, { left: "左", center: "中", right: "右" })}`,
      `可读性遮罩=${zhPreference(options.backgroundReadability, { soft: "柔和", balanced: "均衡", strong: "强" })}`,
      `背景描述=${backgroundBrief || "自动"}`,
    ].join("；");
  }
  return [
    `appearance=${options.appearance}`,
    `style=${options.style}`,
    `density=${options.density}`,
    `contrast=${options.contrast}`,
    `corners=${options.corners}`,
    `accent=${accentColor}`,
    `surfaces=${options.surfaceStyle}`,
    `controls=${options.controlStyle}`,
    `messages=${options.messageStyle}`,
    `sidebar=${options.sidebarStyle}`,
    `composer=${options.composerStyle}`,
    `decoration=${options.decoration}`,
    `conversation-background=${options.backgroundMode}`,
    `background-art=${options.backgroundArtStyle}`,
    `background-fit=${options.backgroundFit}`,
    `background-focus=${options.backgroundFocus}`,
    `background-readability=${options.backgroundReadability}`,
    `background-direction=${backgroundBrief || "automatic"}`,
  ].join("; ");
}

function zhPreference<T extends string>(value: T, labels: Record<T, string>) {
  return labels[value];
}

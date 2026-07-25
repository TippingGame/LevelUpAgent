# LevelUpAgent 主题开发、构建与适配规范

本文面向主题作者和维护 LevelUpAgent 主题能力的开发者。它说明如何从零开发 `.levelup-theme`、何时只需要主题仓库改动、何时必须以最小范围扩展宿主，以及如何验证安装、切换、卸载和真实窗口行为。

包格式的简明参考见 [THEMES.md](./THEMES.md)，供 Agent 执行任务的强制流程见 [THEME_AGENT_WORKFLOW.md](./THEME_AGENT_WORKFLOW.md)。

## 1. 设计目标

LevelUpAgent 的主题系统遵循以下原则：

1. 主题可独立安装、切换、更新和卸载。
2. 默认主题不依赖任何第三方主题文件。
3. 第三方主题停用后不能残留 CSS、布局或窗口状态。
4. 主题包不执行 JavaScript；schemaVersion 2 可在 `layout` 字段内携带一个声明式且经过校验的 `layout.json` 定义。
5. 优先修改主题项目；只有 CSS 无法表达缺失的语义结构时，才扩展 LevelUpAgent。
6. 宿主扩展应是受控、可复用的布局能力，不能为某个主题散落硬编码补丁。

## 2. 主题运行链路

```text
主题源码与本地素材
        ↓ 构建
单个 UTF-8 JSON .levelup-theme 文件
        ↓ 安装与 Rust 校验
应用数据目录/themes/{id}/theme.levelup-theme
                    （布局已内嵌在主题包中；旧版 layoutFile 主题可能另有 layout.json）
        ↓ 激活
<html data-levelup-theme="{id}"> + 专用 <style>
        ↓ 可选内嵌 layout 定义
自定义声明式布局；缺失时读取内置 default.layout.json
```

相关宿主代码：

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/theme.rs` | 包大小、字段、ID、CSS 安全、布局值校验；原子安装、读取和卸载 |
| `src-tauri/src/lib.rs` | 注册 `list_themes`、`install_theme`、`load_theme`、`uninstall_theme` 命令 |
| `src/lib/types.ts` | 前端 `ThemeManifest` 和 `ThemePackage` 类型 |
| `src/lib/bridge.ts` | 文件选择器及 Tauri 主题命令桥接 |
| `src/lib/storage.ts` | 当前主题 ID 的本地持久化 |
| `src/App.tsx` | 初始化主题、提供受控布局数据/动作和真实功能插槽 |
| `src/App.css` | 宿主提供的通用布局区域和默认样式 |
| `src/components/DeclarativeLayout.tsx` | 根据已校验 JSON 渲染组件树、绑定数据和执行受控动作 |
| `layouts/default.layout.json` | 所有无自定义布局主题使用的默认布局文件 |
| `docs/LAYOUTS.md` | 布局 schema、节点、数据、动作和安装契约 |
| `src-tauri/capabilities/default.json` | 结构主题确需原生窗口 API 时的最小权限 |

## 3. 先选择适配等级

开发前必须先确定主题属于哪一档。

| 等级 | 适用情况 | 主题项目改动 | LevelUpAgent 改动 |
| --- | --- | --- | --- |
| A：视觉主题 | 颜色、字体、圆角、阴影、背景、现有控件外观 | manifest、CSS、素材、构建器、测试 | 无 |
| B：声明式结构主题 | 需要重排区域、添加声明式组件或绑定宿主已公开数据/动作 | schemaVersion 2、CSS、内嵌 `layout` 定义 | 无 |
| C：宿主能力扩展 | 需要布局运行时尚未公开的数据、动作或真实功能组件 | 完整主题包与布局 | 增加可复用的数据、动作或插槽契约 |

必须先尝试 A，再检查 B。只有下面情况才进入 C：

- CSS 无法创建可访问、可交互的新控件。
- 主题需要真实窗口最小化、最大化、还原或关闭。
- 主题需要 JSON 节点、现有插槽和受控动作无法表达的新宿主能力。
- 使用伪元素实现会导致功能、键盘访问或响应式布局不完整。

不能因为 CSS 编写麻烦就修改宿主。

## 4. `.levelup-theme` 包契约

主题包是 UTF-8 JSON：

```json
{
  "schemaVersion": 1,
  "id": "example-theme",
  "name": "Example Theme",
  "version": "1.0.0",
  "author": "Theme author",
  "description": "A short description",
  "layout": "standard",
  "homepage": "https://example.com",
  "license": "MIT",
  "css": "html[data-levelup-theme=\"example-theme\"] { --accent: #2878d0; }"
}
```

字段约束：

- `schemaVersion` 可为 `1` 或 `2`。新自定义布局使用 `2`。
- `id` 长度最多 80，只允许 ASCII 字母、数字、`-` 和 `_`；发布后不得更换。
- `name` 最多 80 个可打印字符。
- `version` 最多 32 个可打印字符，建议使用语义化版本。
- `author` 最多 100 个可打印字符。
- `description` 最多 500 个可打印字符。
- schemaVersion 1 的 `layout` 可省略，仅用于兼容 `standard` 与 `qq2007`。
- schemaVersion 2 使用可选 `layout` 对象，将 `layout.json` 的内容直接内嵌到主题包。
- schemaVersion 2 未声明 `layout` 时读取内置默认布局文件。
- `layout` 与 `layoutFile` 不能同时声明；`layoutFile` 仅用于兼容旧版 companion 包。
- 旧版 schemaVersion 2 的 `layoutFile` companion 文件仍可读取，但新主题不应依赖它。
- `homepage` 最多 300 个可打印字符，可省略。
- `license` 最多 80 个可打印字符，可省略。
- 包文件必须是普通文件，大小为 1 字节到 12 MiB。
- `css` 大小为 1 字节到 10 MiB。

CSS 禁止包含：

- `@import`
- `javascript:`
- `expression(`
- `-moz-binding`
- `behavior:`
- `http:`、`https:` 或 `url(//`

## 5. 推荐的主题项目结构

```text
theme-project/
├─ README.md
├─ LICENSE
├─ package.json
└─ levelup/
   ├─ assets/
   │  ├─ background.jpg
   │  └─ icons.png
   ├─ manifest.json
   ├─ theme.css
   ├─ build-theme.mjs
   ├─ theme-package.test.mjs
   └─ dist/
      └─ example-theme/
         ├─ example-theme.levelup-theme
         └─ layout.json（构建输入，内容嵌入包内）
```

主题源仓库不应混入旧平台注入器、无关运行时、私有截图、应用凭据或无法说明来源的素材。

## 6. 从零开发一个主题

### 6.1 审计参考主题

开始编码前记录：

- 顶部、左侧、中央、右侧、底部有哪些区域。
- 哪些只是视觉装饰，哪些必须能点击或输入。
- 窗口栏是否由系统提供，是否需要自定义窗口按钮。
- 最小宽度下哪些区域折叠、隐藏或换行。
- 图片、图标、字体的来源、许可和可再分发性。
- LevelUpAgent 已有哪些真实节点可以复用。

不要直接把参考项目的全局 CSS 或注入脚本复制进主题包。

### 6.2 创建 manifest

先固定稳定的 `id`，默认使用：

```json
{
  "schemaVersion": 1,
  "id": "my-theme",
  "name": "My Theme",
  "version": "0.1.0",
  "author": "Your name",
  "description": "My LevelUpAgent theme",
  "layout": "standard",
  "license": "MIT"
}
```

只有明确需要并且宿主已经支持结构布局时，才把 `layout` 改成其他值。

### 6.3 编写严格作用域 CSS

每个选择器都必须包含精确作用域：

```css
html[data-levelup-theme="my-theme"] {
  --canvas: #edf4fb;
  --surface: #ffffff;
  --text: #173b61;
  --accent: #2878d0;
}

html[data-levelup-theme="my-theme"] .sidebar {
  background: var(--surface);
}
```

错误示例：

```css
:root { --accent: red; }
.sidebar { display: none; }
body.theme { background: red; }
```

规范：

- 先覆盖现有 CSS 变量，再写必要的组件选择器。
- 不依赖构建时随机类名或 React 内部结构。
- 不用 `!important` 作为默认策略；只在确认级联无法安全覆盖时使用。
- 不隐藏关键审批、权限、停止生成、发送或错误状态。
- 保留 `:focus-visible`、禁用态、悬停态和减少动态效果。
- 所有主题布局必须在 720×560 的宿主最小尺寸下可用。
- 结构主题应同时检查 1024×768、1440×920 和最大化窗口。

### 6.4 处理图片资源

运行时不能引用主题仓库路径，也不能下载远程资源。构建器应将图片转换为 `data:` URL：

```js
const bytes = await fs.readFile(assetPath);
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
css = css.replaceAll("__ASSET_ICON__", dataUrl);
```

要求：

- 源素材集中放在 `levelup/assets/`。
- CSS 使用明确占位符，例如 `__ASSET_BACKGROUND__`。
- 构建完成后检查不存在未解析的 `__ASSET_*__`。
- 控制尺寸，最终 JSON 不得超过 12 MiB。
- 不将文档截图作为主题背景，除非已确认分发权利。

### 6.5 构建单文件包

推荐构建器执行以下工作：

1. 读取 `manifest.json`。
2. 读取 `layout.json`（如果主题有自定义结构）并将解析后的对象写入 `layout` 字段。
3. 读取 `theme.css`。
4. 将本地素材替换为 `data:` URL。
5. 检查没有遗留素材占位符。
6. 检查 CSS 包含与 manifest ID 完全一致的作用域。
7. 输出 `{ ...manifest, layout, css }` 到 `dist/{id}.levelup-theme`。

构建命令建议统一为：

```bash
npm run build
npm test
```

### 6.6 主题项目自动测试

至少验证：

- 每个普通 CSS 规则都包含主题作用域。
- manifest 和产物的 `id`、`version` 一致。
- 所有图片已经内嵌。
- 没有 `@import`、远程 URL 或未解析占位符。
- 产物是合法 UTF-8 JSON。
- 产物大小符合限制。

## 7. 什么时候需要修改 LevelUpAgent

### 7.1 普通主题不改宿主

如果只改变外观，禁止修改以下文件：

- `src/App.tsx`
- `src/App.css`
- `src-tauri/src/theme.rs`
- `src-tauri/capabilities/default.json`

主题应在独立仓库完成构建并通过现有安装入口加载。

### 7.2 新增声明式结构布局

新布局必须有稳定、通用的布局 ID，例如 `compact-console`，不能使用临时项目名。通常不修改宿主，按以下顺序实施：

1. 将主题 manifest 升级到 schemaVersion 2 并将 `layout.json` 解析后写入 `layout` 字段。
2. 按 [LAYOUTS.md](./LAYOUTS.md) 使用容器、插槽、数据绑定、条件、列表、局部状态与受控动作。
3. 发布时只需交付包含 `layout` 定义的单个 `.levelup-theme` 文件。
4. 在主题 CSS 中完成全部视觉样式，并保持主题 ID 作用域。
5. 验证缺失布局时回退默认布局，卸载时删除布局并恢复默认状态。

只有布局需要的数据、动作或真实功能插槽尚未注册时才修改宿主。扩展必须通用、最小，并同步 Rust 校验、TypeScript 类型、运行时注册表、文档和测试。

宿主只负责“有什么区域和行为”，主题包负责“看起来是什么样”。

### 7.3 自定义窗口栏

只有结构主题确需合并系统标题栏时才允许使用原生窗口 API：

- 激活布局时调用 `setDecorations(false)`。
- 切回默认或其他普通布局时调用 `setDecorations(true)`。
- 自定义最小化、最大化/还原、关闭按钮必须调用真实 Tauri Window API。
- 标题空白区可拖动，窗口按钮区域不能被拖动层覆盖。
- 双击标题栏应最大化/还原。
- 最大化状态应更新还原图标和圆角。
- `src-tauri/capabilities/default.json` 只添加实际使用的窗口权限。
- 必须真实点击验证，而不能只看截图。

不要为了主题效果永久关闭所有主题的系统标题栏。

## 8. 安装生命周期验收

LevelUpAgent 仓库根目录 `themes/` 下的主题会作为桌面安装包资源发布。应用启动时校验并同步这些内置主题；同 ID 的用户手动安装版本优先，且不会被启动同步覆盖。内置主题在主题管理器中标记为“内置”，不能卸载。

每个新主题至少执行一次完整生命周期：

1. 启动默认主题，确认原界面正常。
2. 安装 `.levelup-theme`。
3. 确认安装后立即激活。
4. 重启应用，确认主题选择和布局仍然恢复。
5. 切换到默认主题，确认第三方 CSS、结构节点和窗口状态全部消失。
6. 再切换到第三方主题。
7. 卸载当前主题，确认自动回到默认主题。
8. 再次重启，确认不存在残留。
9. 安装同 ID 的更高版本，确认原子替换成功。

结构主题额外检查：

- 新建任务、切换项目、聊天、审批、Diff、附件、发送和停止生成功能。
- 右侧面板打开/关闭和窄窗口降级。
- 最小化、最大化、还原、关闭和标题栏拖动。
- 中文、英文和长标题不溢出关键控件。

## 9. LevelUpAgent 验证命令

修改宿主后运行：

```bash
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

发布安装包前运行：

```bash
pnpm tauri build --bundles nsis
```

主题包的 Rust 测试必须覆盖：

- 安装、列出、加载、更新和卸载。
- 无作用域 CSS 拒绝。
- 远程 CSS 和危险构造拒绝。
- 未注册布局拒绝。

## 10. 版本与发布

- 只改颜色或小样式：补丁版本，例如 `1.1.0 → 1.1.1`。
- 新增组件样式或明显视觉能力：次版本，例如 `1.1.0 → 1.2.0`。
- 更换主题 ID、删除主要能力或不兼容包结构：主版本。
- LevelUpAgent 新增宿主布局能力时，同时提升应用版本，避免安装包与旧版本同名。
- 发布时记录主题包和安装包的 SHA-256。

## 11. QQ 2007 适配得到的经验

- 颜色覆盖不能代替结构适配；三栏、标题栏和好友面板需要真实 DOM。
- 主题资产必须迁入主题自己的 `levelup/assets/`，不能依赖旧平台目录。
- 标题栏不能同时保留系统栏和主题栏，否则会出现两层标题栏。
- 装饰圆点不能冒充窗口按钮；可见控件必须有实际功能和可访问标签。
- 将整个标题栏标记为拖动区域会吞掉按钮点击，应只标记标题和空白区域。
- 输入区需要随可用高度伸展，工具栏固定到底部，不能依赖固定截图尺寸。
- 完成适配后应删除旧注入器和无关平台代码，让主题仓库保持单一职责。

## 12. 完成定义

只有全部满足才算主题完成：

- [ ] 主题包可构建且测试通过。
- [ ] CSS 全部严格作用域化。
- [ ] 所有素材本地内嵌且权利可说明。
- [ ] 没有远程 CSS、脚本或旧平台运行时依赖。
- [ ] 安装、切换、重启、更新和卸载通过。
- [ ] 默认主题无回归、无残留。
- [ ] 最小尺寸、常用尺寸和最大化通过。
- [ ] 关键交互和可访问状态通过。
- [ ] 宿主改动确属必要且保持最小范围。
- [ ] 文档、版本号、产物路径和校验值已更新。

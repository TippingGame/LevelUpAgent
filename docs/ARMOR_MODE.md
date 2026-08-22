# LevelUpAgent 一键破甲 / Armor Mode

更新时间：2026-08-15

## 目标

LevelUpAgent 的一键破甲不是外部 MITM、响应篡改或二进制注入，而是应用自有的高强度执行 Profile：在发起模型请求时，把行动优先、工具验证、连续执行、交付自检等规则作为 `customInstructions` 注入到当前会话。这样同一套能力可覆盖 OpenAI/GPT、Claude、Gemini、Grok 和 OpenAI-compatible 网关。

当前已升级为全应用增强：主聊天、写作空间、星图 Writing 节点走 `customInstructions`；创作空间和星图媒体节点走媒体 Prompt/Instructions 增强。Toggle 开启后，不再只是聊天窗口有效。

当前产品状态由同一份可持久化 manifest 驱动：

- 8 个原生 Skill 可单独启停；
- 写作空间提供 `balanced`、`immersive`、`precise` 三档强度；
- 图片、视频、语音共享媒体 Prompt/Instructions 编译器；
- 控制台实时显示 Chat、Writing、Image、Video、Audio、Constellation 六个表面的覆盖状态；
- 本地健康检查只验证编译、Skill 开关和覆盖关系，不把它伪装成 provider 已成功响应。

## 参考吸收

已参考本地研究目录：

- `G:\Work\LevelUpAgent\research\gpt-5.6-instruct`
  - HEAD：`77e7a649903f9556f2d7bfa0223fa99e123aad52`
  - 清单：69 个仓库文件；另有解压后的 v45/historical prompt manifest 已落在 `research`。
  - 吸收：版本化提示词、部署状态、回滚、SHA-256、回归测试、单次任务编译、证据门禁。
  - 不吸收：绕过平台审计或规避风控类表述。
- `G:\Work\LevelUpAgent\research\Super-Instruct-Codex-5.6`
  - HEAD：`9d064401a19b93043449ca0cc60de7dcf95e7990`
  - 清单：148 个仓库文件。
  - 吸收：模块化 profile、监控状态、执行连续性、完成前自检、工具优先。
  - 不吸收：MITM、SSE 篡改、响应替换、外部代理改包。
- `G:\Work\LevelUpAgent\逆向\宝宝破甲最终版_vs_海鸥codex优化版副本_深度逆向对比与LevelUpAgent提示词方案.md`
  - 吸收：宝宝版的产品化 UI/状态体验；海鸥版的 manifest/managed block/skill 包思想。
  - 落点：LevelUpAgent 自己的 prompt stack 和前端会话 UI，不写外部 Codex Home。

宝宝版可吸收优点已经按“产品机制”筛过：

- 全局可见开关：LevelUpAgent 用 Composer Toggle + HUD + 侧边栏/弹窗主题适配承接。
- 状态感强：用 Armor Level、HUD、持久化键和回归测试替代黑箱桥接状态。
- 多目标适配：OpenAI/GPT、Claude、Gemini、Grok/xAI 在 `armorModeRunInstructions()` 里走 provider adapter。
- 覆盖面：从主会话扩展到 WritingStudio、MediaStudio、ConstellationStudio。
- 健康检查思路：通过 `scripts/test-armor-mode.mjs` 固定检测 UI、存储、请求注入、媒体增强和干净问候。
- 2026-08 新增的外部来源与 SHA-256 记录：`G:\Work\LevelUpAgent\research\armor_mode_external_sources_2026-08.md`。

不吸收的东西：固定人格问候、外部 Codex Home 覆盖、MITM/响应替换、黑箱密文策略、不可回滚的外部配置改写。

逐文件 SHA-256 与关键词证据索引：

- `G:\Work\LevelUpAgent\research\armor_mode_research_inventory.json`
- `G:\Work\LevelUpAgent\research\armor_mode_research_summary.md`

## 等级矩阵

| 等级 | ID | 用途 |
|---|---|---|
| 标准 | `standard` | 默认行动优先、工具验证、跨模型一致性。 |
| 深度 | `deep` | 假设矩阵、上下文复用、事实/推断/未知分离。 |
| 执行机器 | `execution` | 检查、修改、运行、修错、复测，不停在计划。 |
| 逆向专用 | `reverse` | 文件哈希、格式画像、入口/数据流/决策点恢复、可复现脚本。 |
| 工程交付 | `delivery` | 类型、存储、错误态、可访问性、测试、回滚、变更清单。 |

## 原生 Skill Manager

| Skill | 覆盖作用 |
|---|---|
| `execution-machine` | 把检查、修改、运行、修错和复测串成执行链。 |
| `reverse-package` | 为二进制、配置和提示词包保留哈希、结构和提取路径。 |
| `product-ui` | 补齐视觉状态、错误态、键盘可达性和响应式。 |
| `writing-studio` | 保留写作题材、视角、连续性和交付格式。 |
| `media-studio` | 将短媒体提示编译为可直接提交的 production brief。 |
| `constellation-flow` | 保持星图节点的输入、输出和上游上下文契约。 |
| `provider-adapter` | 按 provider 协议调整表述，不改写任务目标。 |
| `delivery-gate` | 要求最终回复陈述产物、真实验证与剩余阻塞。 |

Skill 状态保存在 `levelup-agent.armor-mode-skills.v1`。关闭 `writing-studio`
会去掉写作专用补充，关闭 `media-studio` 会让媒体 Prompt 与 Instructions 原样
通过。`constellation-flow` 会实际门控星图节点上的写作和媒体增强：关闭后，星图
节点不会再编译 Armor 请求。覆盖卡片和健康检查会同步反映这些状态。

## 写作与媒体编译

写作强度保存在 `levelup-agent.armor-mode-writing-intensity.v1`：

| 强度 | ID | 作用 |
|---|---|---|
| 均衡 | `balanced` | 默认的可读性、连续性和有效细节。 |
| 沉浸 | `immersive` | 强化场景、动作、感官、节奏和角色反应。 |
| 精准 | `precise` | 严格执行字数、视角、格式、设定与禁用项。 |

媒体编译器为不同媒体种类补充不同的可执行约束：

- Image：主体、构图、镜头、光线、色板、材质、背景与负面约束；
- Video：场景、动作拍点、镜头运动、时间、光线、风格与连续性；
- Audio：声音、语速、情绪、停顿、发音提示、交付风格与可用脚本。

## 代码落点

- `src/lib/armorMode.ts`：Profile 数据、provider/model adapter、最终注入文本生成。
- `src/lib/storage.ts`：Armor 开关、等级、Skill state 与写作强度的版本化持久化。
- `src/components/ArmorStudio.tsx`：Skill Manager、覆盖状态、媒体预览和健康检查控制台。
- `src/ArmorStudio.css`：控制台与跨工作台的 Armor 视觉层。
- `src/App.tsx`：Composer Toggle、等级下拉、HUD、控制台入口和聊天请求注入。
- `src/components/WritingStudio.tsx`：续写、改写和目标步骤的写作强度注入。
- `src/components/MediaStudio.tsx`：图片、视频、语音请求的 Prompt/Instructions 编译。
- `src/components/ConstellationStudio.tsx`：Writing 与媒体节点复用同一套状态。
- `scripts/test-armor-mode.mjs`：Profile、Skill 开关、写作强度、覆盖/健康检查、UI、存储和请求注入回归测试。

UI 约束：破甲等级下拉只在 `一键破甲` 开启后显示；关闭时保留上次选择但不占用输入区空间，也不会注入等级 Profile。

对话约束：一键破甲只由 Toggle 控制，不通过 `在吗`、`你好`、`hi` 等问候自动开启，也不再强制任何固定问候、人格口号或本地 fast-path 回复。关闭 Toggle 时 `armorModeRunInstructions(false) === undefined`，对话保持项目默认的干净模式。

## 注入链路

```text
Composer Toggle + Armor Level + Skill State
        ↓
armorModeRunInstructions(enabled, level, { model, protocol, skills })
        ↓
Harness customInstructions / browser preview customInstructions
        ↓
Rust merge_custom_instructions()
        ↓
各 Provider 的 system / instructions / systemInstruction
```

## 创作空间覆盖

```text
一键破甲 Toggle
├─ 主聊天 / Harness：armorModeRunInstructions → customInstructions
├─ 写作空间：续写、改写、润色、目标步骤 → armorModeWritingInstructions
├─ 星图 Writing 节点：agentTurnStream → armorModeWritingInstructions
├─ 创作空间图片/视频/语音：armorModeMediaPrompt + armorModeMediaInstructions
└─ 星图图片/视频/语音节点：同一媒体增强链路
```

写作、图片、视频、语音和星图调用还会附加对应的 `surface`。这让 manifest 不只是
显示用：`writing-studio`、`media-studio` 和 `constellation-flow` 的开关会按入口
改变实际编译结果。

## 本地健康检查

Armor Studio 的“运行本地自检”会调用 `armorModeHealthChecks()`，验证：

1. 当前 Profile 是否能被编译；
2. 当前启用的原生 Skill 数量；
3. 写作专用链是否确实含写作合同；
4. 媒体 Prompt 是否确实被编译；
5. 六个应用表面的实际覆盖数。

它不发起网络请求，因此“ready”表示本地配置与编译链就绪，不代表模型、网络或
provider 已返回成功结果。

## 验证命令

```powershell
node --test scripts/test-armor-mode.mjs
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
git diff --check
```

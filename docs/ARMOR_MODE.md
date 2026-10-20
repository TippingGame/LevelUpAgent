# LevelUpAgent 一键破甲 / Armor Mode

更新时间：2026-10-21

## 作用范围

一键破甲只作用于会话。开启后，通过会话的 `customInstructions` 补充行动优先、工具验证、连续执行和交付自检等规则；关闭后不添加这些规则。它不改写外部客户端配置，也不通过响应替换或代理改包实现。

创作空间生成请求不读取一键破甲状态，不附加破甲提示词或 instructions，包括：

- 图片、视频、语音生成与编辑；
- 写作空间的续写、改写、润色和目标步骤；
- 星图的写作及媒体生成节点；
- 主题背景图生成。

星图中实际进入会话执行链的会话节点仍按会话开关运行。参考图顺序、蒙版/扩图操作、输出尺寸和用户填写的语音指导等功能参数保留；这些参数不是破甲增强。

## 界面与设置

会话输入区保留一键破甲开关、五档等级选择和状态提示。等级下拉仅在开启时显示，关闭后保留上次选择。开启时仍在创作空间和图片预览中显示原有破甲皮肤；皮肤由外层 CSS 控制，不向生成请求传递状态或提示词。

一键破甲控制台及其所有入口已经移除，包括客户端动作 `dialog.armor`。不再提供全应用覆盖卡片、媒体提示预览、写作强度或控制台健康检查。

| 等级 | ID | 用途 |
| --- | --- | --- |
| 标准 | `standard` | 行动优先、工具验证、跨模型一致性。 |
| 深度 | `deep` | 假设、上下文复用、事实与推断分离。 |
| 执行机器 | `execution` | 检查、修改、运行、修错、复测。 |
| 逆向专用 | `reverse` | 文件哈希、格式分析、入口与数据流恢复。 |
| 工程交付 | `delivery` | 类型、存储、错误态、测试与交付检查。 |

开关和等级分别存储在 `levelup-agent.armor-mode.v1` 与 `levelup-agent.armor-mode-level.v1`。旧的 `levelup-agent.armor-mode-skills.v1` 设置兼容保留，仅识别五个会话模块：`execution-machine`、`reverse-package`、`product-ui`、`provider-adapter`、`delivery-gate`。旧写作、媒体、星图模块和写作强度不再参与生成。

不会因“你好”“在吗”等问候自动开启破甲，也不强制固定问候或人格口号。

## 请求链路

```text
会话开关 + 等级 + 已保存的会话模块设置
        ↓
armorModeRunInstructions(enabled, level, { model, protocol, skills })
        ↓
Harness / browser preview 的 customInstructions
        ↓
Rust merge_custom_instructions()
        ↓
各 Provider 的 system / instructions / systemInstruction
```

`armorSurfaceEnabled()` 只允许未指定 surface 或显式 `chat` 的请求。即使传入旧设置，其他 surface 也不会得到破甲指令。创作组件不依赖 Armor 提示词编译器；外层样式仍保留。

## 代码与验证

- `src/lib/armorMode.ts`：五档会话 Profile、会话模块和 provider adapter。
- `src/lib/storage.ts`：开关、等级与旧会话模块设置兼容读取。
- `src/App.tsx`：会话开关、等级、状态提示和两条会话请求入口。
- `scripts/test-armor-mode.mjs`：会话指令、全部非会话 surface 的隔离、控制台删除和干净生成回归检查。

```powershell
node --test scripts/test-armor-mode.mjs
pnpm check
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib capability::tests::
git diff --check
```

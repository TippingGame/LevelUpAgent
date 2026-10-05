# LevelUpAgent 1.1.65 发布记录

日期：2026-10-05。当前状态：发布前检查通过，待 GitHub CI 与跨平台打包完成后核验并发布。

## 本版内容

- 创作空间新增天蓝色 Spine 工作台：整图和部件生成、装配预览、骨骼和网格编辑、动作轨道及 Spine 4.2 资产导出。
- 支持多图关键姿态、会话识别与审阅、局部姿态拟合，以及生成可继续编辑的骨骼中间帧。
- 桌面版可调用本地 RIFE 生成 RGB 动作参考帧；参考图需要识别、拟合和确认才能进入骨骼动画。
- 增加拆件规划、单件重绘的贴图/装配/动作对照，以及本机 ComfyUI 拆层任务接入和恢复。
- 重建星图项目与蓝图编辑，完善会话绑定、Agent 执行、工具节点、可复用模板和可编辑的本地输入副本。
- 改进媒体模型能力与排序、图片预览与下载、更新下载进度、会话摘要和工作区变更显示。

详细用法和限制见 [Spine 工作台](SPINE_STUDIO.md) 与 [V6 工作流审计](SPINE_V6_CONVERSATIONAL_WORKFLOW.md)。

## 发布前检查

- 应用、Tauri、Cargo 和锁文件版本统一为 `1.1.65`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：292 项通过，0 失败。
- `cargo test`：525 项通过，4 项按条件忽略，0 失败。
- `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings` 通过。
- 修复 RIFE Windows 路径函数的 3 处 Clippy 警告；统一现有 Rust 格式。
- 修复 Chromium 测试关闭后短暂占用目录的问题：只对预期的临时文件锁/目录非空错误重试，最多 5 秒，其他错误仍失败。
- 已核对 GitHub updater 配置名称齐全；没有读取或输出签名私钥和密码。

本机检查日志：`G:\Work\LevelUpAgent\research\release-1.1.65-2026-10-05`。

## 打包与发布步骤

1. 提交发布准备变更，推送 `main`，等待 Windows、macOS、Linux CI。
2. 为该提交创建并推送 `v1.1.65`，由 Release 工作流生成 Draft。
3. 核对 Windows EXE/MSI 及各自签名、两个 macOS DMG、Linux AppImage/DEB/RPM 和 `latest.json`。
4. 检查更新版本、下载 URL、签名与实际资产一致，再公开发布并设为 Latest。
5. 验证公开下载端点，将正式 Windows EXE 同步到本机安装包目录，重新生成两份 SHA256 清单。

## 验证边界

Windows updater 使用原有 Tauri 签名配置；它不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。更新清单仅覆盖 Windows。

本次发布检查不等同于在用户现有应用上实际覆盖安装或从旧版本完成应用内更新。ComfyUI See-through 的真实 GPU 拆层、Spine 编辑器的导入/另存/重开，以及各平台实体机安装仍需单独验收。Spine 官方 4.2 runtime 兼容性和本地 RIFE 推理的既有验证证据见上述工作流审计文档。

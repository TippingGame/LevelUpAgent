# LevelUpAgent 1.2.72 发布记录

日期：2026-10-09。状态：发布准备中，完成检查与资产核验后公开。

## 本版内容

- 修复 3D 贴图生成成功后桌面预览仍显示白模：补齐内嵌贴图读取所需的 CSP blob 权限，已有生成结果可直接显示。
- 3D 工作台复用 Spine 的纯色背景抠图，提供容差调整、透明预览、应用与还原。原图及已完成的形状/贴图保留，后续生成使用已应用参考图。
- 白底预处理只移除边缘连通的近白背景，保护主体内部浅色脸部和头发高光；贴图阶段不再沿用旧任务中受损的参考图。
- 修复 Windows 应用目录重定向下 Rust 与 WSL 读取不同作品目录的问题。
- 媒体生成等待上限延长到 10 分钟。
- 模型、Python / PyTorch / CUDA 和 Blender 继续复用通用资源 `2026.10.1`，无需随本版重新下载。

## 功能验证

- 带内嵌 PNG 的 GLB 浏览器回归复现旧策略的白模，并确认正式 CSP 可载入贴图。
- 参考图抠底、应用、还原通过系统浅/深色 × 装甲开/关和 720px 窗口检查。隔离 Windows WebView2 验证真实导入、保存、页面重载与还原，原图保留。
- RTX 3080 Ti / WSL2 对照使用相同网格、描述、种子 42、30 步和 2K 贴图，仅修复参考图。正式启动器贴图约 62.6 秒，PyTorch 显存保留峰值 2,354 MiB，网格位置最大偏差为 0。
- 美术质量仍需检查：该修复改善参考图损坏导致的乱纹，不保证消除所有接缝或原网格缺陷。

功能验收证据：`artifacts/model-workbench/texture-quality/`；发布证据：
`G:\Work\LevelUpAgent\research\release-1.2.72-2026-10-09`。

## 发布检查与结果

- 应用、Tauri、Cargo 及锁文件统一为 `1.2.72`。
- 本地 `pnpm install --frozen-lockfile`、`pnpm check`（299 项及外观/发布配置检查）、`pnpm build` 通过。
- `cargo fmt --check`、`cargo test`（538 通过、4 按条件忽略）、`cargo clippy --all-targets -- -D warnings` 通过。
- Python 16 项测试在 Windows 14 通过、2 按平台跳过；WSL 16 项全部通过，覆盖真实进程组取消和目录链接恢复。
- CI / Release 工作流通过 actionlint 检查。通用资源清单公开下载返回 200，14 个分片的大小与 GitHub digest 匹配，资源 Release 保持 prerelease、不占用 Latest。

GitHub Actions、资产哈希与 updater 签名、公开更新清单结果将在核验后补充。

## 验证边界

Windows 原生功能验证使用隔离应用标识，未覆盖用户现有安装，也未执行从旧版本的应用内更新。
macOS 使用 ad-hoc 签名且未公证；Windows 未配置 Authenticode；Linux 包未做发行版签名。
本版仍使用已发布的通用 3D 资源，不重复打包或上传大依赖。

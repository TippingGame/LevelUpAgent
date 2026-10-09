# LevelUpAgent 1.2.71 发布记录

日期：2026-10-09。状态：发布准备中，正式 tag 为 `v1.2.71`。

## 本版内容

- 新增创作空间 3D 工作台：TripoSG 生成形状 → SD2.1 + MV-Adapter 独立贴图 → Blender 蒙皮与基础动画。支持 GLB、FBX 和完整工程导出。
- 固定灰色建模背景，作品信息、下载和旋转/动作控件悬浮于画布；修复贴图与阶段切换预览、缓存加载提示残留，隐藏默认深灰进度条。
- Python / CUDA、TripoSG、贴图模型和 Blender 独立安装，显示下载进度、速度、磁盘及显存/内存预算。通用资源版本 `2026.10.1` 放在固定 `model-workbench-resources` Release，后续兼容应用直接复用，应用安装包不包含大依赖。
- Windows NSIS 安装和卸载均实时跟随系统显示语言（简体、繁体、英文回退），清理个人数据需额外确认后才勾选，默认和静默升级保留数据。
- 发布流程与资源兼容约定同步到 [发布手册](RELEASE_GUIDE.md) 和 [3D 工作台说明](MODEL_WORKBENCH.md)。

## 发布前验证

- 应用、Tauri、Cargo 及锁文件统一为 `1.2.71`。
- 本地 `pnpm install --frozen-lockfile`、`pnpm check`（297 项及外观/发布配置检查）、`pnpm build` 通过。
- `cargo fmt --check`、`cargo test`（537 通过、4 按条件忽略）、`cargo clippy --all-targets -- -D warnings` 通过。
- 3D 启动器测试包含跨应用版本复用、不重复安装、错资源版本拒绝、SHA-256、续传、安全解压与失败保留结果。WSL 覆盖进程组取消和目录链接恢复。
- 原生 NSIS 隔离测试覆盖安装/卸载的 7 种语言映射、历史目录迁移、清理确认状态与数据保留。
- 3D 预览已完成 48 次实际 GLB 阶段切换，覆盖浅/深色、Armor 开/关及 1440/720px 窗口；加载提示均消失，无默认进度条和横向溢出。
- GPU 生成验收：RTX 3080 Ti / WSL2，详见 [SD2.1 全流程结果](model-workbench/sd21-pipeline-acceptance.json)。本次通用资源复用相同归档字节，只改变外部分片命名与兼容清单。

本机发布证据：`G:\Work\LevelUpAgent\research\release-1.2.71-2026-10-09`。

## 验证边界

未覆盖用户当前安装、未执行旧版应用内更新。真实 Tauri 的完整 3D 导入/预览/导出链路尚未全部自动验收；GPU 工作流通过相同启动器与资源完成。
当前 3D 生成支持 NVIDIA GPU + Windows WSL2 / Linux x64，CUDA 11.8 资源已验证 RTX 3080 Ti，不能据此声称覆盖所有 GPU；macOS 不支持这套 CUDA 推理资源。
Windows updater 签名不等于 Authenticode；macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。自动更新清单只覆盖 Windows。

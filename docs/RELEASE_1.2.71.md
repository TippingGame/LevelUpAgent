# LevelUpAgent 1.2.71 发布记录

日期：2026-10-09。状态：已发布到 GitHub，正式 Release 为 `v1.2.71`，已设为 Latest。

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

## 已发布结果

- 构建提交：`8aa8fc2d18674a38b2d804720b3029ca30c81d94`，tag：`v1.2.71`。
- 发布时间：北京时间 2026-10-09 15:15:28，正式发布且已设为 Latest，非预发布，Release ID `407544934`。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37888509630) 和 [四平台 Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37888569068) 全部通过。
- 正式 Release：[LevelUpAgent v1.2.71](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.2.71)。Windows x64 EXE/MSI、Apple Silicon/Intel DMG、Linux x64 AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全。
- 10 个资产均完整下载，大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI updater 签名及可信注释签名通过现有公钥验证。
- 未登录的公开 `latest.json` 返回 HTTP 200，版本为 `1.2.71`，字节与已验签资产内的清单一致，下载 URL 和签名均指向本次 Windows 资产；正式发布页返回 HTTP 200。
- Windows EXE 的 FileVersion/ProductVersion 均为 `1.2.71`；两个 macOS 包均在原生 runner 完成 DMG 内和模拟复制安装后应用签名验证。
- 本机安装包：`G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.2.71_Windows_x64-setup.exe`，保留旧版，新增 `SHA256_1.2.71.txt` 并更新总清单 `SHA256.txt`。
- EXE 大小：14,738,386 字节；SHA-256：`EE2414774D359BB36249660ACE9609C799F2C5A394F4264D6898CC9C57A3931F`。

## 通用 3D 资源发布

- 固定 Release：[3D Workbench Shared Resources](https://github.com/TippingGame/LevelUpAgent/releases/tag/model-workbench-resources)，ID `407535594`，北京时间 2026-10-09 15:12:44 公开。使用 prerelease 并排除 Latest，不影响应用更新渠道。
- 资源版本 `2026.10.1`，目标 `linux-x64-cu118`，四组件共 14 个分片、23,294,781,440 字节（约 21.7 GiB），加清单共 15 个资产。
- 本地分片与完整归档 SHA-256 全部通过；所有远端分片的状态、大小及 GitHub digest 与清单一致，清单在分片核验后最后上传。
- 公开清单下载返回 HTTP 200、字节与本地一致。清单 SHA-256：`B69C6E26BD14477A797FD7AD2808BA04D46A920D95B7C8F08DC9F847B4CE966F`。
- WSL 启动器使用隔离数据目录从公开地址读取并校验了实际清单。首次网络读取超时，重试成功；未修改现有资源环境。
- 兼容应用版本继续使用这一资源版本和缓存目录。只有模型或依赖变化时才向同一 Release 追加新资源版本，已公开资产不覆盖。

## 发布流程修复

本次构建产生了两个同名草稿，macOS 和其他平台资产分散。已按大小与 SHA-256 归并至唯一草稿 `407544934`，核对 10 个资产齐全后删除重复的未发布草稿，再公开正式版本。

后续流程已通过提交 `d0fe151a296db2ed9594dacc828bef627048ba83` 修复：从列表识别唯一草稿，拒绝重复草稿或向正式 Release 继续上传，macOS 按选定 Release ID 上传。相关四项流程测试、actionlint 和 [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37890851601) 通过。该提交只改变发布工具，不包含于本次应用构建；已发布 tag 和安装包保持对应上述构建提交。

## 验证边界

未覆盖用户当前安装、未执行旧版应用内更新。真实 Tauri 的完整 3D 导入/预览/导出链路尚未全部自动验收；GPU 工作流通过相同启动器与资源完成。
当前 3D 生成支持 NVIDIA GPU + Windows WSL2 / Linux x64，CUDA 11.8 资源已验证 RTX 3080 Ti，不能据此声称覆盖所有 GPU；macOS 不支持这套 CUDA 推理资源。
Windows updater 签名不等于 Authenticode；macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。自动更新清单只覆盖 Windows。

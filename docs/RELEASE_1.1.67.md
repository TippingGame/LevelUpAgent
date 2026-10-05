# LevelUpAgent 1.1.67 发布记录

日期：2026-10-05。当前状态：已发布到 GitHub，正式 Release 为 `v1.1.67`，已设为 Latest。

## 本版内容

- 修复创作空间中写作、星图、Spine、媒体和摇光残影相关界面的系统深色适配，统一文字、背景、边框及状态色。
- 修复会话 Markdown、代码块、表格、附件、按钮和弹窗的浅色硬编码残留。
- 修复一键破甲主题在创作空间共用标题栏、新页面和挂载到 body 的弹窗中未完整继承的问题。
- 修复摇光残影聊天头像溢出：头像固定为 36×36，精灵按原始比例居中缩放，清除工作区懒加载样式对聊天头像的覆盖。
- 新增外观静态检查并接入 `pnpm check`，阻止新增未经说明的固定中性色和仅浅色的控件；记录系统浅色/深色与破甲开关四种组合的验收规范。

## 发布前检查

- 应用、Tauri、Cargo 及锁文件版本统一为 `1.1.67`。
- `pnpm install --frozen-lockfile`、`pnpm build` 通过。
- `pnpm check`：296 项通过；外观守卫 4 项通过，无新增固定中性色或仅浅色声明。
- `cargo test`：529 项通过、4 项按条件忽略、0 失败。
- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check` 通过。
- 浏览器与隔离 Tauri 原生窗口各完成 32 项外观检查，均无页面异常。覆盖浅色/深色与破甲开/关四种组合、会话、媒体、写作、星图、Spine、写作设置、桌宠面板、body Portal 及头像折叠/展开。
- 原生头像尺寸为 36×36，内部精灵按 192:208 比例缩放且边界完全位于框内；打开桌宠面板后布局保持稳定。

本机日志及资产验证证据：`G:\Work\LevelUpAgent\research\release-1.1.67-2026-10-05`。

## 验证边界

外观静态检查用于拦截新增固定中性色及浅色限定，不替代真实界面检查。旧声明以精确基线跟踪，不允许扩展豁免。

原生外观验收使用独立应用标识和测试会话，通过 WebView 媒体模拟检查深浅色，不修改 Windows 全局主题。没有覆盖用户现有安装或修改生产应用数据。本次未执行 Windows 旧版应用内更新和 Linux 实体机安装；macOS 由原生 runner 验证 DMG 和模拟复制安装后的签名。

Windows updater 使用原有 Tauri 签名配置，不等同于 Authenticode。macOS 使用 ad-hoc 签名且未公证；Linux 包未做发行版签名。自动更新清单仅覆盖 Windows。

## 已发布结果

- 构建提交：`b54a8970fddbcb8eeeb23c6a5e8f2a8ff1f1e560`，tag：`v1.1.67`。
- 发布时间：北京时间 2026-10-05 22:56:21，正式发布且已设为 Latest，非预发布。
- [三平台 CI](https://github.com/TippingGame/LevelUpAgent/actions/runs/37326002407) 全部通过。Windows 首次在两个已有 Python Hook 测试中未取得上下文，其他平台和本机同组测试均通过；只重跑失败的 Windows job 后成功，未更改构建提交或 tag。本机额外复核 Hook 测试 4/4 通过。
- [四平台 Release 工作流](https://github.com/TippingGame/LevelUpAgent/actions/runs/37326006685) 全部通过，Windows x64 EXE/MSI、Apple Silicon/Intel DMG、Linux x64 AppImage/DEB/RPM、Windows 签名及更新清单共 10 个资产齐全。
- 正式 Release：[LevelUpAgent v1.1.67](https://github.com/TippingGame/LevelUpAgent/releases/tag/v1.1.67)。
- 发布页及公开 `latest.json` 均返回 HTTP 200；清单版本为 `1.1.67`，与发布前核验的清单逐字一致，URL 和签名均指向本次资产。
- 10 个资产均完整下载，大小和 SHA-256 与 GitHub digest 一致；Windows EXE/MSI updater 签名及可信注释签名通过现有公钥验证。
- Windows EXE 的 FileVersion/ProductVersion 均为 `1.1.67`；两个 macOS 包均在原生 runner 完成 DMG 内和模拟复制安装后应用签名验证。
- 本机安装包：`G:\Work\LevelUpAgent\安装包\LevelUpAgent_1.1.67_Windows_x64-setup.exe`，已保留旧版，并新增 `SHA256_1.1.67.txt`、更新总清单 `SHA256.txt`。
- EXE 大小：14,227,479 字节；SHA-256：`0EF55172EFB10EDBC757268757BE8B5D66679A6D6715AA1585C02DE8CE1DD22B`。
- Actions 日志、两次 Windows CI 结果、外观截图、资产哈希及签名核验保存在上述本机证据目录。

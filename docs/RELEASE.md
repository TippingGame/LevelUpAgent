# 跨平台安装包与 Windows 签名更新发布

LevelUpAgent 的本地 `pnpm tauri build` 始终允许生成开发/自用安装包，但这些产物不会伪装成已签名
更新。正式发布只由 `v*` tag 触发 `.github/workflows/release.yml`，在 Windows、macOS 和 Linux
runner 上构建并创建 Draft Release。macOS runner 在所有资源写入后对 App 执行 ad-hoc 签名，
并验证 DMG 内及模拟复制安装后的签名；当前未配置 Apple Developer ID 和公证。

## 必需的仓库 Variables

- `TAURI_UPDATER_PUBKEY`：Tauri updater 公钥。
- `TAURI_UPDATER_ENDPOINT`：HTTPS `latest.json` 地址，例如
  `https://github.com/OWNER/REPO/releases/latest/download/latest.json`。

## 必需的仓库 Secrets

- `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：updater artifact 的私钥和密码。

私钥和密码不得写入仓库、安装包、日志或 Draft Release 正文。发布脚本只生成被 `.gitignore`
排除的 `src-tauri/tauri.release.conf.json`。缺少上述任一 updater 参数时，工作流会在打包前失败。

Tauri updater 签名用于验证更新包来自同一发布者且内容未被篡改；当前工作流不配置 Windows
Authenticode，因此安装包没有系统级发布者签名，首次下载或安装可能触发 SmartScreen 警告。

## 发布流程

1. 生成并离线保存 updater keypair，只把公钥放入 Variable、私钥放入 Secret。
2. 配置 GitHub Release 的 `latest.json` HTTPS 地址。
3. 同步更新 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的版本。
4. 在 `main` 上等待 CI 通过。
5. 推送与应用版本一致的 tag，例如 `v1.0.1`。
6. 检查 Draft Release 中的 Windows NSIS/MSI、updater archive、`.sig`、`latest.json`、两个 macOS
   DMG 及 Linux 安装包，实体机验收后发布。

应用设置中的“检查更新”使用 Tauri updater 的签名验证；本地未配置 endpoint 的构建会明确显示
更新未配置，不会回退到下载并执行未签名文件。

已安装的 v1.0.0 没有 updater 配置，不能自动升级；用户需要手动安装一次 updater 版 v1.0.1，之后
才能通过应用内入口安装后续版本。

# 签名发布与自动更新

LevelUpAgent 的本地 `pnpm tauri build` 始终允许生成开发/自用安装包，但这些产物不会伪装成已签名
发行版。正式发布只由 `v*` tag 触发 `.github/workflows/release.yml`，并创建 Draft Release。

## 必需的仓库 Variables

- `TAURI_UPDATER_PUBKEY`：Tauri updater 公钥。
- `TAURI_UPDATER_ENDPOINT`：HTTPS `latest.json` 地址，例如
  `https://github.com/OWNER/REPO/releases/latest/download/latest.json`。
- `WINDOWS_CERTIFICATE_THUMBPRINT`：导入 Windows runner 后的代码签名证书 SHA-1 thumbprint。

## 必需的仓库 Secrets

- `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：updater artifact 的私钥和密码。
- `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`：Authenticode PFX 与密码。
- `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`：Developer ID 证书。
- `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`：macOS notarization 凭据。

私钥、PFX、密码和 Apple 凭据不得写入仓库、安装包、日志或 Draft Release 正文。发布脚本只生成被
`.gitignore` 排除的 `src-tauri/tauri.release.conf.json`。缺 updater 参数或 Windows thumbprint 时，
工作流会在打包前失败；Windows runner 缺 PFX 时也会失败。macOS 凭据由 Tauri action 用于签名和
notarization。

## 发布流程

1. 生成并离线保存 updater keypair，只把公钥放入 Variable、私钥放入 Secret。
2. 配置 GitHub Release 的 `latest.json` HTTPS 地址。
3. 配置 Windows Authenticode 与 Apple Developer ID/notarization 凭据。
4. 在 `main` 上等待 Windows/macOS/Linux CI 全部通过。
5. 推送与应用版本一致的 tag，例如 `v1.0.0`。
6. 检查 Draft Release 中的平台包、updater 签名和 `latest.json`，在实体机验收后手动发布。

应用设置中的“检查更新”使用 Tauri updater 的签名验证；本地未配置 endpoint 的构建会明确显示
更新未配置，不会回退到下载并执行未签名文件。

当前 `ci.yml` 与 `release.yml` 已通过 actionlint 静态校验。Windows/Linux 本地验收包不带正式签名，
不能替代 tag workflow 的 Authenticode、Developer ID/notarization 和 updater artifact 签名。

# LevelUpAgent 跨平台打包与 GitHub 发布手册

本文记录 LevelUpAgent 使用 GitHub Actions 发布 Windows、macOS 和 Linux 安装包的流程。
同一个 `v*` tag 会创建一个 Draft Release，并在四个原生 runner 上并行构建：Windows x64、
macOS Apple Silicon、macOS Intel，以及 Linux x64。Windows 继续生成 NSIS/MSI 和 Tauri
updater 产物；macOS 生成 DMG；Linux 生成 AppImage、DEB 和 RPM。

> 当前 updater 清单仍只由 Windows job 生成，因此 `latest.json` 只覆盖 Windows 自动更新。
> macOS App 会在所有资源写入后执行 ad-hoc 签名，并验证 DMG 内及模拟复制安装后的签名；当前
> 没有 Apple Developer ID 证书和公证，下载后首次打开可能需要用户在 Gatekeeper 中确认。
> Linux 包未做发行版签名。Tauri updater 签名负责更新完整性校验，
> 不等同于 Windows Authenticode，因此 Windows 安装包仍可能触发 SmartScreen。

已验证记录：v1.0.1 于 2026-07-13 通过提交 `2c7c94d` 和 tag `v1.0.1` 触发 Release 工作流，
Windows 构建、签名、上传和公开发布均已成功完成；公开的 `latest.json` 也已验证可用。

已验证记录：v1.0.33 于 2026-08-23 通过提交 `a8ea9e7` 和 tag `v1.0.33` 完成
Windows、macOS Apple Silicon、macOS Intel 和 Linux 四个 runner 的构建。该 Release 最初仍为
Draft，因此 `v1.0.32` 继续显示 `Latest`；在核对资产并正式发布后，`Latest` 和公开
`latest.json` 已切换到 `v1.0.33`。v1.0.33 现有资产已手工同步为带平台名的新名称；
提交 `2ccffbd` 从后续 tag 开始会在工作流上传阶段自动使用同一命名规则。

## 零、以后每次发布速查

### 从 v1.2.71 起：应用和 3D 通用资源分别发布

应用安装包继续通过 `vX.Y.Z` tag 触发四平台构建，本次应用版本为 `1.2.72`。
Python / PyTorch / CUDA、TripoSG、SD2.1 + MV-Adapter、Blender 不进入应用安装包，
也不再随每个应用版本重复打包或上传。所有额外资源固定放在同一个 Release：

```text
https://github.com/TippingGame/LevelUpAgent/releases/tag/model-workbench-resources
```

- 兼容资源由 `modules/model_workbench/resources.json` 指定；初始独立资源版本 `2026.10.1`，
  目标 `linux-x64-cu118`。应用升级只更新应用版本，兼容资源不变时继续复用已安装环境。
- 本地资源存放在 `$XDG_DATA_HOME/levelup-agent/model-workbench/resources/<资源版本>/<目标>`，
  不再使用应用版本目录。作品仍保存在应用数据目录中。
- 清单名为 `model-workbench-<资源版本>-<目标>.json`，分片名也包含独立资源版本，每片小于 2 GB。
  初始清单：`model-workbench-2026.10.1-linux-x64-cu118.json`。
- 资源 Release 使用 prerelease 且 `--latest=false`，只用于把通用资源与应用更新渠道分开，
  不能上传 `latest.json`；应用正式版（当前 `v1.2.72`）设为 Latest。
- 只有模型、CUDA 或依赖内容变化时才增加资源版本并上传新资产，旧资产保留。
  不覆盖已公开的分片或清单；同名同哈希文件复用，同名不同哈希必须改资源版本。
- 上传顺序：本地校验所有分片与完整归档 → 上传分片并核对 GitHub digest → 最后上传清单。
  首次资源草稿核验后公开，以后向同一 Release 追加独立资源版本。

```powershell
python scripts/package-model-workbench.py --staging <准备好的四组件目录> --output artifacts/model-workbench/release
node scripts/upload-model-workbench.mjs artifacts/model-workbench/release
# 仅首次公开通用资源 Release，核验后执行：
gh release edit model-workbench-resources --draft=false --prerelease --latest=false
```

`3D workbench resources` 工作流仅手动触发，不跟随应用 tag 构建；自托管发布机仍需
`model-workbench` 标签和 `MODEL_WORKBENCH_STAGING`。发布普通应用版本时只确认其固定资源清单
和分片可公开下载，不重复上传 20+ GiB 依赖。详细布局与许可证见仓库 `docs/MODEL_WORKBENCH.md`。

Windows NSIS 安装和卸载程序均在每次启动时读取当前 Windows 显示语言：简体中文、繁体中文、
其他语言回退英文，不沿用旧安装记录中的语言，不显示语言选择器。清理个人数据默认不勾选，
必须在额外警告窗口确认后才勾选；静默升级或卸载保留数据。上述 UI 行为指 EXE/NSIS 安装器。

发布检查新增 `python -B -m unittest discover -s modules/model_workbench/tests -v`；
Linux/WSL 必须覆盖真实进程组取消和目录链接恢复，Windows 原生 NSIS 测试覆盖安装/卸载语言
选择和清理确认状态。正式应用发布前检查资源 Release 不会抢占 Latest。

本文的仓库内同步副本为 `LevelUpAgent/docs/RELEASE_GUIDE.md`，修改发布规范时同时更新两份。

已验证记录：v1.2.71 于 2026-10-09 15:15:28（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `8aa8fc2d18674a38b2d804720b3029ca30c81d94`，三平台 CI run `37888509630`
与四平台 Release run `37888569068` 全部成功。10 个应用资产完整下载并通过 SHA-256 / GitHub
digest 校验，Windows EXE/MSI updater 签名及可信注释签名有效；公开 `latest.json` 返回 200、
版本为 `1.2.71`。正式 EXE 已同步到本机安装包目录，保留旧版并更新 SHA 清单。
通用资源 `2026.10.1` 已在固定 `model-workbench-resources` Release 公开，14 个分片共约
21.7 GiB，分片和完整归档均通过哈希校验，清单最后上传并可公开读取；实际 WSL 启动器读取验证
通过。该资源 Release 为 prerelease，不抢占应用 Latest。安装和卸载语言以及清理确认通过原生
NSIS 隔离测试；本次未覆盖现有安装或从旧版执行应用内更新。
本次同名草稿已核对并归并至 Release ID `407544934`；后续流程通过提交 `d0fe151` 修复，
相关测试、actionlint 和三平台 CI run `37890851601` 通过，不改变本次应用 tag 或安装包。
详细记录：`LevelUpAgent/docs/RELEASE_1.2.71.md`；证据：`research/release-1.2.71-2026-10-09`。

已验证记录：v1.1.70 于 2026-10-09 00:32:57（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `9fa7898024faef4ee8cf230977de644411e9915b`，三平台 CI run `37803173487`
与四平台 Release run `37803201706` 全部成功。10 个资产 SHA-256 与 GitHub digest 一致，
Windows EXE/MSI updater 签名及可信注释签名有效；公开 `latest.json` 返回 200、版本为
`1.1.70`。正式 EXE 已同步到本机安装包目录，保留旧版并更新 SHA 清单。
本次未覆盖现有安装或从旧版执行应用内更新。
详细记录：`LevelUpAgent/docs/RELEASE_1.1.70.md`；证据：`research/release-1.1.70-2026-10-08`。

已验证记录：v1.1.69 于 2026-10-07 19:23:10（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `807964d11ecc5e49156c0e949d4280a3a619bfac`，三平台 CI run `37600393933`
与四平台 Release run `37600398546` 全部成功。10 个资产 SHA-256 与 GitHub digest 一致，
Windows EXE/MSI updater 签名及可信注释签名有效；公开 `latest.json` 返回 200、版本为
`1.1.69`。正式 EXE 已同步到本机安装包目录，保留旧版并更新 SHA 清单。
本次未调用真实上游服务，未覆盖现有安装或从旧版执行应用内更新。
详细记录：`LevelUpAgent/docs/RELEASE_1.1.69.md`；证据：`research/release-1.1.69-2026-10-07`。

已验证记录：v1.1.68 于 2026-10-07 04:23:34（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `3774e14814ed619cad80efee99a7b5c3dfdb9ae1`，三平台 CI run `37521611398`
与四平台 Release run `37521631101` 成功。Windows 首次编译成功，但下载 NSIS 辅助 DLL
时 GitHub 返回 HTTP 500；仅重跑失败作业后成功，未改动构建提交或 tag。10 个资产 SHA-256
与 GitHub digest 一致，Windows EXE/MSI updater 签名有效；公开 `latest.json` 返回 200、
版本为 `1.1.68`。正式 EXE 已同步到本机安装包目录，保留旧版并更新 SHA 清单。
本次未调用真实上游生图服务，未覆盖现有安装或从旧版执行应用内更新。
详细记录：`LevelUpAgent/docs/RELEASE_1.1.68.md`；证据：`research/release-1.1.68-2026-10-07`。

已验证记录：v1.1.67 于 2026-10-05 22:56:21（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `b54a8970fddbcb8eeeb23c6a5e8f2a8ff1f1e560`，三平台 CI run `37326002407`
与四平台 Release run `37326006685` 成功。Windows CI 首次两个已有 Python Hook 测试未取得
上下文，仅重跑失败作业后通过，未改动构建提交或 tag。10 个资产 SHA-256 与 GitHub digest
一致，Windows EXE/MSI updater 签名有效；公开 `latest.json` 返回 200、版本为 `1.1.67`。
正式 EXE 已同步到本机安装包目录，保留旧版本并更新 SHA 清单。浏览器和隔离 Tauri 原生窗口
各通过 32 项外观检查，覆盖系统深浅色、破甲开关、创作空间、弹窗、Portal 和桌宠聊天头像。
本次未覆盖现有安装或从旧版执行应用内更新。详细记录：`LevelUpAgent/docs/RELEASE_1.1.67.md`；
证据：`research/release-1.1.67-2026-10-05`。

已验证记录：v1.1.66 于 2026-10-05 19:21:15（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `dc4b3065e72cac9e55674cf5f0c9566b980109a4`，三平台 CI run `37297299227`
与四平台 Release run `37297320357` 成功；Apple Silicon 的 `hdiutil verify` 首次出现
`Resource temporarily unavailable`，仅重跑失败作业后通过。10 个资产 SHA-256 与 GitHub
digest 一致，Windows EXE/MSI updater 签名有效；公开 `latest.json` 返回 200、版本为
`1.1.66`。正式 EXE 已同步到本机安装包目录，保留旧版本并更新 SHA 清单。
本次完成隔离 Tauri 桌宠/主题工具策略与主题生命周期验证，未调用真实生图，也未覆盖安装或
从旧版执行应用内更新。详细记录：`LevelUpAgent/docs/RELEASE_1.1.66.md`；
证据：`research/release-1.1.66-2026-10-05`。

已验证记录：v1.1.65 于 2026-10-05 09:02:59（Asia/Shanghai）正式发布并设为 Latest。
构建提交 `6ffa6b192b4f5855a0c64319477e8a236d50b051`，三平台 CI run `37248488026`
与四平台 Release run `37248857232` 全部成功。10 个资产 SHA-256 与 GitHub digest 一致，
Windows EXE/MSI 的 updater 签名通过公钥验证；公开 `latest.json` 返回 200、版本为 `1.1.65`，
URL 与签名匹配。正式 EXE 已替换本机安装包，两份 SHA 清单已更新。本次未执行用户机器上的
覆盖安装或从旧版应用内更新。详细记录：`LevelUpAgent/docs/RELEASE_1.1.65.md`；
证据：`research/release-1.1.65-2026-10-05`。

首次密钥和 GitHub 配置完成后，日常发布只需要：

1. 把 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本改成同一个新版本。
2. 运行本地检查，确认准备提交的文件里没有密钥。
3. 提交并推送 `main`。
4. 创建并推送同版本的 `v*` tag。
5. 等待 GitHub Actions 的 Release 工作流成功。
6. 在 GitHub Releases 中检查 Draft 资产，然后点击 `Publish release`。
7. 验证 `latest.json`，再用旧版本测试应用内更新。

当前发布电脑已经通过 Windows Git Credential Manager 保存了 `TippingGame` 的 GitHub 授权。
因此 `git push` 可以直接复用系统凭据；即使没有安装 GitHub CLI，也可以在不显示令牌的前提下，
复用同一凭据调用 GitHub API 检查并发布 Draft Release，不需要再次登录浏览器。

以发布 `1.0.2` 为例，核心 Git 命令是：

```powershell
cd G:\Work\LevelUpAgent\LevelUpAgent
git status --short
git diff --check
git add -A
git diff --cached --stat
git commit -m "release: prepare v1.0.2 Windows updater"
git push origin main
git tag -a v1.0.2 -m "LevelUpAgent v1.0.2"
git push origin v1.0.2
```

不要直接复用这段示例中的版本号。tag 一旦推送，GitHub Actions 就会开始正式打包。

## 一、目录和关键文件

项目目录：

```text
G:\Work\LevelUpAgent\LevelUpAgent
```

发布相关文件：

```text
.github/workflows/release.yml
scripts/write-release-config.mjs
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
package.json
```

GitHub 仓库：

```text
https://github.com/TippingGame/LevelUpAgent
```

更新清单固定地址：

```text
https://github.com/TippingGame/LevelUpAgent/releases/latest/download/latest.json
```

## 二、首次配置：生成 updater 密钥

密钥只需生成一次。后续所有版本必须继续使用同一私钥，否则旧版本无法验证新更新。

在项目目录打开 PowerShell：

```powershell
cd G:\Work\LevelUpAgent\LevelUpAgent
New-Item -ItemType Directory -Force "$HOME\.tauri" | Out-Null
corepack pnpm tauri signer generate -w "$HOME\.tauri\levelupagent.key"
```

按照提示设置一个强密码。输入密码时终端不会显示字符，这是正常现象。

生成文件：

```text
C:\Users\<用户名>\.tauri\levelupagent.key       updater 私钥
C:\Users\<用户名>\.tauri\levelupagent.key.pub   updater 公钥
```

必须离线备份私钥，并把密码保存到密码管理器。不要把私钥或密码提交到 Git。

如果 `pnpm` 命令可直接使用，也可以把上述命令中的 `corepack pnpm` 换成 `pnpm`。

## 三、首次配置：GitHub Variables 和 Secrets

进入：

```text
Repository → Settings → Secrets and variables → Actions
```

### Repository variables

添加以下两个 Repository variables，不要添加到 Environment variables：

| Name | Value |
| --- | --- |
| `TAURI_UPDATER_ENDPOINT` | `https://github.com/TippingGame/LevelUpAgent/releases/latest/download/latest.json` |
| `TAURI_UPDATER_PUBKEY` | `levelupagent.key.pub` 的完整内容 |

复制公钥：

```powershell
Get-Content -Raw "$HOME\.tauri\levelupagent.key.pub" | Set-Clipboard
```

### Repository secrets

在 Secrets 页签下方的 Repository secrets 添加：

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `levelupagent.key` 的完整内容，不是文件路径 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的密码 |

复制私钥：

```powershell
Get-Content -Raw "$HOME\.tauri\levelupagent.key" | Set-Clipboard
```

粘贴到 GitHub Secret 后清空剪贴板：

```powershell
Set-Clipboard ""
```

## 四、每次发布前升级版本

假设准备发布 `v1.0.2`，文件内版本号填写 `1.0.2`，Git tag 才带前缀 `v`。

同步修改：

```text
package.json                  version
src-tauri/Cargo.toml          package.version
src-tauri/tauri.conf.json     version
README.md                     Version 徽章（如保留）
README_EN.md                  Version 徽章（如保留）
```

运行 Rust 检查后，`src-tauri/Cargo.lock` 中 `levelup-agent` 的版本也应同步更新。

检查版本是否一致：

```powershell
rg -n '1\.0\.2|v1\.0\.2' package.json src-tauri\Cargo.toml src-tauri\Cargo.lock src-tauri\tauri.conf.json README.md README_EN.md
```

不要在没有升级应用版本的情况下重复发布相同 tag。Tauri updater 只接受比当前版本更高的版本。

## 五、发布前本地检查

在项目根目录执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm build
cargo fmt --check --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml
cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings
```

如果电脑已经可以直接使用 `pnpm`，可以去掉 `corepack` 前缀。
以上命令必须全部通过后再提交版本号和 tag；其中 Clippy 命令与 GitHub CI 使用的门禁一致，
任何警告都会被视为错误，不能只以 `cargo test` 或本地构建成功作为发布依据。

可选：检查 GitHub Actions 工作流语法：

```powershell
go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/ci.yml .github/workflows/release.yml
```

提交前确认没有私钥或临时发布配置进入 Git：

```powershell
git status --short
git diff --check
```

`src-tauri/tauri.release.conf.json` 是发布时临时生成的配置，已被 `.gitignore` 排除，不应提交。

### 可选：本机生成普通安装包

如果只想在本机试装，可执行：

```powershell
corepack pnpm tauri build
```

常见输出目录：

```text
src-tauri\target\release\bundle\nsis
src-tauri\target\release\bundle\msi
```

本地默认配置不会启用 updater，也不会生成可用于正式自动更新的签名发布。正式发布仍应推送 `v*` tag，
由 GitHub Actions 注入公钥、endpoint 和签名 Secrets 后构建。

## 六、提交、推送和创建 tag

确认检查全部通过后执行。将示例版本替换成实际版本：

```powershell
git add -A
git commit -m "release: prepare v1.0.2 Windows updater"
git push origin main
git tag -a v1.0.2 -m "LevelUpAgent v1.0.2"
git push origin v1.0.2
```

应先成功推送 `main`，再推送 tag。推送 `v*` tag 会触发：

```text
.github/workflows/release.yml
```

### Windows Git Credential Manager 授权

当前发布电脑的 Git Credential Manager 中已经保存 `TippingGame` 账号授权。可以先用只读式的
dry-run 验证凭据和推送权限：

```powershell
git push --dry-run origin main
```

如果输出 `Everything up-to-date` 或显示正常的待推送引用，而没有要求重新登录，说明系统凭据可用。
之后正常执行 `git push origin main` 和 `git push origin vX.Y.Z` 即可。

注意：

- 360 极速浏览器、Codex 内置浏览器与 Git Credential Manager 是相互独立的登录会话。
- 浏览器是否登录不影响 Git 复用 Credential Manager 中的授权。
- 不要运行会把 `git credential fill` 的完整结果打印到终端、日志或聊天中的命令，其中可能包含访问令牌。
- 发布脚本可以把凭据临时保存在当前 PowerShell 进程内存中调用 GitHub API，但不得写入文件或输出令牌。
- 换电脑、清理 Windows 凭据或令牌失效后，需要重新通过 Git Credential Manager 完成 GitHub 授权。

运行状态：

```text
https://github.com/TippingGame/LevelUpAgent/actions/workflows/release.yml
```

当前工作流会：

1. 在 `ubuntu-latest` 上创建或复用当前 tag 的 Draft Release。
2. 在 `windows-latest`、`macos-latest`、`macos-15-intel` 和 `ubuntu-22.04` 上并行安装依赖。
3. Windows job 注入 updater endpoint、公钥、私钥和密码。
4. 生成 Windows NSIS/MSI、macOS Apple Silicon/Intel DMG，以及 Linux AppImage/DEB/RPM；macOS
   会在资源写入完成后重新签名，并验证 DMG 和模拟安装后的 App。
5. 只在 Windows job 生成 updater 签名文件和 `latest.json`，避免多个平台并行覆盖同一清单。
6. 所有平台资产上传到同一个 Draft Release，等待人工检查后发布。
7. 上传时统一把平台和架构写入文件名，避免用户下载错误的安装包。

## 七、跨平台 GitHub Actions 与费用边界

工作流文件为：

```text
.github/workflows/release.yml
```

推送 `vX.Y.Z` tag 后，`create-release` job 先从 Release 列表中创建或复用唯一 Draft，
不能依赖可能对草稿返回 404 的 tag 查询。所有上传使用该 job 输出的 Release ID，
避免同名草稿导致四平台资产分散；发现多个同名草稿时应先按 digest 归并，确认资产齐全再重试。
随后 `bundle` job 使用矩阵分别运行：

| Runner | 架构 | 产物 |
| --- | --- | --- |
| `windows-latest` | x64 | `LevelUpAgent_<版本>_Windows_x64-setup.exe`、MSI、updater `.sig`、`latest.json` |
| `macos-latest` | arm64 | `LevelUpAgent_<版本>_macOS_Apple-Silicon.dmg` |
| `macos-15-intel` | x64 | `LevelUpAgent_<版本>_macOS_Intel-x64.dmg` |
| `ubuntu-22.04` | x64 | `LevelUpAgent_<版本>_Linux_x64.AppImage`、DEB、RPM |

GitHub 官方规则是：公开仓库使用标准 GitHub-hosted runners 时，Actions runner 使用免费且不限
时长；这适用于本项目的 `windows-latest`、`macos-*` 和 `ubuntu-22.04`。不要改用 larger
runners，因为 larger runners 即使在公开仓库也会收费。Workflow artifacts 和缓存仍受仓库的
存储保留策略约束；本发布流程直接上传 Release 资产，正式发布后不依赖长期保存的 workflow
artifact。

官方说明：

- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Tauri Action](https://github.com/tauri-apps/tauri-action)

“免费”只表示 GitHub 对公开仓库的标准 runner 不收取 Actions 分钟费用；Apple Developer
Program、Developer ID 证书、公证服务之外的商业服务仍可能产生费用。本仓库当前没有配置
Apple 证书，因此 macOS 包使用 ad-hoc 签名并完成结构校验，但仍是未公证包。

### 首次启用前检查

1. 仓库必须是公开仓库，且 Actions 没有被仓库或组织策略禁用。
2. 保留原有的 `TAURI_UPDATER_PUBKEY`、`TAURI_UPDATER_ENDPOINT`、
   `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 配置；它们只供
   Windows updater job 使用。
3. 确认仓库允许 Actions 使用 `contents: write`，因为工作流需要创建 Draft Release 并上传资产。
4. 先用一个新的补丁版本 tag 试跑，不要覆盖已经发布的 tag。

### 本地对应命令

Windows：

```powershell
corepack pnpm tauri build
```

macOS 原生双架构和 DMG 校验：

```bash
SKIP_CHECK=1 pnpm build:macos
```

Linux：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf rpm
pnpm install --frozen-lockfile
pnpm tauri build --bundles appimage,deb,rpm --no-sign
```

GitHub Actions 使用的是原生 runner，不是在 Windows 上交叉模拟 Linux 或 macOS；因此安装包
会使用对应平台的系统库和打包工具。

## 八、检查并发布 Draft Release

Actions 成功后打开 Releases 列表：

```text
https://github.com/TippingGame/LevelUpAgent/releases
```

必须登录拥有仓库写权限的 GitHub 账号。在 Releases 列表中找到带 `Draft` 标记的版本，点击
`Edit`，不要进入 `Tags → vX.Y.Z`。Tag 页面只显示源码包，不会显示 `Publish release`。

发布前至少检查以下资产：

```text
LevelUpAgent_<版本>_Windows_x64-setup.exe
LevelUpAgent_<版本>_Windows_x64-setup.exe.sig
LevelUpAgent_<版本>_Windows_x64.msi
LevelUpAgent_<版本>_Windows_x64.msi.sig
LevelUpAgent_<版本>_macOS_Apple-Silicon.dmg
LevelUpAgent_<版本>_macOS_Intel-x64.dmg
LevelUpAgent_<版本>_Linux_x64.AppImage
LevelUpAgent_<版本>_Linux_x64.deb
LevelUpAgent_<版本>_Linux_x64.rpm
latest.json
```

上述文件名是工作流中的固定上传名称。Windows 的安装包、对应签名和 `latest.json` 必须存在；
macOS/Linux 则应有表中对应架构的安装包。macOS DMG 已做 ad-hoc 签名和安装复制校验，但因为
当前没有 Apple 公证，首次打开仍可能需要在系统设置中允许。

确认后点击 `Publish release`。工作流成功只表示安装包已构建并上传到 Draft，不会自动把
Draft 发布为正式 Release。在 Draft 发布之前：

- GitHub 不会给该版本标记 `Latest`。
- `/releases/latest` 和 `/releases/latest/download/latest.json` 仍然指向上一个已正式发布的非预发布版本。
- 如果仓库还没有任何正式 Release，上述 `latest` 地址才可能返回 404。

例如 `v1.0.33` 仍是 Draft 时，`v1.0.32` 继续显示 `Latest` 是正常现象，不是 tag 迁移失败。
发布 `v1.0.33` 后，GitHub 才会重新计算 `Latest`，更新端点也才会切换到 `1.0.33`。

也可以用 GitHub CLI 正式发布已核对的 Draft：

```powershell
gh release edit v1.0.33 --draft=false --latest
```

执行前必须先核对资产和 `latest.json`，并把命令中的版本换成实际待发布版本。

如果本机没有安装 `gh`，也不必为了发布单独安装。当前发布电脑可以沿用 Windows Git Credential
Manager 中已有的 `TippingGame` 授权，通过 GitHub API 完成以下操作：

1. 查询 `vX.Y.Z` 对应的 Draft Release。
2. 核对安装包、`.sig` 和 `latest.json`。
3. 下载并解析 Draft 中的 `latest.json`，检查版本、下载 URL 与签名字段。
4. 将 Release 的 `draft` 更新为 `false`，正式发布。

该方式与网页点击 `Publish release` 效果相同。执行时只应输出账号名、仓库权限、Release 状态和资产
元数据，不应输出 Credential Manager 返回的密码或令牌。2026-07-14 发布 `v1.0.3` 时已验证：
系统凭据识别为 `TippingGame`，具有 `TippingGame/LevelUpAgent` 的 Admin 权限，并成功完成 Draft
核验、正式发布和公开 `latest.json` 验证。

## 九、发布后验证

验证 `latest.json` 已公开：

```powershell
$url = "https://github.com/TippingGame/LevelUpAgent/releases/latest/download/latest.json"
Invoke-WebRequest -UseBasicParsing -Method Head $url
Invoke-RestMethod $url | ConvertTo-Json -Depth 10
```

应确认：

- HTTP 状态为 200。
- `version` 是刚发布的版本。
- Windows 下载 URL 指向本次 Release 中带 `Windows_x64` 标识的资产。
- `signature` 字段存在且非空。
- Release 资产列表中同时存在带 `macOS_Apple-Silicon`、`macOS_Intel-x64` 和
  `Linux_x64` 标识的安装包。

也可以直接打开：

```text
https://github.com/TippingGame/LevelUpAgent/releases/latest
https://github.com/TippingGame/LevelUpAgent/releases/latest/download/latest.json
```

再从 Releases 下载 Windows 安装包，完成一次实体机安装或覆盖安装验证。

应用只会提示高于当前版本的更新。因此发布 `v1.0.2` 后，应使用已安装的 `v1.0.1` 测试应用内
“检查更新”。同版本不会提示更新。

## 十、`.sig` 文件的作用

例如：

```text
LevelUpAgent_1.0.1_x64-setup.exe.sig
```

`.sig` 是 Tauri updater 签名文件。应用下载更新后，会使用编译进应用的公钥验证安装包：

- 证明更新由对应私钥签署。
- 检测下载文件是否被替换或篡改。
- 验证失败时拒绝安装。

`.sig` 可以公开，不包含私钥。用户无需手动打开它。签名完成后不能替换或修改对应安装包，否则
签名立即失效。

## 十一、版本迁移说明

- 已发布的 v1.0.0 没有启用 updater，无法自动升级。
- v1.0.0 用户必须手动下载安装一次 updater 版 v1.0.1。
- 从 v1.0.1 开始，后续更高版本可以使用应用内自动更新。
- 不能丢失 updater 私钥或密码；丢失后无法为现有安装生成可验证的新更新。

## 十二、常见问题

### 1. PowerShell 找不到 `pnpm`

直接通过 Corepack 调用：

```powershell
corepack prepare pnpm@11.7.0 --activate
corepack pnpm --version
corepack pnpm check
```

如果 `corepack enable` 报 `C:\Program Files\nodejs\pnpm` 的 EPERM，无需管理员权限，继续使用
`corepack pnpm ...` 即可。

### 2. 应用显示“更新未配置”

常见原因：

- 使用了普通本地构建；本地构建默认关闭 updater。
- 使用的是未启用 updater 的 v1.0.0。
- Release 构建时没有设置 `LEVELUP_ENABLE_UPDATER`。

正式 tag workflow 只在 Windows job 设置该编译开关；macOS/Linux 当前发布的是不带应用内 updater
配置的原生安装包。

### 3. 找不到 `Publish release`

正在查看的是 Tag 页面。返回仓库的 Releases 列表，找到 `Draft`，点击 `Edit` 后在页面底部发布。
Draft 只对拥有仓库权限且已登录的账号可见。

### 4. `latest.json` 返回 404

检查：

- Draft 是否已经 Publish。
- `latest.json` 是否已上传到最新公开 Release。
- `TAURI_UPDATER_ENDPOINT` 是否完全正确。
- 最新 Release 是否被标记为 prerelease；`releases/latest` 不选择 prerelease。

如果该地址返回 200，但其中版本仍是上一版，先检查新 Release 是否仍标记为 `Draft`。
Draft 不参与 `Latest` 选择，必须先正式发布。

### 5. Actions 在准备发布配置时失败

检查以下名称是否完全一致，并确认添加在 Repository 层级：

```text
Repository variables:
TAURI_UPDATER_ENDPOINT
TAURI_UPDATER_PUBKEY

Repository secrets:
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

私钥 Secret 必须是文件完整内容，不是本机路径。

### 6. 签名验证失败

可能原因：

- `.sig` 与安装包不属于同一次构建。
- 签名后替换了安装包。
- 新版本使用了不同的 updater 私钥。
- `latest.json` 中的签名或下载 URL 指向了错误资产。

不要覆盖已经发布的签名资产。需要修复时优先升级补丁版本并重新发布。

### 7. Windows 显示未知发布者或 SmartScreen

这是因为当前流程只有 Tauri updater 签名，没有 Authenticode。Tauri 签名保护自动更新链路，但不会
向 Windows 注册系统级发布者身份。如需消除该提示，需要另行购买并配置 Windows 代码签名证书。

## 十三、安全检查清单

发布前确认：

- [ ] 私钥文件位于仓库之外。
- [ ] 私钥与密码已有至少一份安全离线备份。
- [ ] GitHub 中公钥和 endpoint 使用 Repository variables。
- [ ] GitHub 中私钥和密码使用 Repository secrets。
- [ ] 没有把私钥、密码或临时发布配置提交到 Git。
- [ ] 三个核心版本号完全一致。
- [ ] 本地构建和测试全部通过。
- [ ] tag 与应用版本一致。
- [ ] Actions 构建成功。
- [ ] Draft 中存在 Windows 安装包、`.sig`、`latest.json`，以及 macOS/Linux 安装包。
- [ ] Publish 后 `latest.json` 返回 200。
- [ ] 已完成 Windows 实体机安装或更新验证。
- [ ] 至少完成一次 macOS DMG 和 Linux 安装包的实际安装验证。

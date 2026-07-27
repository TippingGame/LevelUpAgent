#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '错误：macOS DMG 必须在 macOS 上构建。\n' >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '错误：找不到命令 %s，请先安装对应工具。\n' "$1" >&2
    exit 1
  fi
}

require_command node
require_command pnpm
require_command rustup
require_command cargo
require_command codesign
require_command ditto
require_command hdiutil
require_command lipo
require_command security
require_command shasum

PNPM_BIN="$(command -v pnpm)"
VERSION="$(node -p "require('./package.json').version")"
OUTPUT_DIR="$ROOT_DIR/artifacts/macos"
SKIP_CHECK="${SKIP_CHECK:-0}"
SIGNING_IDENTITY="${MACOS_SIGNING_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
NOTARY_PROFILE="${MACOS_NOTARY_PROFILE:-}"
WORK_DIR=""
ACTIVE_MOUNT=""

# pnpm 10+ can try to replace itself with the version in package.json. This
# makes the script work with an already-installed pnpm without changing the
# user's global pnpm directory.
export npm_config_manage_package_manager_versions=false

has_rust_target() {
  rustup target list --installed | grep -Fxq "$1"
}

ensure_rust_target() {
  local target="$1"
  if has_rust_target "$target"; then
    return
  fi

  printf '正在安装 Rust target %s...\n' "$target"
  rustup target add "$target"
}

# Set CARGO_REGISTRY_MIRROR when crates.io is inaccessible, for example:
#   CARGO_REGISTRY_MIRROR='sparse+https://rsproxy.cn/index/' pnpm build:macos
# The temporary config is removed automatically and does not change the repo.
TEMP_CARGO_CONFIG=0
if [[ -n "${CARGO_REGISTRY_MIRROR:-}" && ! -e "$ROOT_DIR/.cargo/config.toml" ]]; then
  mkdir -p "$ROOT_DIR/.cargo"
  printf '%s\n' \
    '[source.crates-io]' \
    'replace-with = "levelup-mirror"' \
    '' \
    '[source.levelup-mirror]' \
    "registry = \"${CARGO_REGISTRY_MIRROR}\"" \
    '' \
    '[net]' \
    'retry = 2' > "$ROOT_DIR/.cargo/config.toml"
  TEMP_CARGO_CONFIG=1
fi

cleanup() {
  if [[ -n "$ACTIVE_MOUNT" ]]; then
    hdiutil detach "$ACTIVE_MOUNT" -quiet 2>/dev/null || true
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  if [[ "$TEMP_CARGO_CONFIG" == 1 ]]; then
    rm -f "$ROOT_DIR/.cargo/config.toml"
    rmdir "$ROOT_DIR/.cargo" 2>/dev/null || true
  fi
}
trap cleanup EXIT

resolve_signing_identity() {
  local identities

  if [[ -n "$SIGNING_IDENTITY" ]]; then
    return
  fi

  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  SIGNING_IDENTITY="$(printf '%s\n' "$identities" \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
    | sed -n '1p')"
  if [[ -z "$SIGNING_IDENTITY" ]]; then
    SIGNING_IDENTITY="-"
  fi
}

sign_app() {
  local app_path="$1"

  if [[ "$SIGNING_IDENTITY" == "-" ]]; then
    codesign --force --deep --sign - "$app_path"
  else
    codesign --force --deep --options runtime --timestamp \
      --sign "$SIGNING_IDENTITY" "$app_path"
  fi
  codesign --verify --deep --strict --verbose=2 "$app_path"
}

create_dmg() {
  local app_path="$1"
  local label="$2"
  local dmg_output="$3"
  local staging_dir="$WORK_DIR/staging-$label"

  mkdir -p "$staging_dir"
  ditto "$app_path" "$staging_dir/LevelUpAgent.app"
  ln -s /Applications "$staging_dir/Applications"
  hdiutil create \
    -volname "LevelUpAgent $VERSION ($label)" \
    -srcfolder "$staging_dir" \
    -format UDZO \
    -ov \
    "$dmg_output" >/dev/null

  if [[ "$SIGNING_IDENTITY" != "-" ]]; then
    codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$dmg_output"
    codesign --verify --verbose=2 "$dmg_output"
  fi

  if [[ -n "$NOTARY_PROFILE" ]]; then
    xcrun notarytool submit "$dmg_output" \
      --keychain-profile "$NOTARY_PROFILE" \
      --wait
    xcrun stapler staple "$dmg_output"
    xcrun stapler validate "$dmg_output"
  fi
}

verify_dmg() {
  local dmg_path="$1"
  local label="$2"
  local expected_arch="$3"
  local mount_dir="$WORK_DIR/mount-$label"
  local bundled_app
  local bundled_binary
  local actual_arch

  hdiutil verify "$dmg_path" >/dev/null
  mkdir -p "$mount_dir"
  hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
  ACTIVE_MOUNT="$mount_dir"
  bundled_app="$mount_dir/LevelUpAgent.app"
  bundled_binary="$bundled_app/Contents/MacOS/levelup-agent"

  if [[ ! -x "$bundled_binary" ]]; then
    printf '错误：%s 内没有可执行的 LevelUpAgent 主程序。\n' "$dmg_path" >&2
    exit 1
  fi

  actual_arch="$(lipo -archs "$bundled_binary")"
  if [[ "$actual_arch" != "$expected_arch" ]]; then
    printf '错误：%s 预期架构为 %s，实际为 %s。\n' \
      "$dmg_path" "$expected_arch" "$actual_arch" >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$bundled_app"

  hdiutil detach "$mount_dir" -quiet
  ACTIVE_MOUNT=""
}

resolve_signing_identity
if [[ -n "$NOTARY_PROFILE" && "$SIGNING_IDENTITY" == "-" ]]; then
  printf '错误：公证需要 Developer ID Application 签名，不能使用 ad-hoc 签名。\n' >&2
  exit 1
fi
if [[ -n "$NOTARY_PROFILE" ]]; then
  require_command xcrun
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/levelup-macos-build.XXXXXX")"

printf 'LevelUpAgent %s macOS 双架构打包\n' "$VERSION"
printf '项目目录：%s\n\n' "$ROOT_DIR"
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  printf '警告：未找到 Developer ID Application 证书，将使用 ad-hoc 签名。\n'
  printf '此产物签名结构完整，可用于本机测试，但在其他 Mac 上首次打开仍会触发 Gatekeeper。\n'
else
  printf '代码签名：%s\n' "$SIGNING_IDENTITY"
  if [[ -n "$NOTARY_PROFILE" ]]; then
    printf 'Apple 公证：钥匙串配置 %s\n' "$NOTARY_PROFILE"
  else
    printf '警告：没有设置 MACOS_NOTARY_PROFILE，产物不会提交 Apple 公证。\n'
  fi
fi

ensure_rust_target x86_64-apple-darwin
ensure_rust_target aarch64-apple-darwin

printf '\n安装前端依赖...\n'
"$PNPM_BIN" install --frozen-lockfile

if [[ "$SKIP_CHECK" != 1 ]]; then
  printf '\n运行项目检查...\n'
  "$PNPM_BIN" check
else
  printf '\nSKIP_CHECK=1，跳过项目检查。\n'
fi

mkdir -p "$OUTPUT_DIR"
SHA_FILE="$OUTPUT_DIR/SHA256SUMS.txt"
: > "$SHA_FILE"

build_target() {
  local target="$1"
  local label="$2"
  local expected_arch="$3"
  local bundle_dir="$ROOT_DIR/src-tauri/target/$target/release/bundle"
  local app_source="$bundle_dir/macos/LevelUpAgent.app"
  local app_binary="$app_source/Contents/MacOS/levelup-agent"
  local actual_arch
  local dmg_output

  printf '\n构建 %s（%s）...\n' "$label" "$target"
  "$PNPM_BIN" tauri build --target "$target" --bundles app --no-sign

  if [[ ! -x "$app_binary" ]]; then
    printf '错误：没有找到 %s 的 app 主程序。\n' "$target" >&2
    exit 1
  fi
  actual_arch="$(lipo -archs "$app_binary")"
  if [[ "$actual_arch" != "$expected_arch" ]]; then
    printf '错误：%s 预期架构为 %s，实际为 %s。\n' \
      "$app_binary" "$expected_arch" "$actual_arch" >&2
    exit 1
  fi

  printf '签名 %s 应用包...\n' "$label"
  sign_app "$app_source"

  dmg_output="$OUTPUT_DIR/LevelUpAgent_${VERSION}_${label}.dmg"
  printf '创建并校验 %s DMG...\n' "$label"
  create_dmg "$app_source" "$label" "$dmg_output"
  verify_dmg "$dmg_output" "$label" "$expected_arch"
  LC_ALL=C shasum -a 256 "$dmg_output" | tee -a "$SHA_FILE"
  printf '完成：%s\n' "$dmg_output"
}

build_target x86_64-apple-darwin x64 x86_64
build_target aarch64-apple-darwin aarch64 arm64

printf '\n全部完成。安装包位于：%s\n' "$OUTPUT_DIR"
printf '校验文件：%s\n' "$SHA_FILE"

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
require_command hdiutil
require_command shasum

PNPM_BIN="$(command -v pnpm)"
VERSION="$(node -p "require('./package.json').version")"
OUTPUT_DIR="$ROOT_DIR/artifacts/macos"
SKIP_CHECK="${SKIP_CHECK:-0}"

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
  if [[ "$TEMP_CARGO_CONFIG" == 1 ]]; then
    rm -f "$ROOT_DIR/.cargo/config.toml"
    rmdir "$ROOT_DIR/.cargo" 2>/dev/null || true
  fi
}
trap cleanup EXIT

printf 'LevelUpAgent %s macOS 双架构打包\n' "$VERSION"
printf '项目目录：%s\n\n' "$ROOT_DIR"

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
  local bundle_dir="$ROOT_DIR/src-tauri/target/$target/release/bundle"
  local dmg_source
  local dmg_output

  printf '\n构建 %s（%s）...\n' "$label" "$target"
  "$PNPM_BIN" tauri build --target "$target" --bundles app,dmg

  dmg_source="$(find "$bundle_dir/dmg" -maxdepth 1 -type f -name "LevelUpAgent_${VERSION}_*.dmg" -print -quit)"
  if [[ -z "$dmg_source" ]]; then
    printf '错误：没有找到 %s 的 DMG 产物。\n' "$target" >&2
    exit 1
  fi

  dmg_output="$OUTPUT_DIR/LevelUpAgent_${VERSION}_${label}.dmg"
  cp "$dmg_source" "$dmg_output"
  hdiutil verify "$dmg_output" >/dev/null
  shasum -a 256 "$dmg_output" | tee -a "$SHA_FILE"
  printf '完成：%s\n' "$dmg_output"
}

build_target x86_64-apple-darwin x64
build_target aarch64-apple-darwin aarch64

printf '\n全部完成。安装包位于：%s\n' "$OUTPUT_DIR"
printf '校验文件：%s\n' "$SHA_FILE"

#!/usr/bin/env bash
# 在本机 WSL（Ubuntu）里隔离构建 + 测试 sandbox（linux 目标）：
# 把源码拷到 ext4（排除 Windows 侧 `target/` 与 cargo v4 lockfile），让发行版 cargo 生成自己的锁，
# 避免与 Windows 侧构建产物 / 锁文件互相污染；仓库本体不被改动。
#
# 前置：WSL 里已 `apt-get install -y cargo rustc build-essential`。
# 用法：bash plugins/sandbox/tools/wsl-test.sh test
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DST="${CHRONO_WSL_SRC:-/tmp/chrono-wsl}"
TARGET="${CARGO_TARGET_DIR:-/tmp/chrono-target}"

rm -rf "$DST"
mkdir -p "$DST/plugins" "$DST/plugin-sdk"
tar -C "$SRC/plugins" --exclude=sandbox/target -cf - sandbox | tar -C "$DST/plugins" -xf -
tar -C "$SRC/plugin-sdk" -cf - rust | tar -C "$DST/plugin-sdk" -xf -
rm -f "$DST/plugins/sandbox/Cargo.lock"

cd "$DST/plugins/sandbox"
CARGO_TARGET_DIR="$TARGET" cargo "$@"

#!/usr/bin/env bash
# Initialize a fresh worktree: trust + install mise tools, then bun dependencies.
set -euo pipefail

cd "$(dirname "$0")"

command -v mise >/dev/null 2>&1 || { echo "error: mise is not installed" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "error: bun is not installed" >&2; exit 1; }

mise trust --all
mise install

bun install --frozen-lockfile

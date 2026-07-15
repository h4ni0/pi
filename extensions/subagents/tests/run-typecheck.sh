#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_dir="$(cd "$here/.." && pwd)"
pi_root="${PI_CODING_AGENT_MODULE_DIR:-$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent}"
modules="$extension_dir/node_modules"

# Keep compiler plugins and subprocesses outside the live Pi broker identity.
for variable in "${!PI_SUBAGENT_@}"; do
  unset "$variable"
done

if [[ -e "$modules" ]]; then
  echo "Refusing to replace existing $modules" >&2
  exit 2
fi
cleanup() { rm -rf "$modules"; }
trap cleanup EXIT

mkdir -p "$modules/@earendil-works" "$modules/@types"
for package in pi-agent-core pi-ai pi-tui; do
  ln -s "$pi_root/node_modules/@earendil-works/$package" "$modules/@earendil-works/$package"
done
ln -s "$pi_root" "$modules/@earendil-works/pi-coding-agent"
ln -s "$pi_root/node_modules/typebox" "$modules/typebox"
ln -s "$pi_root/node_modules/@types/node" "$modules/@types/node"

bun_version="$(bun --version)"
bun_types="$HOME/.bun/install/cache/bun-types@${bun_version}@@@1"
if [[ ! -d "$bun_types" ]]; then
  echo "Missing Bun type package for Bun $bun_version at $bun_types" >&2
  exit 2
fi
ln -s "$bun_types" "$modules/bun-types"

cd "$extension_dir/../.."
bunx --bun --package typescript@5.9.3 tsc -p extensions/subagents/tests/tsconfig.json

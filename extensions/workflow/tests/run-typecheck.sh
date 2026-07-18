#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_dir="$(cd "$here/.." && pwd)"
pi_root="${PI_CODING_AGENT_MODULE_DIR:-$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent}"
modules="$extension_dir/node_modules"
created=()
cleanup() {
  for ((i=${#created[@]}-1; i>=0; i--)); do rm -rf "${created[$i]}"; done
}
trap cleanup EXIT
[[ -f "$modules/yaml/package.json" && ! -L "$modules/yaml" ]] || {
  echo "Missing installed runtime dependency. Run: npm ci --omit=dev --prefix $extension_dir" >&2
  exit 2
}
mkdir -p "$modules/@earendil-works" "$modules/@types"
for package in pi-agent-core pi-ai pi-tui; do
  target="$modules/@earendil-works/$package"
  [[ ! -e "$target" ]] || { echo "Refusing to replace existing $target" >&2; exit 2; }
  ln -s "$pi_root/node_modules/@earendil-works/$package" "$target"
  created+=("$target")
done
target="$modules/@earendil-works/pi-coding-agent"
[[ ! -e "$target" ]] || { echo "Refusing to replace existing $target" >&2; exit 2; }
ln -s "$pi_root" "$target"
created+=("$target")
target="$modules/typebox"
[[ ! -e "$target" ]] || { echo "Refusing to replace existing $target" >&2; exit 2; }
ln -s "$pi_root/node_modules/typebox" "$target"
created+=("$target")
target="$modules/@types/node"
[[ ! -e "$target" ]] || { echo "Refusing to replace existing $target" >&2; exit 2; }
ln -s "$pi_root/node_modules/@types/node" "$target"
created+=("$target")
bun_version="$(bun --version)"
bun_types="$HOME/.bun/install/cache/bun-types@${bun_version}@@@1"
[[ -d "$bun_types" ]] || { echo "Missing Bun type package at $bun_types" >&2; exit 2; }
target="$modules/bun-types"
[[ ! -e "$target" ]] || { echo "Refusing to replace existing $target" >&2; exit 2; }
ln -s "$bun_types" "$target"
created+=("$target")
cd "$extension_dir/../.."
bunx --bun --package typescript@5.9.3 tsc -p extensions/workflow/tsconfig.json

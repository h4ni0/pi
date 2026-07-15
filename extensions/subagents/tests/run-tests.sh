#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_dir="$(cd "$here/.." && pwd)"
pi_root="${PI_CODING_AGENT_MODULE_DIR:-$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent}"
modules="$extension_dir/node_modules"

# Test processes must never inherit a live collaboration identity, capability,
# depth, path, or future PI_SUBAGENT_* control variable from the invoking Pi.
for variable in "${!PI_SUBAGENT_@}"; do
  unset "$variable"
done
if [[ "${SUBAGENTS_TEST_ASSERT_CLEAN_ENV:-0}" == "1" ]] &&
   compgen -e PI_SUBAGENT_ >/dev/null; then
  echo "Failed to sanitize inherited PI_SUBAGENT_* test environment" >&2
  exit 2
fi

if [[ -e "$modules" ]]; then
  echo "Refusing to replace existing $modules" >&2
  exit 2
fi
cleanup() { rm -rf "$modules"; }
trap cleanup EXIT

mkdir -p "$modules/@earendil-works"
for package in pi-agent-core pi-ai pi-tui; do
  ln -s "$pi_root/node_modules/@earendil-works/$package" "$modules/@earendil-works/$package"
done
ln -s "$pi_root" "$modules/@earendil-works/pi-coding-agent"
ln -s "$pi_root/node_modules/typebox" "$modules/typebox"

cd "$extension_dir/../.."
if (( $# > 0 )); then
  bun test "$@"
else
  bun test extensions/subagents/tests
fi

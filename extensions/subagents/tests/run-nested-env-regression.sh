#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_SUBAGENT_DEPTH=2 \
PI_SUBAGENT_MAX_DEPTH=2 \
PI_SUBAGENT_ID=polluted_child \
PI_SUBAGENT_PATH=/root/parent/polluted_child \
PI_SUBAGENT_PARENT_ID=polluted_parent \
PI_SUBAGENT_PARENT_PATH=/root/parent \
PI_SUBAGENT_ROOT_ID=polluted_root \
PI_SUBAGENT_BROKER_SOCKET=/tmp/should-not-leak.sock \
PI_SUBAGENT_BROKER_CAPABILITY="$(printf 'a%.0s' {1..64})" \
PI_SUBAGENT_BROKER_GENERATION=99 \
PI_SUBAGENT_ACTIVE_TOOLS='["read"]' \
PI_SUBAGENT_FUTURE_SENTINEL=must-not-leak \
SUBAGENTS_TEST_ASSERT_CLEAN_ENV=1 \
"$here/run-tests.sh" \
  "$here/runner-environment.test.ts" \
  "$here/completion-outbox.test.ts"

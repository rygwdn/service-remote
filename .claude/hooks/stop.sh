#!/bin/bash
set -euo pipefail

# Escape hatch: set SKIP_CHECKS=1 to bypass all checks
if [ "${SKIP_CHECKS:-}" = "1" ]; then
  exit 0
fi

# Read hook input from stdin
input=$(cat)

# If Claude is already continuing due to a stop hook, don't block again
stop_hook_active=$(echo "$input" | grep -o '"stop_hook_active":[^,}]*' | grep -o 'true\|false' || echo "false")
if [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

fail() {
  local check="$1"
  local output="$2"
  echo "$output" >&2
  printf '{"decision":"block","reason":"%s failed — fix before finishing (or set SKIP_CHECKS=1 to bypass)"}' "$check"
  exit 0
}

output=$(bun run typecheck 2>&1) || fail "typecheck" "$output"
output=$(bun run lint 2>&1)     || fail "lint (stray console.* calls)" "$output"
output=$(bun test test/unit test/e2e 2>&1) || fail "unit/e2e tests" "$output"

#!/bin/bash
set -euo pipefail

# Escape hatch: set SKIP_CHECKS=1 to bypass all checks
if [ "${SKIP_CHECKS:-}" = "1" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Run all CI checks: typecheck, lint, unit tests, e2e tests
# Note: UI tests (Playwright) are skipped here as they require a browser
# Use SKIP_CHECKS=1 if the environment cannot run tests
if ! bun run typecheck 2>&1; then
  echo '{"systemMessage": "Stop hook: typecheck failed. Fix type errors before finishing, or set SKIP_CHECKS=1 to bypass."}'
  exit 2
fi

if ! bun run lint 2>&1; then
  echo '{"systemMessage": "Stop hook: lint failed (stray console.* calls). Fix lint errors before finishing, or set SKIP_CHECKS=1 to bypass."}'
  exit 2
fi

if ! bun test test/unit test/e2e 2>&1; then
  echo '{"systemMessage": "Stop hook: unit/e2e tests failed. Fix failing tests before finishing, or set SKIP_CHECKS=1 to bypass."}'
  exit 2
fi

exit 0

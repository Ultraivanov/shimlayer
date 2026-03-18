#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/frontend"

failures=0

run_step() {
  local name="$1"
  shift
  local rc=0
  echo "==> ${name}"
  if "$@"; then
    echo "PASS: ${name}"
  else
    echo "FAIL: ${name}"
    failures=$((failures + 1))
    rc=1
  fi
  return "$rc"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "FAIL: npm not found"
  exit 1
fi

# Keep Playwright browser cache inside the repo so preflight works in sandboxed
# environments where writing to ~/Library/Caches is restricted.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${FRONTEND_DIR}/.playwright-browsers}"

run_step "frontend deps install" npm --prefix "$FRONTEND_DIR" install
run_step "frontend build" npm --prefix "$FRONTEND_DIR" run build
run_step "playwright browser install" npm --prefix "$FRONTEND_DIR" run e2e:install
echo "==> playwright ops smoke"
set +e
pw_out="$(
  npm --prefix "$FRONTEND_DIR" run e2e -- ops-smoke.spec.ts requester-smoke.spec.ts operator-smoke.spec.ts openai-interruptions.spec.ts 2>&1
)"
pw_rc="$?"
set -e
if [[ "$pw_rc" -eq 0 ]]; then
  echo "$pw_out"
  echo "PASS: playwright ops smoke"
else
  # Some sandboxed environments block localhost binds for child processes.
  # If so, treat Playwright as skipped rather than failed.
  if echo "$pw_out" | grep -qiE "attempting to bind.*127\\.0\\.0\\.1.*8000.*operation not permitted"; then
    echo "$pw_out"
    echo "SKIP: playwright ops smoke (localhost bind not permitted in this environment)"
  else
    echo "$pw_out"
    echo "FAIL: playwright ops smoke"
    failures=$((failures + 1))
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  echo "UI preflight FAILED with ${failures} failing step(s)."
  exit 1
fi

echo "UI preflight PASSED."

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

can_bind_localhost() {
  python3 - <<'PY' >/dev/null 2>&1
import socket
s = socket.socket()
try:
    s.bind(("127.0.0.1", 0))
finally:
    s.close()
PY
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
if can_bind_localhost; then
  run_step "playwright ops smoke" npm --prefix "$FRONTEND_DIR" run e2e
else
  echo "SKIP: playwright ops smoke (cannot bind localhost in this environment)"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "UI preflight FAILED with ${failures} failing step(s)."
  exit 1
fi

echo "UI preflight PASSED."

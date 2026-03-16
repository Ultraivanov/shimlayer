#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

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

run_step "compileall" python3 -m compileall app tests scripts

if python3 -c "import pytest" >/dev/null 2>&1; then
  run_step "pytest smoke+ops" python3 -m pytest -q tests/test_smoke_flow.py tests/test_ops_admin_controls.py
  run_step "pytest webhooks+stripe" python3 -m pytest -q tests/test_webhook_worker.py tests/test_webhook_dispatcher.py tests/test_stripe_signature.py tests/test_stripe_webhook.py
else
  echo "SKIP: pytest module not installed"
fi

if command -v npm >/dev/null 2>&1; then
  run_step "frontend build" npm --prefix frontend run build
else
  echo "SKIP: npm not found"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Fast preflight FAILED with ${failures} failing step(s)."
  exit 1
fi

echo "Fast preflight PASSED."

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

failures=0

run_step() {
  local name="$1"
  shift
  echo "==> ${name}"
  if "$@"; then
    echo "PASS: ${name}"
  else
    echo "FAIL: ${name}"
    failures=$((failures + 1))
  fi
}

docker_daemon_ok() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

run_step "compileall" python3 -m compileall app tests scripts

if python3 -c "import pytest" >/dev/null 2>&1; then
  run_step "pytest unit subset" python3 -m pytest -q tests/test_smoke_flow.py tests/test_webhook_worker.py tests/test_webhook_verification.py
else
  echo "SKIP: pytest module not installed"
fi

if docker_daemon_ok; then
  run_step "docker compose build" docker compose build
  run_step "docker compose up" docker compose up -d
  run_step "smoke postgres script" ./scripts/smoke_postgres.sh
  if python3 -c "import pytest" >/dev/null 2>&1; then
    run_step "postgres integration test" python3 -m pytest -q -m postgres tests/test_postgres_webhook_queue.py
  else
    echo "SKIP: pytest module not installed for postgres test"
  fi
  run_step "docker compose down" docker compose down -v
else
  if [[ "${SHIMLAYER_STRICT_DOCKER:-0}" == "1" ]]; then
    echo "FAIL: docker daemon not available (strict mode enabled)"
    failures=$((failures + 1))
  else
    echo "SKIP: docker daemon not available (compose/postgres steps skipped)"
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Alpha readiness FAILED with ${failures} failing step(s)."
  exit 1
fi

echo "Alpha readiness PASSED."

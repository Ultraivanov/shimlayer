#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

failures=0
compose_started=0

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

docker_daemon_ok() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  return 0
}

cleanup() {
  if [[ "$compose_started" -eq 1 ]]; then
    echo "==> docker compose down"
    if docker compose down -v; then
      echo "PASS: docker compose down"
    else
      echo "WARN: docker compose down failed"
    fi
  fi
}

trap cleanup EXIT

run_step "compileall" python3 -m compileall app tests scripts

if python3 -c "import pytest" >/dev/null 2>&1; then
  run_step "pytest ops/admin" python3 -m pytest -q tests/test_ops_admin_controls.py tests/test_smoke_flow.py tests/test_webhook_worker.py
  run_step "pytest stripe" python3 -m pytest -q tests/test_stripe_signature.py tests/test_stripe_webhook.py
else
  echo "SKIP: pytest module not installed"
fi

if command -v docker >/dev/null 2>&1; then
  if docker_daemon_ok; then
    run_step "docker compose build" docker compose build
    run_step "docker compose up" docker compose up -d postgres migrate api
    compose_started=1

    if run_step "smoke postgres script" ./scripts/smoke_postgres.sh; then
      :
    else
      echo "==> docker compose logs (api,migrate tail)"
      docker compose logs --no-color --tail=200 api migrate || true
    fi

    if python3 -c "import pytest" >/dev/null 2>&1; then
      export SHIMLAYER_DB_DSN="${SHIMLAYER_DB_DSN:-postgresql://shim:shim@localhost:5432/shimlayer}"
      run_step "pytest postgres integration" python3 -m pytest -q -m postgres tests/test_postgres_webhook_queue.py
    else
      echo "SKIP: pytest module not installed for postgres test"
    fi
  else
    if [[ "${SHIMLAYER_STRICT_DOCKER:-0}" == "1" ]]; then
      echo "FAIL: docker daemon not available (strict mode enabled)"
      failures=$((failures + 1))
    else
      echo "SKIP: docker daemon not available (compose/postgres steps skipped)"
    fi
  fi
else
  if [[ "${SHIMLAYER_STRICT_DOCKER:-0}" == "1" ]]; then
    echo "FAIL: docker not found (strict mode enabled)"
    failures=$((failures + 1))
  else
    echo "SKIP: docker not found (compose/postgres steps skipped)"
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Preflight FAILED with ${failures} failing step(s)."
  exit 1
fi

echo "Preflight PASSED."

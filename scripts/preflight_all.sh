#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

RUN_DOCKER=0
if [[ "${1:-}" == "--with-docker" ]]; then
  RUN_DOCKER=1
fi
RUN_STRICT=0
if [[ "${1:-}" == "--strict" ]]; then
  RUN_STRICT=1
fi

if [[ "$RUN_STRICT" -eq 1 ]]; then
  echo "==> preflight strict"
  ./scripts/preflight_strict.sh
  exit 0
fi

echo "==> preflight fast"
./scripts/preflight_fast.sh

echo "==> preflight ui"
./scripts/preflight_ui.sh

if [[ "$RUN_DOCKER" -eq 1 ]]; then
  echo "==> preflight local (docker/postgres)"
  ./scripts/preflight_local.sh
else
  echo "SKIP: docker preflight (pass --with-docker to enable)"
fi

echo "Preflight ALL PASSED."

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export SHIMLAYER_STRICT_UI_SMOKE=1
export SHIMLAYER_STRICT_DOCKER=1
export SHIMLAYER_STRICT_DEPS=1

echo "==> preflight strict (fast + ui + local)"
./scripts/preflight_fast.sh
./scripts/preflight_ui.sh
./scripts/preflight_local.sh

echo "Preflight STRICT PASSED."

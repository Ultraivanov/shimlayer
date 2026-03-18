#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/frontend"

cd "$FRONTEND_DIR"

echo "==> npm install"
npm install

echo "==> playwright browser install (chromium)"
npm run e2e:install

echo "==> playwright ops smoke"
npm run e2e -- ops-smoke.spec.ts requester-smoke.spec.ts operator-smoke.spec.ts openai-interruptions.spec.ts

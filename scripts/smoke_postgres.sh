#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8000}"
API_KEY="${API_KEY:-smoke-key}"
HEALTH_RETRIES="${HEALTH_RETRIES:-40}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-2}"
READY_RETRIES="${READY_RETRIES:-60}"
READY_SLEEP_SECONDS="${READY_SLEEP_SECONDS:-1}"
PURCHASE_RETRIES="${PURCHASE_RETRIES:-20}"
PURCHASE_SLEEP_SECONDS="${PURCHASE_SLEEP_SECONDS:-1}"
PURCHASE_REF="smoke-invoice-$(date +%s)"

echo "Checking health..."
ok=0
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if curl -sf "${API_URL}/v1/healthz" >/dev/null; then
    ok=1
    break
  fi
  sleep "${HEALTH_SLEEP_SECONDS}"
done
if [[ "${ok}" -ne 1 ]]; then
  echo "Health check failed after ${HEALTH_RETRIES} attempts: ${API_URL}/v1/healthz"
  exit 1
fi

echo "Checking API+DB readiness..."
ready_ok=0
for i in $(seq 1 "${READY_RETRIES}"); do
  READY_RESPONSE="$(curl -sS -w '\n%{http_code}' "${API_URL}/v1/readyz")"
  READY_CODE="$(printf '%s' "${READY_RESPONSE}" | tail -n1)"
  READY_BODY="$(printf '%s' "${READY_RESPONSE}" | sed '$d')"
  if [[ "${READY_CODE}" == "200" ]]; then
    ready_ok=1
    break
  fi
  sleep "${READY_SLEEP_SECONDS}"
done
if [[ "${ready_ok}" -ne 1 ]]; then
  echo "API+DB readiness failed with HTTP ${READY_CODE} (${API_URL}/v1/readyz)"
  printf '%s\n' "${READY_BODY}"
  exit 1
fi

echo "Purchasing package..."
purchase_ok=0
for i in $(seq 1 "${PURCHASE_RETRIES}"); do
  PURCHASE_RESPONSE="$(curl -sS -w '\n%{http_code}' -X POST "${API_URL}/v1/billing/packages/purchase" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${API_KEY}" \
    -d "{\"package_code\":\"indie_entry_150\",\"reference\":\"${PURCHASE_REF}-${i}\"}")"
  PURCHASE_CODE="$(printf '%s' "${PURCHASE_RESPONSE}" | tail -n1)"
  PURCHASE_BODY="$(printf '%s' "${PURCHASE_RESPONSE}" | sed '$d')"
  if [[ "${PURCHASE_CODE}" == "200" ]]; then
    purchase_ok=1
    break
  fi
  sleep "${PURCHASE_SLEEP_SECONDS}"
done
if [[ "${purchase_ok}" -ne 1 ]]; then
  echo "Package purchase failed with HTTP ${PURCHASE_CODE}"
  printf '%s\n' "${PURCHASE_BODY}"
  exit 1
fi

echo "Creating task..."
TASK_JSON="$(curl -sf -X POST "${API_URL}/v1/tasks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d '{"task_type":"stuck_recovery","context":{"logs":"smoke loop"},"sla_seconds":120,"callback_url":"https://example.com/webhook"}')"

TASK_ID="$(printf '%s' "${TASK_JSON}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')"

echo "Claiming task ${TASK_ID}..."
curl -sf -X POST "${API_URL}/v1/tasks/${TASK_ID}/claim" \
  -H "X-API-Key: ${API_KEY}" >/dev/null

echo "Registering proof artifact for ${TASK_ID}..."
curl -sf -X POST "${API_URL}/v1/tasks/${TASK_ID}/proof" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "{\"artifact_type\":\"logs\",\"storage_path\":\"proofs/${TASK_ID}/logs.txt\",\"checksum_sha256\":\"7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990\",\"metadata\":{\"source\":\"smoke\"}}" >/dev/null

echo "Completing task ${TASK_ID}..."
curl -sf -X POST "${API_URL}/v1/tasks/${TASK_ID}/complete" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d '{"result":{"action_summary":"smoke fix","next_step":"continue"}}' >/dev/null

echo "Fetching final task state..."
curl -sf "${API_URL}/v1/tasks/${TASK_ID}" -H "X-API-Key: ${API_KEY}" >/dev/null

echo "Smoke test passed."

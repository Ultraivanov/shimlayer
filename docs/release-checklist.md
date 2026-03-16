# Release Checklist (MVP)

## 1. Prepare environment
- Ensure Python, npm, and Docker are installed.
- Ensure required env vars are set (`SHIMLAYER_*`, `VITE_*`).
- Ensure admin headers are configured for Ops/API checks.

## 2. Fast code health
```bash
./scripts/preflight_fast.sh
```
Expected: `Fast preflight PASSED.`

## 3. Frontend + UI smoke
```bash
./scripts/preflight_ui.sh
```
Expected: `UI preflight PASSED.`

## 4. Full local preflight (with Postgres)
```bash
./scripts/preflight_all.sh --with-docker
```
Expected: all internal steps pass.

## 5. API readiness + observability probes
```bash
curl -sS http://localhost:8000/v1/healthz
curl -sS http://localhost:8000/v1/readyz
curl -sS http://localhost:8000/v1/ops/observability/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user"
```
Expected: `healthz=ok`, `readyz=ready`, Prometheus text returned.

## 6. Final manual spot-check
- Open Ops tab and verify queue, action center, incident board, DLQ panel.
- Run one safe action (`add_note`) and verify audit/timeline update.
- Confirm no unexpected 4xx/5xx in API logs.

## 7. Go / No-Go decision
- `GO` only if all checks pass.
- If any step fails: `NO-GO`, capture failing command output and fix before retry.

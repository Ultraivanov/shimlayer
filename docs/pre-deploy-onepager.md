# Pre-Deploy One-Pager

Use this as a single-page checklist for the deployment specialist.

## 1) Environment + secrets
- `SHIMLAYER_REPOSITORY=postgres`
- `SHIMLAYER_DB_DSN` reachable
- `SHIMLAYER_ADMIN_API_KEY` rotated
- `SHIMLAYER_WEBHOOK_SECRET` rotated
- `SHIMLAYER_CORS_ORIGINS` explicit domain list

## 2) Database
- Apply `docs/supabase-schema-v0.sql` (or `python -m app.tools.migrate`)
- Verify required tables exist

## 3) Processes running
- API: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- Worker: `python -m app.workers.webhook_worker`
- OpenAI resume worker: `python -m app.workers.openai_resume_worker`
- Cleanup job (daily): `python -m app.tools.cleanup_db`

## 4) Probes
- `GET /v1/healthz` -> 200
- `GET /v1/readyz` -> 200
- `GET /v1/ops/metrics` -> 200 (admin headers)
- `GET /v1/ops/observability/metrics` -> 200 (admin headers)

## 5) Gates (must not be SKIP)
- `./scripts/preflight_fast.sh`
- `SHIMLAYER_STRICT_UI_SMOKE=1 ./scripts/preflight_ui.sh`
- `SHIMLAYER_STRICT_DOCKER=1 ./scripts/preflight_local.sh`
- `./scripts/preflight_all.sh --with-docker`
- `./scripts/preflight_strict.sh`

## 6) Smoke flows
- Task lifecycle: create → claim → proof → complete
- Manual review: lock → approve/reject
- OpenAI interruptions: ingest → decide → resume payload

## 7) Security
- No `startup_security_warning` in logs
- UI access policy enforced (internal-only unless auth is in place)

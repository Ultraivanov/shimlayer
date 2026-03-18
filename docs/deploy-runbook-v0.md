# Deploy Runbook (v0)

This is a practical checklist for deploying ShimLayer as an API + background workers backed by Postgres.

## 0) Choose a target

You need:
- A place to run **containers** (API + workers).
- A **managed Postgres** (recommended: Supabase Postgres or any hosted Postgres 16+).

ShimLayer runs at least these processes:
- `api`: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- `worker`: `python -m app.workers.webhook_worker`
- `openai-resume-worker`: `python -m app.workers.openai_resume_worker`
- `cleanup` (cron): `python -m app.tools.cleanup_db`

## 1) Database

Apply schema once:
- `docs/supabase-schema-v0.sql`

## 2) Required env vars (production)

Minimum:
- `SHIMLAYER_REPOSITORY=postgres`
- `SHIMLAYER_DB_DSN=...`
- `SHIMLAYER_WEBHOOK_SECRET=...` (rotate; non-empty)
- `SHIMLAYER_ADMIN_API_KEY=...` (rotate; non-empty)
- `SHIMLAYER_CORS_ORIGINS=https://<your-ui-domain>`

Recommended:
- `SHIMLAYER_WEBHOOK_TIMEOUT_SECONDS=5`
- `SHIMLAYER_WEBHOOK_MAX_ATTEMPTS=5`
- `SHIMLAYER_RETENTION_WEBHOOK_DELIVERIES_DAYS=30`
- `SHIMLAYER_RETENTION_SUCCEEDED_JOBS_DAYS=7`
- `SHIMLAYER_RETENTION_API_RATE_WINDOWS_HOURS=48`

## 3) Build + run

The repo includes a `Dockerfile` (API image) and `docker-compose.yml` (reference topology).

At deploy time:
- run migrations (equivalent to `python -m app.tools.migrate`) once per environment rollout
- ensure `worker` and `openai-resume-worker` are always-on
- run `cleanup` on a daily cron

## 4) Post-deploy probes

- `GET /v1/healthz` and `GET /v1/readyz` return 200.
- `GET /v1/ops/observability/metrics` returns text (admin headers required).
- End-to-end smoke: create → claim → proof → complete → webhook/pull convergence.

## 5) CI/Release gates

Run:
- `./scripts/preflight_fast.sh`
- `./scripts/preflight_ui.sh` (in an environment that allows localhost binds for Playwright webServer)
- `./scripts/preflight_all.sh --with-docker` (in a runner with Docker daemon, if you validate compose locally)


# Deploy Handoff (For Technical Specialist)

Goal: deploy ShimLayer without last-minute engineering work. This document is a **practical runbook + acceptance gates**.

## What to run (processes)

ShimLayer consists of:
- **API**: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- **Webhook worker**: `python -m app.workers.webhook_worker`
- **OpenAI resume worker** (required if interruptions are used): `python -m app.workers.openai_resume_worker`
- **Cleanup job** (daily cron): `python -m app.tools.cleanup_db`

All processes must point to the **same Postgres**.

## Required configuration (production)

Minimum env vars:
- `SHIMLAYER_REPOSITORY=postgres`
- `SHIMLAYER_DB_DSN=...` (reachable Postgres DSN)
- `SHIMLAYER_ADMIN_API_KEY=...` (rotated, non-empty)
- `SHIMLAYER_WEBHOOK_SECRET=...` (rotated, non-empty)
- `SHIMLAYER_CORS_ORIGINS=https://<ui-domain>` (or empty if no browser UI)

Recommended:
- `SHIMLAYER_WEBHOOK_TIMEOUT_SECONDS=5`
- `SHIMLAYER_WEBHOOK_MAX_ATTEMPTS=5`
- `SHIMLAYER_RETENTION_WEBHOOK_DELIVERIES_DAYS=30`
- `SHIMLAYER_RETENTION_SUCCEEDED_JOBS_DAYS=7`
- `SHIMLAYER_RETENTION_API_RATE_WINDOWS_HOURS=48`

## Database (one-time per environment)

Apply schema:
- `docs/supabase-schema-v0.sql`

The repo also contains a helper that applies the schema:
- `python -m app.tools.migrate` (uses `SHIMLAYER_DB_DSN`)

## Acceptance gates (must not be “SKIP”)

Run these on a machine/runner where Docker + localhost binds are allowed:

```bash
# API-only and unit-level checks
./scripts/preflight_fast.sh

# UI e2e must actually execute (not SKIP)
SHIMLAYER_STRICT_UI_SMOKE=1 ./scripts/preflight_ui.sh

# Postgres/compose smoke must actually execute (not SKIP)
SHIMLAYER_STRICT_DOCKER=1 ./scripts/preflight_local.sh

# Unified preflight
./scripts/preflight_all.sh --with-docker
```

If any script prints `SKIP:` under strict mode, treat that as a deployment blocker.

## Post-deploy probes (runtime)

API:
- `GET /v1/healthz` → 200
- `GET /v1/readyz` → 200 (only after DB is reachable)

Ops:
- `GET /v1/ops/metrics` with admin headers → 200
- `GET /v1/ops/observability/metrics` with admin headers → 200 (text)

## Minimal end-to-end smoke (production)

1) Purchase package → create task.
2) Claim → upload local proof → complete.
3) Verify webhook delivery or pull convergence (task state via `GET /v1/tasks/{task_id}`).
4) OpenAI interruptions (if used): ingest → decide → resume payload.
5) Manual review (if used): reviewer lock → approve/reject.

## Notes

- If the browser UI is deployed publicly, **do not ship real admin keys** into `VITE_*` variables (they become public in JS). Keep the UI internal or introduce a proper auth gateway.
- Startup warnings like `startup_security_warning` must not appear in production logs (rotate secrets).
See `docs/security-notes.md` for the minimum security posture.

## Current status (handoff)

- **Release readiness:** release‑ready (see `docs/release-summary.md`).
- **Latest UI preflight:** `./scripts/preflight_ui.sh` passed (15/15).
- **Latest commits:** main branch up to `978003c` (release summary pinned).
- **Open items / risks:** none identified.

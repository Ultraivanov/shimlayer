# Alpha Ready Checklist

Use this checklist before onboarding external alpha customers.

## 1. Build and Tests
- `python3 -m compileall app tests scripts` passes.
- Unit smoke tests pass:
  - `tests/test_smoke_flow.py`
  - `tests/test_webhook_worker.py`
  - `tests/test_webhook_verification.py`
- Postgres integration test passes:
  - `pytest -q -m postgres tests/test_postgres_webhook_queue.py`

## 2. Runtime Stack
- `docker compose up -d --build` runs with services:
  - `postgres`
  - `migrate`
  - `api`
  - `worker`
- Schema migration completed successfully from `docs/supabase-schema-v0.sql`.

## 3. Core Flows
- Billing:
  - package purchase succeeds
  - flow credits decrement on task create
  - flow credits restore on refund
- Task lifecycle:
  - `create -> claim -> complete -> proof -> get`
- Webhooks:
  - jobs enqueue from task state transitions
  - worker sends events with signature + timestamp
  - retry on transient failures (`5xx`, `408`, `425`, `429`, transport errors)
  - DLQ on permanent failure
  - DLQ requeue endpoint works

## 4. Security Controls
- API key required for protected endpoints.
- Free-plan rate limit enforced (`10/min`).
- Webhook signature validation helper integrated in receivers.
- Timestamp tolerance applied for replay protection.

## 5. Observability
- `/v1/healthz` returns `200`.
- `/v1/readyz` returns `200` after repository is ready.
- `/v1/ops/metrics` returns expected fields.
- `scripts/check_ops_thresholds.py` runs and alerts on threshold breach.
- Alert thresholds configured from `docs/alpha-launch-kit.md`.

## 6. One-command Validation
- Run `./scripts/alpha_readiness_check.sh`.
- Result must be `Alpha readiness PASSED.`

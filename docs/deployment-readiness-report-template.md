# Deployment Readiness Report (Template)

Use this as a completion artifact before deployment. Replace placeholders and attach command outputs where helpful.

## 1) Environment
- `SHIMLAYER_REPOSITORY=postgres`:
- `SHIMLAYER_DB_DSN` set and reachable:
- `SHIMLAYER_ADMIN_API_KEY` rotated:
- `SHIMLAYER_WEBHOOK_SECRET` rotated:
- `SHIMLAYER_CORS_ORIGINS` explicit domains:
Expected evidence:
- `printenv` output showing non-empty values.

## 2) Database
- Schema applied (`docs/supabase-schema-v0.sql`):
- Required tables present:
  - `ops_task_audit`
  - `ops_incident_events`
  - `stripe_events_processed`
  - `stripe_customers`
  - `stripe_subscriptions`
- Immutability triggers verified:
Expected evidence:
- `python -m app.tools.migrate` prints `Applied schema from .../docs/supabase-schema-v0.sql`.
- SQL check returns non-null for each `to_regclass(...)`.

## 3) API sanity
- `GET /v1/healthz` -> 200:
- `GET /v1/readyz` -> 200:
- `GET /v1/ops/metrics` (admin headers) -> 200:
- `GET /v1/ops/observability/metrics` -> 200:
- `X-Request-ID` present in responses:
Expected evidence:
- Curl output with `200` and `X-Request-ID` header.

## 4) Security
- Ops routes enforce admin headers:
- Role-based denies verified:
- No `startup_security_warning` in logs:
Expected evidence:
- Missing admin headers returns `401/403`.
- Startup logs contain no `startup_security_warning`.

## 5) Billing/Stripe
- Package purchase path:
- Stripe webhook signature validation:
- Stripe idempotency (`event.id`) replay:
Expected evidence:
- Successful purchase response with `200`.
- Stripe CLI test events accepted.

## 6) Smoke flows
- Task lifecycle: create → claim → proof → complete:
- Manual review: lock → approve/reject:
- Ops actions: add_note + audit/timeline update:
- OpenAI interruptions: ingest → decide → resume payload:
Expected evidence:
- Task status transitions observed in API/UI.
- Audit/timeline entries updated after ops action.

## 7) Preflight gates
- `./scripts/preflight_fast.sh`:
- `SHIMLAYER_STRICT_UI_SMOKE=1 ./scripts/preflight_ui.sh`:
- `SHIMLAYER_STRICT_DOCKER=1 ./scripts/preflight_local.sh`:
- `./scripts/preflight_all.sh --with-docker`:
Expected evidence:
- All commands exit 0 with no `SKIP` lines.

## 8) Go / No-Go
- Decision:
- Risks / waivers:
- Owner / approver:
- Date:

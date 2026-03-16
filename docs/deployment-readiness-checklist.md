# Deployment Readiness Checklist

## Environment
- `SHIMLAYER_REPOSITORY` set (`postgres` for production).
- `SHIMLAYER_DB_DSN` points to reachable DB.
- `SHIMLAYER_ADMIN_API_KEY` rotated from default.
- CORS configured via `SHIMLAYER_CORS_ORIGINS`.
- Stripe secrets configured only if Stripe flow is enabled.

## Database
- Apply latest schema: `docs/supabase-schema-v0.sql`.
- Confirm tables exist:
  - `ops_task_audit`, `ops_incident_events`, `stripe_events_processed`, `stripe_customers`, `stripe_subscriptions`.
- Confirm immutability triggers for audit/event tables.

## API sanity
- `GET /v1/healthz` -> 200.
- `GET /v1/readyz` -> 200.
- `GET /v1/ops/metrics` with admin headers -> 200.
- `GET /v1/ops/observability/metrics` returns prometheus-like text.
- `X-Request-ID` is echoed back on responses (traceability baseline).

## Security
- Enforce `X-Admin-Role` and `X-Admin-User` on ops routes.
- Validate role-based deny behavior for restricted actions.
- Ensure no default/demo secrets in production env.
- Review API startup logs and ensure no `startup_security_warning` entries in production.

## Billing/Stripe
- Package purchase path works end-to-end.
- Stripe webhook signature validation tested with Stripe CLI.
- Stripe event idempotency verified (`event.id` replay no-op).

## Smoke flow
- Create task -> claim -> complete -> proof.
- Run manual review + forced status + refund (with reason policy).
- Validate incident creation and updates.
- Validate bulk dry-run then execute.

## Final go/no-go
- Critical tests pass.
- Error budget and alert channels configured.
  - Alert source: `shimlayer_tasks_overdue`, `shimlayer_tasks_sla_risk`, `shimlayer_webhook_dlq_count`, `shimlayer_open_incidents`.
  - Alert routing owner: Ops on-call (primary) and Engineering (secondary).
- Runbook available to operators.

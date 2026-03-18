# Deployment Readiness Checklist

## Environment
- `SHIMLAYER_REPOSITORY` set (`postgres` for production).
- `SHIMLAYER_DB_DSN` points to reachable DB.
- `SHIMLAYER_ADMIN_API_KEY` rotated from default.
- CORS configured via `SHIMLAYER_CORS_ORIGINS`.
- Stripe secrets configured only if Stripe flow is enabled.
Verify:
```bash
printenv | rg "^SHIMLAYER_(REPOSITORY|DB_DSN|ADMIN_API_KEY|WEBHOOK_SECRET|CORS_ORIGINS)="
```
Expected:
- No empty values for `SHIMLAYER_DB_DSN`, `SHIMLAYER_ADMIN_API_KEY`, `SHIMLAYER_WEBHOOK_SECRET`.
- `SHIMLAYER_REPOSITORY=postgres`.

## Database
- Apply latest schema: `docs/supabase-schema-v0.sql`.
- Confirm tables exist:
  - `ops_task_audit`, `ops_incident_events`, `stripe_events_processed`, `stripe_customers`, `stripe_subscriptions`.
- Confirm immutability triggers for audit/event tables.
Verify:
```bash
python -m app.tools.migrate
```
Expected:
- Command prints `Applied schema from .../docs/supabase-schema-v0.sql`.
Then run a quick table check using your Postgres client:
```sql
select to_regclass('public.ops_task_audit'),
       to_regclass('public.ops_incident_events'),
       to_regclass('public.stripe_events_processed'),
       to_regclass('public.stripe_customers'),
       to_regclass('public.stripe_subscriptions');
```
Expected:
- All return non-null.

## API sanity
- `GET /v1/healthz` -> 200.
- `GET /v1/readyz` -> 200.
- `GET /v1/ops/metrics` with admin headers -> 200.
- `GET /v1/ops/observability/metrics` returns prometheus-like text.
- `X-Request-ID` is echoed back on responses (traceability baseline).
Verify:
```bash
curl -i http://localhost:8000/v1/healthz
curl -i http://localhost:8000/v1/readyz
curl -i http://localhost:8000/v1/ops/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user"
curl -i http://localhost:8000/v1/ops/observability/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user"
```
Expected:
- `healthz=ok`, `readyz=ready`.
- Metrics endpoints return 200.
- Each response includes `X-Request-ID`.

## Security
- Enforce `X-Admin-Role` and `X-Admin-User` on ops routes.
- Validate role-based deny behavior for restricted actions.
- Ensure no default/demo secrets in production env.
- Review API startup logs and ensure no `startup_security_warning` entries in production.
Verify:
```bash
curl -i http://localhost:8000/v1/ops/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key"
```
Expected:
- 401/403 when `X-Admin-Role` or `X-Admin-User` is missing.

## Billing/Stripe
- Package purchase path works end-to-end.
- Stripe webhook signature validation tested with Stripe CLI.
- Stripe event idempotency verified (`event.id` replay no-op).
Verify package purchase:
```bash
curl -i http://localhost:8000/v1/billing/packages \
  -H "X-API-Key: demo-key"
curl -i http://localhost:8000/v1/billing/packages/purchase \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -d '{"package_code":"indie_entry_150","reference":"invoice-deploy-check"}'
```

## Smoke flow
- Create task -> claim -> complete -> proof.
- Run manual review + forced status + refund (with reason policy).
- Validate incident creation and updates.
- Validate bulk dry-run then execute.
Verify:
- Use UI or API to run a single flow end-to-end.
- In Ops, run a safe action like `add_note` and confirm audit/timeline update.

## Final go/no-go
- Critical tests pass.
- Error budget and alert channels configured.
  - Alert source: `shimlayer_tasks_overdue`, `shimlayer_tasks_sla_risk`, `shimlayer_webhook_dlq_count`, `shimlayer_open_incidents`.
  - Alert routing owner: Ops on-call (primary) and Engineering (secondary).
- Runbook available to operators.
Verify:
```bash
SHIMLAYER_STRICT_UI_SMOKE=1 ./scripts/preflight_ui.sh
SHIMLAYER_STRICT_DOCKER=1 ./scripts/preflight_local.sh
```

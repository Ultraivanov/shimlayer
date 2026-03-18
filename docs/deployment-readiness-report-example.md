# Deployment Readiness Report (Example)

This is a filled example. Replace values with real outputs from the deployment environment.

## 1) Environment
- `SHIMLAYER_REPOSITORY=postgres`: OK
- `SHIMLAYER_DB_DSN` set and reachable: OK (`postgresql://***`)
- `SHIMLAYER_ADMIN_API_KEY` rotated: OK
- `SHIMLAYER_WEBHOOK_SECRET` rotated: OK
- `SHIMLAYER_CORS_ORIGINS` explicit domains: OK (`https://console.example.com`)

Evidence (sanitized):
```bash
SHIMLAYER_REPOSITORY=postgres
SHIMLAYER_DB_DSN=postgresql://***:***@db.example.com:5432/shimlayer
SHIMLAYER_ADMIN_API_KEY=*** (non-empty)
SHIMLAYER_WEBHOOK_SECRET=*** (non-empty)
SHIMLAYER_CORS_ORIGINS=https://console.example.com
```

## 2) Database
- Schema applied: OK
- Required tables present: OK
- Immutability triggers verified: OK

Evidence:
```bash
Applied schema from /app/docs/supabase-schema-v0.sql
```
```sql
select to_regclass('public.ops_task_audit'),
       to_regclass('public.ops_incident_events'),
       to_regclass('public.stripe_events_processed'),
       to_regclass('public.stripe_customers'),
       to_regclass('public.stripe_subscriptions');
-- all non-null
```

## 3) API sanity
- `/v1/healthz` -> 200: OK
- `/v1/readyz` -> 200: OK
- `/v1/ops/metrics` -> 200: OK
- `/v1/ops/observability/metrics` -> 200: OK
- `X-Request-ID` present: OK

Evidence:
```bash
HTTP/1.1 200 OK
X-Request-ID: 2a1c0d3d-7a2c-4b8a-9cdd-1f0a0b1c2d3e
```

## 4) Security
- Ops routes enforce admin headers: OK (401/403 without headers)
- Role-based denies: OK
- No `startup_security_warning` in logs: OK

## 5) Billing/Stripe
- Package purchase path: OK
- Stripe signature validation: OK (CLI test)
- Stripe idempotency replay: OK

## 6) Smoke flows
- Task lifecycle: OK
- Manual review: OK
- Ops action + audit/timeline: OK
- OpenAI interruptions: OK

## 7) Preflight gates
- `./scripts/preflight_fast.sh`: OK
- `SHIMLAYER_STRICT_UI_SMOKE=1 ./scripts/preflight_ui.sh`: OK
- `SHIMLAYER_STRICT_DOCKER=1 ./scripts/preflight_local.sh`: OK
- `./scripts/preflight_all.sh --with-docker`: OK

## 8) Go / No-Go
- Decision: GO
- Risks / waivers: None
- Owner / approver: <name>
- Date: <YYYY-MM-DD>


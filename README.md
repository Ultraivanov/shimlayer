# ShimLayer

ShimLayer is a HITL API layer for last-mile failures in agentic workflows.

## CI status

- Fast CI  
  `https://github.com/Ultraivanov/shimlayer/actions/workflows/ci-fast.yml`

  ![CI Fast](https://github.com/Ultraivanov/shimlayer/actions/workflows/ci-fast.yml/badge.svg)

- UI E2E  
  `https://github.com/Ultraivanov/shimlayer/actions/workflows/ui-e2e.yml`

  ![UI E2E](https://github.com/Ultraivanov/shimlayer/actions/workflows/ui-e2e.yml/badge.svg)

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export SHIMLAYER_REPOSITORY=inmemory
uvicorn app.main:app --reload
```

Open:
- API docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/v1/healthz`

## Frontend Console

Built with `React + Vite + Gravity UI`.

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open: `http://localhost:5173`

Frontend in Docker:
```bash
docker compose --profile ui up --build frontend
```

## Run tests

```bash
pytest -q
```

## One-command checks

## Product map

- End-to-end user journey (Requester → Operator → Ops): `docs/user-journey.md`
- Requester hybrid integration (push + pull fallback): `docs/requester-hybrid-integration.md`
- OpenAI interruptions (resume loop): `docs/requester-hybrid-integration.md` (section 0)
- Alpha local runbook: `docs/alpha-local-runbook.md`
- Deploy runbook: `docs/deploy-runbook-v0.md`
- Deploy handoff (for specialist): `docs/deploy-handoff.md`
- Security notes: `docs/security-notes.md`
- Deployment readiness report template: `docs/deployment-readiness-report-template.md`
- Pre-deploy one-pager: `docs/pre-deploy-onepager.md`
- Deployment readiness report example: `docs/deployment-readiness-report-example.md`
- Deploy handoff pack (read order): `docs/deploy-handoff-pack.md`
- Lead capture landing (Gravity UI): `frontend/src/pages/LeadPage.tsx` (served at `/lead`)

Fast backend checks (no docker):
```bash
./scripts/preflight_fast.sh
```

Frontend build + UI smoke (Playwright):
```bash
./scripts/preflight_ui.sh
```

Unified preflight:
```bash
# fast + ui
./scripts/preflight_all.sh

# fast + ui + docker/postgres integration
./scripts/preflight_all.sh --with-docker

# strict (fails on any SKIP, requires docker + localhost binds)
./scripts/preflight_strict.sh
```

CI automation:
- `.github/workflows/ci-fast.yml` runs fast preflight on push/PR.
- `.github/workflows/ui-e2e.yml` runs UI smoke on manual trigger.

Common CI failures:
- `playwright executable doesn't exist`: run `npm --prefix frontend run e2e:install`.
- `browser install fails in CI`: ensure outbound access to Playwright CDN is allowed.
- `address already in use (8000/4173)`: verify no parallel job starts conflicting local servers in the same runner step.
- `pytest not found`: ensure `pip install -r requirements.txt` completed before preflight.
- `npm ci` lockfile error: regenerate `frontend/package-lock.json` locally and commit it.

## Docker

```bash
docker compose up --build
```

By default `docker-compose.yml` configures Postgres mode:
- `SHIMLAYER_REPOSITORY=postgres`
- `SHIMLAYER_DB_DSN=postgresql://shim:shim@postgres:5432/shimlayer`
- `SHIMLAYER_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`
- `SHIMLAYER_ADMIN_API_KEY=dev-admin-key`

Apply schema before using Postgres mode:
- Execute [docs/supabase-schema-v0.sql](/Users/dmitryivanov/Documents/ShimLayer/docs/supabase-schema-v0.sql) against your Postgres/Supabase database.
- Schema includes `ops_task_audit` for admin case actions (manual review, reassign, force status, refund note trail).

Webhook delivery settings:
- `SHIMLAYER_WEBHOOK_SECRET`
- `SHIMLAYER_WEBHOOK_TIMEOUT_SECONDS`
- `SHIMLAYER_WEBHOOK_MAX_ATTEMPTS`
- `SHIMLAYER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`
- Outbound webhook headers:
  - `X-ShimLayer-Signature` (`sha256=<hmac>`)
  - `X-ShimLayer-Timestamp` (unix seconds)
  - `Idempotency-Key`

Run webhook worker (queue consumer):
```bash
python -m app.workers.webhook_worker
```

Pull fallback (recommended hybrid mode):
- Poll a single task: `GET /v1/tasks/{task_id}`
- Incremental sync: `GET /v1/tasks/sync` (cursor-based)
- See `docs/requester-hybrid-integration.md`.

Run Postgres integration test (requires local Postgres on 5432):
```bash
pytest -q -m postgres tests/test_postgres_webhook_queue.py
```

Run compose smoke check:
```bash
./scripts/smoke_postgres.sh
```

Run full alpha readiness check:
```bash
./scripts/alpha_readiness_check.sh
```

Run local preflight (ops/admin + stripe tests + postgres smoke/integration):
```bash
./scripts/preflight_local.sh
```

Run DB cleanup job (recommended via daily cron):
```bash
python -m app.tools.cleanup_db
```

Cleanup retention settings (env vars):
- `SHIMLAYER_RETENTION_WEBHOOK_DELIVERIES_DAYS` (default `30`)
- `SHIMLAYER_RETENTION_SUCCEEDED_JOBS_DAYS` (default `7`)
- `SHIMLAYER_RETENTION_API_RATE_WINDOWS_HOURS` (default `48`)
- `SHIMLAYER_RETENTION_ARTIFACTS_DAYS` (default `30`, also deletes `local:` artifact files)

Run ops threshold check (for cron/CI):
```bash
SHIMLAYER_API_URL=http://localhost:8000 \
SHIMLAYER_API_KEY=ops-checker \
./scripts/check_ops_thresholds.py
```

Generate alpha sign-off report:
```bash
SHIMLAYER_API_URL=http://localhost:8000 \
SHIMLAYER_API_KEY=ops-checker \
SHIMLAYER_ENV=local \
SHIMLAYER_REVIEWER=your-name \
./scripts/generate_alpha_signoff.py
```

## Contract and data docs

- `docs/prd-v0.md`
- `docs/openapi-v0.yaml`
- `docs/supabase-schema-v0.sql`
- `docs/alpha-launch-kit.md`
- `docs/alpha-ready-checklist.md`
- `docs/alpha-release-notes.md`
- `docs/webhook-receiver-example.md`
- `docs/runbook-commands.md`
- `docs/alpha-signoff-template.md`
- `docs/ops-admin-test-plan.md`
- `docs/ops-runbook.md`
- `docs/deployment-readiness-checklist.md`
- `docs/release-checklist.md`

## Billing flow (v0)

1. Purchase package:
```bash
curl -X GET http://localhost:8000/v1/billing/packages \
  -H "X-API-Key: demo-key"
```

2. Purchase selected package:
```bash
curl -X POST http://localhost:8000/v1/billing/packages/purchase \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -d '{"package_code":"indie_entry_150","reference":"invoice-123"}'
```

2a. Create Stripe Checkout Session (if Stripe keys configured):
```bash
curl -X POST http://localhost:8000/v1/billing/stripe/checkout-session \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -d '{"package_code":"indie_entry_150","success_url":"https://example.com/success","cancel_url":"https://example.com/cancel","customer_email":"dev@example.com"}'
```

3. Create task (consumes 1 flow credit).
4. Refund task (restores 1 flow credit):
```bash
curl -X POST http://localhost:8000/v1/tasks/<task_id>/refund \
  -H "X-API-Key: demo-key"
```

5. Requeue dead-letter webhook item:
```bash
curl -X POST http://localhost:8000/v1/webhooks/dlq/<dead_letter_id>/requeue \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

6. Fetch ops metrics:
```bash
curl http://localhost:8000/v1/ops/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

6a. List webhook dead-letter entries:
```bash
curl "http://localhost:8000/v1/ops/dlq?limit=20" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

6b. List active/problem flows for Ops Control Tower:
```bash
curl "http://localhost:8000/v1/ops/flows?limit=50&only_problem=true" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

6b.1. List SLA-breach queue (overdue or <2 min to deadline):
```bash
curl "http://localhost:8000/v1/ops/flows?limit=50&only_sla_breach=true" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

6c. Run admin action on a flow:
```bash
curl -X POST "http://localhost:8000/v1/ops/flows/<task_id>/actions" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user-1" \
  -d '{"action":"manual_review","manual_verdict":"rejected","note":"Proof mismatch"}'
```

For sensitive actions (`refund`, `force_status`) `reason_code` is required:
`customer_request`, `proof_mismatch`, `policy_violation`, `sla_breach`, `fraud_risk`, `incident_mitigation`.
Admin role header is mandatory for Ops endpoints (`X-Admin-Role`): `ops_agent`, `ops_manager`, `finance`, `admin`.

6d. Run bulk admin action:
```bash
curl -X POST "http://localhost:8000/v1/ops/flows/bulk-actions" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user-1" \
  -d '{"task_ids":["<task_id_1>","<task_id_2>"],"action":"force_status","status":"disputed","reason_code":"incident_mitigation","note":"incident triage"}'
```

6e. Incident board and auto scan:
```bash
curl "http://localhost:8000/v1/ops/incidents?status_filter=open&limit=50" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user-1"
```

```bash
curl -X POST "http://localhost:8000/v1/ops/incidents/scan" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user-1" \
  -d '{"overdue_threshold": 5}'
```

6f. Incident event log:
```bash
curl "http://localhost:8000/v1/ops/incidents/<incident_id>/events?limit=100" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user-1"
```

6g. Finance + observability:
```bash
curl "http://localhost:8000/v1/ops/finance/ledger?limit=100" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: finance" \
  -H "X-Admin-User: finance-user-1"
```

```bash
curl "http://localhost:8000/v1/ops/finance/margin" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: finance" \
  -H "X-Admin-User: finance-user-1"
```

```bash
curl "http://localhost:8000/v1/ops/observability/metrics" \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user-1"
```

7. Verify inbound webhook signature in your receiver (example):
```python
from app.webhooks.verification import verify_webhook_signature

ok = verify_webhook_signature(
    payload=request_body_bytes,
    signature_header=request_headers.get("X-ShimLayer-Signature"),
    timestamp_header=request_headers.get("X-ShimLayer-Timestamp"),
    secret=WEBHOOK_SECRET,
    tolerance_seconds=300,
)
```

8. Stripe webhook endpoint (server-side):
- `POST /v1/webhooks/stripe`
- verifies `Stripe-Signature`
- idempotent by Stripe `event.id`
- processes:
  - `checkout.session.completed`
  - `payment_intent.succeeded`
  - `charge.refunded`
  - `customer.subscription.created|updated|deleted`
- expected metadata:
  - `api_key`
  - `package_code`
  - optional `topup_usd` for payment intents

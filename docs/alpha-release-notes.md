# ShimLayer Alpha Release Notes

## 1. Ready
- API for task lifecycle:
  - create / claim / complete / proof / refund
- Package billing with flow credits:
  - purchase package, consume per flow, refund restores flow
- Webhook async pipeline:
  - enqueue -> worker delivery -> retry/backoff -> DLQ -> requeue
- Security controls:
  - API key auth
  - free-plan rate limit (`10/min`)
  - webhook signature (`timestamp.payload`) + timestamp tolerance helper
- Observability:
  - ops metrics endpoint
  - DLQ listing endpoint
  - threshold check script for cron/CI

## 2. Known Risks
- Full end-to-end runtime still needs validation in target environment (network, docker, webhook endpoints).
- No external incident paging integration yet (script emits pass/fail only).
- Postgres integration test requires local DB and dependencies present.

## 3. Go-Live Commands
```bash
docker compose up -d --build
./scripts/smoke_postgres.sh
./scripts/alpha_readiness_check.sh
```

Optional checks:
```bash
pytest -q -m postgres tests/test_postgres_webhook_queue.py
SHIMLAYER_API_URL=http://localhost:8000 SHIMLAYER_API_KEY=ops-checker ./scripts/check_ops_thresholds.py
```

## 4. Rollback Plan
- Stop stack:
```bash
docker compose down -v
```
- Re-deploy previous known-good image/tag.
- Re-run smoke and readiness scripts before traffic restore.

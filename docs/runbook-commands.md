# Runbook Commands (Alpha)

Primary release gate: see [`/Users/dmitryivanov/Documents/ShimLayer/docs/release-checklist.md`](/Users/dmitryivanov/Documents/ShimLayer/docs/release-checklist.md)

## 1. Start Stack
```bash
docker compose up -d --build
```

## 2. Smoke Check
```bash
./scripts/smoke_postgres.sh
```

## 2.1 Readiness Probe
```bash
curl -sS http://localhost:8000/v1/readyz
```

## 3. Readiness Check
```bash
./scripts/alpha_readiness_check.sh
```

## 4. Fast Preflight (No Docker DB)
```bash
./scripts/preflight_fast.sh
```

## 5. UI E2E Smoke (Ops)
```bash
./scripts/preflight_ui.sh
```

## 6. Unified Preflight
```bash
# fast + ui
./scripts/preflight_all.sh

# fast + ui + docker/postgres integration
./scripts/preflight_all.sh --with-docker
```

## 7. Ops Threshold Check
```bash
SHIMLAYER_API_URL=http://localhost:8000 \
SHIMLAYER_API_KEY=ops-checker \
./scripts/check_ops_thresholds.py
```

## 8. Generate Sign-Off Report
```bash
SHIMLAYER_API_URL=http://localhost:8000 \
SHIMLAYER_API_KEY=ops-checker \
./scripts/generate_alpha_signoff.py
```

## 9. Postgres Integration Test
```bash
pytest -q -m postgres tests/test_postgres_webhook_queue.py
```

## 10. Replay Dead-Letter Item
```bash
curl -X POST http://localhost:8000/v1/webhooks/dlq/<dead_letter_id>/requeue \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: ops_manager" \
  -H "X-Admin-User: ops-user"
```

## 11. Observability Probe
```bash
curl -sS http://localhost:8000/v1/ops/observability/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: ops-user"
```

## 12. Maintenance Cleanup
```bash
python -m app.tools.cleanup_db
```

## 13. Stop Stack
```bash
docker compose down -v
```

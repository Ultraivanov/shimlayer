# Alpha Sign-Off Report

- Generated at: `2026-02-24T00:00:00Z (placeholder, update on runtime validation)`
- Environment: `code-complete (no runtime e2e in this sandbox)`
- API URL: `n/a`
- Reviewer: `codex`

## Verdict
- Status: `CONDITIONAL PASS`
- Blocking issues: `runtime validation pending (docker/pytest not available in current environment)`
- Notes: `codebase is feature-complete for alpha scope; operational checks must be run locally`

## Health
- Status: `n/a`
- Timestamp: `n/a`

## Ops Metrics
- `queue_pending`: `n/a`
- `queue_processing`: `n/a`
- `queue_total`: `n/a`
- `webhook_delivery_total`: `n/a`
- `webhook_delivery_success_rate`: `n/a`
- `webhook_retry_rate`: `n/a`
- `webhook_dlq_count`: `n/a`
- `task_resolution_p95_seconds`: `n/a`

## Packages
- `indie_entry_150`: flows=`150`, price_usd=`255.0`, unit_price_usd=`1.7`, active=`true`
- `growth_2000`: flows=`2000`, price_usd=`3360.0`, unit_price_usd=`1.68`, active=`true`
- `scale_10000`: flows=`10000`, price_usd=`16500.0`, unit_price_usd=`1.65`, active=`true`

## Checks Executed
- `python3 -m compileall app tests scripts` (pass)
- `./scripts/alpha_readiness_check.sh` (pass with skips for missing docker/pytest)
- `feature completeness review vs alpha checklist` (pass)

## Required Local Runtime Validation (Pending)
- `docker compose up -d --build`
- `./scripts/smoke_postgres.sh`
- `./scripts/alpha_readiness_check.sh`
- `pytest -q -m postgres tests/test_postgres_webhook_queue.py`
- `./scripts/check_ops_thresholds.py`
- `./scripts/generate_alpha_signoff.py` (regenerate this report with live metrics)

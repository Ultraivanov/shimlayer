# Alpha Sign-Off Report

- Generated at: `<timestamp>`
- Environment: `<local/staging>`
- API URL: `<url>`
- Reviewer: `<name>`

## Verdict
- Status: `PASS | FAIL`
- Blocking issues: `<none | short list>`
- Notes: `<optional>`

## Health
- Status: `<ok/fail>`
- Timestamp: `<iso>`

## Ops Metrics
- `queue_pending`: `<int>`
- `queue_processing`: `<int>`
- `queue_total`: `<int>`
- `webhook_delivery_total`: `<int>`
- `webhook_delivery_success_rate`: `<float>`
- `webhook_retry_rate`: `<float>`
- `webhook_dlq_count`: `<int>`
- `task_resolution_p95_seconds`: `<float | null>`

## Packages
- `<code>`: flows=`<int>`, price_usd=`<float>`, unit_price_usd=`<float>`, active=`<bool>`

## Checks Executed
- `./scripts/smoke_postgres.sh`
- `./scripts/alpha_readiness_check.sh`
- `./scripts/check_ops_thresholds.py`
- `pytest -q -m postgres tests/test_postgres_webhook_queue.py`

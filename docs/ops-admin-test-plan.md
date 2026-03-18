# Ops/Admin Test Plan

## Preconditions
- Python env with dependencies installed from `requirements.txt`
- API running with `SHIMLAYER_REPOSITORY=inmemory` (or Postgres with migrated schema)

## Quick run
```bash
python3 -m pytest -q \
  tests/test_ops_admin_controls.py \
  tests/test_smoke_flow.py \
  tests/test_openai_resume_worker_e2e.py \
  tests/test_webhook_worker.py \
  tests/test_stripe_webhook.py \
  tests/test_stripe_signature.py
```

## Coverage map
- RBAC and role headers: `tests/test_ops_admin_controls.py`
- Reason policy and sensitive actions: `tests/test_ops_admin_controls.py`
- Bulk safety (`dry_run`, `confirm_text`): `tests/test_ops_admin_controls.py`
- Incident lifecycle + events: `tests/test_ops_admin_controls.py`
- Finance/observability access: `tests/test_ops_admin_controls.py`
- Webhook queue/DLQ behavior: `tests/test_webhook_worker.py`
- Stripe signature + idempotency: `tests/test_stripe_signature.py`, `tests/test_stripe_webhook.py`

## Suggested CI gate
- Block merge if any of the test files above fail.
- For Postgres mode, add migration + smoke job before tests.

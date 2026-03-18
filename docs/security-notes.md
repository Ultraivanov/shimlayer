# Security Notes (Pre-Deploy)

This document captures the minimum security posture expected for alpha/beta deployments.

## UI and API keys
- Anything in `VITE_*` is shipped to the browser and **must be treated as public**.
- If you must use the console UI with admin features, keep it internal:
  - private network, VPN, or IP allowlist
  - basic auth at the edge
- Do not expose `VITE_ADMIN_KEY` or `VITE_API_KEY` publicly without a proper auth layer.

## Admin headers
- Ops endpoints require:
  - `X-Admin-Key`, `X-Admin-Role`, `X-Admin-User`
- Treat these as secrets and rotate regularly.

## Webhook security
- Set a non-default `SHIMLAYER_WEBHOOK_SECRET`.
- Validate signatures in your receiver:
  - `X-ShimLayer-Signature` + `X-ShimLayer-Timestamp`
- Enforce idempotency using `Idempotency-Key`.

## CORS
- Set `SHIMLAYER_CORS_ORIGINS` to explicit domains only.
- Do not use `*` in production.

## Startup warnings
- Production logs must not include `startup_security_warning`.
- If present, rotate secrets and re-check env vars.


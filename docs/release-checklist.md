# Release Checklist (ShimLayer)

## 1) Backend Preflight
- Run: `./scripts/preflight_fast.sh`
- Expect: all tests pass, frontend build passes.

## 2) Frontend Build (standalone)
- Run:
  - `cd frontend`
  - `npm install`
  - `npm run build`

## 3) Environment & Secrets
- Verify API keys (requester + admin)
- Verify `SHIMLAYER_DB_DSN` (or Supabase connection)
- Verify webhook signing/secret config if used
- Confirm admin role headers are set for Ops UI

## 4) Database Migration (new env)
- Apply schema: `docs/supabase-schema-v0.sql`
- If reusing an existing DB, ensure new tables are present:
  - `ops_metrics_history`
  - `leads`
  - `openai_interruptions`

## 5) Smoke UI (optional but recommended)
- Run:
  - `cd frontend`
  - `npm run e2e`

## 6) Manual Quick Check (5–10 minutes)
- Requester:
  - Create task → upload proof → complete
  - Open by Task ID works
- Operator:
  - Claim → add proof → complete
  - Interruption task path (Approve/Reject)
- Ops:
  - Queue filters/presets
  - Inspector tabs
  - Webhook resend + attempts
  - Bulk download (multi + zip)

## 7) Post‑deploy Quick Checks
- Health endpoint responds
- Requester/Operator/Ops pages load
- Auto‑refresh runs without errors

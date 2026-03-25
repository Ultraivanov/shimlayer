# Release Checklist (ShimLayer)

## Short checklist (release‑ready)
- Run preflights: `./scripts/preflight_fast.sh` + `./scripts/preflight_ui.sh`
- Verify env/secrets: API keys, `SHIMLAYER_DB_DSN`, webhook secret (if used), Ops admin role header
- DB ready: apply `docs/supabase-schema-v0.sql` (and ensure tables exist: `ops_metrics_history`, `leads`, `openai_interruptions`)
- 5‑minute manual UX pass:
  - Requester: create → upload proof → complete; open by ID
  - Operator: claim → add proof → complete; interruption approve/reject
  - Ops: presets/filters, inspector tabs, webhook resend+attempts, bulk download
- Post‑deploy smoke: health endpoint + pages load + auto‑refresh healthy

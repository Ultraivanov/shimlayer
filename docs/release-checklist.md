## Release checklist (MVP)

### Backend + config
- `SHIMLAYER_REPOSITORY=postgres`
- `SHIMLAYER_DB_DSN` set
- `SHIMLAYER_ADMIN_API_KEY` / `SHIMLAYER_WEBHOOK_SECRET` not default
- `SHIMLAYER_OPERATOR_RATE_LIMIT_PER_MINUTE` set (reasonable value)
- Run `./scripts/preflight_fast.sh`

### Database
- Apply `docs/supabase-schema-v0.sql` (includes operators + deliveries + audit tables)

### Telegram (operator delivery)
- `SHIMLAYER_TELEGRAM_BOT_TOKEN` set
- Bot responds to `/link <token>` (operator linking)

### Ops smoke
- Operator onboarding: approve → verify → notify task
- Webhook resend when `callback_url` exists
- Bulk download (1–2 tasks + zip)

### Optional polish
- Quick visual pass on Requester/Operator pages
- Ops audit view UI (if needed)

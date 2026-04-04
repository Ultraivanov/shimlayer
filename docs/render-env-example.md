## Render env пример (MVP)

### shimlayer-api (web)
```
SHIMLAYER_REPOSITORY=postgres
SHIMLAYER_DB_DSN=postgresql://USER:PASS@HOST:5432/DBNAME
SHIMLAYER_ADMIN_API_KEY=generate-strong
SHIMLAYER_WEBHOOK_SECRET=generate-strong
SHIMLAYER_OPERATOR_RATE_LIMIT_PER_MINUTE=120
SHIMLAYER_TELEGRAM_BOT_TOKEN=123456:ABCDEF
SHIMLAYER_CORS_ORIGINS=https://<your-frontend-domain>
```

### shimlayer-webhook-worker (worker)
```
SHIMLAYER_REPOSITORY=postgres
SHIMLAYER_DB_DSN=postgresql://USER:PASS@HOST:5432/DBNAME
SHIMLAYER_ADMIN_API_KEY=<same-as-api>
SHIMLAYER_WEBHOOK_SECRET=<same-as-api>
```

### shimlayer-frontend (static)
```
VITE_API_URL=https://<your-api-domain>
VITE_API_KEY=demo-key
VITE_ADMIN_KEY=<same-as-SHIMLAYER_ADMIN_API_KEY>
VITE_ADMIN_ROLE=admin
VITE_ADMIN_USER=render-admin
VITE_OPERATOR_KEY=<filled-after-operator-approve>
```

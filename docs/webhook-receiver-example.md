# Webhook Receiver Example (FastAPI)

```python
from fastapi import FastAPI, Header, HTTPException, Request

from app.webhooks.idempotency import WebhookReplayGuard
from app.webhooks.verification import verify_webhook_signature

app = FastAPI()
guard = WebhookReplayGuard(ttl_seconds=600)
WEBHOOK_SECRET = "replace-with-your-secret"


@app.post("/shimlayer/webhook")
async def shimlayer_webhook(
    request: Request,
    x_shimlayer_signature: str | None = Header(default=None),
    x_shimlayer_timestamp: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None),
):
    body = await request.body()
    ok = verify_webhook_signature(
        payload=body,
        signature_header=x_shimlayer_signature,
        timestamp_header=x_shimlayer_timestamp,
        secret=WEBHOOK_SECRET,
        tolerance_seconds=300,
    )
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid signature")

    if not idempotency_key or not guard.check_and_mark(idempotency_key):
        raise HTTPException(status_code=409, detail="Duplicate event")

    # TODO: persist event and process business logic
    return {"ok": True}
```

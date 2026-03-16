import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient

from app.api.routes import get_repo as get_repo_dep
from app.main import app
from app.repositories.in_memory import InMemoryRepository
from app.config import get_settings


def _stripe_signature(payload: bytes, secret: str) -> str:
    ts = str(int(time.time()))
    digest = hmac.new(secret.encode("utf-8"), f"{ts}.".encode("utf-8") + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def test_stripe_webhook_checkout_completed_is_idempotent() -> None:
    repo = InMemoryRepository()
    app.dependency_overrides.clear()
    app.dependency_overrides[get_repo_dep] = lambda: repo

    settings = get_settings()
    old_secret = settings.shimlayer_stripe_webhook_secret
    settings.shimlayer_stripe_webhook_secret = "whsec_test"

    client = TestClient(app)
    api_key = "stripe-user"

    event = {
        "id": "evt_test_1",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_1",
                "metadata": {
                    "api_key": api_key,
                    "package_code": "indie_entry_150",
                },
            }
        },
    }
    payload = json.dumps(event).encode("utf-8")
    signature = _stripe_signature(payload, "whsec_test")

    first = client.post("/v1/webhooks/stripe", content=payload, headers={"Stripe-Signature": signature})
    assert first.status_code == 200
    assert first.json()["processed"] is True

    balance = client.get("/v1/billing/balance", headers={"X-API-Key": api_key})
    assert balance.status_code == 200
    assert balance.json()["flow_credits"] == 150

    second = client.post("/v1/webhooks/stripe", content=payload, headers={"Stripe-Signature": signature})
    assert second.status_code == 200
    assert second.json().get("idempotent") is True

    balance2 = client.get("/v1/billing/balance", headers={"X-API-Key": api_key})
    assert balance2.status_code == 200
    assert balance2.json()["flow_credits"] == 150

    settings.shimlayer_stripe_webhook_secret = old_secret
    app.dependency_overrides.clear()


def test_stripe_webhook_payment_intent_topup() -> None:
    repo = InMemoryRepository()
    app.dependency_overrides.clear()
    app.dependency_overrides[get_repo_dep] = lambda: repo

    settings = get_settings()
    old_secret = settings.shimlayer_stripe_webhook_secret
    settings.shimlayer_stripe_webhook_secret = "whsec_test"

    client = TestClient(app)
    api_key = "stripe-topup-user"

    event = {
        "id": "evt_test_2",
        "type": "payment_intent.succeeded",
        "data": {
            "object": {
                "id": "pi_test_1",
                "amount_received": 12345,
                "metadata": {
                    "api_key": api_key,
                },
            }
        },
    }
    payload = json.dumps(event).encode("utf-8")
    signature = _stripe_signature(payload, "whsec_test")

    res = client.post("/v1/webhooks/stripe", content=payload, headers={"Stripe-Signature": signature})
    assert res.status_code == 200
    assert res.json()["processed"] is True

    balance = client.get("/v1/billing/balance", headers={"X-API-Key": api_key})
    assert balance.status_code == 200
    assert round(float(balance.json()["balance_usd"]), 2) == 123.45

    settings.shimlayer_stripe_webhook_secret = old_secret
    app.dependency_overrides.clear()

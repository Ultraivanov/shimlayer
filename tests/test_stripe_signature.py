import hashlib
import hmac
import time

from app.webhooks.stripe_verification import verify_stripe_signature


def _sig(payload: bytes, secret: str, ts: int) -> str:
    digest = hmac.new(secret.encode("utf-8"), f"{ts}.".encode("utf-8") + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def test_verify_stripe_signature_ok() -> None:
    payload = b'{"id":"evt_1"}'
    secret = "whsec_test"
    ts = int(time.time())
    assert verify_stripe_signature(payload=payload, signature_header=_sig(payload, secret, ts), secret=secret)


def test_verify_stripe_signature_bad() -> None:
    payload = b'{"id":"evt_1"}'
    secret = "whsec_test"
    ts = int(time.time())
    assert not verify_stripe_signature(payload=payload, signature_header=f"t={ts},v1=deadbeef", secret=secret)

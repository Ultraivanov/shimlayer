import hashlib
import hmac

from app.webhooks.verification import verify_webhook_signature


def _sign(payload: bytes, timestamp: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), timestamp.encode("utf-8") + b"." + payload, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def test_verify_webhook_signature_success() -> None:
    payload = b'{"event":"task.updated"}'
    ts = "1710000000"
    secret = "test-secret"
    signature = _sign(payload, ts, secret)
    assert verify_webhook_signature(
        payload=payload,
        signature_header=signature,
        timestamp_header=ts,
        secret=secret,
        tolerance_seconds=300,
        now_ts=1710000100,
    )


def test_verify_webhook_signature_rejects_old_timestamp() -> None:
    payload = b'{"event":"task.updated"}'
    ts = "1710000000"
    secret = "test-secret"
    signature = _sign(payload, ts, secret)
    assert not verify_webhook_signature(
        payload=payload,
        signature_header=signature,
        timestamp_header=ts,
        secret=secret,
        tolerance_seconds=30,
        now_ts=1710000100,
    )


def test_verify_webhook_signature_rejects_invalid_signature() -> None:
    payload = b'{"event":"task.updated"}'
    ts = "1710000000"
    assert not verify_webhook_signature(
        payload=payload,
        signature_header="sha256=deadbeef",
        timestamp_header=ts,
        secret="test-secret",
        tolerance_seconds=300,
        now_ts=1710000100,
    )

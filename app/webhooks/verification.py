import hashlib
import hmac
import time


def verify_webhook_signature(
    *,
    payload: bytes,
    signature_header: str | None,
    timestamp_header: str | None,
    secret: str,
    tolerance_seconds: int = 300,
    now_ts: int | None = None,
) -> bool:
    if not signature_header or not timestamp_header:
        return False
    if not signature_header.startswith("sha256="):
        return False

    try:
        ts = int(timestamp_header)
    except ValueError:
        return False

    now = int(time.time()) if now_ts is None else now_ts
    if abs(now - ts) > tolerance_seconds:
        return False

    signed_payload = timestamp_header.encode("utf-8") + b"." + payload
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    provided = signature_header.split("=", 1)[1]
    return hmac.compare_digest(expected, provided)

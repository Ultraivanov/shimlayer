import hashlib
import hmac
import time


def verify_stripe_signature(*, payload: bytes, signature_header: str | None, secret: str, tolerance_seconds: int = 300) -> bool:
    if not signature_header or not secret:
        return False

    parts = {}
    for piece in signature_header.split(","):
        if "=" not in piece:
            continue
        k, v = piece.split("=", 1)
        parts[k.strip()] = v.strip()

    ts_raw = parts.get("t")
    sig_v1 = parts.get("v1")
    if not ts_raw or not sig_v1:
        return False

    try:
        ts = int(ts_raw)
    except ValueError:
        return False

    now = int(time.time())
    if abs(now - ts) > tolerance_seconds:
        return False

    signed_payload = f"{ts}.{payload.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_v1)

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import timezone

import httpx

from app.config import get_settings
from app.models import WebhookJob, utcnow

RETRYABLE_STATUS_CODES = {408, 425, 429}


class WebhookDispatcher:
    def __init__(self) -> None:
        self.settings = get_settings()

    def send(self, job: WebhookJob) -> "WebhookSendResult":
        payload_bytes = json.dumps(job.payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        timestamp = str(int(utcnow().replace(tzinfo=timezone.utc).timestamp()))
        signature = self._sign(payload_bytes, timestamp)

        timeout = self.settings.shimlayer_webhook_timeout_seconds
        with httpx.Client(timeout=timeout) as client:
            try:
                response = client.post(
                    job.callback_url,
                    content=payload_bytes,
                    headers={
                        "Content-Type": "application/json",
                        "X-ShimLayer-Signature": signature,
                        "X-ShimLayer-Timestamp": timestamp,
                        "X-ShimLayer-Event": job.event_type,
                        "Idempotency-Key": job.idempotency_key,
                    },
                )
            except httpx.HTTPError as exc:
                return WebhookSendResult(success=False, status_code=None, error=str(exc), retryable=True)

            success = 200 <= response.status_code < 300
            retryable = response.status_code >= 500 or response.status_code in RETRYABLE_STATUS_CODES
            error = None if success else f"status {response.status_code}"
            return WebhookSendResult(
                success=success,
                status_code=response.status_code,
                error=error,
                retryable=retryable,
            )

    def _sign(self, payload: bytes, timestamp: str) -> str:
        secret = self.settings.shimlayer_webhook_secret.encode("utf-8")
        signed_payload = timestamp.encode("utf-8") + b"." + payload
        digest = hmac.new(secret, signed_payload, hashlib.sha256).hexdigest()
        return f"sha256={digest}"


_dispatcher = WebhookDispatcher()


def get_dispatcher() -> WebhookDispatcher:
    return _dispatcher


@dataclass
class WebhookSendResult:
    success: bool
    status_code: int | None
    error: str | None
    retryable: bool

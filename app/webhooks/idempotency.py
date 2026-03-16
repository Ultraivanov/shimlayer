from datetime import datetime, timedelta, timezone
from threading import RLock


class WebhookReplayGuard:
    def __init__(self, ttl_seconds: int = 600) -> None:
        self.ttl_seconds = ttl_seconds
        self._seen: dict[str, datetime] = {}
        self._lock = RLock()

    def check_and_mark(self, idempotency_key: str, now: datetime | None = None) -> bool:
        current = now or datetime.now(timezone.utc)
        with self._lock:
            self._cleanup(current)
            if idempotency_key in self._seen:
                return False
            self._seen[idempotency_key] = current
            return True

    def _cleanup(self, current: datetime) -> None:
        deadline = current - timedelta(seconds=self.ttl_seconds)
        stale = [k for k, ts in self._seen.items() if ts < deadline]
        for key in stale:
            self._seen.pop(key, None)

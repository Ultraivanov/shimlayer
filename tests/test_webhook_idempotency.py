from datetime import datetime, timedelta, timezone

from app.webhooks.idempotency import WebhookReplayGuard


def test_idempotency_guard_blocks_duplicate_key() -> None:
    guard = WebhookReplayGuard(ttl_seconds=600)
    now = datetime.now(timezone.utc)

    assert guard.check_and_mark("k1", now=now) is True
    assert guard.check_and_mark("k1", now=now + timedelta(seconds=1)) is False


def test_idempotency_guard_expires_key_after_ttl() -> None:
    guard = WebhookReplayGuard(ttl_seconds=10)
    now = datetime.now(timezone.utc)

    assert guard.check_and_mark("k2", now=now) is True
    assert guard.check_and_mark("k2", now=now + timedelta(seconds=11)) is True

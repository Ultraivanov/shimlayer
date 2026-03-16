from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import httpx

from app.models import WebhookJob
from app.webhooks.dispatcher import WebhookDispatcher


class _Resp:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _ClientOK:
    def __init__(self, status_code: int) -> None:
        self._status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, *args, **kwargs):  # noqa: ANN002, ANN003
        _ = (args, kwargs)
        return _Resp(self._status_code)


class _ClientErr:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, *args, **kwargs):  # noqa: ANN002, ANN003
        _ = (args, kwargs)
        raise httpx.ConnectTimeout("timed out")


def _job() -> WebhookJob:
    now = datetime.now(timezone.utc)
    return WebhookJob(
        id=uuid4(),
        task_id=uuid4(),
        callback_url="https://example.com/hook",
        event_type="task.updated",
        payload={"event": "task.updated"},
        idempotency_key=str(uuid4()),
        attempts=1,
        max_attempts=3,
        next_attempt_at=now,
        created_at=now,
    )


def test_dispatcher_marks_429_as_retryable(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "Client", lambda timeout: _ClientOK(status_code=429))
    result = WebhookDispatcher().send(_job())
    assert result.success is False
    assert result.retryable is True
    assert result.status_code == 429


def test_dispatcher_marks_400_as_non_retryable(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "Client", lambda timeout: _ClientOK(status_code=400))
    result = WebhookDispatcher().send(_job())
    assert result.success is False
    assert result.retryable is False
    assert result.status_code == 400


def test_dispatcher_marks_transport_errors_as_retryable(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "Client", lambda timeout: _ClientErr())
    result = WebhookDispatcher().send(_job())
    assert result.success is False
    assert result.retryable is True
    assert result.status_code is None

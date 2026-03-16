from __future__ import annotations

from dataclasses import dataclass

import app.services.review as review_mod
from app.config import get_settings
from app.domain.enums import TaskStatus, TaskType
from app.models import Artifact, Task, utcnow


@dataclass
class _DummyResponse:
    status_code: int = 200

    def json(self):
        return {"output_text": '{"score": 0.95, "reason": "cached_ok"}'}


class _DummyClient:
    def __init__(self, *_, **__):
        self.calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, *_args, **_kwargs):
        self.calls += 1
        return _DummyResponse()


def test_openai_autocheck_cache_avoids_duplicate_calls(monkeypatch) -> None:
    settings = get_settings()
    prev_mode = settings.shimlayer_auto_check_mode
    prev_key = settings.shimlayer_openai_api_key
    prev_cache = settings.shimlayer_auto_check_openai_cache_enabled
    prev_ttl = settings.shimlayer_auto_check_openai_cache_ttl_seconds
    prev_price = settings.shimlayer_auto_check_price_threshold_usd
    try:
        settings.shimlayer_auto_check_mode = "hybrid"
        settings.shimlayer_openai_api_key = "sk-test"
        settings.shimlayer_auto_check_openai_cache_enabled = True
        settings.shimlayer_auto_check_openai_cache_ttl_seconds = 600
        # Ensure heuristic routes to manual so hybrid triggers OpenAI.
        settings.shimlayer_auto_check_price_threshold_usd = 0.1

        dummy = _DummyClient()
        monkeypatch.setattr(review_mod.httpx, "Client", lambda *a, **k: dummy)

        now = utcnow()
        task = Task(
            id="00000000-0000-4000-8000-000000000000",
            account_id="00000000-0000-4000-8000-000000000001",
            worker_id=None,
            task_type=TaskType.STUCK_RECOVERY,
            status=TaskStatus.COMPLETED,
            context={"email": "alice@example.com"},
            result={"action_summary": "ok", "next_step": "resume"},
            max_price_usd=0.48,
            callback_url=None,
            sla_seconds=120,
            sla_deadline=now,
            created_at=now,
            updated_at=now,
        )
        artifacts: list[Artifact] = []

        r1 = review_mod.build_review(task, artifacts, worker_note=None)
        r2 = review_mod.build_review(task, artifacts, worker_note=None)

        assert r1.auto_check_provider == "openai"
        assert r2.auto_check_provider == "openai"
        assert r1.auto_check_model == settings.shimlayer_auto_check_openai_model
        assert r1.auto_check_redacted == bool(settings.shimlayer_auto_check_redact_pii)
        assert dummy.calls == 1
    finally:
        settings.shimlayer_auto_check_mode = prev_mode
        settings.shimlayer_openai_api_key = prev_key
        settings.shimlayer_auto_check_openai_cache_enabled = prev_cache
        settings.shimlayer_auto_check_openai_cache_ttl_seconds = prev_ttl
        settings.shimlayer_auto_check_price_threshold_usd = prev_price

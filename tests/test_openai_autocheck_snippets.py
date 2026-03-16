from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from uuid import UUID

import app.services.review as review_mod
from app.config import get_settings
from app.domain.enums import ArtifactType, TaskStatus, TaskType
from app.models import Artifact, Task, utcnow
from app.services.artifact_storage import save_local_artifact


@dataclass
class _DummyResponse:
    status_code: int = 200

    def json(self):
        return {"output_text": '{"score": 0.95, "reason": "snippet_ok"}'}


class _CaptureClient:
    def __init__(self, *_, **__):
        self.last_payload = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, _url, **kwargs):
        self.last_payload = kwargs.get("json")
        return _DummyResponse()


def test_openai_prompt_includes_redacted_local_snippets(tmp_path) -> None:
    settings = get_settings()
    prev_mode = settings.shimlayer_auto_check_mode
    prev_key = settings.shimlayer_openai_api_key
    prev_dir = settings.shimlayer_artifacts_dir
    prev_include = settings.shimlayer_auto_check_openai_include_local_snippets
    prev_bytes = settings.shimlayer_auto_check_openai_max_snippet_bytes
    prev_lines = settings.shimlayer_auto_check_openai_max_snippet_lines
    prev_redact = settings.shimlayer_auto_check_redact_pii
    prev_max_len = settings.shimlayer_auto_check_redact_max_string_length
    prev_price = settings.shimlayer_auto_check_price_threshold_usd
    try:
        settings.shimlayer_auto_check_mode = "hybrid"
        settings.shimlayer_openai_api_key = "sk-test"
        settings.shimlayer_artifacts_dir = str(tmp_path)
        settings.shimlayer_auto_check_openai_include_local_snippets = True
        settings.shimlayer_auto_check_openai_max_snippet_bytes = 200
        settings.shimlayer_auto_check_openai_max_snippet_lines = 10
        settings.shimlayer_auto_check_redact_pii = True
        settings.shimlayer_auto_check_redact_max_string_length = 2000
        # Force heuristic < pass threshold so hybrid calls OpenAI.
        settings.shimlayer_auto_check_price_threshold_usd = 0.1

        content = b"User alice@example.com logged in from 10.20.30.40\nLine2\nLine3\n"
        storage_path, checksum, metadata = save_local_artifact(
            base_dir=str(tmp_path),
            task_id=UUID("00000000-0000-4000-8000-000000000000"),
            artifact_type=ArtifactType.LOGS,
            content=content,
            filename="logs.txt",
            content_type="text/plain",
            extra_metadata={},
        )
        artifact = Artifact(
            id=UUID("00000000-0000-4000-8000-000000000002"),
            task_id=UUID("00000000-0000-4000-8000-000000000000"),
            artifact_type=ArtifactType.LOGS,
            storage_path=storage_path,
            checksum_sha256=checksum,
            metadata=metadata,
            created_at=utcnow(),
        )

        cap = _CaptureClient()
        review_mod._OPENAI_SCORE_CACHE.clear()
        review_mod.httpx.Client = lambda *a, **k: cap  # type: ignore

        now = utcnow()
        task = Task(
            id=UUID("00000000-0000-4000-8000-000000000000"),
            account_id=UUID("00000000-0000-4000-8000-000000000001"),
            worker_id=None,
            task_type=TaskType.STUCK_RECOVERY,
            status=TaskStatus.COMPLETED,
            context={"note": "contact alice@example.com"},
            result={"action_summary": "ok", "next_step": "resume"},
            max_price_usd=0.48,
            callback_url=None,
            sla_seconds=120,
            sla_deadline=now,
            created_at=now,
            updated_at=now,
        )

        r = review_mod.build_review(task, [artifact], worker_note=None)
        assert r.auto_check_provider == "openai"
        assert r.auto_check_model == settings.shimlayer_auto_check_openai_model
        assert r.auto_check_redacted is True

        assert cap.last_payload is not None
        prompt = json.loads(cap.last_payload["input"])
        artifacts = prompt["artifacts"]
        assert len(artifacts) == 1
        snippet = artifacts[0].get("snippet", "")
        assert "[REDACTED_EMAIL]" in snippet
        assert "[REDACTED_IP]" in snippet
    finally:
        settings.shimlayer_auto_check_mode = prev_mode
        settings.shimlayer_openai_api_key = prev_key
        settings.shimlayer_artifacts_dir = prev_dir
        settings.shimlayer_auto_check_openai_include_local_snippets = prev_include
        settings.shimlayer_auto_check_openai_max_snippet_bytes = prev_bytes
        settings.shimlayer_auto_check_openai_max_snippet_lines = prev_lines
        settings.shimlayer_auto_check_redact_pii = prev_redact
        settings.shimlayer_auto_check_redact_max_string_length = prev_max_len
        settings.shimlayer_auto_check_price_threshold_usd = prev_price

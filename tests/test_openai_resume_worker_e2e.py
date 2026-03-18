from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.main import app
from app.repositories import get_repo
from app.workers.openai_resume_worker import OpenAIResumeDispatcher, OpenAIResumeWorker


def _purchase(client: TestClient, api_key: str, reference: str) -> None:
    r = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": reference},
        headers={"X-API-Key": api_key},
    )
    assert r.status_code == 200


def test_openai_resume_worker_dispatches_via_httpx_and_marks_resumed(monkeypatch) -> None:
    # This is an "e2e" test of the resume-worker loop using the real dispatcher,
    # but without binding a local TCP port (some sandboxed envs forbid binds).
    sent: list[tuple[str, dict[str, Any]]] = []

    class FakeResponse:
        status_code = 204
        text = ""

    class FakeClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            _ = (args, kwargs)

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
            return None

        def post(self, url: str, json: dict[str, Any]) -> FakeResponse:  # noqa: A002
            sent.append((url, json))
            return FakeResponse()

    monkeypatch.setattr("app.workers.openai_resume_worker.httpx.Client", FakeClient)

    client = TestClient(app)
    headers = {"X-API-Key": "openai-worker-e2e-httpx"}
    _purchase(client, headers["X-API-Key"], "invoice-openai-worker-e2e-httpx-1")

    ingest = client.post(
        "/v1/openai/interruptions/ingest",
        json={
            "run_id": "run_e2e_httpx_1",
            "thread_id": "thread_e2e_httpx_1",
            "interruption_id": "intr_worker_e2e_httpx_1",
            "agent_name": "support-agent",
            "tool_name": "cancelOrder",
            "tool_arguments": {"orderId": 777},
            "state_blob": "{\"state\":\"serialized\"}",
            "metadata": {"tenant": "demo"},
            "callback_url": "https://example.invalid/openai/resume",
            "sla_seconds": 90,
        },
        headers=headers,
    )
    assert ingest.status_code == 201

    decide = client.post(
        "/v1/openai/interruptions/intr_worker_e2e_httpx_1/decision",
        json={
            "decision": "approve",
            "actor": "ops-e2e",
            "note": "safe to continue",
            "output": {"choice": "approve"},
        },
        headers=headers,
    )
    assert decide.status_code == 200
    assert decide.json()["status"] == "decided"

    worker = OpenAIResumeWorker(get_repo(), OpenAIResumeDispatcher())
    processed = worker.run_once(max_items=10)
    assert processed >= 1

    assert len(sent) == 1
    url, payload = sent[0]
    assert url == "https://example.invalid/openai/resume"
    assert payload["interruption_id"] == "intr_worker_e2e_httpx_1"
    assert payload["run_id"] == "run_e2e_httpx_1"
    assert payload["thread_id"] == "thread_e2e_httpx_1"
    assert payload["decision"] == "approve"
    assert payload["state_blob"] == "{\"state\":\"serialized\"}"

    check = client.get("/v1/openai/interruptions/intr_worker_e2e_httpx_1", headers=headers)
    assert check.status_code == 200
    assert check.json()["status"] == "resumed"


def test_openai_resume_worker_marks_failed_when_callback_url_missing() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "openai-worker-e2e-missing-callback"}
    _purchase(client, headers["X-API-Key"], "invoice-openai-worker-e2e-missing-callback-1")

    ingest = client.post(
        "/v1/openai/interruptions/ingest",
        json={
            "run_id": "run_e2e_2",
            "thread_id": "thread_e2e_2",
            "interruption_id": "intr_worker_e2e_2",
            "agent_name": "support-agent",
            "tool_name": "cancelOrder",
            "tool_arguments": {"orderId": 888},
            "state_blob": "{\"state\":\"serialized\"}",
            "metadata": {"tenant": "demo"},
            "sla_seconds": 90,
        },
        headers=headers,
    )
    assert ingest.status_code == 201

    decide = client.post(
        "/v1/openai/interruptions/intr_worker_e2e_2/decision",
        json={
            "decision": "approve",
            "actor": "ops-e2e",
            "note": "safe to continue",
            "output": {"choice": "approve"},
        },
        headers=headers,
    )
    assert decide.status_code == 200
    assert decide.json()["status"] == "decided"

    worker = OpenAIResumeWorker(get_repo(), OpenAIResumeDispatcher())
    processed = worker.run_once(max_items=10)
    assert processed >= 1

    check = client.get("/v1/openai/interruptions/intr_worker_e2e_2", headers=headers)
    assert check.status_code == 200
    body = check.json()
    assert body["status"] == "failed"
    assert "callback_url is missing" in (body.get("decision_note") or "")


from fastapi.testclient import TestClient

from app.main import app
from app.repositories import get_repo
from app.workers.openai_resume_worker import OpenAIResumeDispatcher, OpenAIResumeWorker, ResumeDispatchResult


def _admin_headers(api_key: str, role: str = "admin", user: str = "test-admin") -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": role,
        "X-Admin-User": user,
    }


def test_smoke_task_flow() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "test-key"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-1"},
        headers=headers,
    )
    assert purchase.status_code == 200
    assert purchase.json()["purchased_flows"] == 150

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "agent retry loop"},
            "sla_seconds": 120,
            "max_price_usd": 0.48,
        },
        headers=headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]
    assert created.json()["status"] == "queued"

    balance_after_create = client.get("/v1/billing/balance", headers=headers)
    assert balance_after_create.status_code == 200
    assert balance_after_create.json()["flow_credits"] == 149

    claimed = client.post(f"/v1/tasks/{task_id}/claim", headers=headers)
    assert claimed.status_code == 200
    assert claimed.json()["status"] == "claimed"

    proof = client.post(
        f"/v1/tasks/{task_id}/proof",
        json={
            "artifact_type": "screenshot",
            "storage_path": "proofs/task-1/screenshot.png",
            "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
            "metadata": {"width": 1280, "height": 720},
        },
        headers=headers,
    )
    assert proof.status_code == 201

    completed = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "clicked retry", "next_step": "resume workflow"}},
        headers=headers,
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"

    task = client.get(f"/v1/tasks/{task_id}", headers=headers)
    assert task.status_code == 200
    body = task.json()
    assert body["status"] == "completed"
    assert len(body["artifacts"]) == 1
    assert body["review"]["review_status"] in ("auto_passed", "manual_required")

    refunded = client.post(f"/v1/tasks/{task_id}/refund", headers=headers)
    assert refunded.status_code == 200
    assert refunded.json()["status"] == "refunded"

    balance_after_refund = client.get("/v1/billing/balance", headers=headers)
    assert balance_after_refund.status_code == 200
    assert balance_after_refund.json()["flow_credits"] == 150


def test_create_quick_judgment() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "test-key-2"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-2"},
        headers=headers,
    )
    assert purchase.status_code == 200

    response = client.post(
        "/v1/judgments",
        json={"context": {"question": "approve send?"}, "sla_seconds": 60},
        headers=headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["task_type"] == "quick_judgment"
    assert body["status"] == "queued"


def test_list_packages() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "packages-key"}
    response = client.get("/v1/billing/packages", headers=headers)
    assert response.status_code == 200
    items = response.json()
    codes = {i["code"] for i in items}
    assert "indie_entry_150" in codes
    assert "growth_2000" in codes
    assert "scale_10000" in codes


def test_create_task_without_flow_credits_fails() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "no-credits"}

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "agent retry loop"},
            "sla_seconds": 120,
        },
        headers=headers,
    )
    assert created.status_code == 402


def test_free_plan_rate_limit_10_per_minute() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "rate-limit-free"}

    for _ in range(10):
        r = client.get("/v1/billing/balance", headers=headers)
        assert r.status_code == 200

    blocked = client.get("/v1/billing/balance", headers=headers)
    assert blocked.status_code == 429


def test_ops_metrics_shape() -> None:
    client = TestClient(app)
    metrics = client.get("/v1/ops/metrics", headers=_admin_headers("ops-metrics"))
    assert metrics.status_code == 200
    body = metrics.json()
    assert "queue_total" in body
    assert "webhook_delivery_success_rate" in body
    assert "manual_review_pending" in body


def test_list_tasks_isolated_by_api_key() -> None:
    client = TestClient(app)
    a = {"X-API-Key": "list-tasks-a"}
    b = {"X-API-Key": "list-tasks-b"}

    for hdr in (a, b):
        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": f"inv-{hdr['X-API-Key']}"},
            headers=hdr,
        )
        assert purchase.status_code == 200

    created_a = client.post(
        "/v1/tasks",
        json={"task_type": "quick_judgment", "context": {"question": "a"}, "sla_seconds": 60},
        headers=a,
    )
    assert created_a.status_code == 201
    created_b = client.post(
        "/v1/tasks",
        json={"task_type": "quick_judgment", "context": {"question": "b"}, "sla_seconds": 60},
        headers=b,
    )
    assert created_b.status_code == 201

    list_a = client.get("/v1/tasks?limit=50", headers=a)
    assert list_a.status_code == 200
    ids_a = {row["id"] for row in list_a.json()}
    assert created_a.json()["id"] in ids_a
    assert created_b.json()["id"] not in ids_a

    list_b = client.get("/v1/tasks?limit=50", headers=b)
    assert list_b.status_code == 200
    ids_b = {row["id"] for row in list_b.json()}
    assert created_b.json()["id"] in ids_b
    assert created_a.json()["id"] not in ids_b


def test_ops_metrics_requires_admin_key() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "ops-metrics-no-admin"}
    metrics = client.get("/v1/ops/metrics", headers=headers)
    assert metrics.status_code == 403


def test_ops_metrics_requires_role_context() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "ops-metrics-missing-role", "X-Admin-Key": "dev-admin-key"}
    metrics = client.get("/v1/ops/metrics", headers=headers)
    assert metrics.status_code == 403


def test_request_id_header_propagated() -> None:
    client = TestClient(app)
    response = client.get("/v1/healthz", headers={"X-Request-ID": "req-123"})
    assert response.status_code == 200
    assert response.headers.get("X-Request-ID") == "req-123"


def test_readyz() -> None:
    client = TestClient(app)
    response = client.get("/v1/readyz", headers={"X-Request-ID": "req-ready-1"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert response.headers.get("X-Request-ID") == "req-ready-1"


def test_openai_interruption_to_task_and_resume_flow() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "openai-hitl-key"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-openai-1"},
        headers=headers,
    )
    assert purchase.status_code == 200

    ingest = client.post(
        "/v1/openai/interruptions/ingest",
        json={
            "run_id": "run_123",
            "thread_id": "thread_1",
            "interruption_id": "intr_abc",
            "agent_name": "support-agent",
            "tool_name": "cancelOrder",
            "tool_arguments": {"orderId": 101},
            "state_blob": "{\"state\":\"serialized\"}",
            "metadata": {"tenant": "demo"},
            "sla_seconds": 90,
        },
        headers=headers,
    )
    assert ingest.status_code == 201
    body = ingest.json()
    assert body["status"] == "pending"
    task_id = body["task_id"]

    task = client.get(f"/v1/tasks/{task_id}", headers=headers)
    assert task.status_code == 200
    assert task.json()["status"] == "queued"
    assert task.json()["context"]["source"] == "openai.interruption"

    decide = client.post(
        "/v1/openai/interruptions/intr_abc/decision",
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
    assert decide.json()["decision"] == "approve"

    task_after = client.get(f"/v1/tasks/{task_id}", headers=headers)
    assert task_after.status_code == 200
    assert task_after.json()["status"] == "completed"
    assert task_after.json()["result"]["decision"] == "approve"

    resume = client.post("/v1/openai/interruptions/intr_abc/resume", headers=headers)
    assert resume.status_code == 200
    resume_body = resume.json()
    assert resume_body["resume_enqueued"] is True
    assert resume_body["resume_payload"]["interruption_id"] == "intr_abc"
    assert resume_body["resume_payload"]["decision"] == "approve"


def test_openai_resume_worker_dispatches_decided_interruptions() -> None:
    class StubDispatcher(OpenAIResumeDispatcher):
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict]] = []

        def send(self, callback_url: str, payload: dict) -> ResumeDispatchResult:
            self.calls.append((callback_url, payload))
            return ResumeDispatchResult(success=True, status_code=204)

    client = TestClient(app)
    headers = {"X-API-Key": "openai-worker-key"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-openai-worker-1"},
        headers=headers,
    )
    assert purchase.status_code == 200

    ingest = client.post(
        "/v1/openai/interruptions/ingest",
        json={
            "run_id": "run_worker_1",
            "thread_id": "thread_worker_1",
            "interruption_id": "intr_worker_abc",
            "agent_name": "support-agent",
            "tool_name": "cancelOrder",
            "tool_arguments": {"orderId": 202},
            "state_blob": "{\"state\":\"serialized\"}",
            "metadata": {"tenant": "demo"},
            "callback_url": "https://example.com/openai-resume",
            "sla_seconds": 90,
        },
        headers=headers,
    )
    assert ingest.status_code == 201

    decide = client.post(
        "/v1/openai/interruptions/intr_worker_abc/decision",
        json={
            "decision": "approve",
            "actor": "ops-e2e",
            "note": "safe to continue",
            "output": {"choice": "approve"},
        },
        headers=headers,
    )
    assert decide.status_code == 200

    dispatcher = StubDispatcher()
    worker = OpenAIResumeWorker(get_repo(), dispatcher)
    processed = worker.run_once(max_items=10)
    assert processed >= 1
    assert len(dispatcher.calls) == 1
    assert dispatcher.calls[0][0] == "https://example.com/openai-resume"
    assert dispatcher.calls[0][1]["interruption_id"] == "intr_worker_abc"

    check = client.get("/v1/openai/interruptions/intr_worker_abc", headers=headers)
    assert check.status_code == 200
    assert check.json()["status"] == "resumed"

from dataclasses import dataclass

from fastapi.testclient import TestClient

from app.main import app
from app.repositories import get_repo
from app.workers.webhook_worker import WebhookWorker
from app.webhooks.dispatcher import WebhookSendResult


def _admin_headers(api_key: str, role: str, user: str = "ops-user") -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": role,
        "X-Admin-User": user,
    }


@dataclass
class _FakeDispatcher:
    status_code: int = 200
    success: bool = True
    error: str | None = None
    retryable: bool = False

    def send(self, job):  # type: ignore[no-untyped-def]
        _ = job
        return WebhookSendResult(
            success=self.success,
            status_code=self.status_code,
            error=self.error,
            retryable=self.retryable,
        )


def _seed_task_with_callback(client: TestClient, api_key: str) -> str:
    base_headers = {"X-API-Key": api_key}
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": f"ops-webhook-last-{api_key}"},
        headers=base_headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "ops webhook last"},
            "callback_url": "https://example.invalid/webhook",
            "sla_seconds": 120,
        },
        headers=base_headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

    claimed = client.post(f"/v1/tasks/{task_id}/claim", headers=base_headers)
    assert claimed.status_code == 200

    proof = client.post(
        f"/v1/tasks/{task_id}/proof",
        json={
            "artifact_type": "logs",
            "storage_path": f"proofs/{task_id}/logs.txt",
            "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
        },
        headers=base_headers,
    )
    assert proof.status_code == 201

    completed = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "fixed", "next_step": "resume"}},
        headers=base_headers,
    )
    assert completed.status_code == 200
    return task_id


def test_ops_webhook_last_returns_null_then_delivery() -> None:
    client = TestClient(app)
    api_key = "ops-webhook-last"
    task_id = _seed_task_with_callback(client, api_key)

    before = client.get(
        f"/v1/ops/webhooks/last?task_id={task_id}",
        headers=_admin_headers(api_key, role="ops_agent"),
    )
    assert before.status_code == 200
    assert before.json() is None

    repo = get_repo()
    worker = WebhookWorker(repo, _FakeDispatcher(status_code=200, success=True))
    processed = worker.run_once(max_jobs=5)
    assert processed >= 1

    after = client.get(
        f"/v1/ops/webhooks/last?task_id={task_id}",
        headers=_admin_headers(api_key, role="ops_agent"),
    )
    assert after.status_code == 200
    body = after.json()
    assert body is not None
    assert body["task_id"] == task_id
    assert body["success"] is True


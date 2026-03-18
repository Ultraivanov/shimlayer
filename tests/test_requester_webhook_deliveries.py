from dataclasses import dataclass

from fastapi.testclient import TestClient

from app.main import app
from app.repositories import get_repo
from app.workers.webhook_worker import WebhookWorker
from app.webhooks.dispatcher import WebhookSendResult


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
        json={"package_code": "indie_entry_150", "reference": f"req-webhook-{api_key}"},
        headers=base_headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "requester webhook delivery"},
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


def test_requester_can_view_own_task_webhook_deliveries() -> None:
    client = TestClient(app)
    api_key = "requester-webhook-deliveries"
    task_id = _seed_task_with_callback(client, api_key)

    repo = get_repo()
    worker = WebhookWorker(repo, _FakeDispatcher(status_code=200, success=True))
    processed = worker.run_once(max_jobs=5)
    assert processed >= 1

    last = client.get(
        f"/v1/tasks/{task_id}/webhooks/last",
        headers={"X-API-Key": api_key},
    )
    assert last.status_code == 200
    last_body = last.json()
    assert last_body is not None
    assert last_body["task_id"] == task_id
    assert last_body["success"] is True

    res = client.get(
        f"/v1/tasks/{task_id}/webhooks/deliveries?limit=10",
        headers={"X-API-Key": api_key},
    )
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body, list)
    assert len(body) >= 1
    assert body[0]["task_id"] == task_id
    assert body[0]["success"] is True


def test_requester_cannot_view_other_account_webhook_deliveries() -> None:
    client = TestClient(app)
    owner_key = "requester-webhook-owner"
    other_key = "requester-webhook-other"
    task_id = _seed_task_with_callback(client, owner_key)

    last = client.get(
        f"/v1/tasks/{task_id}/webhooks/last",
        headers={"X-API-Key": other_key},
    )
    assert last.status_code == 404

    res = client.get(
        f"/v1/tasks/{task_id}/webhooks/deliveries?limit=10",
        headers={"X-API-Key": other_key},
    )
    assert res.status_code == 404

from uuid import UUID

from app.models import CreateTaskRequest, PackagePurchaseRequest
from app.main import app
from app.repositories.in_memory import InMemoryRepository
from app.workers.webhook_worker import WebhookWorker
from app.webhooks.dispatcher import WebhookSendResult
from fastapi.testclient import TestClient


class SuccessDispatcher:
    def send(self, job):
        _ = job
        return WebhookSendResult(success=True, status_code=200, error=None, retryable=False)


class FailDispatcher:
    def send(self, job):
        _ = job
        return WebhookSendResult(success=False, status_code=400, error="bad request", retryable=False)


def test_webhook_worker_processes_successful_job() -> None:
    repo = InMemoryRepository()
    repo.purchase_package("k1", PackagePurchaseRequest(package_code="indie_entry_150", reference="inv-1"))
    task = repo.create_task(
        "k1",
        CreateTaskRequest(
            task_type="stuck_recovery",
            context={"k": "v"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=3)

    worker = WebhookWorker(repo=repo, dispatcher=SuccessDispatcher())
    processed = worker.run_once()

    assert processed == 1
    assert repo.claim_due_webhook_job() is None


def test_webhook_worker_sends_failed_job_to_dlq() -> None:
    repo = InMemoryRepository()
    repo.purchase_package("k2", PackagePurchaseRequest(package_code="indie_entry_150", reference="inv-2"))
    task = repo.create_task(
        "k2",
        CreateTaskRequest(
            task_type="quick_judgment",
            context={"question": "q"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=1)

    worker = WebhookWorker(repo=repo, dispatcher=FailDispatcher())
    processed = worker.run_once()

    assert processed == 1
    assert len(repo._webhook_dead_letters) == 1


def test_requeue_dead_letter_once() -> None:
    repo = InMemoryRepository()
    repo.purchase_package("k3", PackagePurchaseRequest(package_code="indie_entry_150", reference="inv-3"))
    task = repo.create_task(
        "k3",
        CreateTaskRequest(
            task_type="quick_judgment",
            context={"question": "q"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=1)

    worker = WebhookWorker(repo=repo, dispatcher=FailDispatcher())
    assert worker.run_once() == 1
    assert len(repo._webhook_dead_letters) == 1

    dead_letter_id = UUID(repo._webhook_dead_letters[0]["id"])
    assert repo.requeue_dead_letter(dead_letter_id=dead_letter_id, max_attempts=3) is True
    assert repo.requeue_dead_letter(dead_letter_id=dead_letter_id, max_attempts=3) is False


def test_retryable_failure_is_requeued_with_backoff() -> None:
    class RetryableDispatcher:
        def send(self, job):
            _ = job
            return WebhookSendResult(success=False, status_code=503, error="upstream down", retryable=True)

    repo = InMemoryRepository()
    repo.purchase_package("k4", PackagePurchaseRequest(package_code="indie_entry_150", reference="inv-4"))
    task = repo.create_task(
        "k4",
        CreateTaskRequest(
            task_type="quick_judgment",
            context={"question": "q"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=3)
    worker = WebhookWorker(repo=repo, dispatcher=RetryableDispatcher())
    assert worker.run_once() == 1
    assert len(repo._webhook_jobs) == 1


def test_ops_dlq_endpoint_lists_dead_letters() -> None:
    repo = InMemoryRepository()
    repo.purchase_package("dlq-key", PackagePurchaseRequest(package_code="indie_entry_150", reference="inv-5"))
    task = repo.create_task(
        "dlq-key",
        CreateTaskRequest(
            task_type="quick_judgment",
            context={"question": "q"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=1)
    WebhookWorker(repo=repo, dispatcher=FailDispatcher()).run_once()

    app.dependency_overrides.clear()
    from app.api.routes import get_repo as get_repo_dep

    app.dependency_overrides[get_repo_dep] = lambda: repo
    client = TestClient(app)

    forbidden = client.get("/v1/ops/dlq?limit=10", headers={"X-API-Key": "dlq-key"})
    assert forbidden.status_code == 403

    admin_headers = {
        "X-API-Key": "dlq-key",
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": "admin",
        "X-Admin-User": "test-admin",
    }

    res = client.get("/v1/ops/dlq?limit=10", headers=admin_headers)
    assert res.status_code == 200
    payload = res.json()
    assert len(payload) >= 1
    dead_letter_id = payload[0]["id"]

    requeue = client.post(
        f"/v1/webhooks/dlq/{dead_letter_id}/requeue",
        headers=admin_headers,
    )
    assert requeue.status_code == 200

    res2 = client.get("/v1/ops/dlq?limit=10", headers=admin_headers)
    assert res2.status_code == 200
    assert res2.json()[0]["requeued_at"] is not None

    app.dependency_overrides.clear()

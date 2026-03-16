from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


def test_completion_requires_quality_proof() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "proof-layer-key"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-proof-layer-1"},
        headers=headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "proof required"},
            "sla_seconds": 120,
        },
        headers=headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]
    assert client.post(f"/v1/tasks/{task_id}/claim", headers=headers).status_code == 200

    completed = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "fixed", "next_step": "resume"}},
        headers=headers,
    )
    assert completed.status_code == 409
    assert "proof" in completed.json()["detail"].lower()


def test_auto_check_price_threshold_routes_to_manual_review() -> None:
    settings = get_settings()
    prev = settings.shimlayer_auto_check_price_threshold_usd
    settings.shimlayer_auto_check_price_threshold_usd = 0.1
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "proof-layer-key-2"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-proof-layer-2"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "price threshold"},
                "sla_seconds": 120,
                "max_price_usd": 0.48,
            },
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]
        assert client.post(f"/v1/tasks/{task_id}/claim", headers=headers).status_code == 200

        proof = client.post(
            f"/v1/tasks/{task_id}/proof",
            json={
                "artifact_type": "logs",
                "storage_path": "proofs/task/proof.txt",
                "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
            },
            headers=headers,
        )
        assert proof.status_code == 201

        completed = client.post(
            f"/v1/tasks/{task_id}/complete",
            json={"result": {"action_summary": "fixed", "next_step": "resume"}},
            headers=headers,
        )
        assert completed.status_code == 200

        task = client.get(f"/v1/tasks/{task_id}", headers=headers)
        assert task.status_code == 200
        assert task.json()["review"]["review_status"] == "manual_required"
    finally:
        settings.shimlayer_auto_check_price_threshold_usd = prev

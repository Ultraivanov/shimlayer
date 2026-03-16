from fastapi.testclient import TestClient

from app.main import app


def _admin_headers(api_key: str, role: str = "admin", user: str = "test-admin") -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": role,
        "X-Admin-User": user,
    }


def test_ops_manual_review_queue_returns_task_with_review() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-endpoint"
    headers = {"X-API-Key": api_key}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-ops-manual-review-endpoint"},
        headers=headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "manual review"},
            "sla_seconds": 120,
            "max_price_usd": 2.5,
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
            "storage_path": f"proofs/{task_id}/logs.txt",
            "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
        },
        headers=headers,
    )
    assert proof.status_code == 201

    done = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "ok", "next_step": "go"}},
        headers=headers,
    )
    assert done.status_code == 200

    queue = client.get("/v1/ops/manual-review", headers=_admin_headers(api_key))
    assert queue.status_code == 200
    items = queue.json()
    ids = {t["id"] for t in items}
    assert task_id in ids

    found = next(t for t in items if t["id"] == task_id)
    assert found.get("review") is not None
    assert found["review"]["review_status"] == "manual_required"
    assert isinstance(found.get("artifacts"), list)


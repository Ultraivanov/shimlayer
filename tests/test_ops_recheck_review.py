from fastapi.testclient import TestClient

from app.main import app


def _admin_headers(api_key: str, role: str = "ops_agent", user: str = "ops-rechecker") -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": role,
        "X-Admin-User": user,
    }


def test_ops_recheck_review_recomputes_auto_check() -> None:
    client = TestClient(app)
    api_key = "ops-recheck-review"
    headers = {"X-API-Key": api_key}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-ops-recheck-review-1"},
        headers=headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "recheck review"},
            "sla_seconds": 120,
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
            "storage_path": "proofs/recheck/logs.txt",
            "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
        },
        headers=headers,
    )
    assert proof.status_code == 201

    completed = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={
            "result": {"action_summary": "fixed", "next_step": "resume"},
            "worker_note": "uncertain about the root cause",
        },
        headers=headers,
    )
    assert completed.status_code == 200

    task = client.get(f"/v1/tasks/{task_id}", headers=headers)
    assert task.status_code == 200
    assert task.json()["review"]["review_status"] == "manual_required"

    recheck = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "recheck_review"},
        headers=_admin_headers(api_key),
    )
    assert recheck.status_code == 200
    body = recheck.json()
    assert body["audit_entry"]["action"] == "recheck_review"
    assert set(("provider", "model", "reason", "redacted")).issubset(set(body["audit_entry"]["metadata"].keys()))
    assert body["task"]["review"]["review_status"] == "auto_passed"

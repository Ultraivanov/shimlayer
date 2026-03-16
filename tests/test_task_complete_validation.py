from fastapi.testclient import TestClient

from app.main import app


def test_complete_stuck_recovery_requires_next_step() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "complete-validate-1"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-complete-1"},
        headers=headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "validation"},
            "sla_seconds": 120,
        },
        headers=headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

    claim = client.post(f"/v1/tasks/{task_id}/claim", headers=headers)
    assert claim.status_code == 200

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

    bad_complete = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "did thing"}},
        headers=headers,
    )
    assert bad_complete.status_code == 400


def test_complete_quick_judgment_requires_yes_no() -> None:
    client = TestClient(app)
    headers = {"X-API-Key": "complete-validate-2"}

    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "invoice-complete-2"},
        headers=headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/judgments",
        json={"context": {"question": "ship?"}, "sla_seconds": 60},
        headers=headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

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

    bad_complete = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"decision": "approve"}},
        headers=headers,
    )
    assert bad_complete.status_code == 400

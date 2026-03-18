from fastapi.testclient import TestClient

from app.main import app


def seed_completed_task(client: TestClient, api_key: str, suffix: str) -> str:
    base_headers = {"X-API-Key": api_key}
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": f"sync-{api_key}-{suffix}"},
        headers=base_headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": f"sync-{suffix}"},
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


def test_task_sync_paginates_with_cursor() -> None:
    client = TestClient(app)
    api_key = "task-sync-cursor"
    task_id_1 = seed_completed_task(client, api_key, "a")
    task_id_2 = seed_completed_task(client, api_key, "b")

    first = client.get(
        "/v1/tasks/sync?limit=1&updated_after=1970-01-01T00:00:00Z",
        headers={"X-API-Key": api_key},
    )
    assert first.status_code == 200
    first_body = first.json()
    assert len(first_body["items"]) == 1
    assert first_body["items"][0]["id"] in (task_id_1, task_id_2)
    assert first_body["next_cursor"]

    second = client.get(
        f"/v1/tasks/sync?limit=10&cursor={first_body['next_cursor']}",
        headers={"X-API-Key": api_key},
    )
    assert second.status_code == 200
    second_ids = [row["id"] for row in second.json()["items"]]
    assert task_id_1 in second_ids or task_id_2 in second_ids
    assert first_body["items"][0]["id"] not in second_ids


def test_task_sync_rejects_invalid_cursor() -> None:
    client = TestClient(app)
    api_key = "task-sync-invalid"
    res = client.get(
        "/v1/tasks/sync?cursor=not-a-real-cursor",
        headers={"X-API-Key": api_key},
    )
    assert res.status_code == 400


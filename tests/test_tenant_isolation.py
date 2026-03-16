from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_task_endpoints_are_tenant_isolated() -> None:
    client = TestClient(app)

    key1 = "tenant-a"
    key2 = "tenant-b"

    assert (
        client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-tenant-a-1"},
            headers={"X-API-Key": key1},
        ).status_code
        == 200
    )

    created = client.post(
        "/v1/tasks",
        json={"task_type": "stuck_recovery", "context": {"logs": "isolation"}, "sla_seconds": 120},
        headers={"X-API-Key": key1},
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

    assert client.get(f"/v1/tasks/{task_id}", headers={"X-API-Key": key1}).status_code == 200
    assert client.get(f"/v1/tasks/{task_id}/download", headers={"X-API-Key": key1}).status_code == 200

    assert client.get(f"/v1/tasks/{task_id}", headers={"X-API-Key": key2}).status_code == 404
    assert client.get(f"/v1/tasks/{task_id}/download", headers={"X-API-Key": key2}).status_code == 404
    assert (
        client.post(
            f"/v1/tasks/{task_id}/claim",
            headers={"X-API-Key": key2},
        ).status_code
        == 404
    )


def test_openai_interruption_endpoints_are_tenant_isolated() -> None:
    client = TestClient(app)

    key1 = "tenant-int-a"
    key2 = "tenant-int-b"

    assert (
        client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-tenant-int-a-1"},
            headers={"X-API-Key": key1},
        ).status_code
        == 200
    )

    ingest = client.post(
        "/v1/openai/interruptions/ingest",
        json={
            "interruption_id": "int-tenant-1",
            "run_id": "run-1",
            "thread_id": "thread-1",
            "agent_name": "agent",
            "tool_name": "tool",
            "tool_arguments": {"k": "v"},
            "state_blob": "{}",
            "sla_seconds": 120,
            "callback_url": None,
        },
        headers={"X-API-Key": key1},
    )
    assert ingest.status_code == 201

    assert client.get("/v1/openai/interruptions/int-tenant-1", headers={"X-API-Key": key1}).status_code == 200
    assert client.get("/v1/openai/interruptions/int-tenant-1", headers={"X-API-Key": key2}).status_code == 404

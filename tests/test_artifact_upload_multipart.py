from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
import app.api.routes as routes


def test_multipart_upload_registers_local_artifact_and_allows_complete(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "multipart-1"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-multipart-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={"task_type": "stuck_recovery", "context": {"logs": "x"}, "sla_seconds": 120},
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]
        assert client.post(f"/v1/tasks/{task_id}/claim", headers=headers).status_code == 200

        up = client.post(
            f"/v1/tasks/{task_id}/artifacts/upload-multipart",
            data={"artifact_type": "logs"},
            files={"file": ("proof.txt", b"proof bytes", "text/plain")},
            headers=headers,
        )
        assert up.status_code == 201
        artifact = up.json()
        assert artifact["storage_path"].startswith("local:")
        assert isinstance(artifact.get("checksum_sha256"), str) and len(artifact["checksum_sha256"]) == 64

        done = client.post(
            f"/v1/tasks/{task_id}/complete",
            json={"result": {"action_summary": "ok", "next_step": "go"}},
            headers=headers,
        )
        assert done.status_code == 200

        dl = client.get(
            f"/v1/tasks/{task_id}/artifacts/{artifact['id']}/download",
            headers=headers,
        )
        assert dl.status_code == 200
        assert dl.content == b"proof bytes"
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir


from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import routes
from app.main import app


def test_task_bundle_download_includes_task_timeline_manifest_and_artifacts(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "task-bundle-key"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-task-bundle-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "task bundle download"},
                "sla_seconds": 120,
            },
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]
        assert client.post(f"/v1/tasks/{task_id}/claim", headers=headers).status_code == 200

        content = b"bundle artifact"
        upload = client.post(
            f"/v1/tasks/{task_id}/artifacts/upload",
            json={
                "artifact_type": "logs",
                "content_base64": base64.b64encode(content).decode("ascii"),
                "filename": "bundle.txt",
                "content_type": "text/plain",
            },
            headers=headers,
        )
        assert upload.status_code == 201
        artifact_id = upload.json()["id"]

        completed = client.post(
            f"/v1/tasks/{task_id}/complete",
            json={"result": {"action_summary": "fixed", "next_step": "resume"}},
            headers=headers,
        )
        assert completed.status_code == 200

        dl = client.get(f"/v1/tasks/{task_id}/download", headers=headers)
        assert dl.status_code == 200
        assert dl.headers.get("content-type", "").startswith("application/zip")

        zf = zipfile.ZipFile(io.BytesIO(dl.content))
        names = set(zf.namelist())
        assert "task.json" in names
        assert "timeline.json" in names
        assert "manifest.json" in names
        assert "audit.json" not in names
        artifact_prefix = f"artifacts/{artifact_id}_bundle.txt"
        assert artifact_prefix in names
        assert zf.read(artifact_prefix) == content
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir


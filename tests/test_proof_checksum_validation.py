from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient

from app.main import app
import app.api.routes as routes
from app.domain.enums import ArtifactType
from app.services.artifact_storage import save_local_artifact


def test_register_proof_verifies_local_checksum_and_can_fill(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "proof-checksum-1"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-proof-checksum-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={"task_type": "stuck_recovery", "context": {"logs": "x"}, "sla_seconds": 120},
            headers=headers,
        )
        assert created.status_code == 201
        task_id = UUID(created.json()["id"])

        storage_path, actual_sha, _ = save_local_artifact(
            base_dir=str(tmp_path),
            task_id=task_id,
            artifact_type=ArtifactType.LOGS,
            content=b"proof bytes",
            filename="proof.txt",
            content_type="text/plain",
            extra_metadata={},
        )

        bad = client.post(
            f"/v1/tasks/{task_id}/proof",
            json={
                "artifact_type": "logs",
                "storage_path": storage_path,
                "checksum_sha256": "0" * 64,
            },
            headers=headers,
        )
        assert bad.status_code == 400

        filled = client.post(
            f"/v1/tasks/{task_id}/proof",
            json={"artifact_type": "logs", "storage_path": storage_path},
            headers=headers,
        )
        assert filled.status_code == 201
        assert filled.json()["checksum_sha256"] == actual_sha
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir

import base64
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
import app.api.routes as routes


def test_review_requires_checksum_for_auto_pass(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "review-proof-quality"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-review-1"},
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

        proof = client.post(
            f"/v1/tasks/{task_id}/proof",
            json={"artifact_type": "logs", "storage_path": f"proofs/{task_id}/logs.txt"},
            headers=headers,
        )
        assert proof.status_code == 201

        done = client.post(
            f"/v1/tasks/{task_id}/complete",
            json={"result": {"action_summary": "ok", "next_step": "go"}},
            headers=headers,
        )
        assert done.status_code == 409

        created2 = client.post(
            "/v1/tasks",
            json={"task_type": "stuck_recovery", "context": {"logs": "y"}, "sla_seconds": 120},
            headers=headers,
        )
        assert created2.status_code == 201
        task_id2 = created2.json()["id"]
        assert client.post(f"/v1/tasks/{task_id2}/claim", headers=headers).status_code == 200

        upload = client.post(
            f"/v1/tasks/{task_id2}/artifacts/upload",
            json={
                "artifact_type": "logs",
                "content_base64": base64.b64encode(b"proof bytes").decode("ascii"),
                "filename": "proof.txt",
                "content_type": "text/plain",
            },
            headers=headers,
        )
        assert upload.status_code == 201

        done2 = client.post(
            f"/v1/tasks/{task_id2}/complete",
            json={"result": {"action_summary": "ok", "next_step": "go"}},
            headers=headers,
        )
        assert done2.status_code == 200

        fetched2 = client.get(f"/v1/tasks/{task_id2}", headers=headers)
        assert fetched2.status_code == 200
        assert fetched2.json()["review"]["review_status"] == "auto_passed"
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir

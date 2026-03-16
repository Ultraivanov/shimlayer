import base64
import hashlib
import io
from pathlib import Path
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
import app.api.routes as routes


def test_upload_artifact_and_download_roundtrip(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "artifact-key"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-artifacts-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "artifact upload"},
                "sla_seconds": 120,
            },
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]

        content = b"hello proof"
        expected_sha = hashlib.sha256(content).hexdigest()
        upload = client.post(
            f"/v1/tasks/{task_id}/artifacts/upload",
            json={
                "artifact_type": "logs",
                "content_base64": base64.b64encode(content).decode("ascii"),
                "filename": "proof.txt",
                "content_type": "text/plain",
                "metadata": {"kind": "unit"},
            },
            headers=headers,
        )
        assert upload.status_code == 201
        body = upload.json()
        assert body["artifact_type"] == "logs"
        assert body["checksum_sha256"] == expected_sha
        assert body["storage_path"].startswith("local:")
        artifact_id = body["id"]

        dl = client.get(f"/v1/tasks/{task_id}/artifacts/{artifact_id}/download", headers=headers)
        assert dl.status_code == 200
        assert dl.content == content
        assert dl.headers.get("content-type", "").startswith("text/plain")
        assert dl.headers.get("x-checksum-sha256") == expected_sha
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir


def test_ops_download_artifact_roundtrip(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "artifact-ops-key"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-artifacts-ops-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "artifact ops download"},
                "sla_seconds": 120,
            },
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]

        content = b"hello ops download"
        expected_sha = hashlib.sha256(content).hexdigest()
        upload = client.post(
            f"/v1/tasks/{task_id}/artifacts/upload",
            json={
                "artifact_type": "logs",
                "content_base64": base64.b64encode(content).decode("ascii"),
                "filename": "ops-proof.txt",
                "content_type": "text/plain",
            },
            headers=headers,
        )
        assert upload.status_code == 201
        artifact_id = upload.json()["id"]

        ops_headers = {
            "X-API-Key": "any-key",
            "X-Admin-Key": "dev-admin-key",
            "X-Admin-Role": "ops_agent",
            "X-Admin-User": "ops-user-1",
        }
        dl = client.get(f"/v1/ops/flows/{task_id}/artifacts/{artifact_id}/download", headers=ops_headers)
        assert dl.status_code == 200
        assert dl.content == content
        assert dl.headers.get("content-type", "").startswith("text/plain")
        assert dl.headers.get("x-checksum-sha256") == expected_sha
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir


def test_ops_download_flow_bundle_contains_metadata_and_artifacts(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "artifact-ops-bundle-key"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-artifacts-ops-bundle-1"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "artifact ops bundle download"},
                "sla_seconds": 120,
                "max_price_usd": 1.5,
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

        ops_headers = {
            "X-API-Key": "any-key",
            "X-Admin-Key": "dev-admin-key",
            "X-Admin-Role": "ops_agent",
            "X-Admin-User": "ops-user-1",
        }
        dl = client.get(f"/v1/ops/flows/{task_id}/download", headers=ops_headers)
        assert dl.status_code == 200
        assert dl.headers.get("content-type", "").startswith("application/zip")

        zf = zipfile.ZipFile(io.BytesIO(dl.content))
        names = set(zf.namelist())
        assert "task.json" in names
        assert "audit.json" in names
        assert "timeline.json" in names
        assert "manifest.json" in names
        artifact_prefix = f"artifacts/{artifact_id}_bundle.txt"
        assert artifact_prefix in names
        assert zf.read(artifact_prefix) == content
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir


def test_upload_artifact_rejects_invalid_base64(tmp_path: Path) -> None:
    prev_dir = routes.settings.shimlayer_artifacts_dir
    routes.settings.shimlayer_artifacts_dir = str(tmp_path)
    try:
        client = TestClient(app)
        headers = {"X-API-Key": "artifact-key-bad"}

        purchase = client.post(
            "/v1/billing/packages/purchase",
            json={"package_code": "indie_entry_150", "reference": "invoice-artifacts-2"},
            headers=headers,
        )
        assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "stuck_recovery",
                "context": {"logs": "artifact upload"},
                "sla_seconds": 120,
            },
            headers=headers,
        )
        assert created.status_code == 201
        task_id = created.json()["id"]

        upload = client.post(
            f"/v1/tasks/{task_id}/artifacts/upload",
            json={
                "artifact_type": "logs",
                "content_base64": "!!!not-base64!!!",
            },
            headers=headers,
        )
        assert upload.status_code == 400
    finally:
        routes.settings.shimlayer_artifacts_dir = prev_dir

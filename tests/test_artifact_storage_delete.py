from __future__ import annotations

from uuid import uuid4

import pytest

from app.domain.enums import ArtifactType
from app.services.artifact_storage import delete_local_artifact, load_local_artifact, save_local_artifact


def test_delete_local_artifact_roundtrip(tmp_path) -> None:
    task_id = uuid4()
    storage_path, _, _ = save_local_artifact(
        base_dir=str(tmp_path),
        task_id=task_id,
        artifact_type=ArtifactType.LOGS,
        content=b"hello",
        filename="log.txt",
        content_type="text/plain",
        extra_metadata={},
    )
    assert load_local_artifact(base_dir=str(tmp_path), storage_path=storage_path) == b"hello"
    assert delete_local_artifact(base_dir=str(tmp_path), storage_path=storage_path) is True
    assert delete_local_artifact(base_dir=str(tmp_path), storage_path=storage_path) is False
    with pytest.raises(FileNotFoundError):
        load_local_artifact(base_dir=str(tmp_path), storage_path=storage_path)


def test_delete_local_artifact_rejects_bad_paths(tmp_path) -> None:
    assert delete_local_artifact(base_dir=str(tmp_path), storage_path="s3://bucket/x") is False
    assert delete_local_artifact(base_dir=str(tmp_path), storage_path="local:") is False
    assert delete_local_artifact(base_dir=str(tmp_path), storage_path="local:/../escape") is False

from __future__ import annotations

import hashlib
from pathlib import Path
from uuid import UUID, uuid4

from app.domain.enums import ArtifactType


LOCAL_SCHEME_PREFIX = "local:"


def _safe_extension(filename: str | None) -> str:
    if not filename:
        return ""
    suffix = Path(filename).suffix
    if not suffix or len(suffix) > 12:
        return ""
    # Allow only a conservative set for extensions.
    if not all(ch.isalnum() or ch == "." for ch in suffix):
        return ""
    return suffix.lower()


def _ensure_within_base(base_dir: Path, candidate: Path) -> Path:
    base_resolved = base_dir.resolve()
    candidate_resolved = candidate.resolve()
    if base_resolved == candidate_resolved or base_resolved in candidate_resolved.parents:
        return candidate_resolved
    raise ValueError("Invalid storage path")


def save_local_artifact(
    *,
    base_dir: str,
    task_id: UUID,
    artifact_type: ArtifactType,
    content: bytes,
    filename: str | None,
    content_type: str | None,
    extra_metadata: dict,
) -> tuple[str, str, dict]:
    base = Path(base_dir)
    base.mkdir(parents=True, exist_ok=True)

    checksum = hashlib.sha256(content).hexdigest()
    file_id = uuid4()
    ext = _safe_extension(filename)
    relative = Path(str(task_id)) / f"{file_id}_{artifact_type.value}{ext}"
    full_path = _ensure_within_base(base, base / relative)
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_bytes(content)

    metadata = {
        "filename": filename,
        "content_type": content_type,
        "size_bytes": len(content),
    }
    # Extra metadata goes last so callers can attach additional info.
    if extra_metadata:
        metadata.update(extra_metadata)

    storage_path = f"{LOCAL_SCHEME_PREFIX}{relative.as_posix()}"
    return storage_path, checksum, metadata


def load_local_artifact(*, base_dir: str, storage_path: str) -> bytes:
    if not storage_path.startswith(LOCAL_SCHEME_PREFIX):
        raise ValueError("Unsupported storage scheme")
    rel = storage_path.removeprefix(LOCAL_SCHEME_PREFIX).lstrip("/")
    if not rel:
        raise ValueError("Invalid storage path")
    rel_path = Path(rel)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        raise ValueError("Invalid storage path")
    base = Path(base_dir)
    full_path = _ensure_within_base(base, base / rel_path)
    return full_path.read_bytes()


def delete_local_artifact(*, base_dir: str, storage_path: str) -> bool:
    if not storage_path.startswith(LOCAL_SCHEME_PREFIX):
        return False
    rel = storage_path.removeprefix(LOCAL_SCHEME_PREFIX).lstrip("/")
    if not rel:
        return False
    rel_path = Path(rel)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        return False
    base = Path(base_dir)
    full_path = _ensure_within_base(base, base / rel_path)
    try:
        full_path.unlink()
        return True
    except FileNotFoundError:
        return False

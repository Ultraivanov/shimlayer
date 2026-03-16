from uuid import uuid4

import json
import hashlib
import re
from typing import Any

import httpx

from app.domain.enums import ReviewStatus
from app.config import get_settings
from app.models import Artifact, Review, Task, utcnow
from app.services.pii_redaction import redact_pii
from app.services.auto_check_cache import TtlCache
from app.services.artifact_storage import load_local_artifact


_OPENAI_SCORE_CACHE: TtlCache[tuple[float, str]] = TtlCache(max_items=512)


def _looks_binary_text(decoded: str) -> bool:
    if not decoded:
        return False
    bad = decoded.count("\ufffd")
    return (bad / max(1, len(decoded))) > 0.02


def _snippet_from_local_artifact(
    *,
    storage_path: str,
    artifact_type: str,
    max_bytes: int,
    max_lines: int,
) -> str | None:
    if artifact_type == "screenshot":
        return None
    try:
        raw = load_local_artifact(base_dir=get_settings().shimlayer_artifacts_dir, storage_path=storage_path)
    except Exception:
        return None
    raw = raw[: max(1, int(max_bytes))]
    try:
        decoded = raw.decode("utf-8", errors="replace")
    except Exception:
        return None
    if _looks_binary_text(decoded):
        return None
    lines = decoded.splitlines()
    if len(lines) > max_lines:
        decoded = "\n".join(lines[:max_lines]) + "\n…[TRUNCATED_LINES]"
    return decoded


def build_review(task: Task, artifacts: list[Artifact], worker_note: str | None) -> Review:
    settings = get_settings()
    heuristic_score, heuristic_reason = auto_check_score(
        max_price_usd=task.max_price_usd,
        worker_note=worker_note,
        artifacts=artifacts,
        price_threshold_usd=settings.shimlayer_auto_check_price_threshold_usd,
        min_score_on_price_breach=settings.shimlayer_auto_check_min_score_on_price_breach,
    )

    provider = "heuristic"
    score = heuristic_score
    reason = heuristic_reason
    model_used: str | None = None
    redacted_used: bool | None = None
    mode = settings.shimlayer_auto_check_mode.strip().lower()
    if mode in {"hybrid", "openai"} and settings.shimlayer_openai_api_key:
        # In hybrid mode we only spend tokens when heuristic would route to manual review.
        should_call = mode == "openai" or heuristic_score < settings.shimlayer_auto_check_pass_threshold
        if should_call:
            llm = _openai_auto_check_score(
                task=task,
                artifacts=artifacts,
                worker_note=worker_note,
                api_key=settings.shimlayer_openai_api_key,
                api_base=settings.shimlayer_openai_api_base,
                model=settings.shimlayer_auto_check_openai_model,
                timeout_seconds=settings.shimlayer_auto_check_openai_timeout_seconds,
                heuristic_score=heuristic_score,
                heuristic_reason=heuristic_reason,
            )
            if llm is not None:
                score, reason = llm
                provider = "openai"
                model_used = settings.shimlayer_auto_check_openai_model
                redacted_used = bool(settings.shimlayer_auto_check_redact_pii)

    status = ReviewStatus.AUTO_PASSED if score >= settings.shimlayer_auto_check_pass_threshold else ReviewStatus.MANUAL_REQUIRED
    return Review(
        id=uuid4(),
        task_id=task.id,
        auto_check_provider=provider,
        auto_check_model=model_used,
        auto_check_score=score,
        auto_check_reason=reason,
        auto_check_redacted=redacted_used,
        review_status=status,
        refund_flag=False,
        created_at=utcnow(),
    )


def auto_check_score(
    *,
    max_price_usd: float,
    worker_note: str | None,
    artifacts: list[Artifact],
    price_threshold_usd: float,
    min_score_on_price_breach: float,
) -> float:
    note = (worker_note or "").lower()
    low_confidence = any(token in note for token in ("uncertain", "not sure", "unsure", "guess"))
    missing_details = any(token in note for token in ("no proof", "no logs", "cannot", "can't", "unable"))

    if not artifacts:
        score = 0.55
        reason = "no_artifacts"
    else:
        has_checksum = any(bool(a.checksum_sha256) for a in artifacts)
        if not has_checksum:
            score = 0.72
            reason = "artifacts_missing_checksum"
        else:
            has_local_content = any(str(a.storage_path).startswith("local:") for a in artifacts)
            score = 0.92 if has_local_content else 0.86
            reason = "artifacts_local" if has_local_content else "artifacts_checksums_only"

    if low_confidence:
        score = min(score, 0.70)
        reason = f"{reason}+low_confidence"
    if missing_details:
        score = min(score, 0.66)
        reason = f"{reason}+missing_details"
    if max_price_usd > price_threshold_usd:
        score = min(score, float(min_score_on_price_breach))
        reason = f"{reason}+price_threshold"

    return max(0.0, min(1.0, float(score))), reason


def _extract_text_from_openai_response(body: dict[str, Any]) -> str:
    if isinstance(body.get("output_text"), str):
        return body["output_text"]
    out = body.get("output")
    if isinstance(out, list):
        parts: list[str] = []
        for item in out:
            content = (item or {}).get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and isinstance(c.get("text"), str):
                    parts.append(c["text"])
        if parts:
            return "\n".join(parts)
    # Fallback for other shapes.
    return json.dumps(body)


def _parse_score_payload(text: str) -> tuple[float, str] | None:
    # Find first JSON object in the output.
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    score = obj.get("score")
    reason = obj.get("reason")
    if not isinstance(score, (int, float)):
        return None
    if not isinstance(reason, str):
        reason = "openai"
    score_f = max(0.0, min(1.0, float(score)))
    return score_f, reason.strip()[:500]


def _openai_auto_check_score(
    *,
    task: Task,
    artifacts: list[Artifact],
    worker_note: str | None,
    api_key: str,
    api_base: str,
    model: str,
    timeout_seconds: float,
    heuristic_score: float,
    heuristic_reason: str,
) -> tuple[float, str] | None:
    settings = get_settings()
    redacted = (settings.shimlayer_auto_check_redact_pii is True)
    max_len = settings.shimlayer_auto_check_redact_max_string_length
    safe_context = redact_pii(task.context, max_string_length=max_len) if redacted else task.context
    safe_result = redact_pii(task.result, max_string_length=max_len) if redacted else task.result
    safe_worker_note = redact_pii(worker_note, max_string_length=max_len) if redacted else worker_note
    safe_artifacts = [
        {
            "id": str(a.id),
            "artifact_type": str(a.artifact_type),
            "storage_scheme": "local" if str(a.storage_path).startswith("local:") else "external",
            "has_checksum_sha256": bool(a.checksum_sha256),
            "metadata": redact_pii(a.metadata, max_string_length=max_len) if redacted else a.metadata,
        }
        for a in artifacts
    ]

    if bool(settings.shimlayer_auto_check_openai_include_local_snippets):
        max_bytes = int(settings.shimlayer_auto_check_openai_max_snippet_bytes)
        max_lines = int(settings.shimlayer_auto_check_openai_max_snippet_lines)
        for item, a in zip(safe_artifacts, artifacts, strict=False):
            if not str(a.storage_path).startswith("local:"):
                continue
            snippet = _snippet_from_local_artifact(
                storage_path=str(a.storage_path),
                artifact_type=str(a.artifact_type),
                max_bytes=max_bytes,
                max_lines=max_lines,
            )
            if not snippet:
                continue
            item["snippet"] = redact_pii(snippet, max_string_length=max_len) if redacted else snippet

    prompt = {
        "task": {
            "id": str(task.id),
            "task_type": str(task.task_type),
            "status": str(task.status),
            "max_price_usd": task.max_price_usd,
            "context": safe_context,
            "result": safe_result,
        },
        "worker_note": safe_worker_note,
        "artifacts": safe_artifacts,
        "heuristic": {"score": heuristic_score, "reason": heuristic_reason},
        "pii_redaction": {"enabled": redacted, "max_string_length": max_len},
        "instructions": (
            "You are an audit checker for a human-in-the-loop task system. "
            "Return ONLY JSON: {\"score\": number 0..1, \"reason\": string}. "
            "Score should reflect whether the provided result and artifacts look consistent with the context, "
            "and whether the proof seems sufficient. Prefer lower scores when evidence is weak or inconsistent."
        ),
    }

    cache_ttl = int(settings.shimlayer_auto_check_openai_cache_ttl_seconds)
    cache_enabled = bool(settings.shimlayer_auto_check_openai_cache_enabled) and cache_ttl > 0
    cache_key = ""
    if cache_enabled:
        packed = json.dumps(
            {
                "model": model,
                "prompt": prompt,
                "pass_threshold": settings.shimlayer_auto_check_pass_threshold,
            },
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        cache_key = hashlib.sha256(packed).hexdigest()
        hit = _OPENAI_SCORE_CACHE.get(cache_key)
        if hit is not None:
            return hit

    url = f"{api_base.rstrip('/')}/responses"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "input": json.dumps(prompt),
        "temperature": 0,
        "max_output_tokens": 200,
    }
    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            res = client.post(url, headers=headers, json=payload)
        if res.status_code >= 400:
            return None
        body = res.json()
        text = _extract_text_from_openai_response(body if isinstance(body, dict) else {})
        parsed = _parse_score_payload(text)
        if parsed is not None and cache_enabled and cache_key:
            _OPENAI_SCORE_CACHE.set(cache_key, parsed, ttl_seconds=cache_ttl)
        return parsed
    except Exception:
        return None

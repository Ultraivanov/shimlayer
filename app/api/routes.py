from datetime import datetime, timezone
import base64
import binascii
import hashlib
import io
import json
import os
import zipfile
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import PlainTextResponse
from pydantic import ValidationError
from pydantic import BaseModel

from app.config import get_settings
from app.domain.enums import ArtifactType, TaskType
from app.models import (
    AdminContext,
    Artifact,
    BalanceResponse,
    CompleteTaskRequest,
    CreateArtifactRequest,
    UploadArtifactRequest,
    CreateLeadRequest,
    CreateOperatorApplicationRequest,
    CreateOpsIncidentRequest,
    ApproveOperatorApplicationRequest,
    StripeCheckoutSessionRequest,
    StripeCheckoutSessionResponse,
    CreateJudgmentRequest,
    CreateTaskRequest,
    QuickJudgmentResult,
    OpsBulkActionItem,
    OpsBulkActionRequest,
    OpsBulkActionResponse,
    OpsMetricsHistoryPoint,
    OpsMetricsResponse,
    OpsIncident,
    OpsIncidentEvent,
    OpsIncidentScanRequest,
    OpsMarginSummary,
    OpsObservabilityResponse,
    OpsTaskActionRequest,
    OpsTaskActionResponse,
    OpsTaskAuditEntry,
    OpsTimelineEvent,
    OpenAIInterruptionDecisionRequest,
    OpenAIInterruptionIngestRequest,
    OpenAIInterruptionRecord,
    OpenAIResumeResponse,
    PackageInfo,
    LeadRecord,
    OperatorApplicationRecord,
    OperatorApprovalResponse,
    OperatorDeliveryRecord,
    OperatorDeliverySummary,
    OperatorRecord,
    OperatorTokenRotateResponse,
    PackagePurchaseRequest,
    PackagePurchaseResponse,
    StuckRecoveryResult,
    Task,
    TaskUpdatedEvent,
    TaskWithReview,
    TaskSyncResponse,
    TopUpRequest,
    UpdateOpsIncidentRequest,
    UpdateOperatorApplicationRequest,
    UpdateOperatorStatusRequest,
    UpdateOperatorVerificationRequest,
    WebhookDeadLetter,
    WebhookDelivery,
    LedgerEntry,
)
from app.repositories import get_repo
from app.repositories.base import Repository
from app.repositories.errors import (
    InsufficientFlowCreditsError,
    RateLimitExceededError,
    RefundNotAllowedError,
    UnknownPackageError,
)
from app.webhooks.stripe_verification import verify_stripe_signature
from app.services.openai_hitl import compose_context_capsule
from app.services.artifact_storage import load_local_artifact, save_local_artifact
from app.services.telegram import send_telegram_message

router = APIRouter(prefix="/v1")
settings = get_settings()

SENSITIVE_ACTIONS = {"refund", "force_status"}
VALID_ADMIN_ROLES = {"ops_agent", "ops_manager", "finance", "admin"}
ACTION_PERMISSIONS: dict[str, set[str]] = {
    "ops_agent": {"manual_review", "reassign", "add_note", "recheck_review", "download_artifact", "download_bundle"},
    "ops_manager": {"manual_review", "reassign", "add_note", "refund", "force_status", "recheck_review", "download_artifact", "download_bundle"},
    "finance": {"refund", "add_note"},
    "admin": {"manual_review", "reassign", "add_note", "refund", "force_status", "recheck_review", "download_artifact", "download_bundle"},
}
REASON_POLICY: dict[str, set[str]] = {
    "refund": {
        "customer_request",
        "proof_mismatch",
        "policy_violation",
        "sla_breach",
        "fraud_risk",
        "incident_mitigation",
    },
    "force_status": {"policy_violation", "sla_breach", "fraud_risk", "incident_mitigation"},
}
NOTE_REQUIRED_REASON_CODES = {"fraud_risk", "policy_violation"}


def _is_sha256_hex(value: str | None) -> bool:
    if not value or len(value) != 64:
        return False
    for ch in value:
        if ch not in "0123456789abcdef":
            return False
    return True


def is_uuid_string(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except Exception:
        return False


def _has_quality_proof(task: TaskWithReview) -> bool:
    for artifact in task.artifacts:
        if str(artifact.storage_path).startswith("local:"):
            return True
        checksum = str(artifact.checksum_sha256 or "").lower()
        if _is_sha256_hex(checksum):
            return True
    return False


def _require_operator_task(
    task_id: UUID,
    operator: OperatorRecord,
    repo: Repository,
    require_claimed: bool = False,
) -> TaskWithReview:
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if task.status not in ("queued", "claimed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task not available")
    if task.worker_id and task.worker_id != operator.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task claimed by another operator")
    if require_claimed and task.worker_id != operator.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task must be claimed before action")
    return task


def _auto_create_sla_incident_if_needed(
    repo: Repository,
    overdue_threshold: int,
) -> OpsIncident | None:
    metrics = repo.get_ops_metrics()
    if metrics.tasks_overdue < overdue_threshold:
        return None
    open_incidents = repo.list_incidents(status="open", limit=100)
    existing = next(
        (i for i in open_incidents if i.incident_type == "sla_breach" and i.source == "auto"),
        None,
    )
    if existing:
        return existing
    incident = repo.create_incident(
        CreateOpsIncidentRequest(
            incident_type="sla_breach",
            severity="high" if metrics.tasks_overdue < overdue_threshold * 2 else "critical",
            title=f"SLA breach: overdue={metrics.tasks_overdue}",
            description=(
                f"Auto-created by threshold. overdue={metrics.tasks_overdue}, "
                f"at_risk={metrics.tasks_sla_risk}, threshold={overdue_threshold}"
            ),
            owner=None,
            source="auto",
            metadata={
                "tasks_overdue": metrics.tasks_overdue,
                "tasks_sla_risk": metrics.tasks_sla_risk,
                "threshold": overdue_threshold,
            },
        )
    )
    return incident


def _build_checkout_session(
    *,
    payload: StripeCheckoutSessionRequest,
    api_key: str,
) -> StripeCheckoutSessionResponse:
    if not settings.shimlayer_stripe_secret_key:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Stripe is not configured")

    try:
        from app.billing.catalog import get_package_or_none

        package = get_package_or_none(payload.package_code)
        if not package:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown package")

        form_data = {
            "mode": "payment",
            "success_url": payload.success_url,
            "cancel_url": payload.cancel_url,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": "usd",
            "line_items[0][price_data][product_data][name]": f"ShimLayer {package.code}",
            "line_items[0][price_data][unit_amount]": str(int(package.price_usd * 100)),
            "metadata[api_key]": api_key,
            "metadata[package_code]": package.code,
        }
        if payload.customer_email:
            form_data["customer_email"] = payload.customer_email

        with httpx.Client(timeout=10.0) as client:
            res = client.post(
                f"{settings.shimlayer_stripe_api_base}/v1/checkout/sessions",
                auth=(settings.shimlayer_stripe_secret_key, ""),
                data=form_data,
            )
        if res.status_code >= 400:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Stripe error: {res.text}")
        body = res.json()
        return StripeCheckoutSessionResponse(
            session_id=body.get("id", ""),
            checkout_url=body.get("url", ""),
            publishable_key=settings.shimlayer_stripe_publishable_key,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Stripe integration failed: {exc}") from exc


def _ensure_role_permission(role: str, action: str) -> None:
    if action not in ACTION_PERMISSIONS.get(role, set()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed for this action")


def _validate_reason_policy(action: str, reason_code: str | None, note: str | None) -> None:
    if action not in SENSITIVE_ACTIONS:
        return
    if not reason_code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="reason_code is required")
    allowed = REASON_POLICY.get(action, set())
    if reason_code not in allowed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="reason_code not allowed for action")
    if reason_code in NOTE_REQUIRED_REASON_CODES and not (note and note.strip()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="note is required for selected reason_code")


def _apply_ops_action(
    repo: Repository,
    task_id: UUID,
    payload: OpsTaskActionRequest,
    admin_ctx: AdminContext,
    request_id: str | None,
    remote_ip: str | None,
    dry_run: bool = False,
) -> OpsTaskActionResponse:
    action = payload.action
    _ensure_role_permission(admin_ctx.role, action)
    _validate_reason_policy(action, payload.reason_code, payload.note)
    base_meta = {"role": admin_ctx.role, "reason_code": payload.reason_code, "request_id": request_id, "remote_ip": remote_ip}

    if action == "manual_review":
        if payload.manual_verdict not in ("approved", "rejected"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="manual_verdict is required")
        if dry_run:
            task_state = repo.get_task(task_id)
            if not task_state:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
            return OpsTaskActionResponse(task=task_state, audit_entry=None)
        claimed = repo.claim_manual_review(
            reviewer_id=admin_ctx.user_id,
            task_id=task_id,
            lock_seconds=settings.shimlayer_manual_review_lock_seconds,
        )
        if not claimed:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task is claimed by another reviewer")
        task = repo.set_review_verdict(task_id, payload.manual_verdict, note=payload.note)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="manual_review",
            note=payload.note,
            metadata={**base_meta, "manual_verdict": payload.manual_verdict},
        )
    elif action == "refund":
        if dry_run:
            task_state = repo.get_task(task_id)
            if not task_state:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
            return OpsTaskActionResponse(task=task_state, audit_entry=None)
        try:
            refund_reason = payload.reason_code if not payload.note else f"{payload.reason_code}:{payload.note}"
            task = repo.refund_task(task_id, reason=refund_reason)
        except RefundNotAllowedError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="refund",
            note=payload.note,
            metadata=base_meta,
        )
    elif action == "reassign":
        if not payload.worker_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="worker_id is required")
        if dry_run:
            task_state = repo.get_task(task_id)
            if not task_state:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
            return OpsTaskActionResponse(task=task_state, audit_entry=None)
        task = repo.reassign_task(task_id, payload.worker_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="reassign",
            note=payload.note,
            metadata={**base_meta, "worker_id": str(payload.worker_id)},
        )
    elif action == "force_status":
        if not payload.status:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="status is required")
        if dry_run:
            task_state = repo.get_task(task_id)
            if not task_state:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
            return OpsTaskActionResponse(task=task_state, audit_entry=None)
        task = repo.force_task_status(task_id, payload.status.value)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="force_status",
            note=payload.note,
            metadata={**base_meta, "status": payload.status.value},
        )
    elif action == "recheck_review":
        task_state = repo.get_task(task_id)
        if not task_state:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        if task_state.status not in ("completed", "disputed"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task must be completed or disputed")
        if task_state.review and task_state.review.review_status in ("approved", "rejected"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot recheck after manual verdict")
        if dry_run:
            return OpsTaskActionResponse(task=task_state, audit_entry=None)

        before_status = task_state.review.review_status if task_state.review else None
        before_score = task_state.review.auto_check_score if task_state.review else None
        ok = repo.recheck_review(task_id)
        if not ok:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Recheck failed")
        updated = repo.get_task(task_id)
        if not updated:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        after_status = updated.review.review_status if updated.review else None
        after_score = updated.review.auto_check_score if updated.review else None
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="recheck_review",
            note=payload.note,
            metadata={
                **base_meta,
                "before_status": before_status,
                "after_status": after_status,
                "before_score": before_score,
                "after_score": after_score,
                "provider": getattr(updated.review, "auto_check_provider", None) if updated.review else None,
                "model": getattr(updated.review, "auto_check_model", None) if updated.review else None,
                "reason": getattr(updated.review, "auto_check_reason", None) if updated.review else None,
                "redacted": getattr(updated.review, "auto_check_redacted", None) if updated.review else None,
            },
        )
    elif action == "add_note":
        task = repo.get_task(task_id)
        if not task:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
        if dry_run:
            return OpsTaskActionResponse(task=task, audit_entry=None)
        audit = repo.append_task_audit(
            task_id,
            actor=admin_ctx.user_id,
            action="add_note",
            note=payload.note,
            metadata=base_meta,
        )
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown action")

    task_state = repo.get_task(task_id)
    if not task_state:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if not dry_run and action in ("refund", "manual_review", "reassign", "force_status", "recheck_review"):
        repo.enqueue_task_webhook(task_state, settings.shimlayer_webhook_max_attempts)
    return OpsTaskActionResponse(task=task_state, audit_entry=audit)


def require_api_key(
    x_api_key: str | None = Header(default=None),
    repo: Repository = Depends(get_repo),
) -> str:
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing X-API-Key")
    try:
        repo.consume_rate_limit(x_api_key)
    except RateLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    return x_api_key


def _require_owned_task(task_id: UUID, api_key: str, repo: Repository) -> TaskWithReview:
    account_id = repo.get_balance(api_key).account_id
    task = repo.get_task(task_id)
    if not task or task.account_id != account_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


def require_admin_key(
    x_admin_key: str | None = Header(default=None),
) -> str:
    if not x_admin_key or x_admin_key != settings.shimlayer_admin_api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return x_admin_key


def require_admin_context(
    x_admin_role: str | None = Header(default=None),
    x_admin_user: str | None = Header(default=None),
) -> AdminContext:
    if not x_admin_role or x_admin_role not in VALID_ADMIN_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin role")
    if not x_admin_user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing X-Admin-User")
    return AdminContext(role=x_admin_role, user_id=x_admin_user)


def require_operator_key(
    x_operator_key: str | None = Header(default=None, alias="X-Operator-Key"),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    if not x_operator_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing operator key")
    operator = repo.get_operator_by_token(x_operator_key)
    if not operator or operator.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid operator key")
    if operator.verification_status != "verified":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operator not verified")
    try:
        repo.consume_operator_rate_limit(operator.id, settings.shimlayer_operator_rate_limit_per_minute)
    except RateLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    return operator


def require_operator_key_basic(
    x_operator_key: str | None = Header(default=None, alias="X-Operator-Key"),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    if not x_operator_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing operator key")
    operator = repo.get_operator_by_token(x_operator_key)
    if not operator or operator.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid operator key")
    try:
        repo.consume_operator_rate_limit(operator.id, settings.shimlayer_operator_rate_limit_per_minute)
    except RateLimitExceededError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    return operator


def _notify_operator_decision(record: OperatorApplicationRecord) -> None:
    if not record.telegram_chat_id or record.status not in {"approved", "rejected"}:
        return
    if record.status == "approved":
        message = (
            "✅ You are approved for ShimLayer operator onboarding. "
            "We’ll share task access and onboarding steps here."
        )
    else:
        message = (
            "Thank you for applying to ShimLayer. "
            "We can’t approve your application right now, but we’ll keep your details on file."
        )
    _ = send_telegram_message(record.telegram_chat_id, message)


class _TaskSyncCursor(BaseModel):
    updated_at: datetime
    task_id: UUID


class _OperatorNotifyTaskRequest(BaseModel):
    task_id: UUID
    message: str | None = None


def _encode_task_sync_cursor(updated_at: datetime, task_id: UUID) -> str:
    raw = _TaskSyncCursor(updated_at=updated_at, task_id=task_id).model_dump(mode="json")
    data = json.dumps(raw, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _decode_task_sync_cursor(cursor: str) -> _TaskSyncCursor:
    pad = "=" * ((4 - (len(cursor) % 4)) % 4)
    data = base64.urlsafe_b64decode((cursor + pad).encode("utf-8"))
    obj = json.loads(data.decode("utf-8"))
    return _TaskSyncCursor(**obj)


@router.post("/tasks", response_model=Task, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: CreateTaskRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    try:
        task = repo.create_task(api_key, payload)
    except InsufficientFlowCreditsError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=str(exc),
        ) from exc
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.get("/tasks", response_model=list[TaskWithReview])
def list_my_tasks(
    limit: int = 50,
    status_filter: str | None = None,
    task_type: str | None = None,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> list[TaskWithReview]:
    return repo.list_account_tasks_with_review(
        api_key=api_key,
        limit=limit,
        status=status_filter,
        task_type=task_type,
    )


@router.get("/tasks/sync", response_model=TaskSyncResponse)
def sync_my_tasks(
    limit: int = 50,
    cursor: str | None = None,
    updated_after: datetime | None = None,
    status_filter: str | None = None,
    task_type: str | None = None,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> TaskSyncResponse:
    capped_limit = max(1, min(limit, 200))
    after_updated_at: datetime | None = None
    after_task_id: UUID | None = None
    if cursor:
        try:
            decoded = _decode_task_sync_cursor(cursor)
            after_updated_at = decoded.updated_at
            after_task_id = decoded.task_id
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid cursor: {exc}") from exc
    elif updated_after:
        after_updated_at = updated_after
        after_task_id = UUID(int=0)

    items = repo.list_account_tasks_with_review_after(
        api_key=api_key,
        after_updated_at=after_updated_at,
        after_task_id=after_task_id,
        limit=capped_limit,
        status=status_filter,
        task_type=task_type,
    )
    next_cursor = _encode_task_sync_cursor(items[-1].updated_at, items[-1].id) if items else None
    return TaskSyncResponse(items=items, next_cursor=next_cursor)


@router.get("/tasks/{task_id}", response_model=TaskWithReview)
def get_task(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview:
    return _require_owned_task(task_id, api_key, repo)


@router.get("/tasks/{task_id}/webhooks/deliveries", response_model=list[WebhookDelivery])
def my_task_webhook_deliveries(
    task_id: UUID,
    limit: int = 20,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> list[WebhookDelivery]:
    _ = _require_owned_task(task_id, api_key, repo)
    capped_limit = max(1, min(limit, 50))
    return repo.list_webhook_deliveries(task_id=task_id, limit=capped_limit)


@router.get("/tasks/{task_id}/webhooks/last", response_model=WebhookDelivery | None)
def my_task_webhook_last_delivery(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> WebhookDelivery | None:
    _ = _require_owned_task(task_id, api_key, repo)
    rows = repo.list_webhook_deliveries(task_id=task_id, limit=1)
    return rows[0] if rows else None


@router.get("/tasks/{task_id}/download")
def download_task_bundle(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Response:
    task = _require_owned_task(task_id, api_key, repo)

    events: list[OpsTimelineEvent] = [
        OpsTimelineEvent(
            at=task.created_at,
            kind="task_created",
            actor="system",
            message=f"Task created with status={task.status}",
            metadata={"task_type": task.task_type, "status": task.status},
        )
    ]
    for artifact in task.artifacts:
        events.append(
            OpsTimelineEvent(
                at=artifact.created_at,
                kind="artifact_uploaded",
                actor="operator",
                message=f"artifact={artifact.artifact_type}",
                metadata={"storage_path": artifact.storage_path},
            )
        )
    if task.review:
        events.append(
            OpsTimelineEvent(
                at=task.review.created_at,
                kind="review",
                actor="review_engine",
                message=f"review_status={task.review.review_status}",
                metadata={
                    "manual_verdict": task.review.manual_verdict,
                    "auto_check_provider": getattr(task.review, "auto_check_provider", "heuristic"),
                    "auto_check_model": getattr(task.review, "auto_check_model", None),
                    "auto_check_score": task.review.auto_check_score,
                    "auto_check_reason": getattr(task.review, "auto_check_reason", None),
                    "auto_check_redacted": getattr(task.review, "auto_check_redacted", None),
                },
            )
        )
    events.sort(key=lambda e: e.at, reverse=True)

    buf = io.BytesIO()
    manifest: dict = {
        "task_id": str(task_id),
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "artifacts": [],
    }
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("task.json", json.dumps(task.model_dump(), indent=2, default=str))
        zf.writestr("timeline.json", json.dumps([e.model_dump() for e in events], indent=2, default=str))

        for artifact in task.artifacts:
            filename = str(artifact.metadata.get("filename") or "artifact.bin").replace('"', "")
            safe_name = os.path.basename(filename) or "artifact.bin"
            zip_name = f"artifacts/{artifact.id}_{safe_name}"
            entry = {
                "id": str(artifact.id),
                "artifact_type": str(artifact.artifact_type),
                "storage_path": str(artifact.storage_path),
                "checksum_sha256": artifact.checksum_sha256 or "",
                "filename": safe_name,
                "zip_path": zip_name,
            }
            try:
                content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=artifact.storage_path)
                zf.writestr(zip_name, content)
                entry["included"] = True
                entry["size_bytes"] = len(content)
            except Exception as exc:
                zf.writestr(zip_name, f"UNAVAILABLE: {artifact.storage_path}\nERROR: {exc}\n")
                entry["included"] = False
                entry["error"] = str(exc)
            manifest["artifacts"].append(entry)

        zf.writestr("manifest.json", json.dumps(manifest, indent=2, default=str))

    payload = buf.getvalue()
    headers = {"Content-Disposition": f'attachment; filename="task-{task_id}.zip"'}
    return Response(content=payload, media_type="application/zip", headers=headers)


@router.post("/tasks/{task_id}/claim", response_model=Task)
def claim_task(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    _require_owned_task(task_id, api_key, repo)
    task = repo.claim_task(task_id, worker_id=uuid4())
    if not task:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task unavailable")
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.post("/tasks/{task_id}/refund", response_model=Task)
def refund_task(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    _require_owned_task(task_id, api_key, repo)
    try:
        task = repo.refund_task(task_id, reason="manual_refund")
    except RefundNotAllowedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.post("/tasks/{task_id}/complete", response_model=Task)
def complete_task(
    task_id: UUID,
    payload: CompleteTaskRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    existing = _require_owned_task(task_id, api_key, repo)
    if existing.status not in ("queued", "claimed"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found or invalid state")
    if not _has_quality_proof(existing):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Quality proof artifact required before completion",
        )
    try:
        if existing.task_type == TaskType.STUCK_RECOVERY:
            StuckRecoveryResult.model_validate(payload.result)
        elif existing.task_type == TaskType.QUICK_JUDGMENT:
            QuickJudgmentResult.model_validate(payload.result)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid result payload") from exc
    task = repo.complete_task(task_id, result=payload.result, worker_note=payload.worker_note)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found or invalid state")
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.post("/tasks/{task_id}/proof", response_model=Artifact, status_code=status.HTTP_201_CREATED)
def register_proof(
    task_id: UUID,
    payload: CreateArtifactRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Artifact:
    _require_owned_task(task_id, api_key, repo)
    checksum = payload.checksum_sha256
    if checksum is not None:
        checksum = str(checksum).lower()
        if not _is_sha256_hex(checksum):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid checksum_sha256")

    # If the caller registers a local artifact, we can verify (or fill) its checksum.
    if str(payload.storage_path).startswith("local:"):
        try:
            content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=payload.storage_path)
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact content not found") from exc
        actual = hashlib.sha256(content).hexdigest()
        if checksum is not None and checksum != actual:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Checksum mismatch")
        checksum = actual

    artifact = repo.add_artifact(
        task_id,
        payload.model_copy(update={"checksum_sha256": checksum}),
    )
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return artifact


@router.post("/tasks/{task_id}/artifacts/upload", response_model=Artifact, status_code=status.HTTP_201_CREATED)
def upload_artifact(
    task_id: UUID,
    payload: UploadArtifactRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Artifact:
    _require_owned_task(task_id, api_key, repo)
    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid base64 content") from exc

    storage_path, checksum, metadata = save_local_artifact(
        base_dir=settings.shimlayer_artifacts_dir,
        task_id=task_id,
        artifact_type=payload.artifact_type,
        content=content,
        filename=payload.filename,
        content_type=payload.content_type,
        extra_metadata=payload.metadata,
    )
    artifact = repo.add_artifact(
        task_id,
        CreateArtifactRequest(
            artifact_type=payload.artifact_type,
            storage_path=storage_path,
            checksum_sha256=checksum,
            metadata=metadata,
        ),
    )
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return artifact


@router.post("/tasks/{task_id}/artifacts/upload-multipart", response_model=Artifact, status_code=status.HTTP_201_CREATED)
async def upload_artifact_multipart(
    task_id: UUID,
    artifact_type: str = Form(...),
    file: UploadFile = File(...),
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Artifact:
    _require_owned_task(task_id, api_key, repo)
    try:
        at = ArtifactType(artifact_type)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid artifact_type") from exc

    content = await file.read()
    storage_path, checksum, metadata = save_local_artifact(
        base_dir=settings.shimlayer_artifacts_dir,
        task_id=task_id,
        artifact_type=at,
        content=content,
        filename=file.filename,
        content_type=file.content_type,
        extra_metadata={},
    )
    artifact = repo.add_artifact(
        task_id,
        CreateArtifactRequest(
            artifact_type=at,
            storage_path=storage_path,
            checksum_sha256=checksum,
            metadata=metadata,
        ),
    )
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return artifact


@router.get("/operator/queue", response_model=list[TaskWithReview])
def operator_queue(
    status_filter: str | None = None,
    task_type: str | None = None,
    only_manual_review: bool = False,
    mine_only: bool = False,
    limit: int = 100,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> list[TaskWithReview]:
    rows = repo.list_tasks_with_review(
        limit=limit,
        status=status_filter,
        task_type=task_type,
        only_manual_review=only_manual_review,
    )
    if not status_filter:
        rows = [r for r in rows if r.status in ("queued", "claimed")]
    if mine_only or status_filter == "claimed":
        rows = [r for r in rows if r.worker_id == operator.id]
    else:
        rows = [r for r in rows if r.worker_id is None or r.worker_id == operator.id]
    return rows


@router.get("/operator/me", response_model=OperatorRecord)
def operator_me(
    operator: OperatorRecord = Depends(require_operator_key_basic),
) -> OperatorRecord:
    return operator


@router.get("/operator/deliveries/last", response_model=OperatorDeliveryRecord | None)
def operator_last_delivery(
    operator: OperatorRecord = Depends(require_operator_key_basic),
    repo: Repository = Depends(get_repo),
) -> OperatorDeliveryRecord | None:
    return repo.get_operator_last_delivery(operator.id)


@router.get("/operator/tasks/{task_id}", response_model=TaskWithReview)
def operator_get_task(
    task_id: UUID,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview:
    return _require_operator_task(task_id, operator, repo, require_claimed=False)


@router.post("/operator/tasks/{task_id}/claim", response_model=Task)
def operator_claim_task(
    task_id: UUID,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    task = _require_operator_task(task_id, operator, repo, require_claimed=False)
    if task.status == "claimed" and task.worker_id == operator.id:
        return task
    claimed = repo.claim_task(task_id, worker_id=operator.id)
    if not claimed:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task unavailable")
    repo.enqueue_task_webhook(claimed, settings.shimlayer_webhook_max_attempts)
    return claimed


@router.post("/operator/tasks/{task_id}/complete", response_model=Task)
def operator_complete_task(
    task_id: UUID,
    payload: CompleteTaskRequest,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    existing = _require_operator_task(task_id, operator, repo, require_claimed=True)
    if not _has_quality_proof(existing):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Quality proof artifact required before completion",
        )
    try:
        if existing.task_type == TaskType.STUCK_RECOVERY:
            StuckRecoveryResult.model_validate(payload.result)
        elif existing.task_type == TaskType.QUICK_JUDGMENT:
            QuickJudgmentResult.model_validate(payload.result)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid result payload") from exc
    task = repo.complete_task(task_id, result=payload.result, worker_note=payload.worker_note)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found or invalid state")
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.post("/operator/tasks/{task_id}/proof", response_model=Artifact, status_code=status.HTTP_201_CREATED)
def operator_register_proof(
    task_id: UUID,
    payload: CreateArtifactRequest,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> Artifact:
    _ = _require_operator_task(task_id, operator, repo, require_claimed=True)
    checksum = payload.checksum_sha256
    if checksum is not None:
        checksum = str(checksum).lower()
        if not _is_sha256_hex(checksum):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid checksum_sha256")

    if str(payload.storage_path).startswith("local:"):
        try:
            content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=payload.storage_path)
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact content not found") from exc
        actual = hashlib.sha256(content).hexdigest()
        if checksum is not None and checksum != actual:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Checksum mismatch")
        checksum = actual

    artifact = repo.add_artifact(
        task_id,
        payload.model_copy(update={"checksum_sha256": checksum}),
    )
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return artifact


@router.post("/operator/tasks/{task_id}/artifacts/upload", response_model=Artifact, status_code=status.HTTP_201_CREATED)
def operator_upload_artifact(
    task_id: UUID,
    payload: UploadArtifactRequest,
    operator: OperatorRecord = Depends(require_operator_key),
    repo: Repository = Depends(get_repo),
) -> Artifact:
    _ = _require_operator_task(task_id, operator, repo, require_claimed=True)
    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid base64 content") from exc

    storage_path, checksum, metadata = save_local_artifact(
        base_dir=settings.shimlayer_artifacts_dir,
        task_id=task_id,
        artifact_type=payload.artifact_type,
        content=content,
        filename=payload.filename,
        content_type=payload.content_type,
        extra_metadata=payload.metadata,
    )
    artifact = repo.add_artifact(
        task_id,
        CreateArtifactRequest(
            artifact_type=payload.artifact_type,
            storage_path=storage_path,
            checksum_sha256=checksum,
            metadata=metadata,
        ),
    )
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return artifact


@router.get("/tasks/{task_id}/artifacts/{artifact_id}/download")
def download_artifact(
    task_id: UUID,
    artifact_id: UUID,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Response:
    task = _require_owned_task(task_id, api_key, repo)
    artifact = next((a for a in task.artifacts if a.id == artifact_id), None)
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")
    try:
        content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=artifact.storage_path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact content not found") from exc

    filename = str(artifact.metadata.get("filename") or "artifact.bin").replace('"', "")
    content_type = str(artifact.metadata.get("content_type") or "application/octet-stream")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Checksum-Sha256": artifact.checksum_sha256 or "",
    }
    return Response(content=content, media_type=content_type, headers=headers)


@router.post("/judgments", response_model=Task, status_code=status.HTTP_201_CREATED)
def create_judgment(
    payload: CreateJudgmentRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> Task:
    task_payload = CreateTaskRequest(
        task_type=TaskType.QUICK_JUDGMENT,
        context=payload.context,
        sla_seconds=payload.sla_seconds,
        callback_url=payload.callback_url,
    )
    try:
        task = repo.create_task(api_key, task_payload)
    except InsufficientFlowCreditsError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=str(exc),
        ) from exc
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return task


@router.post("/openai/interruptions/ingest", response_model=OpenAIInterruptionRecord, status_code=status.HTTP_201_CREATED)
def ingest_openai_interruption(
    payload: OpenAIInterruptionIngestRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> OpenAIInterruptionRecord:
    existing = repo.get_openai_interruption(payload.interruption_id)
    if existing:
        return existing

    context_capsule = compose_context_capsule(payload)
    task_type = TaskType.QUICK_JUDGMENT
    if context_capsule.get("task_type_hint") == "stuck_recovery":
        task_type = TaskType.STUCK_RECOVERY
    task_payload = CreateTaskRequest(
        task_type=task_type,
        context={
            "source": "openai.interruption",
            "run_id": payload.run_id,
            "thread_id": payload.thread_id,
            "interruption_id": payload.interruption_id,
            "agent_name": payload.agent_name,
            "tool_name": payload.tool_name,
            "tool_arguments": payload.tool_arguments,
            "capsule": context_capsule,
        },
        sla_seconds=payload.sla_seconds,
        callback_url=payload.callback_url,
    )
    try:
        task = repo.create_task(api_key, task_payload)
    except InsufficientFlowCreditsError as exc:
        raise HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=str(exc)) from exc
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    return repo.create_openai_interruption(payload, task.id, context_capsule)


@router.get("/openai/interruptions/{interruption_id}", response_model=OpenAIInterruptionRecord)
def get_openai_interruption(
    interruption_id: str,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> OpenAIInterruptionRecord:
    item = repo.get_openai_interruption(interruption_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OpenAI interruption not found")
    _require_owned_task(item.task_id, api_key, repo)
    return item


@router.post("/openai/interruptions/{interruption_id}/decision", response_model=OpenAIInterruptionRecord)
def decide_openai_interruption(
    interruption_id: str,
    payload: OpenAIInterruptionDecisionRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> OpenAIInterruptionRecord:
    item = repo.get_openai_interruption(interruption_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OpenAI interruption not found")

    task = _require_owned_task(item.task_id, api_key, repo)
    if task.status in ("queued", "claimed"):
        completed = repo.complete_task(
            item.task_id,
            result={
                "decision": payload.decision,
                "output": payload.output,
                "note": payload.note,
                "source": "openai.interruption",
            },
            worker_note=payload.note,
        )
        if completed:
            repo.enqueue_task_webhook(completed, settings.shimlayer_webhook_max_attempts)

    decided = repo.decide_openai_interruption(interruption_id, payload)
    if not decided:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OpenAI interruption not found")
    return decided


@router.post("/openai/interruptions/{interruption_id}/resume", response_model=OpenAIResumeResponse)
def resume_openai_interruption(
    interruption_id: str,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> OpenAIResumeResponse:
    item = repo.get_openai_interruption(interruption_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OpenAI interruption not found")
    _require_owned_task(item.task_id, api_key, repo)
    if item.status != "decided" or not item.decision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interruption decision is not ready")
    resumed = repo.mark_openai_interruption_resumed(interruption_id)
    if not resumed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OpenAI interruption not found")
    return resumed


@router.post("/webhooks/task.updated", status_code=status.HTTP_204_NO_CONTENT)
def task_updated_webhook(event: TaskUpdatedEvent) -> Response:
    _ = event
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/webhooks/dlq/{dead_letter_id}/requeue")
def requeue_dead_letter(
    dead_letter_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> dict[str, bool]:
    _ = (api_key, admin_key, admin_ctx)
    ok = repo.requeue_dead_letter(dead_letter_id, settings.shimlayer_webhook_max_attempts)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dead-letter item not found")
    return {"requeued": True}


@router.post("/billing/topup", response_model=BalanceResponse)
def topup(
    payload: TopUpRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> BalanceResponse:
    return repo.topup(api_key, payload)


@router.get("/billing/balance", response_model=BalanceResponse)
def balance(
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> BalanceResponse:
    return repo.get_balance(api_key)


@router.get("/billing/packages", response_model=list[PackageInfo])
def list_packages(
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> list[PackageInfo]:
    _ = api_key
    return repo.list_packages()


@router.post("/billing/packages/purchase", response_model=PackagePurchaseResponse)
def purchase_package(
    payload: PackagePurchaseRequest,
    api_key: str = Depends(require_api_key),
    repo: Repository = Depends(get_repo),
) -> PackagePurchaseResponse:
    try:
        return repo.purchase_package(api_key, payload)
    except UnknownPackageError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/billing/stripe/checkout-session", response_model=StripeCheckoutSessionResponse)
def create_stripe_checkout_session(
    payload: StripeCheckoutSessionRequest,
    api_key: str = Depends(require_api_key),
) -> StripeCheckoutSessionResponse:
    return _build_checkout_session(payload=payload, api_key=api_key)


@router.post("/leads", response_model=LeadRecord, status_code=status.HTTP_201_CREATED)
def create_lead(
    payload: CreateLeadRequest,
    request: Request,
    repo: Repository = Depends(get_repo),
) -> LeadRecord | Response:
    if payload.company_site and payload.company_site.strip():
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    metadata = dict(payload.metadata or {})
    if request.client and request.client.host and "remote_ip" not in metadata:
        metadata["remote_ip"] = request.client.host
    user_agent = request.headers.get("user-agent")
    if user_agent and "user_agent" not in metadata:
        metadata["user_agent"] = user_agent
    referer = request.headers.get("referer")
    if referer and "referer" not in metadata:
        metadata["referer"] = referer
    payload = payload.model_copy(update={"metadata": metadata})
    return repo.create_lead(payload)


@router.post("/operator-applications", response_model=OperatorApplicationRecord, status_code=status.HTTP_201_CREATED)
def create_operator_application(
    payload: CreateOperatorApplicationRequest,
    request: Request,
    repo: Repository = Depends(get_repo),
) -> OperatorApplicationRecord | Response:
    if payload.website and payload.website.strip():
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    metadata = dict(payload.metadata or {})
    if request.client and request.client.host and "remote_ip" not in metadata:
        metadata["remote_ip"] = request.client.host
    user_agent = request.headers.get("user-agent")
    if user_agent and "user_agent" not in metadata:
        metadata["user_agent"] = user_agent
    referer = request.headers.get("referer")
    if referer and "referer" not in metadata:
        metadata["referer"] = referer
    payload = payload.model_copy(update={"metadata": metadata})
    return repo.create_operator_application(payload)


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/readyz")
def readyz(repo: Repository = Depends(get_repo)) -> dict[str, str]:
    try:
        _ = repo.list_packages()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Repository not ready: {exc.__class__.__name__}",
        ) from exc
    return {"status": "ready", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.post("/webhooks/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    repo: Repository = Depends(get_repo),
) -> dict[str, bool | str]:
    if not settings.shimlayer_stripe_webhook_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Stripe webhook is not configured")
    payload_bytes = await request.body()
    if not verify_stripe_signature(
        payload=payload_bytes,
        signature_header=stripe_signature,
        secret=settings.shimlayer_stripe_webhook_secret,
        tolerance_seconds=settings.shimlayer_webhook_timestamp_tolerance_seconds,
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Stripe signature")

    try:
        event = json.loads(payload_bytes.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON payload") from exc

    event_id = str(event.get("id", ""))
    event_type = str(event.get("type", "unknown"))
    if not event_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing event id")
    if repo.is_stripe_event_processed(event_id):
        return {"processed": True, "idempotent": True}

    if event_type == "checkout.session.completed":
        obj = ((event.get("data") or {}).get("object") or {})
        metadata = obj.get("metadata") or {}
        customer_api_key = metadata.get("api_key")
        package_code = metadata.get("package_code")
        customer_id = obj.get("customer")
        customer_email = obj.get("customer_details", {}).get("email") or obj.get("customer_email")
        if customer_id and customer_api_key:
            repo.record_stripe_customer(customer_api_key, str(customer_id), email=customer_email)
        if customer_api_key and package_code:
            try:
                repo.purchase_package(
                    customer_api_key,
                    PackagePurchaseRequest(
                        package_code=package_code,
                        reference=f"stripe:{obj.get('id', event_id)}",
                    ),
                )
            except UnknownPackageError:
                repo.mark_stripe_event_processed(event_id, event_type, event)
                return {"processed": False, "idempotent": False, "reason": "unknown package"}
            repo.mark_stripe_event_processed(event_id, event_type, event)
            return {"processed": True, "idempotent": False}
        repo.mark_stripe_event_processed(event_id, event_type, event)
        return {"processed": False, "idempotent": False, "reason": "missing metadata"}

    if event_type == "payment_intent.succeeded":
        obj = ((event.get("data") or {}).get("object") or {})
        metadata = obj.get("metadata") or {}
        customer_api_key = metadata.get("api_key")
        amount_usd_raw = metadata.get("topup_usd")
        if not customer_api_key:
            customer_id = obj.get("customer")
            if customer_id:
                customer_api_key = repo.find_api_key_by_stripe_customer(str(customer_id))
        if customer_api_key:
            if amount_usd_raw is not None:
                try:
                    amount_usd = float(amount_usd_raw)
                except ValueError:
                    amount_usd = float(obj.get("amount_received", 0)) / 100.0
            else:
                amount_usd = float(obj.get("amount_received", 0)) / 100.0
            if amount_usd > 0:
                repo.add_ledger_adjustment(
                    customer_api_key,
                    amount_usd=amount_usd,
                    entry_type="stripe_topup",
                    reference=f"stripe:pi:{obj.get('id', event_id)}",
                    meta={"payment_intent_id": obj.get("id")},
                )
                repo.mark_stripe_event_processed(event_id, event_type, event)
                return {"processed": True, "idempotent": False}
        repo.mark_stripe_event_processed(event_id, event_type, event)
        return {"processed": False, "idempotent": False, "reason": "missing customer mapping"}

    if event_type == "charge.refunded":
        obj = ((event.get("data") or {}).get("object") or {})
        metadata = obj.get("metadata") or {}
        customer_api_key = metadata.get("api_key")
        if not customer_api_key:
            customer_id = obj.get("customer")
            if customer_id:
                customer_api_key = repo.find_api_key_by_stripe_customer(str(customer_id))
        if customer_api_key:
            amount_refunded_usd = float(obj.get("amount_refunded", 0)) / 100.0
            if amount_refunded_usd > 0:
                repo.add_ledger_adjustment(
                    customer_api_key,
                    amount_usd=-amount_refunded_usd,
                    entry_type="stripe_refund_adjustment",
                    reference=f"stripe:ch_refund:{obj.get('id', event_id)}",
                    meta={"charge_id": obj.get("id"), "refund_amount_usd": amount_refunded_usd},
                )
                repo.mark_stripe_event_processed(event_id, event_type, event)
                return {"processed": True, "idempotent": False}
        repo.mark_stripe_event_processed(event_id, event_type, event)
        return {"processed": False, "idempotent": False, "reason": "missing customer mapping"}

    if event_type in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        obj = ((event.get("data") or {}).get("object") or {})
        customer_id = obj.get("customer")
        if customer_id:
            item = (((obj.get("items") or {}).get("data") or [{}])[0]) or {}
            price_id = (item.get("price") or {}).get("id")
            repo.upsert_stripe_subscription(
                customer_id=str(customer_id),
                subscription_id=str(obj.get("id")),
                status=str(obj.get("status", "unknown")),
                price_id=str(price_id) if price_id else None,
                current_period_end_ts=int(obj.get("current_period_end")) if obj.get("current_period_end") else None,
            )
            repo.mark_stripe_event_processed(event_id, event_type, event)
            return {"processed": True, "idempotent": False}
        repo.mark_stripe_event_processed(event_id, event_type, event)
        return {"processed": False, "idempotent": False, "reason": "missing customer"}

    repo.mark_stripe_event_processed(event_id, event_type, event)
    return {"processed": False, "idempotent": False, "reason": "event ignored"}


@router.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    repo: Repository = Depends(get_repo),
) -> dict[str, str | bool]:
    payload = await request.json()
    message = payload.get("message") or {}
    callback = payload.get("callback_query") or {}
    chat = message.get("chat") or (callback.get("message") or {}).get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return {"ok": True, "ignored": "no_chat"}
    text = str(message.get("text") or "").strip()
    callback_data = str(callback.get("data") or "").strip()
    cmd = callback_data or text
    if not cmd:
        return {"ok": True}

    def _extract_task_id(raw: str, prefix: str) -> str:
        if raw.startswith(f"/{prefix}"):
            return raw[len(prefix) + 1 :].strip()
        if raw.startswith(f"{prefix}:"):
            return raw.split(":", 1)[1].strip()
        return ""

    def _extract_token(raw: str) -> str:
        token = _extract_task_id(raw, "start")
        if not token:
            token = _extract_task_id(raw, "link")
        return token

    if cmd.startswith("/start") or cmd.startswith("/help") or cmd.startswith("/link") or cmd.startswith("link:"):
        token = _extract_token(cmd)
        if token:
            linked = repo.link_operator_chat_id(token, str(chat_id))
            if linked:
                send_telegram_message(
                    str(chat_id),
                    "✅ Operator linked. Use /claim <task_id> to accept tasks, /skip <task_id> to skip.",
                )
                return {"ok": True}
            send_telegram_message(
                str(chat_id),
                "Invalid or already-linked token. Ask ops for a fresh token.",
            )
            return {"ok": True}
        send_telegram_message(
            str(chat_id),
            "ShimLayer operator bot. Use /link <token> to connect, then /claim <task_id>.",
        )
        return {"ok": True}

    operator = repo.get_operator_by_chat_id(str(chat_id))
    if not operator:
        send_telegram_message(
            str(chat_id),
            "Operator not linked yet. Use /link <token> from ops to connect.",
        )
        return {"ok": True, "ignored": "unknown_operator"}

    if cmd.startswith("/claim") or cmd.startswith("claim:"):
        task_id = _extract_task_id(cmd, "claim")
        if not task_id:
            send_telegram_message(str(chat_id), "Missing task_id. Use /claim <task_id>.")
            return {"ok": True}
        task = repo.get_task(UUID(task_id)) if is_uuid_string(task_id) else None
        if not task:
            send_telegram_message(str(chat_id), "Task not found.")
            return {"ok": True}
        claimed = repo.claim_task(UUID(task_id), worker_id=operator.id)
        if not claimed:
            send_telegram_message(str(chat_id), "Task is unavailable or already claimed.")
            return {"ok": True}
        repo.enqueue_task_webhook(claimed, settings.shimlayer_webhook_max_attempts)
        send_telegram_message(str(chat_id), f"✅ Claimed {task_id}.")
        return {"ok": True}

    if cmd.startswith("/skip") or cmd.startswith("skip:"):
        task_id = _extract_task_id(cmd, "skip")
        if not task_id:
            send_telegram_message(str(chat_id), "Missing task_id. Use /skip <task_id>.")
            return {"ok": True}
        send_telegram_message(str(chat_id), f"Skipped {task_id}.")
        return {"ok": True}

    return {"ok": True, "ignored": "unknown_command"}


@router.get("/ops/metrics", response_model=OpsMetricsResponse)
def ops_metrics(
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsMetricsResponse:
    _ = (api_key, admin_key, admin_ctx)
    metrics = repo.get_ops_metrics()
    repo.record_ops_metrics_sample(metrics)
    return metrics


@router.get("/ops/metrics/history", response_model=list[OpsMetricsHistoryPoint])
def ops_metrics_history(
    limit: int = 48,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OpsMetricsHistoryPoint]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.get_ops_metrics_history(limit=limit)


@router.get("/ops/dlq", response_model=list[WebhookDeadLetter])
def ops_dead_letters(
    limit: int = 50,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[WebhookDeadLetter]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.list_webhook_dead_letters(limit=limit)


@router.get("/ops/webhooks/deliveries", response_model=list[WebhookDelivery])
def ops_webhook_deliveries(
    task_id: UUID,
    limit: int = 50,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[WebhookDelivery]:
    _ = (api_key, admin_key)
    if admin_ctx.role not in ("ops_agent", "ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to view webhook deliveries")
    return repo.list_webhook_deliveries(task_id=task_id, limit=limit)


@router.get("/ops/webhooks/last", response_model=WebhookDelivery | None)
def ops_webhook_last_delivery(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> WebhookDelivery | None:
    _ = (api_key, admin_key)
    if admin_ctx.role not in ("ops_agent", "ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to view webhook deliveries")
    rows = repo.list_webhook_deliveries(task_id=task_id, limit=1)
    return rows[0] if rows else None


@router.post("/ops/webhooks/tasks/{task_id}/resend")
def ops_webhook_resend(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> dict:
    _ = (api_key, admin_key)
    if admin_ctx.role not in ("ops_agent", "ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to resend webhooks")
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    if not task.callback_url:
        return {"enqueued": False, "reason": "no callback_url"}
    repo.enqueue_task_webhook(task, settings.shimlayer_webhook_max_attempts)
    repo.append_task_audit(
        task_id=task_id,
        actor=f"ops:{admin_ctx.user_id}",
        action="webhook_resend",
        note="Webhook resend requested",
        metadata={"callback_url": task.callback_url},
    )
    return {"enqueued": True}


@router.get("/ops/incidents", response_model=list[OpsIncident])
def ops_incidents(
    status_filter: str | None = None,
    limit: int = 50,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OpsIncident]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.list_incidents(status=status_filter, limit=limit)


@router.get("/ops/operator-applications", response_model=list[OperatorApplicationRecord])
def list_operator_applications(
    status_filter: str | None = None,
    limit: int = 50,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OperatorApplicationRecord]:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    return repo.list_operator_applications(status=status_filter, limit=limit)


@router.get("/ops/operators/{operator_id}", response_model=OperatorRecord)
def get_operator(
    operator_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    operator = repo.get_operator(operator_id)
    if not operator:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found")
    return operator


@router.post("/ops/operators/{operator_id}/rotate-token", response_model=OperatorTokenRotateResponse)
def rotate_operator_token(
    operator_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorTokenRotateResponse:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    rotated = repo.rotate_operator_token(operator_id)
    if not rotated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found")
    operator, token = rotated
    return OperatorTokenRotateResponse(operator=operator, operator_token=token)


@router.post("/ops/operators/{operator_id}/status", response_model=OperatorRecord)
def update_operator_status(
    operator_id: UUID,
    payload: UpdateOperatorStatusRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    operator = repo.update_operator_status(operator_id, payload.status)
    if not operator:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found")
    return operator


@router.post("/ops/operators/{operator_id}/unlink-chat", response_model=OperatorRecord)
def unlink_operator_chat(
    operator_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    operator = repo.unlink_operator_chat(operator_id)
    if not operator:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found")
    return operator


@router.post("/ops/operators/{operator_id}/verification", response_model=OperatorRecord)
def update_operator_verification(
    operator_id: UUID,
    payload: UpdateOperatorVerificationRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorRecord:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    operator = repo.update_operator_verification(
        operator_id,
        status=payload.verification_status,
        note=payload.verification_note,
        reviewer_id=admin_ctx.user_id,
    )
    if not operator:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator not found")
    return operator


@router.post("/ops/operator-applications/{application_id}/approve", response_model=OperatorApprovalResponse)
def approve_operator_application(
    application_id: UUID,
    payload: ApproveOperatorApplicationRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorApprovalResponse:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    updated = repo.update_operator_application(
        application_id,
        UpdateOperatorApplicationRequest(
            status="approved",
            decision_note=payload.decision_note,
            telegram_chat_id=payload.telegram_chat_id,
        ),
        reviewer_id=admin_ctx.user_id,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator application not found")
    created = repo.create_operator_from_application(application_id, reviewer_id=admin_ctx.user_id)
    if not created:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator application not found")
    _notify_operator_decision(updated)
    operator, token = created
    return OperatorApprovalResponse(application=updated, operator=operator, operator_token=token)


@router.patch("/ops/operator-applications/{application_id}", response_model=OperatorApplicationRecord)
def update_operator_application(
    application_id: UUID,
    payload: UpdateOperatorApplicationRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorApplicationRecord:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    record = repo.update_operator_application(application_id, payload, reviewer_id=admin_ctx.user_id)
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator application not found")
    _notify_operator_decision(record)
    return record


@router.post("/ops/operators/{operator_id}/notify-task")
def notify_operator_task(
    operator_id: UUID,
    payload: _OperatorNotifyTaskRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> dict:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator notify")
    operator = repo.get_operator(operator_id)
    if not operator or not operator.telegram_chat_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operator or chat_id not found")
    task = repo.get_task(payload.task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    text = payload.message or (
        f"New task {task.id}\n"
        f"type: {task.task_type}\n"
        "Reply /claim <task_id> to take it, or /skip <task_id> to skip."
    )
    reply_markup = {
        "inline_keyboard": [
            [
                {"text": "Claim", "callback_data": f"claim:{task.id}"},
                {"text": "Skip", "callback_data": f"skip:{task.id}"},
            ]
        ]
    }
    sent = send_telegram_message(operator.telegram_chat_id, text, reply_markup=reply_markup)
    status = "sent" if sent else "failed"
    repo.record_operator_delivery(
        operator_id=operator_id,
        task_id=payload.task_id,
        channel="telegram",
        status=status,
        attempt=1,
        error=None if sent else "telegram_failed",
    )
    if not sent:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Telegram delivery failed")
    return {"sent": True}


@router.get("/ops/operators/{operator_id}/deliveries/last", response_model=OperatorDeliveryRecord | None)
def get_operator_last_delivery(
    operator_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OperatorDeliveryRecord | None:
    _ = (api_key, admin_key, admin_ctx)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operator onboarding")
    return repo.get_operator_last_delivery(operator_id)


@router.post("/ops/incidents", response_model=OpsIncident, status_code=status.HTTP_201_CREATED)
def create_ops_incident(
    payload: CreateOpsIncidentRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsIncident:
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to create incidents")
    _ = (api_key, admin_key)
    return repo.create_incident(payload)


@router.patch("/ops/incidents/{incident_id}", response_model=OpsIncident)
def update_ops_incident(
    incident_id: UUID,
    payload: UpdateOpsIncidentRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsIncident:
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to update incidents")
    _ = (api_key, admin_key)
    incident = repo.update_incident(incident_id, payload)
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    return incident


@router.get("/ops/incidents/{incident_id}/events", response_model=list[OpsIncidentEvent])
def ops_incident_events(
    incident_id: UUID,
    limit: int = 100,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OpsIncidentEvent]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.list_incident_events(incident_id, limit=limit)


@router.post("/ops/incidents/scan", response_model=OpsIncident | None)
def scan_ops_incidents(
    payload: OpsIncidentScanRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsIncident | None:
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed to run incident scan")
    _ = (api_key, admin_key)
    return _auto_create_sla_incident_if_needed(repo, overdue_threshold=payload.overdue_threshold)


@router.get("/ops/finance/ledger", response_model=list[LedgerEntry])
def ops_finance_ledger(
    limit: int = 100,
    account_id: UUID | None = None,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[LedgerEntry]:
    if admin_ctx.role not in ("finance", "ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed for finance view")
    _ = (api_key, admin_key)
    return repo.list_ledger_entries(limit=limit, account_id=account_id)


@router.get("/ops/finance/margin", response_model=OpsMarginSummary)
def ops_finance_margin(
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsMarginSummary:
    if admin_ctx.role not in ("finance", "ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Role is not allowed for finance view")
    _ = (api_key, admin_key)
    return repo.get_margin_summary()


@router.get("/ops/observability", response_model=OpsObservabilityResponse)
def ops_observability(
    request: Request,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsObservabilityResponse:
    _ = (api_key, admin_key, admin_ctx)
    request_id = getattr(request.state, "request_id", None)
    metrics = repo.get_ops_metrics()
    open_incidents = len(repo.list_incidents(status="open", limit=500))
    return OpsObservabilityResponse(
        service="shimlayer-api",
        generated_at=datetime.now(timezone.utc),
        request_id_echo=request_id,
        ops_metrics=metrics,
        open_incidents=open_incidents,
    )


@router.get("/ops/observability/metrics", response_class=PlainTextResponse)
def ops_observability_metrics(
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> PlainTextResponse:
    _ = (api_key, admin_key, admin_ctx)
    m = repo.get_ops_metrics()
    open_incidents = len(repo.list_incidents(status="open", limit=500))
    lines = [
        "# HELP shimlayer_tasks_overdue Total overdue active tasks",
        "# TYPE shimlayer_tasks_overdue gauge",
        f"shimlayer_tasks_overdue {m.tasks_overdue}",
        "# HELP shimlayer_tasks_sla_risk Active tasks at SLA risk",
        "# TYPE shimlayer_tasks_sla_risk gauge",
        f"shimlayer_tasks_sla_risk {m.tasks_sla_risk}",
        "# HELP shimlayer_webhook_dlq_count Dead-letter webhook jobs",
        "# TYPE shimlayer_webhook_dlq_count gauge",
        f"shimlayer_webhook_dlq_count {m.webhook_dlq_count}",
        "# HELP shimlayer_manual_review_pending Tasks requiring manual review",
        "# TYPE shimlayer_manual_review_pending gauge",
        f"shimlayer_manual_review_pending {m.manual_review_pending}",
        "# HELP shimlayer_open_incidents Open incidents count",
        "# TYPE shimlayer_open_incidents gauge",
        f"shimlayer_open_incidents {open_incidents}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n")


@router.get("/ops/flows", response_model=list[Task])
def ops_flows(
    limit: int = 100,
    status_filter: str | None = None,
    task_type: str | None = None,
    only_problem: bool = False,
    only_sla_breach: bool = False,
    only_manual_review: bool = False,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[Task]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.list_tasks(
        limit=limit,
        status=status_filter,
        task_type=task_type,
        only_problem=only_problem,
        only_sla_breach=only_sla_breach,
        only_manual_review=only_manual_review,
    )


@router.get("/ops/manual-review", response_model=list[TaskWithReview])
def ops_manual_review_queue(
    limit: int = 100,
    status_filter: str | None = None,
    task_type: str | None = None,
    include_locked: bool = False,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[TaskWithReview]:
    _ = (api_key, admin_key)
    return repo.list_manual_review_queue(
        reviewer_id=admin_ctx.user_id,
        limit=limit,
        status=status_filter,
        task_type=task_type,
        include_locked=include_locked,
    )


@router.post("/ops/manual-review/claim-next", response_model=TaskWithReview | None)
def ops_claim_next_manual_review(
    status_filter: str | None = None,
    task_type: str | None = None,
    exclude_task_id: UUID | None = None,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview | None:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "manual_review")
    return repo.claim_next_manual_review(
        reviewer_id=admin_ctx.user_id,
        lock_seconds=settings.shimlayer_manual_review_lock_seconds,
        status=status_filter,
        task_type=task_type,
        exclude_task_id=exclude_task_id,
    )


@router.post("/ops/manual-review/{task_id}/claim", response_model=TaskWithReview)
def ops_claim_manual_review_by_id(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "manual_review")
    ok = repo.claim_manual_review(
        reviewer_id=admin_ctx.user_id,
        task_id=task_id,
        lock_seconds=settings.shimlayer_manual_review_lock_seconds,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task is claimed by another reviewer")
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


@router.post("/ops/manual-review/{task_id}/take-over", response_model=TaskWithReview)
def ops_take_over_manual_review(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview:
    _ = (api_key, admin_key)
    if admin_ctx.role not in ("ops_manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    ok = repo.take_over_manual_review(
        reviewer_id=admin_ctx.user_id,
        task_id=task_id,
        lock_seconds=settings.shimlayer_manual_review_lock_seconds,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


@router.post("/ops/manual-review/{task_id}/release", status_code=status.HTTP_204_NO_CONTENT)
def ops_release_manual_review(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> None:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "manual_review")
    ok = repo.release_manual_review(reviewer_id=admin_ctx.user_id, task_id=task_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task is not claimed by you")
    return None


@router.get("/ops/flows/{task_id}", response_model=TaskWithReview)
def ops_flow_detail(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> TaskWithReview:
    _ = (api_key, admin_key, admin_ctx)
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


@router.get("/ops/flows/{task_id}/download")
def ops_download_flow_bundle(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> Response:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "download_bundle")
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    audit = repo.list_task_audit(task_id, limit=200)
    events: list[OpsTimelineEvent] = [
        OpsTimelineEvent(
            at=task.created_at,
            kind="task_created",
            actor="system",
            message=f"Task created with status={task.status}",
            metadata={"task_type": task.task_type, "status": task.status},
        )
    ]
    for entry in audit:
        events.append(
            OpsTimelineEvent(
                at=entry.created_at,
                kind="ops_action",
                actor=entry.actor,
                message=f"{entry.action}",
                metadata={"note": entry.note, **(entry.metadata or {})},
            )
        )
    for artifact in task.artifacts:
        events.append(
            OpsTimelineEvent(
                at=artifact.created_at,
                kind="artifact_uploaded",
                actor="operator",
                message=f"artifact={artifact.artifact_type}",
                metadata={"storage_path": artifact.storage_path},
            )
        )
    if task.review:
        events.append(
            OpsTimelineEvent(
                at=task.review.created_at,
                kind="review",
                actor="review_engine",
                message=f"review_status={task.review.review_status}",
                metadata={
                    "manual_verdict": task.review.manual_verdict,
                    "auto_check_provider": getattr(task.review, "auto_check_provider", "heuristic"),
                    "auto_check_model": getattr(task.review, "auto_check_model", None),
                    "auto_check_score": task.review.auto_check_score,
                    "auto_check_reason": getattr(task.review, "auto_check_reason", None),
                    "auto_check_redacted": getattr(task.review, "auto_check_redacted", None),
                },
            )
        )
    events.sort(key=lambda e: e.at, reverse=True)

    buf = io.BytesIO()
    manifest: dict = {
        "task_id": str(task_id),
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "artifacts": [],
    }
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("task.json", json.dumps(task.model_dump(), indent=2, default=str))
        zf.writestr("audit.json", json.dumps([a.model_dump() for a in audit], indent=2, default=str))
        zf.writestr("timeline.json", json.dumps([e.model_dump() for e in events], indent=2, default=str))

        for artifact in task.artifacts:
            filename = str(artifact.metadata.get("filename") or "artifact.bin").replace('"', "")
            safe_name = os.path.basename(filename) or "artifact.bin"
            zip_name = f"artifacts/{artifact.id}_{safe_name}"
            entry = {
                "id": str(artifact.id),
                "artifact_type": str(artifact.artifact_type),
                "storage_path": str(artifact.storage_path),
                "checksum_sha256": artifact.checksum_sha256 or "",
                "filename": safe_name,
                "zip_path": zip_name,
            }
            try:
                content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=artifact.storage_path)
                zf.writestr(zip_name, content)
                entry["included"] = True
                entry["size_bytes"] = len(content)
            except Exception as exc:
                zf.writestr(zip_name, f"UNAVAILABLE: {artifact.storage_path}\nERROR: {exc}\n")
                entry["included"] = False
                entry["error"] = str(exc)
            manifest["artifacts"].append(entry)

        zf.writestr("manifest.json", json.dumps(manifest, indent=2, default=str))

    payload = buf.getvalue()
    headers = {"Content-Disposition": f'attachment; filename="flow-{task_id}.zip"'}
    return Response(content=payload, media_type="application/zip", headers=headers)


class _OpsBulkDownloadRequest(BaseModel):
    task_ids: list[UUID]


@router.post("/ops/flows/download-bulk")
def ops_download_flow_bundles_bulk(
    payload: _OpsBulkDownloadRequest,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> Response:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "download_bundle")
    task_ids = list(dict.fromkeys(payload.task_ids))
    if not task_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="task_ids is required")
    if len(task_ids) > 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Too many task_ids (max 200)")

    buf = io.BytesIO()
    manifest: dict = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "count": len(task_ids),
        "flows": [],
    }
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for task_id in task_ids:
            task = repo.get_task(task_id)
            if not task:
                manifest["flows"].append({"task_id": str(task_id), "included": False, "error": "Task not found"})
                continue

            # Reuse the single-flow bundle logic by embedding each flow bundle as its own zip file.
            try:
                flow_payload = ops_download_flow_bundle(task_id=task_id, api_key=api_key, admin_key=admin_key, admin_ctx=admin_ctx, repo=repo).body
                if flow_payload is None:
                    raise RuntimeError("Empty response body")
                zip_name = f"flows/flow-{task_id}.zip"
                zf.writestr(zip_name, flow_payload)
                manifest["flows"].append({"task_id": str(task_id), "included": True, "zip_path": zip_name})
            except Exception as exc:
                manifest["flows"].append({"task_id": str(task_id), "included": False, "error": str(exc)})

        zf.writestr("manifest.json", json.dumps(manifest, indent=2, default=str))

    payload_bytes = buf.getvalue()
    headers = {"Content-Disposition": 'attachment; filename="flows-selected.zip"'}
    return Response(content=payload_bytes, media_type="application/zip", headers=headers)


@router.get("/ops/flows/{task_id}/artifacts/{artifact_id}/download")
def ops_download_artifact(
    task_id: UUID,
    artifact_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> Response:
    _ = (api_key, admin_key)
    _ensure_role_permission(admin_ctx.role, "download_artifact")
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    artifact = next((a for a in task.artifacts if a.id == artifact_id), None)
    if not artifact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")
    try:
        content = load_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=artifact.storage_path)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact content not found") from exc

    filename = str(artifact.metadata.get("filename") or "artifact.bin").replace('"', "")
    content_type = str(artifact.metadata.get("content_type") or "application/octet-stream")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "X-Checksum-Sha256": artifact.checksum_sha256 or "",
    }
    return Response(content=content, media_type=content_type, headers=headers)


@router.get("/ops/flows/{task_id}/audit", response_model=list[OpsTaskAuditEntry])
def ops_flow_audit(
    task_id: UUID,
    limit: int = 50,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OpsTaskAuditEntry]:
    _ = (api_key, admin_key, admin_ctx)
    return repo.list_task_audit(task_id, limit=limit)


@router.get("/ops/flows/{task_id}/timeline", response_model=list[OpsTimelineEvent])
def ops_flow_timeline(
    task_id: UUID,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> list[OpsTimelineEvent]:
    _ = (api_key, admin_key, admin_ctx)
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    events: list[OpsTimelineEvent] = [
        OpsTimelineEvent(
            at=task.created_at,
            kind="task_created",
            actor="system",
            message=f"Task created with status={task.status}",
            metadata={"task_type": task.task_type, "status": task.status},
        )
    ]
    for audit in repo.list_task_audit(task_id, limit=200):
        events.append(
            OpsTimelineEvent(
                at=audit.created_at,
                kind="ops_action",
                actor=audit.actor,
                message=f"{audit.action}",
                metadata={"note": audit.note, **(audit.metadata or {})},
            )
        )
    for artifact in task.artifacts:
        events.append(
            OpsTimelineEvent(
                at=artifact.created_at,
                kind="artifact_uploaded",
                actor="operator",
                message=f"artifact={artifact.artifact_type}",
                metadata={"storage_path": artifact.storage_path},
            )
        )
    if task.review:
        events.append(
            OpsTimelineEvent(
                at=task.review.created_at,
                kind="review",
                actor="review_engine",
                message=f"review_status={task.review.review_status}",
                metadata={
                    "manual_verdict": task.review.manual_verdict,
                    "auto_check_provider": getattr(task.review, "auto_check_provider", "heuristic"),
                    "auto_check_model": getattr(task.review, "auto_check_model", None),
                    "auto_check_score": task.review.auto_check_score,
                    "auto_check_reason": getattr(task.review, "auto_check_reason", None),
                    "auto_check_redacted": getattr(task.review, "auto_check_redacted", None),
                },
            )
        )

    events.sort(key=lambda e: e.at, reverse=True)
    return events


@router.post("/ops/flows/{task_id}/actions", response_model=OpsTaskActionResponse)
def ops_flow_action(
    task_id: UUID,
    payload: OpsTaskActionRequest,
    request: Request,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsTaskActionResponse:
    _ = (api_key, admin_key)
    request_id = getattr(request.state, "request_id", None)
    remote_ip = request.client.host if request.client else None
    return _apply_ops_action(
        repo,
        task_id,
        payload,
        admin_ctx=admin_ctx,
        request_id=request_id,
        remote_ip=remote_ip,
        dry_run=False,
    )


@router.post("/ops/flows/bulk-actions", response_model=OpsBulkActionResponse)
def ops_flow_bulk_action(
    payload: OpsBulkActionRequest,
    request: Request,
    api_key: str = Depends(require_api_key),
    admin_key: str = Depends(require_admin_key),
    admin_ctx: AdminContext = Depends(require_admin_context),
    repo: Repository = Depends(get_repo),
) -> OpsBulkActionResponse:
    _ = (api_key, admin_key)
    unique_task_ids = list(dict.fromkeys(payload.task_ids))
    if len(unique_task_ids) > 20 and payload.confirm_text != "CONFIRM":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="confirm_text=CONFIRM required for bulk > 20")

    results: list[OpsBulkActionItem] = []
    request_id = getattr(request.state, "request_id", None)
    remote_ip = request.client.host if request.client else None
    for task_id in unique_task_ids:
        single = OpsTaskActionRequest(
            action=payload.action,
            note=payload.note,
            reason_code=payload.reason_code,
            manual_verdict=payload.manual_verdict,
            worker_id=payload.worker_id,
            status=payload.status,
        )
        try:
            response = _apply_ops_action(
                repo,
                task_id,
                single,
                admin_ctx=admin_ctx,
                request_id=request_id,
                remote_ip=remote_ip,
                dry_run=payload.dry_run,
            )
            results.append(
                OpsBulkActionItem(
                    task_id=task_id,
                    ok=True,
                    task=response.task,
                    audit_entry=response.audit_entry,
                )
            )
        except HTTPException as exc:
            results.append(
                OpsBulkActionItem(
                    task_id=task_id,
                    ok=False,
                    error=str(exc.detail),
                )
            )
    return OpsBulkActionResponse(results=results)

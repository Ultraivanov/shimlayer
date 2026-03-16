from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import ArtifactType, ReviewStatus, TaskStatus, TaskType


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CreateTaskRequest(BaseModel):
    task_type: TaskType
    context: dict[str, Any]
    sla_seconds: int = Field(ge=30, le=900)
    max_price_usd: float = 0.48
    callback_url: str | None = None


class StuckRecoveryResult(BaseModel):
    action_summary: str = Field(max_length=2000)
    next_step: str = Field(max_length=1000)


class QuickJudgmentResult(BaseModel):
    decision: str = Field(pattern="^(yes|no)$")
    note: str | None = Field(default=None, max_length=300)


class CompleteTaskRequest(BaseModel):
    result: dict[str, Any]
    worker_note: str | None = Field(default=None, max_length=500)


class CreateArtifactRequest(BaseModel):
    artifact_type: ArtifactType
    storage_path: str
    checksum_sha256: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class UploadArtifactRequest(BaseModel):
    artifact_type: ArtifactType
    content_base64: str
    filename: str | None = None
    content_type: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CreateJudgmentRequest(BaseModel):
    context: dict[str, Any]
    sla_seconds: int = Field(ge=30, le=600)
    callback_url: str | None = None


class TopUpRequest(BaseModel):
    amount_usd: float = Field(ge=1)
    reference: str


class BalanceResponse(BaseModel):
    account_id: UUID
    balance_usd: float
    flow_credits: int = 0


class PackagePurchaseRequest(BaseModel):
    package_code: str
    reference: str


class PackagePurchaseResponse(BaseModel):
    account_id: UUID
    package_code: str
    purchased_flows: int
    remaining_flows: int
    charged_usd: float


class StripeCheckoutSessionRequest(BaseModel):
    package_code: str
    success_url: str
    cancel_url: str
    customer_email: str | None = None


class StripeCheckoutSessionResponse(BaseModel):
    session_id: str
    checkout_url: str
    publishable_key: str | None = None


class PackageInfo(BaseModel):
    code: str
    flows: int
    price_usd: float
    unit_price_usd: float
    active: bool = True


class Artifact(BaseModel):
    id: UUID
    task_id: UUID
    artifact_type: ArtifactType
    storage_path: str
    checksum_sha256: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class Review(BaseModel):
    id: UUID
    task_id: UUID
    auto_check_provider: str = "heuristic"
    auto_check_model: str | None = None
    auto_check_score: float = Field(ge=0, le=1)
    auto_check_reason: str | None = None
    auto_check_redacted: bool | None = None
    review_status: ReviewStatus
    manual_verdict: str | None = None
    refund_flag: bool = False
    claimed_by: str | None = None
    claimed_until: datetime | None = None
    created_at: datetime


class Task(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    id: UUID
    account_id: UUID
    worker_id: UUID | None = None
    task_type: TaskType
    status: TaskStatus
    context: dict[str, Any]
    result: dict[str, Any] | None = None
    max_price_usd: float = 0.48
    callback_url: str | None = None
    sla_seconds: int
    sla_deadline: datetime
    created_at: datetime
    updated_at: datetime


class TaskWithReview(Task):
    artifacts: list[Artifact] = Field(default_factory=list)
    review: Review | None = None


class TaskUpdatedEvent(BaseModel):
    event_id: UUID
    event_type: str = "task.updated"
    created_at: datetime
    task: Task


class WebhookJob(BaseModel):
    id: UUID
    task_id: UUID
    callback_url: str
    event_type: str
    payload: dict[str, Any]
    idempotency_key: str
    attempts: int
    max_attempts: int
    next_attempt_at: datetime
    created_at: datetime


class OpsMetricsResponse(BaseModel):
    queue_pending: int
    queue_processing: int
    queue_total: int
    webhook_delivery_total: int
    webhook_delivery_success_rate: float
    webhook_retry_rate: float
    webhook_dlq_count: int
    manual_review_pending: int = 0
    task_resolution_p95_seconds: float | None = None
    active_tasks: int = 0
    tasks_sla_risk: int = 0
    tasks_overdue: int = 0
    task_status_counts: dict[str, int] = Field(default_factory=dict)


class WebhookDeadLetter(BaseModel):
    id: UUID
    webhook_job_id: UUID
    task_id: UUID
    callback_url: str
    payload: dict[str, Any]
    error: str | None = None
    status_code: int | None = None
    created_at: datetime
    requeued_at: datetime | None = None


class OpsTaskActionRequest(BaseModel):
    action: str = Field(pattern="^(manual_review|refund|reassign|force_status|add_note|recheck_review)$")
    note: str | None = Field(default=None, max_length=1000)
    reason_code: str | None = Field(
        default=None,
        pattern="^(customer_request|proof_mismatch|policy_violation|sla_breach|fraud_risk|incident_mitigation)$",
    )
    manual_verdict: str | None = Field(default=None, pattern="^(approved|rejected)$")
    worker_id: UUID | None = None
    status: TaskStatus | None = None


class AdminContext(BaseModel):
    role: str
    user_id: str


class OpsTaskAuditEntry(BaseModel):
    id: UUID
    task_id: UUID
    actor: str
    action: str
    note: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class OpsTaskActionResponse(BaseModel):
    task: TaskWithReview
    audit_entry: OpsTaskAuditEntry | None = None


class OpsBulkActionRequest(OpsTaskActionRequest):
    task_ids: list[UUID] = Field(min_length=1, max_length=100)
    dry_run: bool = False
    confirm_text: str | None = None


class OpsBulkActionItem(BaseModel):
    task_id: UUID
    ok: bool
    error: str | None = None
    task: TaskWithReview | None = None
    audit_entry: OpsTaskAuditEntry | None = None


class OpsBulkActionResponse(BaseModel):
    results: list[OpsBulkActionItem]


class OpsTimelineEvent(BaseModel):
    at: datetime
    kind: str
    actor: str
    message: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class OpsIncident(BaseModel):
    id: UUID
    incident_type: str
    severity: str
    status: str
    title: str
    description: str | None = None
    owner: str | None = None
    source: str = "manual"
    postmortem: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None = None


class OpsIncidentEvent(BaseModel):
    id: UUID
    incident_id: UUID
    actor: str
    action: str
    note: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class CreateOpsIncidentRequest(BaseModel):
    incident_type: str = Field(pattern="^(sla_breach|webhook_degradation|manual)$")
    severity: str = Field(pattern="^(low|medium|high|critical)$")
    title: str = Field(min_length=3, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    owner: str | None = Field(default=None, max_length=120)
    source: str = Field(default="manual", pattern="^(manual|auto)$")
    metadata: dict[str, Any] = Field(default_factory=dict)


class UpdateOpsIncidentRequest(BaseModel):
    status: str | None = Field(default=None, pattern="^(open|triage|monitoring|resolved)$")
    owner: str | None = Field(default=None, max_length=120)
    postmortem: str | None = Field(default=None, max_length=4000)
    note: str | None = Field(default=None, max_length=1000)


class OpsIncidentScanRequest(BaseModel):
    overdue_threshold: int = Field(default=5, ge=1, le=10000)


class LedgerEntry(BaseModel):
    id: UUID
    account_id: UUID | None = None
    task_id: UUID | None = None
    entry_type: str
    amount_usd: float
    currency: str = "USD"
    external_ref: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class OpsMarginSummary(BaseModel):
    period: str = "all_time"
    flows_used: int
    refunds_count: int
    avg_revenue_per_flow_usd: float
    estimated_cost_per_flow_usd: float
    estimated_revenue_usd: float
    estimated_cost_usd: float
    estimated_gross_profit_usd: float


class OpsObservabilityResponse(BaseModel):
    service: str
    generated_at: datetime
    request_id_echo: str | None = None
    ops_metrics: OpsMetricsResponse
    open_incidents: int


class OpenAIInterruptionIngestRequest(BaseModel):
    run_id: str = Field(min_length=1, max_length=200)
    thread_id: str | None = Field(default=None, max_length=200)
    interruption_id: str = Field(min_length=1, max_length=200)
    agent_name: str | None = Field(default=None, max_length=120)
    tool_name: str = Field(min_length=1, max_length=200)
    tool_arguments: dict[str, Any] = Field(default_factory=dict)
    state_blob: str = Field(min_length=2)
    metadata: dict[str, Any] = Field(default_factory=dict)
    callback_url: str | None = None
    sla_seconds: int = Field(default=120, ge=30, le=900)


class OpenAIInterruptionDecisionRequest(BaseModel):
    decision: str = Field(pattern="^(approve|reject)$")
    actor: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=1000)
    output: dict[str, Any] = Field(default_factory=dict)


class OpenAIInterruptionRecord(BaseModel):
    interruption_id: str
    run_id: str
    thread_id: str | None = None
    agent_name: str | None = None
    tool_name: str
    task_id: UUID
    status: str = Field(pattern="^(pending|decided|resumed|failed)$")
    decision: str | None = Field(default=None, pattern="^(approve|reject)$")
    decision_actor: str | None = None
    decision_note: str | None = None
    decision_output: dict[str, Any] = Field(default_factory=dict)
    context_capsule: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    state_blob: str
    created_at: datetime
    decided_at: datetime | None = None
    resumed_at: datetime | None = None


class OpenAIResumeResponse(BaseModel):
    interruption_id: str
    run_id: str
    resume_enqueued: bool = True
    resume_payload: dict[str, Any] = Field(default_factory=dict)
    resumed_at: datetime


def new_task(account_id: UUID, payload: CreateTaskRequest) -> Task:
    now = utcnow()
    return Task(
        id=uuid4(),
        account_id=account_id,
        task_type=payload.task_type,
        status=TaskStatus.QUEUED,
        context=payload.context,
        max_price_usd=payload.max_price_usd,
        callback_url=payload.callback_url,
        sla_seconds=payload.sla_seconds,
        sla_deadline=now + timedelta(seconds=payload.sla_seconds),
        created_at=now,
        updated_at=now,
    )

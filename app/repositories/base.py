from datetime import datetime
from typing import Protocol
from uuid import UUID

from app.models import (
    Artifact,
    BalanceResponse,
    CreateArtifactRequest,
    CreateTaskRequest,
    PackagePurchaseResponse,
    PackagePurchaseRequest,
    PackageInfo,
    OpsTaskAuditEntry,
    OpsIncident,
    OpsIncidentEvent,
    LedgerEntry,
    OpsMarginSummary,
    CreateOpsIncidentRequest,
    UpdateOpsIncidentRequest,
    OpenAIInterruptionDecisionRequest,
    OpenAIInterruptionIngestRequest,
    OpenAIInterruptionRecord,
    OpenAIResumeResponse,
    Task,
    TaskWithReview,
    TopUpRequest,
    WebhookJob,
    WebhookDeadLetter,
    WebhookDelivery,
    OpsMetricsResponse,
    OpsMetricsHistoryPoint,
    CreateLeadRequest,
    LeadRecord,
    CreateOperatorApplicationRequest,
    OperatorApplicationRecord,
    OperatorRecord,
    UpdateOperatorApplicationRequest,
    OperatorDeliveryRecord,
)


class Repository(Protocol):
    def consume_rate_limit(self, api_key: str) -> None: ...
    def consume_operator_rate_limit(self, operator_id: UUID, limit_per_minute: int) -> None: ...

    def topup(self, api_key: str, payload: TopUpRequest) -> BalanceResponse: ...
    def get_balance(self, api_key: str) -> BalanceResponse: ...
    def list_packages(self) -> list[PackageInfo]: ...
    def purchase_package(self, api_key: str, payload: PackagePurchaseRequest) -> PackagePurchaseResponse: ...
    def is_stripe_event_processed(self, event_id: str) -> bool: ...
    def mark_stripe_event_processed(self, event_id: str, event_type: str, payload: dict) -> None: ...
    def record_stripe_customer(self, api_key: str, customer_id: str, email: str | None = None) -> None: ...
    def find_api_key_by_stripe_customer(self, customer_id: str) -> str | None: ...
    def upsert_stripe_subscription(
        self,
        customer_id: str,
        subscription_id: str,
        status: str,
        price_id: str | None = None,
        current_period_end_ts: int | None = None,
    ) -> None: ...
    def add_ledger_adjustment(
        self,
        api_key: str,
        amount_usd: float,
        entry_type: str,
        reference: str,
        meta: dict | None = None,
    ) -> None: ...
    def create_lead(self, payload: CreateLeadRequest) -> LeadRecord: ...
    def create_operator_application(self, payload: CreateOperatorApplicationRequest) -> OperatorApplicationRecord: ...
    def list_operator_applications(
        self,
        status: str | None = None,
        limit: int = 50,
    ) -> list[OperatorApplicationRecord]: ...
    def update_operator_application(
        self,
        application_id: UUID,
        payload: UpdateOperatorApplicationRequest,
        reviewer_id: str,
    ) -> OperatorApplicationRecord | None: ...
    def create_operator_from_application(
        self,
        application_id: UUID,
        reviewer_id: str,
    ) -> tuple[OperatorRecord, str] | None: ...
    def get_operator_by_token(self, token: str) -> OperatorRecord | None: ...
    def get_operator(self, operator_id: UUID) -> OperatorRecord | None: ...
    def get_operator_by_chat_id(self, chat_id: str) -> OperatorRecord | None: ...
    def link_operator_chat_id(self, token: str, chat_id: str) -> OperatorRecord | None: ...
    def rotate_operator_token(self, operator_id: UUID) -> tuple[OperatorRecord, str] | None: ...
    def update_operator_status(self, operator_id: UUID, status: str) -> OperatorRecord | None: ...
    def unlink_operator_chat(self, operator_id: UUID) -> OperatorRecord | None: ...
    def update_operator_verification(
        self,
        operator_id: UUID,
        status: str,
        note: str | None,
        reviewer_id: str,
    ) -> OperatorRecord | None: ...
    def record_operator_delivery(
        self,
        operator_id: UUID,
        task_id: UUID,
        channel: str,
        status: str,
        attempt: int,
        error: str | None = None,
    ) -> None: ...
    def get_operator_last_delivery(self, operator_id: UUID) -> OperatorDeliveryRecord | None: ...

    def create_task(self, api_key: str, payload: CreateTaskRequest) -> Task: ...
    def list_account_tasks_with_review(
        self,
        api_key: str,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
    ) -> list[TaskWithReview]: ...
    def list_account_tasks_with_review_after(
        self,
        api_key: str,
        after_updated_at: datetime | None,
        after_task_id: UUID | None,
        limit: int = 50,
        status: str | None = None,
        task_type: str | None = None,
    ) -> list[TaskWithReview]: ...
    def list_tasks(
        self,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        only_problem: bool = False,
        only_sla_breach: bool = False,
        only_manual_review: bool = False,
    ) -> list[Task]: ...

    def list_tasks_with_review(
        self,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        only_manual_review: bool = False,
    ) -> list[TaskWithReview]: ...

    def list_manual_review_queue(
        self,
        reviewer_id: str,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        include_locked: bool = False,
    ) -> list[TaskWithReview]: ...

    def claim_next_manual_review(
        self,
        reviewer_id: str,
        lock_seconds: int,
        status: str | None = None,
        task_type: str | None = None,
        exclude_task_id: UUID | None = None,
    ) -> TaskWithReview | None: ...

    def claim_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool: ...

    def take_over_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool: ...

    def release_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
    ) -> bool: ...

    def get_task(self, task_id: UUID) -> TaskWithReview | None: ...
    def list_task_audit(self, task_id: UUID, limit: int = 50) -> list[OpsTaskAuditEntry]: ...
    def append_task_audit(
        self,
        task_id: UUID,
        actor: str,
        action: str,
        note: str | None = None,
        metadata: dict | None = None,
    ) -> OpsTaskAuditEntry | None: ...
    def set_review_verdict(self, task_id: UUID, verdict: str, note: str | None = None) -> Task | None: ...
    def recheck_review(self, task_id: UUID) -> bool: ...
    def reassign_task(self, task_id: UUID, worker_id: UUID) -> Task | None: ...
    def force_task_status(self, task_id: UUID, status: str) -> Task | None: ...
    def list_incidents(self, status: str | None = None, limit: int = 50) -> list[OpsIncident]: ...
    def create_incident(self, payload: CreateOpsIncidentRequest) -> OpsIncident: ...
    def update_incident(self, incident_id: UUID, payload: UpdateOpsIncidentRequest) -> OpsIncident | None: ...
    def list_incident_events(self, incident_id: UUID, limit: int = 100) -> list[OpsIncidentEvent]: ...

    def claim_task(self, task_id: UUID, worker_id: UUID) -> Task | None: ...

    def complete_task(self, task_id: UUID, result: dict, worker_note: str | None) -> Task | None: ...
    def refund_task(self, task_id: UUID, reason: str | None = None) -> Task | None: ...

    def add_artifact(self, task_id: UUID, payload: CreateArtifactRequest) -> Artifact | None: ...
    def enqueue_task_webhook(self, task: Task, max_attempts: int) -> None: ...
    def claim_due_webhook_job(self) -> WebhookJob | None: ...
    def mark_webhook_job_success(self, job_id: UUID) -> None: ...
    def mark_webhook_job_retry(
        self,
        job_id: UUID,
        status_code: int | None,
        error: str | None,
        next_attempt_at: datetime,
    ) -> None: ...
    def mark_webhook_job_failed(self, job_id: UUID, status_code: int | None, error: str | None) -> None: ...
    def requeue_dead_letter(self, dead_letter_id: UUID, max_attempts: int) -> bool: ...
    def get_ops_metrics(self) -> OpsMetricsResponse: ...
    def record_ops_metrics_sample(self, metrics: OpsMetricsResponse, min_interval_seconds: int = 60) -> bool: ...
    def get_ops_metrics_history(self, limit: int = 48) -> list[OpsMetricsHistoryPoint]: ...
    def list_webhook_dead_letters(self, limit: int = 50) -> list[WebhookDeadLetter]: ...
    def list_ledger_entries(self, limit: int = 100, account_id: UUID | None = None) -> list[LedgerEntry]: ...
    def get_margin_summary(self) -> OpsMarginSummary: ...

    def record_webhook_delivery(
        self,
        task_id: UUID,
        callback_url: str,
        status_code: int | None,
        attempt: int,
        success: bool,
        error: str | None = None,
    ) -> None: ...
    def list_webhook_deliveries(self, task_id: UUID, limit: int = 50) -> list[WebhookDelivery]: ...
    def get_openai_interruption(self, interruption_id: str) -> OpenAIInterruptionRecord | None: ...
    def create_openai_interruption(
        self,
        payload: OpenAIInterruptionIngestRequest,
        task_id: UUID,
        context_capsule: dict,
    ) -> OpenAIInterruptionRecord: ...
    def decide_openai_interruption(
        self,
        interruption_id: str,
        payload: OpenAIInterruptionDecisionRequest,
    ) -> OpenAIInterruptionRecord | None: ...
    def mark_openai_interruption_resumed(self, interruption_id: str) -> OpenAIResumeResponse | None: ...
    def list_openai_interruptions_by_status(self, status: str, limit: int = 100) -> list[OpenAIInterruptionRecord]: ...
    def mark_openai_interruption_failed(self, interruption_id: str, note: str | None = None) -> OpenAIInterruptionRecord | None: ...

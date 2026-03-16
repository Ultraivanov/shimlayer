from datetime import datetime, timedelta, timezone
from threading import RLock
from uuid import UUID, uuid4

from app.billing.catalog import PACKAGES, get_package_or_none
from app.domain.enums import ReviewStatus, TaskStatus
from app.models import (
    Artifact,
    BalanceResponse,
    CreateOpsIncidentRequest,
    CreateArtifactRequest,
    CreateTaskRequest,
    OpsMetricsResponse,
    OpsIncidentEvent,
    OpsMarginSummary,
    LedgerEntry,
    OpsIncident,
    OpenAIInterruptionDecisionRequest,
    OpenAIInterruptionIngestRequest,
    OpenAIInterruptionRecord,
    OpenAIResumeResponse,
    UpdateOpsIncidentRequest,
    PackageInfo,
    PackagePurchaseRequest,
    PackagePurchaseResponse,
    OpsTaskAuditEntry,
    Review,
    Task,
    TaskUpdatedEvent,
    TaskWithReview,
    TopUpRequest,
    WebhookJob,
    WebhookDeadLetter,
    new_task,
    utcnow,
)
from app.repositories.errors import (
    InsufficientFlowCreditsError,
    RateLimitExceededError,
    RefundNotAllowedError,
    UnknownPackageError,
)
from app.services.review import build_review


class InMemoryRepository:
    def __init__(self) -> None:
        self._lock = RLock()
        self._accounts: dict[str, dict] = {}
        self._rate_windows: dict[tuple[str, datetime], int] = {}
        self._ledger: list[dict] = []
        self._tasks: dict[UUID, Task] = {}
        self._artifacts: dict[UUID, list[Artifact]] = {}
        self._reviews: dict[UUID, Review] = {}
        self._webhook_deliveries: list[dict] = []
        self._webhook_jobs: list[dict] = []
        self._webhook_dead_letters: list[dict] = []
        self._task_audit: dict[UUID, list[OpsTaskAuditEntry]] = {}
        self._incidents: dict[UUID, OpsIncident] = {}
        self._incident_events: dict[UUID, list[OpsIncidentEvent]] = {}
        self._stripe_events: dict[str, dict] = {}
        self._stripe_customer_by_api_key: dict[str, dict] = {}
        self._api_key_by_stripe_customer: dict[str, str] = {}
        self._stripe_subscriptions: dict[str, dict] = {}
        self._openai_interruptions: dict[str, OpenAIInterruptionRecord] = {}

    @staticmethod
    def _enum_or_str(value: object) -> str:
        if hasattr(value, "value"):
            return str(getattr(value, "value"))
        return str(value)

    def get_or_create_account(self, api_key: str) -> tuple[UUID, float, int]:
        with self._lock:
            if api_key not in self._accounts:
                self._accounts[api_key] = {
                    "id": uuid4(),
                    "balance_usd": 0.0,
                    "flow_credits": 0,
                    "plan": "free",
                }
            account = self._accounts[api_key]
            return account["id"], account["balance_usd"], account["flow_credits"]

    def consume_rate_limit(self, api_key: str) -> None:
        with self._lock:
            self.get_or_create_account(api_key)
            if self._accounts[api_key].get("plan", "free") != "free":
                return
            now = utcnow()
            bucket = now.replace(second=0, microsecond=0, tzinfo=timezone.utc)
            key = (api_key, bucket)
            count = self._rate_windows.get(key, 0)
            if count >= 10:
                raise RateLimitExceededError("Rate limit exceeded: free plan allows 10 requests per minute")
            self._rate_windows[key] = count + 1

    def get_balance(self, api_key: str) -> BalanceResponse:
        with self._lock:
            account_id, balance_usd, flow_credits = self.get_or_create_account(api_key)
            return BalanceResponse(
                account_id=account_id,
                balance_usd=round(balance_usd, 4),
                flow_credits=flow_credits,
            )

    def list_packages(self) -> list[PackageInfo]:
        return [
            PackageInfo(
                code=p.code,
                flows=p.flows,
                price_usd=p.price_usd,
                unit_price_usd=p.unit_price_usd,
                active=True,
            )
            for p in PACKAGES.values()
        ]

    def topup(self, api_key: str, payload: TopUpRequest) -> BalanceResponse:
        with self._lock:
            account_id, _, flow_credits = self.get_or_create_account(api_key)
            self._accounts[api_key]["balance_usd"] += payload.amount_usd
            self._ledger.append(
                {
                    "id": str(uuid4()),
                    "account_id": str(account_id),
                    "entry_type": "topup",
                    "amount_usd": payload.amount_usd,
                    "currency": "USD",
                    "external_ref": payload.reference,
                    "created_at": utcnow().isoformat(),
                }
            )
            return BalanceResponse(
                account_id=account_id,
                balance_usd=round(self._accounts[api_key]["balance_usd"], 4),
                flow_credits=flow_credits,
            )

    def purchase_package(self, api_key: str, payload: PackagePurchaseRequest) -> PackagePurchaseResponse:
        with self._lock:
            package = get_package_or_none(payload.package_code)
            if not package:
                raise UnknownPackageError(payload.package_code)
            account_id, _, flow_credits = self.get_or_create_account(api_key)
            self._accounts[api_key]["flow_credits"] += package.flows
            self._accounts[api_key]["plan"] = "pro"
            remaining = flow_credits + package.flows
            self._ledger.append(
                {
                    "id": str(uuid4()),
                    "account_id": str(account_id),
                    "entry_type": "package_purchase",
                    "amount_usd": package.price_usd,
                    "currency": "USD",
                    "external_ref": payload.reference,
                    "meta": {"package_code": package.code, "flows": package.flows},
                    "created_at": utcnow().isoformat(),
                }
            )
            return PackagePurchaseResponse(
                account_id=account_id,
                package_code=package.code,
                purchased_flows=package.flows,
                remaining_flows=remaining,
                charged_usd=package.price_usd,
            )

    def is_stripe_event_processed(self, event_id: str) -> bool:
        with self._lock:
            return event_id in self._stripe_events

    def mark_stripe_event_processed(self, event_id: str, event_type: str, payload: dict) -> None:
        with self._lock:
            self._stripe_events[event_id] = {
                "event_type": event_type,
                "payload": payload,
                "processed_at": utcnow().isoformat(),
            }

    def record_stripe_customer(self, api_key: str, customer_id: str, email: str | None = None) -> None:
        with self._lock:
            self.get_or_create_account(api_key)
            self._stripe_customer_by_api_key[api_key] = {
                "customer_id": customer_id,
                "email": email,
                "updated_at": utcnow().isoformat(),
            }
            self._api_key_by_stripe_customer[customer_id] = api_key

    def find_api_key_by_stripe_customer(self, customer_id: str) -> str | None:
        with self._lock:
            return self._api_key_by_stripe_customer.get(customer_id)

    def upsert_stripe_subscription(
        self,
        customer_id: str,
        subscription_id: str,
        status: str,
        price_id: str | None = None,
        current_period_end_ts: int | None = None,
    ) -> None:
        with self._lock:
            self._stripe_subscriptions[subscription_id] = {
                "customer_id": customer_id,
                "status": status,
                "price_id": price_id,
                "current_period_end_ts": current_period_end_ts,
                "updated_at": utcnow().isoformat(),
            }

    def add_ledger_adjustment(
        self,
        api_key: str,
        amount_usd: float,
        entry_type: str,
        reference: str,
        meta: dict | None = None,
    ) -> None:
        with self._lock:
            account_id, _, flow_credits = self.get_or_create_account(api_key)
            self._accounts[api_key]["balance_usd"] += amount_usd
            self._ledger.append(
                {
                    "id": str(uuid4()),
                    "account_id": str(account_id),
                    "entry_type": entry_type,
                    "amount_usd": amount_usd,
                    "currency": "USD",
                    "external_ref": reference,
                    "meta": meta or {},
                    "created_at": utcnow().isoformat(),
                }
            )
            _ = flow_credits

    def create_task(self, api_key: str, payload: CreateTaskRequest) -> Task:
        with self._lock:
            account_id, _, flow_credits = self.get_or_create_account(api_key)
            if flow_credits < 1:
                raise InsufficientFlowCreditsError("No flow credits available")
            self._accounts[api_key]["flow_credits"] -= 1
            task = new_task(account_id, payload)
            self._tasks[task.id] = task
            self._artifacts[task.id] = []
            self._task_audit[task.id] = []
            self._ledger.append(
                {
                    "id": str(uuid4()),
                    "account_id": str(account_id),
                    "task_id": str(task.id),
                    "entry_type": "task_charge",
                    "amount_usd": 0.0,
                    "currency": "USD",
                    "meta": {"flow_delta": -1},
                    "created_at": utcnow().isoformat(),
                }
            )
            return task

    def list_account_tasks_with_review(
        self,
        api_key: str,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
    ) -> list[TaskWithReview]:
        with self._lock:
            account_id, _, _ = self.get_or_create_account(api_key)
            rows = [t for t in self._tasks.values() if t.account_id == account_id]
            if status:
                rows = [t for t in rows if self._enum_or_str(t.status) == status]
            if task_type:
                rows = [t for t in rows if self._enum_or_str(t.task_type) == task_type]
            rows.sort(key=lambda t: t.updated_at, reverse=True)
            capped = rows[: max(1, min(limit, 500))]
            out: list[TaskWithReview] = []
            for t in capped:
                out.append(
                    TaskWithReview(
                        **t.model_dump(),
                        artifacts=self._artifacts.get(t.id, []),
                        review=self._reviews.get(t.id),
                    )
                )
            return out

    def list_tasks(
        self,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        only_problem: bool = False,
        only_sla_breach: bool = False,
        only_manual_review: bool = False,
    ) -> list[Task]:
        with self._lock:
            now = utcnow()
            rows = list(self._tasks.values())
            if status:
                rows = [t for t in rows if self._enum_or_str(t.status) == status]
            if task_type:
                rows = [t for t in rows if self._enum_or_str(t.task_type) == task_type]
            if only_problem:
                rows = [
                    t
                    for t in rows
                    if t.status in (TaskStatus.FAILED, TaskStatus.DISPUTED, TaskStatus.REFUNDED)
                    or (t.status in (TaskStatus.QUEUED, TaskStatus.CLAIMED) and t.sla_deadline <= now)
                ]
            if only_sla_breach:
                rows = [
                    t
                    for t in rows
                    if t.status in (TaskStatus.QUEUED, TaskStatus.CLAIMED)
                    and (t.sla_deadline <= now or (t.sla_deadline - now).total_seconds() <= 120)
                ]
            if only_manual_review:
                rows = [
                    t
                    for t in rows
                    if (self._reviews.get(t.id) is not None)
                    and self._reviews[t.id].review_status == ReviewStatus.MANUAL_REQUIRED
                ]
            rows.sort(key=lambda t: t.updated_at, reverse=True)
            return rows[: max(1, min(limit, 500))]

    def list_tasks_with_review(
        self,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        only_manual_review: bool = False,
    ) -> list[TaskWithReview]:
        rows = self.list_tasks(
            limit=limit,
            status=status,
            task_type=task_type,
            only_manual_review=only_manual_review,
        )
        out: list[TaskWithReview] = []
        for t in rows:
            full = self.get_task(t.id)
            if full:
                out.append(full)
        return out

    def list_manual_review_queue(
        self,
        reviewer_id: str,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        include_locked: bool = False,
    ) -> list[TaskWithReview]:
        rows = self.list_tasks_with_review(
            limit=limit,
            status=status,
            task_type=task_type,
            only_manual_review=True,
        )
        if include_locked:
            return rows
        now = utcnow()
        out: list[TaskWithReview] = []
        for t in rows:
            review = t.review
            if not review:
                continue
            active = bool(review.claimed_by) and bool(review.claimed_until) and review.claimed_until > now
            if active and review.claimed_by != reviewer_id:
                continue
            out.append(t)
        return out

    def claim_next_manual_review(
        self,
        reviewer_id: str,
        lock_seconds: int,
        status: str | None = None,
        task_type: str | None = None,
    ) -> TaskWithReview | None:
        with self._lock:
            now = utcnow()
            rows = self.list_tasks(
                limit=500,
                status=status,
                task_type=task_type,
                only_manual_review=True,
            )
            for t in rows:
                review = self._reviews.get(t.id)
                if not review or review.review_status != ReviewStatus.MANUAL_REQUIRED:
                    continue
                active = bool(review.claimed_by) and bool(review.claimed_until) and review.claimed_until > now
                if active and review.claimed_by != reviewer_id:
                    continue
                review.claimed_by = reviewer_id
                review.claimed_until = now + timedelta(seconds=max(1, lock_seconds))
                self._reviews[t.id] = review
                return self.get_task(t.id)
            return None

    def claim_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool:
        with self._lock:
            review = self._reviews.get(task_id)
            if not review or review.review_status != ReviewStatus.MANUAL_REQUIRED:
                return False
            now = utcnow()
            active = bool(review.claimed_by) and bool(review.claimed_until) and review.claimed_until > now
            if active and review.claimed_by != reviewer_id:
                return False
            review.claimed_by = reviewer_id
            review.claimed_until = now + timedelta(seconds=max(1, lock_seconds))
            self._reviews[task_id] = review
            return True

    def take_over_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool:
        with self._lock:
            review = self._reviews.get(task_id)
            if not review or review.review_status != ReviewStatus.MANUAL_REQUIRED:
                return False
            now = utcnow()
            review.claimed_by = reviewer_id
            review.claimed_until = now + timedelta(seconds=max(1, lock_seconds))
            self._reviews[task_id] = review
            return True

    def release_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
    ) -> bool:
        with self._lock:
            review = self._reviews.get(task_id)
            if not review:
                return False
            if review.claimed_by != reviewer_id:
                return False
            review.claimed_by = None
            review.claimed_until = None
            self._reviews[task_id] = review
            return True

    def get_task(self, task_id: UUID) -> TaskWithReview | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            return TaskWithReview(
                **task.model_dump(),
                artifacts=self._artifacts.get(task_id, []),
                review=self._reviews.get(task_id),
            )

    def list_task_audit(self, task_id: UUID, limit: int = 50) -> list[OpsTaskAuditEntry]:
        with self._lock:
            rows = list(reversed(self._task_audit.get(task_id, [])))
            return rows[: max(1, min(limit, 200))]

    def append_task_audit(
        self,
        task_id: UUID,
        actor: str,
        action: str,
        note: str | None = None,
        metadata: dict | None = None,
    ) -> OpsTaskAuditEntry | None:
        with self._lock:
            if task_id not in self._tasks:
                return None
            entry = OpsTaskAuditEntry(
                id=uuid4(),
                task_id=task_id,
                actor=actor,
                action=action,
                note=note,
                metadata=metadata or {},
                created_at=utcnow(),
            )
            self._task_audit.setdefault(task_id, []).append(entry)
            return entry

    def claim_task(self, task_id: UUID, worker_id: UUID) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status != TaskStatus.QUEUED:
                return None
            task.status = TaskStatus.CLAIMED
            task.worker_id = worker_id
            task.updated_at = utcnow()
            self._tasks[task_id] = task
            self.append_task_audit(task_id, actor="system", action="claim", metadata={"worker_id": str(worker_id)})
            return task

    def complete_task(self, task_id: UUID, result: dict, worker_note: str | None) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status not in (TaskStatus.CLAIMED, TaskStatus.QUEUED):
                return None
            task.status = TaskStatus.COMPLETED
            task.result = result
            task.updated_at = utcnow()
            self._tasks[task_id] = task
            artifacts = list(self._artifacts.get(task_id, []))
            self._reviews[task_id] = build_review(task, artifacts, worker_note)
            self.append_task_audit(task_id, actor="system", action="complete", note=worker_note)
            return task

    def refund_task(self, task_id: UUID, reason: str | None = None) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status not in (TaskStatus.COMPLETED, TaskStatus.DISPUTED):
                raise RefundNotAllowedError("Task must be completed or disputed for refund")
            task.status = TaskStatus.REFUNDED
            task.updated_at = utcnow()
            self._tasks[task_id] = task

            account = next((a for a in self._accounts.values() if a["id"] == task.account_id), None)
            if account:
                account["flow_credits"] += 1
            self._ledger.append(
                {
                    "id": str(uuid4()),
                    "account_id": str(task.account_id),
                    "task_id": str(task.id),
                    "entry_type": "refund",
                    "amount_usd": 0.0,
                    "currency": "USD",
                    "meta": {"flow_delta": 1, "reason": reason},
                    "created_at": utcnow().isoformat(),
                }
            )
            self.append_task_audit(task_id, actor="system", action="refund", note=reason)
            return task

    def set_review_verdict(self, task_id: UUID, verdict: str, note: str | None = None) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            review = self._reviews.get(task_id)
            if not review:
                artifacts = list(self._artifacts.get(task_id, []))
                review = build_review(task, artifacts, worker_note=None)
            if verdict == "approved":
                review.review_status = ReviewStatus.APPROVED
                review.manual_verdict = note
            else:
                review.review_status = ReviewStatus.REJECTED
                review.manual_verdict = note
                if task.status == TaskStatus.COMPLETED:
                    task.status = TaskStatus.DISPUTED
                    task.updated_at = utcnow()
            review.claimed_by = None
            review.claimed_until = None
            self._reviews[task_id] = review
            self._tasks[task_id] = task
            return task

    def recheck_review(self, task_id: UUID) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status not in (TaskStatus.COMPLETED, TaskStatus.DISPUTED):
                return False
            existing = self._reviews.get(task_id)
            if existing and existing.review_status in (ReviewStatus.APPROVED, ReviewStatus.REJECTED):
                return False

            artifacts = list(self._artifacts.get(task_id, []))
            review = build_review(task, artifacts, worker_note=None)
            if existing:
                review.id = existing.id
                review.created_at = existing.created_at
            review.manual_verdict = None
            review.claimed_by = None
            review.claimed_until = None
            self._reviews[task_id] = review
            return True

    def reassign_task(self, task_id: UUID, worker_id: UUID) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.worker_id = worker_id
            if task.status == TaskStatus.QUEUED:
                task.status = TaskStatus.CLAIMED
            task.updated_at = utcnow()
            self._tasks[task_id] = task
            return task

    def force_task_status(self, task_id: UUID, status: str) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.status = TaskStatus(status)
            task.updated_at = utcnow()
            self._tasks[task_id] = task
            return task

    def list_incidents(self, status: str | None = None, limit: int = 50) -> list[OpsIncident]:
        with self._lock:
            rows = list(self._incidents.values())
            if status:
                rows = [i for i in rows if i.status == status]
            rows.sort(key=lambda i: i.updated_at, reverse=True)
            return rows[: max(1, min(limit, 200))]

    def create_incident(self, payload: CreateOpsIncidentRequest) -> OpsIncident:
        with self._lock:
            now = utcnow()
            incident = OpsIncident(
                id=uuid4(),
                incident_type=payload.incident_type,
                severity=payload.severity,
                status="open",
                title=payload.title,
                description=payload.description,
                owner=payload.owner,
                source=payload.source,
                postmortem=None,
                metadata=payload.metadata,
                created_at=now,
                updated_at=now,
                resolved_at=None,
            )
            self._incidents[incident.id] = incident
            self._incident_events[incident.id] = [
                OpsIncidentEvent(
                    id=uuid4(),
                    incident_id=incident.id,
                    actor="system",
                    action="incident_created",
                    note=incident.description,
                    metadata={"source": incident.source, "severity": incident.severity},
                    created_at=now,
                )
            ]
            return incident

    def update_incident(self, incident_id: UUID, payload: UpdateOpsIncidentRequest) -> OpsIncident | None:
        with self._lock:
            incident = self._incidents.get(incident_id)
            if not incident:
                return None
            if payload.status:
                incident.status = payload.status
                if payload.status == "resolved":
                    incident.resolved_at = utcnow()
                elif incident.resolved_at is not None:
                    incident.resolved_at = None
            if payload.owner is not None:
                incident.owner = payload.owner
            if payload.postmortem is not None:
                incident.postmortem = payload.postmortem
            if payload.note:
                notes = list(incident.metadata.get("notes", []))
                notes.append({"at": utcnow().isoformat(), "note": payload.note})
                incident.metadata["notes"] = notes
            incident.updated_at = utcnow()
            self._incidents[incident_id] = incident
            self._incident_events.setdefault(incident_id, []).append(
                OpsIncidentEvent(
                    id=uuid4(),
                    incident_id=incident_id,
                    actor="ops_admin",
                    action="incident_updated",
                    note=payload.note,
                    metadata={
                        "status": payload.status,
                        "owner": payload.owner,
                        "postmortem_updated": payload.postmortem is not None,
                    },
                    created_at=incident.updated_at,
                )
            )
            return incident

    def list_incident_events(self, incident_id: UUID, limit: int = 100) -> list[OpsIncidentEvent]:
        with self._lock:
            rows = list(reversed(self._incident_events.get(incident_id, [])))
            return rows[: max(1, min(limit, 300))]

    def add_artifact(self, task_id: UUID, payload: CreateArtifactRequest) -> Artifact | None:
        with self._lock:
            if task_id not in self._tasks:
                return None
            artifact = Artifact(
                id=uuid4(),
                task_id=task_id,
                artifact_type=payload.artifact_type,
                storage_path=payload.storage_path,
                checksum_sha256=payload.checksum_sha256,
                metadata=payload.metadata,
                created_at=utcnow(),
            )
            self._artifacts[task_id].append(artifact)
            return artifact

    def enqueue_task_webhook(self, task: Task, max_attempts: int) -> None:
        with self._lock:
            if not task.callback_url:
                return
            event = TaskUpdatedEvent(
                event_id=uuid4(),
                event_type="task.updated",
                created_at=utcnow(),
                task=task,
            )
            job = WebhookJob(
                id=uuid4(),
                task_id=task.id,
                callback_url=task.callback_url,
                event_type=event.event_type,
                payload=event.model_dump(mode="json"),
                idempotency_key=str(uuid4()),
                attempts=0,
                max_attempts=max_attempts,
                next_attempt_at=utcnow(),
                created_at=utcnow(),
            )
            self._webhook_jobs.append(job.model_dump())

    def claim_due_webhook_job(self) -> WebhookJob | None:
        with self._lock:
            now = utcnow()
            for idx, row in enumerate(self._webhook_jobs):
                if row["next_attempt_at"] <= now and row["attempts"] < row["max_attempts"]:
                    row["attempts"] += 1
                    self._webhook_jobs[idx] = row
                    return WebhookJob(**row)
            return None

    def mark_webhook_job_success(self, job_id: UUID) -> None:
        with self._lock:
            self._webhook_jobs = [j for j in self._webhook_jobs if j["id"] != job_id]

    def mark_webhook_job_retry(
        self,
        job_id: UUID,
        status_code: int | None,
        error: str | None,
        next_attempt_at: datetime,
    ) -> None:
        with self._lock:
            for job in self._webhook_jobs:
                if job["id"] == job_id:
                    job["next_attempt_at"] = next_attempt_at
                    job["last_status_code"] = status_code
                    job["last_error"] = error
                    return

    def mark_webhook_job_failed(self, job_id: UUID, status_code: int | None, error: str | None) -> None:
        with self._lock:
            for job in self._webhook_jobs:
                if job["id"] == job_id:
                    self._webhook_dead_letters.append(
                        {
                            "id": str(uuid4()),
                            "webhook_job_id": str(job_id),
                            "task_id": str(job["task_id"]),
                            "callback_url": job["callback_url"],
                            "payload": job["payload"],
                            "error": error,
                            "status_code": status_code,
                            "created_at": utcnow().isoformat(),
                            "requeued_at": None,
                        }
                    )
                    break
            self._webhook_jobs = [j for j in self._webhook_jobs if j["id"] != job_id]

    def requeue_dead_letter(self, dead_letter_id: UUID, max_attempts: int) -> bool:
        with self._lock:
            for dlq in self._webhook_dead_letters:
                if dlq["id"] == str(dead_letter_id) and dlq["requeued_at"] is None:
                    self._webhook_jobs.append(
                        {
                            "id": uuid4(),
                            "task_id": UUID(dlq["task_id"]),
                            "callback_url": dlq["callback_url"],
                            "event_type": dlq["payload"].get("event_type", "task.updated"),
                            "payload": dlq["payload"],
                            "idempotency_key": str(uuid4()),
                            "attempts": 0,
                            "max_attempts": max_attempts,
                            "next_attempt_at": utcnow(),
                            "created_at": utcnow(),
                        }
                    )
                    dlq["requeued_at"] = utcnow().isoformat()
                    return True
            return False

    def get_ops_metrics(self) -> OpsMetricsResponse:
        with self._lock:
            queue_pending = sum(1 for j in self._webhook_jobs if j.get("attempts", 0) < j.get("max_attempts", 0))
            queue_processing = 0
            queue_total = len(self._webhook_jobs)

            delivery_total = len(self._webhook_deliveries)
            success_total = sum(1 for d in self._webhook_deliveries if d.get("success"))
            retry_total = sum(1 for d in self._webhook_deliveries if int(d.get("attempt", 1)) > 1)

            durations = []
            status_counts: dict[str, int] = {}
            active_tasks = 0
            tasks_sla_risk = 0
            tasks_overdue = 0
            now = utcnow()
            for task in self._tasks.values():
                task_status = self._enum_or_str(task.status)
                status_counts[task_status] = status_counts.get(task_status, 0) + 1
                if task_status in (TaskStatus.QUEUED.value, TaskStatus.CLAIMED.value):
                    active_tasks += 1
                    if task.sla_deadline <= now:
                        tasks_overdue += 1
                    elif (task.sla_deadline - now).total_seconds() <= 120:
                        tasks_sla_risk += 1
                if task.created_at and task.updated_at and task_status in (
                    TaskStatus.COMPLETED.value,
                    TaskStatus.REFUNDED.value,
                ):
                    durations.append((task.updated_at - task.created_at).total_seconds())
            durations.sort()
            p95 = None
            if durations:
                idx = max(0, int(0.95 * (len(durations) - 1)))
                p95 = float(durations[idx])

            manual_review_pending = sum(
                1 for r in self._reviews.values() if r.review_status == ReviewStatus.MANUAL_REQUIRED
            )

            return OpsMetricsResponse(
                queue_pending=queue_pending,
                queue_processing=queue_processing,
                queue_total=queue_total,
                webhook_delivery_total=delivery_total,
                webhook_delivery_success_rate=round((success_total / delivery_total), 4) if delivery_total else 1.0,
                webhook_retry_rate=round((retry_total / delivery_total), 4) if delivery_total else 0.0,
                webhook_dlq_count=len(self._webhook_dead_letters),
                manual_review_pending=manual_review_pending,
                task_resolution_p95_seconds=p95,
                active_tasks=active_tasks,
                tasks_sla_risk=tasks_sla_risk,
                tasks_overdue=tasks_overdue,
                task_status_counts=status_counts,
            )

    def list_webhook_dead_letters(self, limit: int = 50) -> list[WebhookDeadLetter]:
        with self._lock:
            rows = list(reversed(self._webhook_dead_letters[:]))[: max(1, min(limit, 500))]
            results: list[WebhookDeadLetter] = []
            for row in rows:
                results.append(
                    WebhookDeadLetter(
                        id=UUID(row["id"]),
                        webhook_job_id=UUID(row["webhook_job_id"]),
                        task_id=UUID(row["task_id"]),
                        callback_url=row["callback_url"],
                        payload=row["payload"],
                        error=row.get("error"),
                        status_code=row.get("status_code"),
                        created_at=datetime.fromisoformat(row["created_at"]),
                        requeued_at=datetime.fromisoformat(row["requeued_at"]) if row.get("requeued_at") else None,
                    )
                )
            return results

    def list_ledger_entries(self, limit: int = 100, account_id: UUID | None = None) -> list[LedgerEntry]:
        with self._lock:
            rows = list(reversed(self._ledger))
            if account_id:
                rows = [row for row in rows if row.get("account_id") == str(account_id)]
            rows = rows[: max(1, min(limit, 1000))]
            entries: list[LedgerEntry] = []
            for row in rows:
                entries.append(
                    LedgerEntry(
                        id=UUID(row.get("id")) if row.get("id") else uuid4(),
                        account_id=UUID(row["account_id"]) if row.get("account_id") else None,
                        task_id=UUID(row["task_id"]) if row.get("task_id") else None,
                        entry_type=row.get("entry_type", "unknown"),
                        amount_usd=float(row.get("amount_usd", 0.0)),
                        currency=row.get("currency", "USD"),
                        external_ref=row.get("external_ref"),
                        meta=row.get("meta", {}),
                        created_at=(
                            datetime.fromisoformat(row["created_at"])
                            if isinstance(row.get("created_at"), str)
                            else utcnow()
                        ),
                    )
                )
            return entries

    def get_margin_summary(self) -> OpsMarginSummary:
        with self._lock:
            package_amount = 0.0
            purchased_flows = 0
            used_flows = 0
            refunds = 0
            for row in self._ledger:
                et = row.get("entry_type")
                if et == "package_purchase":
                    package_amount += float(row.get("amount_usd", 0.0))
                    purchased_flows += int((row.get("meta") or {}).get("flows", 0))
                if et == "task_charge" and int((row.get("meta") or {}).get("flow_delta", 0)) < 0:
                    used_flows += 1
                if et == "refund":
                    refunds += 1
            avg_revenue_per_flow = (package_amount / purchased_flows) if purchased_flows else 0.0
            estimated_cost_per_flow = 0.42
            estimated_revenue = used_flows * avg_revenue_per_flow
            estimated_cost = used_flows * estimated_cost_per_flow
            return OpsMarginSummary(
                period="all_time",
                flows_used=used_flows,
                refunds_count=refunds,
                avg_revenue_per_flow_usd=round(avg_revenue_per_flow, 4),
                estimated_cost_per_flow_usd=estimated_cost_per_flow,
                estimated_revenue_usd=round(estimated_revenue, 4),
                estimated_cost_usd=round(estimated_cost, 4),
                estimated_gross_profit_usd=round(estimated_revenue - estimated_cost, 4),
            )

    def record_webhook_delivery(
        self,
        task_id: UUID,
        callback_url: str,
        status_code: int | None,
        attempt: int,
        success: bool,
        error: str | None = None,
    ) -> None:
        with self._lock:
            self._webhook_deliveries.append(
                {
                    "task_id": str(task_id),
                    "callback_url": callback_url,
                    "status_code": status_code,
                    "attempt": attempt,
                    "success": success,
                    "error": error,
                    "created_at": utcnow().isoformat(),
                }
            )

    def get_openai_interruption(self, interruption_id: str) -> OpenAIInterruptionRecord | None:
        with self._lock:
            return self._openai_interruptions.get(interruption_id)

    def create_openai_interruption(
        self,
        payload: OpenAIInterruptionIngestRequest,
        task_id: UUID,
        context_capsule: dict,
    ) -> OpenAIInterruptionRecord:
        with self._lock:
            existing = self._openai_interruptions.get(payload.interruption_id)
            if existing:
                return existing
            now = utcnow()
            record = OpenAIInterruptionRecord(
                interruption_id=payload.interruption_id,
                run_id=payload.run_id,
                thread_id=payload.thread_id,
                agent_name=payload.agent_name,
                tool_name=payload.tool_name,
                task_id=task_id,
                status="pending",
                decision=None,
                decision_actor=None,
                decision_note=None,
                decision_output={},
                context_capsule=context_capsule,
                metadata=payload.metadata,
                state_blob=payload.state_blob,
                created_at=now,
                decided_at=None,
                resumed_at=None,
            )
            self._openai_interruptions[payload.interruption_id] = record
            return record

    def decide_openai_interruption(
        self,
        interruption_id: str,
        payload: OpenAIInterruptionDecisionRequest,
    ) -> OpenAIInterruptionRecord | None:
        with self._lock:
            item = self._openai_interruptions.get(interruption_id)
            if not item:
                return None
            item.status = "decided"
            item.decision = payload.decision
            item.decision_actor = payload.actor
            item.decision_note = payload.note
            item.decision_output = payload.output
            item.decided_at = utcnow()
            self._openai_interruptions[interruption_id] = item
            return item

    def mark_openai_interruption_resumed(self, interruption_id: str) -> OpenAIResumeResponse | None:
        with self._lock:
            item = self._openai_interruptions.get(interruption_id)
            if not item:
                return None
            now = utcnow()
            item.status = "resumed"
            item.resumed_at = now
            self._openai_interruptions[interruption_id] = item
            return OpenAIResumeResponse(
                interruption_id=item.interruption_id,
                run_id=item.run_id,
                resume_enqueued=True,
                resumed_at=now,
                resume_payload={
                    "run_id": item.run_id,
                    "thread_id": item.thread_id,
                    "interruption_id": item.interruption_id,
                    "decision": item.decision,
                    "output": item.decision_output,
                    "note": item.decision_note,
                    "state_blob": item.state_blob,
                },
            )

    def list_openai_interruptions_by_status(self, status: str, limit: int = 100) -> list[OpenAIInterruptionRecord]:
        capped_limit = max(1, min(limit, 500))
        with self._lock:
            rows = [i for i in self._openai_interruptions.values() if i.status == status]
            rows.sort(key=lambda i: i.created_at)
            return rows[:capped_limit]

    def mark_openai_interruption_failed(self, interruption_id: str, note: str | None = None) -> OpenAIInterruptionRecord | None:
        with self._lock:
            item = self._openai_interruptions.get(interruption_id)
            if not item:
                return None
            item.status = "failed"
            if note:
                item.decision_note = note
            self._openai_interruptions[interruption_id] = item
            return item

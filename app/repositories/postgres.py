from uuid import UUID, uuid4
from datetime import datetime, timezone
import os

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from app.billing.catalog import get_package_or_none
from app.domain.enums import ArtifactType, ReviewStatus, TaskStatus, TaskType
from app.models import (
    Artifact,
    BalanceResponse,
    CreateOpsIncidentRequest,
    CreateArtifactRequest,
    CreateTaskRequest,
    CreateLeadRequest,
    CreateOperatorApplicationRequest,
    LeadRecord,
    OpsMetricsResponse,
    OpsMetricsHistoryPoint,
    OpsIncident,
    OpsIncidentEvent,
    Review,
    OpenAIInterruptionDecisionRequest,
    OpenAIInterruptionIngestRequest,
    OpenAIInterruptionRecord,
    OpenAIResumeResponse,
    OpsMarginSummary,
    OpsTaskAuditEntry,
    LedgerEntry,
    PackageInfo,
    PackagePurchaseRequest,
    PackagePurchaseResponse,
    Task,
    TaskUpdatedEvent,
    TaskWithReview,
    TopUpRequest,
    UpdateOpsIncidentRequest,
    WebhookJob,
    WebhookDeadLetter,
    WebhookDelivery,
    OperatorApplicationRecord,
    OperatorRecord,
    UpdateOperatorApplicationRequest,
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


class PostgresRepository:
    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    @staticmethod
    def _enum_or_str(value: object) -> str:
        if hasattr(value, "value"):
            return str(getattr(value, "value"))
        return str(value)

    def _conn(self) -> psycopg.Connection:
        return psycopg.connect(self.dsn, row_factory=dict_row)

    @staticmethod
    def _read_dev_seed() -> tuple[int, str | None]:
        seed_credits_raw = os.getenv("SHIMLAYER_DEV_SEED_CREDITS", "").strip()
        seed_plan_raw = os.getenv("SHIMLAYER_DEV_PLAN", "").strip().lower()
        seed_credits = 0
        if seed_credits_raw:
            try:
                seed_credits = max(0, int(seed_credits_raw))
            except ValueError:
                seed_credits = 0
        desired_plan = seed_plan_raw or ("pro" if seed_credits > 0 else "")
        return seed_credits, desired_plan or None

    def _get_or_create_account(self, conn: psycopg.Connection, api_key: str) -> tuple[UUID, float, int]:
        seed_credits, desired_plan = self._read_dev_seed()
        with conn.cursor() as cur:
            cur.execute(
                "select id, balance_usd, flow_credits, plan from public.accounts where external_ref = %s",
                (api_key,),
            )
            row = cur.fetchone()
            if row:
                current_credits = int(row["flow_credits"])
                current_plan = row.get("plan") or "free"
                target_credits = max(current_credits, seed_credits) if seed_credits else current_credits
                target_plan = desired_plan or current_plan
                if target_credits != current_credits or target_plan != current_plan:
                    cur.execute(
                        """
                        update public.accounts
                        set flow_credits = %s, plan = %s
                        where id = %s
                        """,
                        (target_credits, target_plan, row["id"]),
                    )
                    return row["id"], float(row["balance_usd"]), target_credits
                return row["id"], float(row["balance_usd"]), current_credits
            account_id = uuid4()
            plan = desired_plan or ("pro" if seed_credits > 0 else "free")
            cur.execute(
                """
                insert into public.accounts (id, external_ref, plan, balance_usd, flow_credits)
                values (%s, %s, %s, 0, %s)
                """,
                (account_id, api_key, plan, seed_credits),
            )
            return account_id, 0.0, seed_credits

    def consume_rate_limit(self, api_key: str) -> None:
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            with conn.cursor() as cur:
                cur.execute("select plan from public.accounts where id = %s", (account_id,))
                row = cur.fetchone()
                plan = row["plan"] if row else "free"
                if plan != "free":
                    conn.commit()
                    return
                cur.execute(
                    """
                    insert into public.api_rate_windows (account_id, window_start, request_count)
                    values (%s, date_trunc('minute', now()), 1)
                    on conflict (account_id, window_start)
                    do update set request_count = public.api_rate_windows.request_count + 1
                    returning request_count
                    """,
                    (account_id,),
                )
                count = int(cur.fetchone()["request_count"])
                if count > 10:
                    conn.rollback()
                    raise RateLimitExceededError("Rate limit exceeded: free plan allows 10 requests per minute")
            conn.commit()

    def get_balance(self, api_key: str) -> BalanceResponse:
        with self._conn() as conn:
            account_id, balance, flow_credits = self._get_or_create_account(conn, api_key)
            conn.commit()
            return BalanceResponse(account_id=account_id, balance_usd=round(balance, 4), flow_credits=flow_credits)

    def list_packages(self) -> list[PackageInfo]:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select code, flows, price_usd, active
                    from public.package_catalog
                    order by flows asc
                    """
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            PackageInfo(
                code=row["code"],
                flows=int(row["flows"]),
                price_usd=float(row["price_usd"]),
                unit_price_usd=round(float(row["price_usd"]) / int(row["flows"]), 4),
                active=bool(row["active"]),
            )
            for row in rows
        ]

    def topup(self, api_key: str, payload: TopUpRequest) -> BalanceResponse:
        with self._conn() as conn:
            account_id, _, flow_credits = self._get_or_create_account(conn, api_key)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.accounts
                    set balance_usd = balance_usd + %s
                    where id = %s
                    returning balance_usd
                    """,
                    (payload.amount_usd, account_id),
                )
                balance = float(cur.fetchone()["balance_usd"])
                cur.execute(
                    """
                    insert into public.ledger (account_id, entry_type, amount_usd, external_ref, meta)
                    values (%s, 'topup', %s, %s, %s)
                    """,
                    (account_id, payload.amount_usd, payload.reference, Json({})),
                )
            conn.commit()
            return BalanceResponse(account_id=account_id, balance_usd=round(balance, 4), flow_credits=flow_credits)

    def purchase_package(self, api_key: str, payload: PackagePurchaseRequest) -> PackagePurchaseResponse:
        package = get_package_or_none(payload.package_code)
        if not package:
            raise UnknownPackageError(payload.package_code)
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.accounts
                    set flow_credits = flow_credits + %s, plan = 'pro'
                    where id = %s
                    returning flow_credits
                    """,
                    (package.flows, account_id),
                )
                remaining = int(cur.fetchone()["flow_credits"])
                cur.execute(
                    """
                    insert into public.ledger (account_id, entry_type, amount_usd, external_ref, meta)
                    values (%s, 'package_purchase', %s, %s, %s)
                    """,
                    (
                        account_id,
                        package.price_usd,
                        payload.reference,
                        Json({"package_code": package.code, "flow_delta": package.flows}),
                    ),
                )
            conn.commit()
            return PackagePurchaseResponse(
                account_id=account_id,
                package_code=package.code,
                purchased_flows=package.flows,
                remaining_flows=remaining,
                charged_usd=package.price_usd,
            )

    def is_stripe_event_processed(self, event_id: str) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select 1 from public.stripe_events_processed where event_id = %s", (event_id,))
                row = cur.fetchone()
            conn.commit()
        return row is not None

    def mark_stripe_event_processed(self, event_id: str, event_type: str, payload: dict) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.stripe_events_processed (event_id, event_type, payload, processed_at)
                    values (%s, %s, %s, now())
                    on conflict (event_id) do nothing
                    """,
                    (event_id, event_type, Json(payload)),
                )
            conn.commit()

    def record_stripe_customer(self, api_key: str, customer_id: str, email: str | None = None) -> None:
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.stripe_customers (account_id, customer_id, email, created_at, updated_at)
                    values (%s, %s, %s, now(), now())
                    on conflict (customer_id) do update
                    set account_id = excluded.account_id,
                        email = excluded.email,
                        updated_at = now()
                    """,
                    (account_id, customer_id, email),
                )
            conn.commit()

    def find_api_key_by_stripe_customer(self, customer_id: str) -> str | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select a.external_ref
                    from public.stripe_customers sc
                    join public.accounts a on a.id = sc.account_id
                    where sc.customer_id = %s
                    """,
                    (customer_id,),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return row.get("external_ref")

    def upsert_stripe_subscription(
        self,
        customer_id: str,
        subscription_id: str,
        status: str,
        price_id: str | None = None,
        current_period_end_ts: int | None = None,
    ) -> None:
        period_end = (
            datetime.fromtimestamp(current_period_end_ts, tz=timezone.utc) if current_period_end_ts else None
        )
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.stripe_subscriptions
                    (subscription_id, customer_id, status, price_id, current_period_end, created_at, updated_at)
                    values (%s, %s, %s, %s, %s, now(), now())
                    on conflict (subscription_id) do update
                    set customer_id = excluded.customer_id,
                        status = excluded.status,
                        price_id = excluded.price_id,
                        current_period_end = excluded.current_period_end,
                        updated_at = now()
                    """,
                    (subscription_id, customer_id, status, price_id, period_end),
                )
            conn.commit()

    def add_ledger_adjustment(
        self,
        api_key: str,
        amount_usd: float,
        entry_type: str,
        reference: str,
        meta: dict | None = None,
    ) -> None:
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.accounts
                    set balance_usd = balance_usd + %s
                    where id = %s
                    """,
                    (amount_usd, account_id),
                )
                cur.execute(
                    """
                    insert into public.ledger (account_id, entry_type, amount_usd, external_ref, meta)
                    values (%s, %s::ledger_entry_type, %s, %s, %s)
                    """,
                    (account_id, entry_type, amount_usd, reference, Json(meta or {})),
                )
            conn.commit()

    def create_lead(self, payload: CreateLeadRequest) -> LeadRecord:
        lead_id = uuid4()
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.leads
                    (id, name, email, company, role, volume, timeline, usecase, contact, source, page, metadata)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    returning id, name, email, company, role, volume, timeline, usecase, contact, source, page, metadata, created_at
                    """,
                    (
                        lead_id,
                        payload.name,
                        payload.email,
                        payload.company,
                        payload.role,
                        payload.volume,
                        payload.timeline,
                        payload.usecase,
                        payload.contact,
                        payload.source,
                        payload.page,
                        Json(payload.metadata or {}),
                    ),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            raise ValueError("Failed to insert lead")
        return LeadRecord(
            id=row["id"],
            name=row["name"],
            email=row["email"],
            company=row["company"],
            role=row.get("role"),
            volume=row.get("volume"),
            timeline=row.get("timeline"),
            usecase=row.get("usecase"),
            contact=row.get("contact"),
            source=row.get("source"),
            page=row.get("page"),
            metadata=row.get("metadata") or {},
            created_at=row["created_at"],
        )

    def create_operator_application(self, payload: CreateOperatorApplicationRequest) -> OperatorApplicationRecord:
        application_id = uuid4()
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.operator_applications
                    (id, region, email, phone, telegram_handle, telegram_chat_id, experience, languages, status, source, page, metadata)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s)
                    returning id, region, email, phone, telegram_handle, telegram_chat_id, experience, languages,
                      status, decision_note, reviewed_by, reviewed_at, operator_id, source, page, metadata, created_at, updated_at
                    """,
                    (
                        application_id,
                        payload.region,
                        payload.email,
                        payload.phone,
                        payload.telegram_handle,
                        payload.telegram_chat_id,
                        payload.experience,
                        payload.languages,
                        payload.source,
                        payload.page,
                        Json(payload.metadata or {}),
                    ),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            raise ValueError("Failed to insert operator application")
        return OperatorApplicationRecord(
            id=row["id"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            experience=row.get("experience"),
            languages=row.get("languages"),
            status=row["status"],
            decision_note=row.get("decision_note"),
            reviewed_by=row.get("reviewed_by"),
            reviewed_at=row.get("reviewed_at"),
            operator_id=row.get("operator_id"),
            source=row.get("source"),
            page=row.get("page"),
            metadata=row.get("metadata") or {},
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_operator_applications(
        self,
        status: str | None = None,
        limit: int = 50,
    ) -> list[OperatorApplicationRecord]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            with conn.cursor() as cur:
                if status:
                    cur.execute(
                        """
                        select id, region, email, phone, telegram_handle, telegram_chat_id, experience, languages,
                          status, decision_note, reviewed_by, reviewed_at, operator_id, source, page, metadata, created_at, updated_at
                        from public.operator_applications
                        where status = %s
                        order by created_at desc
                        limit %s
                        """,
                        (status, capped_limit),
                    )
                else:
                    cur.execute(
                        """
                        select id, region, email, phone, telegram_handle, telegram_chat_id, experience, languages,
                          status, decision_note, reviewed_by, reviewed_at, operator_id, source, page, metadata, created_at, updated_at
                        from public.operator_applications
                        order by created_at desc
                        limit %s
                        """,
                        (capped_limit,),
                    )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            OperatorApplicationRecord(
                id=row["id"],
                region=row["region"],
                email=row["email"],
                phone=row["phone"],
                telegram_handle=row["telegram_handle"],
                telegram_chat_id=row.get("telegram_chat_id"),
                experience=row.get("experience"),
                languages=row.get("languages"),
                status=row["status"],
                decision_note=row.get("decision_note"),
                reviewed_by=row.get("reviewed_by"),
                reviewed_at=row.get("reviewed_at"),
                operator_id=row.get("operator_id"),
                source=row.get("source"),
                page=row.get("page"),
                metadata=row.get("metadata") or {},
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def update_operator_application(
        self,
        application_id: UUID,
        payload: UpdateOperatorApplicationRequest,
        reviewer_id: str,
    ) -> OperatorApplicationRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.operator_applications
                    set status = %s,
                        decision_note = %s,
                        reviewed_by = %s,
                        reviewed_at = now(),
                        telegram_chat_id = coalesce(%s, telegram_chat_id)
                    where id = %s
                    returning id, region, email, phone, telegram_handle, telegram_chat_id, experience, languages,
                      status, decision_note, reviewed_by, reviewed_at, operator_id, source, page, metadata, created_at, updated_at
                    """,
                    (
                        payload.status,
                        payload.decision_note,
                        reviewer_id,
                        payload.telegram_chat_id,
                        application_id,
                    ),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return OperatorApplicationRecord(
            id=row["id"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            experience=row.get("experience"),
            languages=row.get("languages"),
            status=row["status"],
            decision_note=row.get("decision_note"),
            reviewed_by=row.get("reviewed_by"),
            reviewed_at=row.get("reviewed_at"),
            operator_id=row.get("operator_id"),
            source=row.get("source"),
            page=row.get("page"),
            metadata=row.get("metadata") or {},
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def create_operator_from_application(
        self,
        application_id: UUID,
        reviewer_id: str,
    ) -> tuple[OperatorRecord, str] | None:
        token = f"op_{uuid4().hex}"
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, region, email, phone, telegram_handle, telegram_chat_id
                    from public.operator_applications
                    where id = %s
                    """,
                    (application_id,),
                )
                app = cur.fetchone()
                if not app:
                    conn.rollback()
                    return None
                cur.execute(
                    """
                    select id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id,
                      access_token, created_at, updated_at
                    from public.operators
                    where application_id = %s
                    """,
                    (application_id,),
                )
                existing = cur.fetchone()
                if existing:
                    operator = OperatorRecord(
                        id=existing["id"],
                        application_id=existing["application_id"],
                        status=existing["status"],
                        role=existing["role"],
                        region=existing["region"],
                        email=existing["email"],
                        phone=existing["phone"],
                        telegram_handle=existing["telegram_handle"],
                        telegram_chat_id=existing.get("telegram_chat_id"),
                        created_at=existing["created_at"],
                        updated_at=existing["updated_at"],
                    )
                    cur.execute(
                        """
                        update public.operator_applications
                        set operator_id = %s
                        where id = %s and operator_id is null
                        """,
                        (existing["id"], application_id),
                    )
                    conn.commit()
                    return operator, existing["access_token"]
                operator_id = uuid4()
                cur.execute(
                    """
                    insert into public.operators
                    (id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id, access_token)
                    values (%s, %s, 'active', 'operator', %s, %s, %s, %s, %s, %s)
                    returning id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id,
                      access_token, created_at, updated_at
                    """,
                    (
                        operator_id,
                        application_id,
                        app["region"],
                        app["email"],
                        app["phone"],
                        app["telegram_handle"],
                        app.get("telegram_chat_id"),
                        token,
                    ),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        """
                        update public.operator_applications
                        set operator_id = %s
                        where id = %s
                        """,
                        (row["id"], application_id),
                    )
            conn.commit()
        if not row:
            return None
        operator = OperatorRecord(
            id=row["id"],
            application_id=row["application_id"],
            status=row["status"],
            role=row["role"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        return operator, row["access_token"]

    def get_operator_by_token(self, token: str) -> OperatorRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id, created_at, updated_at
                    from public.operators
                    where access_token = %s
                    """,
                    (token,),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return OperatorRecord(
            id=row["id"],
            application_id=row["application_id"],
            status=row["status"],
            role=row["role"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def get_operator(self, operator_id: UUID) -> OperatorRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id, created_at, updated_at
                    from public.operators
                    where id = %s
                    """,
                    (operator_id,),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return OperatorRecord(
            id=row["id"],
            application_id=row["application_id"],
            status=row["status"],
            role=row["role"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def get_operator_by_chat_id(self, chat_id: str) -> OperatorRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id, created_at, updated_at
                    from public.operators
                    where telegram_chat_id = %s
                    """,
                    (chat_id,),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return OperatorRecord(
            id=row["id"],
            application_id=row["application_id"],
            status=row["status"],
            role=row["role"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def link_operator_chat_id(self, token: str, chat_id: str) -> OperatorRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, application_id, status, role, region, email, phone, telegram_handle, telegram_chat_id
                    from public.operators
                    where access_token = %s
                    """,
                    (token,),
                )
                operator = cur.fetchone()
                if not operator:
                    conn.rollback()
                    return None
                cur.execute(
                    """
                    select id
                    from public.operators
                    where telegram_chat_id = %s
                    """,
                    (chat_id,),
                )
                existing = cur.fetchone()
                if existing and existing["id"] != operator["id"]:
                    conn.rollback()
                    return None
                if operator.get("telegram_chat_id") and operator.get("telegram_chat_id") != chat_id:
                    conn.rollback()
                    return None
                cur.execute(
                    """
                    update public.operators
                    set telegram_chat_id = %s, updated_at = now()
                    where id = %s
                    returning id, application_id, status, role, region, email, phone, telegram_handle,
                      telegram_chat_id, created_at, updated_at
                    """,
                    (chat_id, operator["id"]),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        """
                        update public.operator_applications
                        set telegram_chat_id = coalesce(telegram_chat_id, %s), updated_at = now()
                        where id = %s
                        """,
                        (chat_id, row["application_id"]),
                    )
            conn.commit()
        if not row:
            return None
        return OperatorRecord(
            id=row["id"],
            application_id=row["application_id"],
            status=row["status"],
            role=row["role"],
            region=row["region"],
            email=row["email"],
            phone=row["phone"],
            telegram_handle=row["telegram_handle"],
            telegram_chat_id=row.get("telegram_chat_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def create_task(self, api_key: str, payload: CreateTaskRequest) -> Task:
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            task = new_task(account_id, payload)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.accounts
                    set flow_credits = flow_credits - 1
                    where id = %s and flow_credits > 0
                    returning flow_credits
                    """,
                    (account_id,),
                )
                credits_row = cur.fetchone()
                if not credits_row:
                    raise InsufficientFlowCreditsError("No flow credits available")
                cur.execute(
                    """
                    insert into public.tasks
                    (id, account_id, task_type, status, context, max_price_usd, callback_url, sla_seconds, sla_deadline, created_at, updated_at)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        task.id,
                        task.account_id,
                        self._enum_or_str(task.task_type),
                        self._enum_or_str(task.status),
                        Json(task.context),
                        task.max_price_usd,
                        payload.callback_url,
                        task.sla_seconds,
                        task.sla_deadline,
                        task.created_at,
                        task.updated_at,
                    ),
                )
                cur.execute(
                    """
                    insert into public.ledger (account_id, task_id, entry_type, amount_usd, meta)
                    values (%s, %s, 'task_charge', 0, %s)
                    """,
                    (account_id, task.id, Json({"flow_delta": -1})),
                )
            conn.commit()
            task.callback_url = payload.callback_url
            return task

    def list_account_tasks_with_review(
        self,
        api_key: str,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
    ) -> list[TaskWithReview]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            filters: list[str] = ["t.account_id = %s"]
            params: list[object] = [account_id]
            if status:
                filters.append("t.status = %s")
                params.append(status)
            if task_type:
                filters.append("t.task_type = %s")
                params.append(task_type)
            where_sql = f"where {' and '.join(filters)}"
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select t.*
                    from public.tasks t
                    {where_sql}
                    order by t.updated_at desc
                    limit %s
                    """,
                    (*params, capped_limit),
                )
                task_rows = cur.fetchall() or []
                tasks = [self._task_from_row(row) for row in task_rows]
                if not tasks:
                    conn.commit()
                    return []

                task_ids = [t.id for t in tasks]
                cur.execute(
                    """
                    select *
                    from public.artifacts
                    where task_id = any(%s)
                    order by created_at desc
                    """,
                    (task_ids,),
                )
                artifact_rows = cur.fetchall() or []
                cur.execute("select * from public.reviews where task_id = any(%s)", (task_ids,))
                review_rows = cur.fetchall() or []
            conn.commit()

        artifacts_by_task: dict[UUID, list[Artifact]] = {}
        for row in artifact_rows:
            tid = row["task_id"]
            artifacts_by_task.setdefault(tid, []).append(self._artifact_from_row(row))

        review_by_task: dict[UUID, Review] = {}
        for row in review_rows:
            review = self._review_from_row(row)
            review_by_task[review.task_id] = review

        out: list[TaskWithReview] = []
        for t in tasks:
            out.append(
                TaskWithReview(
                    **t.model_dump(),
                    artifacts=artifacts_by_task.get(t.id, []),
                    review=review_by_task.get(t.id),
                )
            )
        return out

    def list_account_tasks_with_review_after(
        self,
        api_key: str,
        after_updated_at: datetime | None,
        after_task_id: UUID | None,
        limit: int = 50,
        status: str | None = None,
        task_type: str | None = None,
    ) -> list[TaskWithReview]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            account_id, _, _ = self._get_or_create_account(conn, api_key)
            filters: list[str] = ["t.account_id = %s"]
            params: list[object] = [account_id]
            if status:
                filters.append("t.status = %s")
                params.append(status)
            if task_type:
                filters.append("t.task_type = %s")
                params.append(task_type)
            if after_updated_at is not None:
                filters.append("(t.updated_at, t.id) > (%s, %s)")
                params.append(after_updated_at)
                params.append(after_task_id or UUID(int=0))
            where_sql = f"where {' and '.join(filters)}"
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select t.*
                    from public.tasks t
                    {where_sql}
                    order by t.updated_at asc, t.id asc
                    limit %s
                    """,
                    (*params, capped_limit),
                )
                task_rows = cur.fetchall() or []
                tasks = [self._task_from_row(row) for row in task_rows]
                if not tasks:
                    conn.commit()
                    return []

                task_ids = [t.id for t in tasks]
                cur.execute(
                    """
                    select *
                    from public.artifacts
                    where task_id = any(%s)
                    order by created_at desc
                    """,
                    (task_ids,),
                )
                artifact_rows = cur.fetchall() or []
                cur.execute("select * from public.reviews where task_id = any(%s)", (task_ids,))
                review_rows = cur.fetchall() or []
            conn.commit()

        artifacts_by_task: dict[UUID, list[Artifact]] = {}
        for row in artifact_rows:
            tid = row["task_id"]
            artifacts_by_task.setdefault(tid, []).append(self._artifact_from_row(row))

        review_by_task: dict[UUID, Review] = {}
        for row in review_rows:
            review = self._review_from_row(row)
            review_by_task[review.task_id] = review

        out: list[TaskWithReview] = []
        for t in tasks:
            out.append(
                TaskWithReview(
                    **t.model_dump(),
                    artifacts=artifacts_by_task.get(t.id, []),
                    review=review_by_task.get(t.id),
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
        capped_limit = max(1, min(limit, 500))
        filters: list[str] = []
        params: list[object] = []
        if status:
            filters.append("t.status = %s")
            params.append(status)
        if task_type:
            filters.append("t.task_type = %s")
            params.append(task_type)
        if only_problem:
            filters.append(
                "("
                "t.status in ('failed', 'disputed', 'refunded') "
                "or (t.status in ('queued', 'claimed') and t.sla_deadline <= now())"
                ")"
            )
        if only_sla_breach:
            filters.append(
                "("
                "t.status in ('queued', 'claimed') "
                "and (t.sla_deadline <= now() or t.sla_deadline <= now() + interval '2 minutes')"
                ")"
            )
        if only_manual_review:
            filters.append(
                "exists ("
                "select 1 from public.reviews r "
                "where r.task_id = t.id and r.review_status = 'manual_required'"
                ")"
            )
        where_sql = f"where {' and '.join(filters)}" if filters else ""
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select t.*
                    from public.tasks t
                    {where_sql}
                    order by t.updated_at desc
                    limit %s
                    """,
                    (*params, capped_limit),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [self._task_from_row(row) for row in rows]

    def list_tasks_with_review(
        self,
        limit: int = 100,
        status: str | None = None,
        task_type: str | None = None,
        only_manual_review: bool = False,
    ) -> list[TaskWithReview]:
        tasks = self.list_tasks(
            limit=limit,
            status=status,
            task_type=task_type,
            only_manual_review=only_manual_review,
        )
        if not tasks:
            return []

        task_ids = [t.id for t in tasks]
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select *
                    from public.artifacts
                    where task_id = any(%s)
                    order by created_at desc
                    """,
                    (task_ids,),
                )
                artifact_rows = cur.fetchall() or []

                cur.execute("select * from public.reviews where task_id = any(%s)", (task_ids,))
                review_rows = cur.fetchall() or []
            conn.commit()

        artifacts_by_task: dict[UUID, list[Artifact]] = {}
        for row in artifact_rows:
            task_id = row["task_id"]
            artifacts_by_task.setdefault(task_id, []).append(self._artifact_from_row(row))

        review_by_task: dict[UUID, Review] = {}
        for row in review_rows:
            review = self._review_from_row(row)
            review_by_task[review.task_id] = review

        out: list[TaskWithReview] = []
        for t in tasks:
            out.append(
                TaskWithReview(
                    **t.model_dump(),
                    artifacts=artifacts_by_task.get(t.id, []),
                    review=review_by_task.get(t.id),
                )
            )
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
        exclude_task_id: UUID | None = None,
    ) -> TaskWithReview | None:
        capped_limit = 1
        filters: list[str] = [
            "r.review_status = 'manual_required'",
            "(r.claimed_by is null or r.claimed_until is null or r.claimed_until < now())",
        ]
        params: list[object] = []
        if status:
            filters.append("t.status = %s")
            params.append(status)
        if task_type:
            filters.append("t.task_type = %s")
            params.append(task_type)
        if exclude_task_id:
            filters.append("r.task_id <> %s")
            params.append(exclude_task_id)
        where_sql = f"where {' and '.join(filters)}"
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    with candidate as (
                      select r.task_id
                      from public.reviews r
                      join public.tasks t on t.id = r.task_id
                      {where_sql}
                      order by t.updated_at desc
                      limit %s
                      for update of r skip locked
                    )
                    update public.reviews r
                    set claimed_by = %s,
                        claimed_until = now() + make_interval(secs => %s),
                        updated_at = now()
                    from candidate c
                    where r.task_id = c.task_id
                    returning r.task_id
                    """,
                    (*params, capped_limit, reviewer_id, max(1, int(lock_seconds))),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return self.get_task(row["task_id"])

    def claim_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.reviews
                    set claimed_by = %s,
                        claimed_until = now() + make_interval(secs => %s),
                        updated_at = now()
                    where task_id = %s
                      and review_status = 'manual_required'
                      and (
                        claimed_by is null
                        or claimed_until is null
                        or claimed_until < now()
                        or claimed_by = %s
                      )
                    returning task_id
                    """,
                    (reviewer_id, max(1, int(lock_seconds)), task_id, reviewer_id),
                )
                ok = cur.fetchone() is not None
            conn.commit()
        return ok

    def take_over_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
        lock_seconds: int,
    ) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.reviews
                    set claimed_by = %s,
                        claimed_until = now() + make_interval(secs => %s),
                        updated_at = now()
                    where task_id = %s
                      and review_status = 'manual_required'
                    returning task_id
                    """,
                    (reviewer_id, max(1, int(lock_seconds)), task_id),
                )
                ok = cur.fetchone() is not None
            conn.commit()
        return ok

    def release_manual_review(
        self,
        reviewer_id: str,
        task_id: UUID,
    ) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.reviews
                    set claimed_by = null,
                        claimed_until = null,
                        updated_at = now()
                    where task_id = %s and claimed_by = %s
                    returning task_id
                    """,
                    (task_id, reviewer_id),
                )
                ok = cur.fetchone() is not None
            conn.commit()
        return ok

    def get_task(self, task_id: UUID) -> TaskWithReview | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select * from public.tasks where id = %s", (task_id,))
                task_row = cur.fetchone()
                if not task_row:
                    return None

                cur.execute(
                    "select * from public.artifacts where task_id = %s order by created_at desc",
                    (task_id,),
                )
                artifact_rows = cur.fetchall() or []

                cur.execute("select * from public.reviews where task_id = %s", (task_id,))
                review_row = cur.fetchone()

        task = self._task_from_row(task_row)
        artifacts = [self._artifact_from_row(row) for row in artifact_rows]
        review = self._review_from_row(review_row) if review_row else None
        return TaskWithReview(**task.model_dump(), artifacts=artifacts, review=review)

    def list_task_audit(self, task_id: UUID, limit: int = 50) -> list[OpsTaskAuditEntry]:
        capped_limit = max(1, min(limit, 200))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, task_id, actor, action, note, metadata, created_at
                    from public.ops_task_audit
                    where task_id = %s
                    order by created_at desc
                    limit %s
                    """,
                    (task_id, capped_limit),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            OpsTaskAuditEntry(
                id=row["id"],
                task_id=row["task_id"],
                actor=row["actor"],
                action=row["action"],
                note=row.get("note"),
                metadata=row.get("metadata") or {},
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def append_task_audit(
        self,
        task_id: UUID,
        actor: str,
        action: str,
        note: str | None = None,
        metadata: dict | None = None,
    ) -> OpsTaskAuditEntry | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select id from public.tasks where id = %s", (task_id,))
                if not cur.fetchone():
                    conn.commit()
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
                cur.execute(
                    """
                    insert into public.ops_task_audit
                    (id, task_id, actor, action, note, metadata, created_at)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        entry.id,
                        entry.task_id,
                        entry.actor,
                        entry.action,
                        entry.note,
                        Json(entry.metadata),
                        entry.created_at,
                    ),
                )
            conn.commit()
            return entry

    def set_review_verdict(self, task_id: UUID, verdict: str, note: str | None = None) -> Task | None:
        target_status = ReviewStatus.APPROVED.value if verdict == "approved" else ReviewStatus.REJECTED.value
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select * from public.tasks where id = %s", (task_id,))
                task_row = cur.fetchone()
                if not task_row:
                    conn.commit()
                    return None
                if verdict == "rejected" and task_row["status"] == TaskStatus.COMPLETED.value:
                    cur.execute(
                        "update public.tasks set status = 'disputed', updated_at = now() where id = %s returning *",
                        (task_id,),
                    )
                    task_row = cur.fetchone()
                cur.execute(
                    """
                    insert into public.reviews
                    (id, task_id, auto_check_provider, auto_check_model, auto_check_score, auto_check_reason, auto_check_redacted, review_status, manual_verdict, refund_flag, created_at, updated_at)
                    values (%s, %s, 'manual', null, 0.5, null, null, %s, %s, false, now(), now())
                    on conflict (task_id) do update
                    set auto_check_provider = 'manual',
                        auto_check_model = null,
                        auto_check_score = 0.5,
                        auto_check_reason = null,
                        auto_check_redacted = null,
                        review_status = excluded.review_status,
                        manual_verdict = excluded.manual_verdict,
                        claimed_by = null,
                        claimed_until = null,
                        updated_at = now()
                    """,
                    (uuid4(), task_id, target_status, note),
                )
            conn.commit()
            return self._task_from_row(task_row)

    def recheck_review(self, task_id: UUID) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select * from public.tasks where id = %s", (task_id,))
                task_row = cur.fetchone()
                if not task_row:
                    conn.commit()
                    return False
                if task_row["status"] not in ("completed", "disputed"):
                    conn.commit()
                    return False

                cur.execute(
                    """
                    select id, task_id, artifact_type, storage_path, checksum_sha256, metadata, created_at
                    from public.artifacts
                    where task_id = %s
                    order by created_at asc
                    """,
                    (task_id,),
                )
                artifact_rows = cur.fetchall() or []
                artifacts = [self._artifact_from_row(row) for row in artifact_rows]

                cur.execute("select * from public.reviews where task_id = %s", (task_id,))
                review_row = cur.fetchone()
                if review_row and review_row.get("review_status") in ("approved", "rejected"):
                    conn.commit()
                    return False

                task = self._task_from_row(task_row)
                review = build_review(task, artifacts, worker_note=None)
                provider = str(getattr(review, "auto_check_provider", "heuristic"))
                model = getattr(review, "auto_check_model", None)
                reason = getattr(review, "auto_check_reason", None)
                redacted = getattr(review, "auto_check_redacted", None)
                status_val = self._enum_or_str(review.review_status)

                if review_row:
                    cur.execute(
                        """
                        update public.reviews
                        set auto_check_provider = %s,
                            auto_check_model = %s,
                            auto_check_score = %s,
                            auto_check_reason = %s,
                            auto_check_redacted = %s,
                            review_status = %s,
                            manual_verdict = null,
                            claimed_by = null,
                            claimed_until = null,
                            updated_at = now()
                        where task_id = %s
                        """,
                        (provider, model, review.auto_check_score, reason, redacted, status_val, task_id),
                    )
                    ok = cur.rowcount > 0
                else:
                    cur.execute(
                        """
                        insert into public.reviews
                        (id, task_id, auto_check_provider, auto_check_model, auto_check_score, auto_check_reason, auto_check_redacted, review_status, manual_verdict, refund_flag, created_at, updated_at)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, null, false, now(), now())
                        """,
                        (uuid4(), task_id, provider, model, review.auto_check_score, reason, redacted, status_val),
                    )
                    ok = True
            conn.commit()
            return ok

    def reassign_task(self, task_id: UUID, worker_id: UUID) -> Task | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.tasks
                    set worker_id = %s,
                        status = case when status = 'queued' then 'claimed' else status end,
                        updated_at = now()
                    where id = %s
                    returning *
                    """,
                    (worker_id, task_id),
                )
                row = cur.fetchone()
            conn.commit()
            return self._task_from_row(row) if row else None

    def force_task_status(self, task_id: UUID, status: str) -> Task | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.tasks
                    set status = %s::task_status,
                        completed_at = case
                            when %s::task_status in ('completed', 'failed', 'refunded', 'disputed')
                            then coalesce(completed_at, now())
                            else completed_at
                        end,
                        updated_at = now()
                    where id = %s
                    returning *
                    """,
                    (status, status, task_id),
                )
                row = cur.fetchone()
            conn.commit()
            return self._task_from_row(row) if row else None

    def list_incidents(self, status: str | None = None, limit: int = 50) -> list[OpsIncident]:
        capped_limit = max(1, min(limit, 200))
        filters = ""
        params: tuple[object, ...]
        if status:
            filters = "where status = %s"
            params = (status, capped_limit)
        else:
            params = (capped_limit,)
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select *
                    from public.ops_incidents
                    {filters}
                    order by updated_at desc
                    limit %s
                    """,
                    params,
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [self._incident_from_row(row) for row in rows]

    def create_incident(self, payload: CreateOpsIncidentRequest) -> OpsIncident:
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
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.ops_incidents
                    (id, incident_type, severity, status, title, description, owner, source, postmortem, metadata, created_at, updated_at, resolved_at)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        incident.id,
                        incident.incident_type,
                        incident.severity,
                        incident.status,
                        incident.title,
                        incident.description,
                        incident.owner,
                        incident.source,
                        incident.postmortem,
                        Json(incident.metadata),
                        incident.created_at,
                        incident.updated_at,
                        incident.resolved_at,
                    ),
                )
                cur.execute(
                    """
                    insert into public.ops_incident_events
                    (id, incident_id, actor, action, note, metadata, created_at)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        uuid4(),
                        incident.id,
                        "system",
                        "incident_created",
                        incident.description,
                        Json({"source": incident.source, "severity": incident.severity}),
                        incident.created_at,
                    ),
                )
            conn.commit()
        return incident

    def update_incident(self, incident_id: UUID, payload: UpdateOpsIncidentRequest) -> OpsIncident | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select * from public.ops_incidents where id = %s", (incident_id,))
                row = cur.fetchone()
                if not row:
                    conn.commit()
                    return None
                incident = self._incident_from_row(row)
                if payload.status:
                    incident.status = payload.status
                    if payload.status == "resolved":
                        incident.resolved_at = utcnow()
                    else:
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
                cur.execute(
                    """
                    update public.ops_incidents
                    set status = %s,
                        owner = %s,
                        postmortem = %s,
                        metadata = %s,
                        resolved_at = %s,
                        updated_at = %s
                    where id = %s
                    returning *
                    """,
                    (
                        incident.status,
                        incident.owner,
                        incident.postmortem,
                        Json(incident.metadata),
                        incident.resolved_at,
                        incident.updated_at,
                        incident_id,
                    ),
                )
                updated = cur.fetchone()
                if updated:
                    cur.execute(
                        """
                        insert into public.ops_incident_events
                        (id, incident_id, actor, action, note, metadata, created_at)
                        values (%s, %s, %s, %s, %s, %s, now())
                        """,
                        (
                            uuid4(),
                            incident_id,
                            "ops_admin",
                            "incident_updated",
                            payload.note,
                            Json(
                                {
                                    "status": payload.status,
                                    "owner": payload.owner,
                                    "postmortem_updated": payload.postmortem is not None,
                                }
                            ),
                        ),
                    )
            conn.commit()
            return self._incident_from_row(updated) if updated else None

    def list_incident_events(self, incident_id: UUID, limit: int = 100) -> list[OpsIncidentEvent]:
        capped_limit = max(1, min(limit, 300))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, incident_id, actor, action, note, metadata, created_at
                    from public.ops_incident_events
                    where incident_id = %s
                    order by created_at desc
                    limit %s
                    """,
                    (incident_id, capped_limit),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            OpsIncidentEvent(
                id=row["id"],
                incident_id=row["incident_id"],
                actor=row["actor"],
                action=row["action"],
                note=row.get("note"),
                metadata=row.get("metadata") or {},
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def claim_task(self, task_id: UUID, worker_id: UUID) -> Task | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.tasks
                    set status = 'claimed', worker_id = %s, claimed_at = %s, updated_at = %s
                    where id = %s and status = 'queued'
                    returning *
                    """,
                    (worker_id, utcnow(), utcnow(), task_id),
                )
                row = cur.fetchone()
            conn.commit()
            if not row:
                return None
            return self._task_from_row(row)

    def complete_task(self, task_id: UUID, result: dict, worker_note: str | None) -> Task | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.tasks
                    set status = 'completed', result = %s, completed_at = %s, updated_at = %s
                    where id = %s and status in ('queued', 'claimed')
                    returning *
                    """,
                    (Json(result), utcnow(), utcnow(), task_id),
                )
                task_row = cur.fetchone()
                if not task_row:
                    conn.commit()
                    return None

                task = self._task_from_row(task_row)
                cur.execute(
                    """
                    select id, task_id, artifact_type, storage_path, checksum_sha256, metadata, created_at
                    from public.artifacts
                    where task_id = %s
                    order by created_at asc
                    """,
                    (task_id,),
                )
                artifact_rows = cur.fetchall() or []
                artifacts = [
                    Artifact(
                        id=row["id"],
                        task_id=row["task_id"],
                        artifact_type=row["artifact_type"],
                        storage_path=row["storage_path"],
                        checksum_sha256=row["checksum_sha256"],
                        metadata=row["metadata"] or {},
                        created_at=row["created_at"],
                    )
                    for row in artifact_rows
                ]
                review = build_review(task, artifacts, worker_note)
                cur.execute(
                    """
                    insert into public.reviews
                    (id, task_id, auto_check_provider, auto_check_model, auto_check_score, auto_check_reason, auto_check_redacted, review_status, manual_verdict, refund_flag, created_at, updated_at)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    on conflict (task_id) do update
                    set auto_check_provider = excluded.auto_check_provider,
                        auto_check_model = excluded.auto_check_model,
                        auto_check_score = excluded.auto_check_score,
                        auto_check_reason = excluded.auto_check_reason,
                        auto_check_redacted = excluded.auto_check_redacted,
                        review_status = excluded.review_status,
                        manual_verdict = excluded.manual_verdict,
                        refund_flag = excluded.refund_flag,
                        updated_at = excluded.updated_at
                    """,
                    (
                        review.id,
                        review.task_id,
                        str(getattr(review, "auto_check_provider", "heuristic")),
                        getattr(review, "auto_check_model", None),
                        review.auto_check_score,
                        getattr(review, "auto_check_reason", None),
                        getattr(review, "auto_check_redacted", None),
                        self._enum_or_str(review.review_status),
                        review.manual_verdict,
                        review.refund_flag,
                        review.created_at,
                        review.created_at,
                    ),
                )
            conn.commit()
            return task

    def add_artifact(self, task_id: UUID, payload: CreateArtifactRequest) -> Artifact | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("select id from public.tasks where id = %s", (task_id,))
                if not cur.fetchone():
                    conn.commit()
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
                cur.execute(
                    """
                    insert into public.artifacts
                    (id, task_id, artifact_type, storage_path, checksum_sha256, metadata, created_at)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        artifact.id,
                        artifact.task_id,
                        self._enum_or_str(artifact.artifact_type),
                        artifact.storage_path,
                        artifact.checksum_sha256,
                        Json(artifact.metadata),
                        artifact.created_at,
                    ),
                )
            conn.commit()
            return artifact

    def enqueue_task_webhook(self, task: Task, max_attempts: int) -> None:
        if not task.callback_url:
            return
        event = TaskUpdatedEvent(
            event_id=uuid4(),
            event_type="task.updated",
            created_at=utcnow(),
            task=task,
        )
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.webhook_jobs
                    (id, task_id, callback_url, event_type, payload, idempotency_key, attempts, max_attempts, next_attempt_at, status, created_at, updated_at)
                    values (%s, %s, %s, %s, %s, %s, 0, %s, %s, 'pending', %s, %s)
                    """,
                    (
                        uuid4(),
                        task.id,
                        task.callback_url,
                        event.event_type,
                        Json(event.model_dump(mode="json")),
                        str(uuid4()),
                        max_attempts,
                        utcnow(),
                        utcnow(),
                        utcnow(),
                    ),
                )
            conn.commit()

    def claim_due_webhook_job(self) -> WebhookJob | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    with due as (
                        select id
                        from public.webhook_jobs
                        where (
                            status = 'pending'
                            or (status = 'processing' and updated_at < now() - interval '5 minutes')
                        )
                          and next_attempt_at <= now()
                          and attempts < max_attempts
                        order by next_attempt_at asc
                        for update skip locked
                        limit 1
                    )
                    update public.webhook_jobs j
                    set status = 'processing',
                        attempts = attempts + 1,
                        updated_at = now()
                    from due
                    where j.id = due.id
                    returning j.*
                    """
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return WebhookJob(
            id=row["id"],
            task_id=row["task_id"],
            callback_url=row["callback_url"],
            event_type=row["event_type"],
            payload=row["payload"] or {},
            idempotency_key=row["idempotency_key"],
            attempts=int(row["attempts"]),
            max_attempts=int(row["max_attempts"]),
            next_attempt_at=row["next_attempt_at"],
            created_at=row["created_at"],
        )

    def mark_webhook_job_success(self, job_id: UUID) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.webhook_jobs
                    set status = 'succeeded', updated_at = now()
                    where id = %s
                    """,
                    (job_id,),
                )
            conn.commit()

    def mark_webhook_job_retry(
        self,
        job_id: UUID,
        status_code: int | None,
        error: str | None,
        next_attempt_at,
    ) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.webhook_jobs
                    set status = 'pending',
                        next_attempt_at = %s,
                        last_status_code = %s,
                        last_error = %s,
                        updated_at = now()
                    where id = %s
                    """,
                    (next_attempt_at, status_code, error, job_id),
                )
            conn.commit()

    def mark_webhook_job_failed(self, job_id: UUID, status_code: int | None, error: str | None) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    with failed as (
                        update public.webhook_jobs
                        set status = 'failed',
                            last_status_code = %s,
                            last_error = %s,
                            updated_at = now()
                        where id = %s
                        returning *
                    )
                    insert into public.webhook_dead_letters
                    (id, webhook_job_id, task_id, callback_url, payload, error, status_code, created_at, requeued_at)
                    select %s, failed.id, failed.task_id, failed.callback_url, failed.payload, %s, %s, now(), null
                    from failed
                    """,
                    (status_code, error, job_id, uuid4(), error, status_code),
                )
            conn.commit()

    def requeue_dead_letter(self, dead_letter_id: UUID, max_attempts: int) -> bool:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select *
                    from public.webhook_dead_letters
                    where id = %s and requeued_at is null
                    for update
                    """,
                    (dead_letter_id,),
                )
                dlq_row = cur.fetchone()
                if not dlq_row:
                    conn.commit()
                    return False

                cur.execute(
                    """
                    insert into public.webhook_jobs
                    (id, task_id, callback_url, event_type, payload, idempotency_key, attempts, max_attempts, next_attempt_at, status, created_at, updated_at)
                    values (%s, %s, %s, %s, %s, %s, 0, %s, now(), 'pending', now(), now())
                    """,
                    (
                        uuid4(),
                        dlq_row["task_id"],
                        dlq_row["callback_url"],
                        (dlq_row["payload"] or {}).get("event_type", "task.updated"),
                        Json(dlq_row["payload"] or {}),
                        str(uuid4()),
                        max_attempts,
                    ),
                )
                cur.execute(
                    """
                    update public.webhook_dead_letters
                    set requeued_at = now()
                    where id = %s
                    """,
                    (dead_letter_id,),
                )
            conn.commit()
            return True

    def get_ops_metrics(self) -> OpsMetricsResponse:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select
                      count(*) filter (where status = 'pending') as queue_pending,
                      count(*) filter (where status = 'processing') as queue_processing,
                      count(*) as queue_total
                    from public.webhook_jobs
                    where status in ('pending', 'processing')
                    """
                )
                queue = cur.fetchone() or {"queue_pending": 0, "queue_processing": 0, "queue_total": 0}

                cur.execute(
                    """
                    select
                      count(*) as delivery_total,
                      count(*) filter (where success = true) as success_total,
                      count(*) filter (where attempt_no > 1) as retry_total
                    from public.webhook_deliveries
                    """
                )
                deliveries = cur.fetchone() or {"delivery_total": 0, "success_total": 0, "retry_total": 0}

                cur.execute("select count(*) as dlq_count from public.webhook_dead_letters")
                dlq_row = cur.fetchone() or {"dlq_count": 0}

                cur.execute("select count(*) as manual_review_pending from public.reviews where review_status = 'manual_required'")
                manual_row = cur.fetchone() or {"manual_review_pending": 0}

                cur.execute(
                    """
                    select
                      count(*) filter (where status in ('queued', 'claimed')) as active_tasks,
                      count(*) filter (where status in ('queued', 'claimed') and sla_deadline <= now()) as tasks_overdue,
                      count(*) filter (
                        where status in ('queued', 'claimed')
                          and sla_deadline > now()
                          and sla_deadline <= now() + interval '2 minutes'
                      ) as tasks_sla_risk
                    from public.tasks
                    """
                )
                task_health = cur.fetchone() or {"active_tasks": 0, "tasks_overdue": 0, "tasks_sla_risk": 0}

                cur.execute(
                    """
                    select status::text as status, count(*)::int as count
                    from public.tasks
                    group by status
                    """
                )
                status_rows = cur.fetchall() or []

                cur.execute(
                    """
                    select percentile_cont(0.95) within group (
                        order by extract(epoch from (coalesce(completed_at, updated_at) - created_at))
                    ) as p95
                    from public.tasks
                    where status in ('completed', 'refunded')
                    """
                )
                p95_row = cur.fetchone() or {"p95": None}
            conn.commit()

        delivery_total = int(deliveries["delivery_total"] or 0)
        success_total = int(deliveries["success_total"] or 0)
        retry_total = int(deliveries["retry_total"] or 0)
        status_counts = {str(row["status"]): int(row["count"]) for row in status_rows}

        return OpsMetricsResponse(
            queue_pending=int(queue["queue_pending"] or 0),
            queue_processing=int(queue["queue_processing"] or 0),
            queue_total=int(queue["queue_total"] or 0),
            webhook_delivery_total=delivery_total,
            webhook_delivery_success_rate=round((success_total / delivery_total), 4) if delivery_total else 1.0,
            webhook_retry_rate=round((retry_total / delivery_total), 4) if delivery_total else 0.0,
            webhook_dlq_count=int(dlq_row["dlq_count"] or 0),
            manual_review_pending=int(manual_row["manual_review_pending"] or 0),
            task_resolution_p95_seconds=float(p95_row["p95"]) if p95_row["p95"] is not None else None,
            active_tasks=int(task_health["active_tasks"] or 0),
            tasks_sla_risk=int(task_health["tasks_sla_risk"] or 0),
            tasks_overdue=int(task_health["tasks_overdue"] or 0),
            task_status_counts=status_counts,
        )

    def record_ops_metrics_sample(self, metrics: OpsMetricsResponse, min_interval_seconds: int = 60) -> bool:
        now = utcnow()
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select at
                    from public.ops_metrics_history
                    order by at desc
                    limit 1
                    """
                )
                row = cur.fetchone()
                if row:
                    last_at = row["at"]
                    if last_at and (now - last_at).total_seconds() < min_interval_seconds:
                        conn.commit()
                        return False
                cur.execute(
                    """
                    insert into public.ops_metrics_history (
                      at,
                      tasks_overdue,
                      tasks_sla_risk,
                      webhook_dlq_count,
                      webhook_retry_rate
                    )
                    values (%s, %s, %s, %s, %s)
                    """,
                    (
                        now,
                        metrics.tasks_overdue,
                        metrics.tasks_sla_risk,
                        metrics.webhook_dlq_count,
                        metrics.webhook_retry_rate,
                    ),
                )
            conn.commit()
        return True

    def get_ops_metrics_history(self, limit: int = 48) -> list[OpsMetricsHistoryPoint]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select at, tasks_overdue, tasks_sla_risk, webhook_dlq_count, webhook_retry_rate
                    from public.ops_metrics_history
                    order by at desc
                    limit %s
                    """,
                    (capped_limit,),
                )
                rows = cur.fetchall() or []
            conn.commit()
        rows.reverse()
        return [
            OpsMetricsHistoryPoint(
                at=row["at"],
                tasks_overdue=int(row["tasks_overdue"] or 0),
                tasks_sla_risk=int(row["tasks_sla_risk"] or 0),
                webhook_dlq_count=int(row["webhook_dlq_count"] or 0),
                webhook_retry_rate=float(row["webhook_retry_rate"] or 0.0),
            )
            for row in rows
        ]

    def list_webhook_dead_letters(self, limit: int = 50) -> list[WebhookDeadLetter]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, webhook_job_id, task_id, callback_url, payload, error, status_code, created_at, requeued_at
                    from public.webhook_dead_letters
                    order by created_at desc
                    limit %s
                    """,
                    (capped_limit,),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            WebhookDeadLetter(
                id=row["id"],
                webhook_job_id=row["webhook_job_id"],
                task_id=row["task_id"],
                callback_url=row["callback_url"],
                payload=row["payload"] or {},
                error=row.get("error"),
                status_code=row.get("status_code"),
                created_at=row["created_at"],
                requeued_at=row.get("requeued_at"),
            )
            for row in rows
        ]

    def list_ledger_entries(self, limit: int = 100, account_id: UUID | None = None) -> list[LedgerEntry]:
        capped_limit = max(1, min(limit, 1000))
        with self._conn() as conn:
            with conn.cursor() as cur:
                if account_id:
                    cur.execute(
                        """
                        select id, account_id, task_id, entry_type, amount_usd, currency, external_ref, meta, created_at
                        from public.ledger
                        where account_id = %s
                        order by created_at desc
                        limit %s
                        """,
                        (account_id, capped_limit),
                    )
                else:
                    cur.execute(
                        """
                        select id, account_id, task_id, entry_type, amount_usd, currency, external_ref, meta, created_at
                        from public.ledger
                        order by created_at desc
                        limit %s
                        """,
                        (capped_limit,),
                    )
                rows = cur.fetchall() or []
            conn.commit()
        return [
            LedgerEntry(
                id=row["id"],
                account_id=row.get("account_id"),
                task_id=row.get("task_id"),
                entry_type=row["entry_type"],
                amount_usd=float(row["amount_usd"]),
                currency=row.get("currency") or "USD",
                external_ref=row.get("external_ref"),
                meta=row.get("meta") or {},
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def get_margin_summary(self) -> OpsMarginSummary:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select
                      coalesce(sum(case when entry_type = 'package_purchase' then amount_usd else 0 end), 0) as package_amount,
                      coalesce(sum(case when entry_type = 'package_purchase' then (meta->>'flow_delta')::int else 0 end), 0) as purchased_flows,
                      coalesce(sum(case when entry_type = 'task_charge' and (meta->>'flow_delta')::int < 0 then 1 else 0 end), 0) as used_flows,
                      coalesce(sum(case when entry_type = 'refund' then 1 else 0 end), 0) as refunds
                    from public.ledger
                    """
                )
                row = cur.fetchone() or {"package_amount": 0, "purchased_flows": 0, "used_flows": 0, "refunds": 0}
            conn.commit()
        package_amount = float(row["package_amount"] or 0.0)
        purchased_flows = int(row["purchased_flows"] or 0)
        used_flows = int(row["used_flows"] or 0)
        refunds = int(row["refunds"] or 0)
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
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.webhook_deliveries
                    (id, task_id, callback_url, status_code, attempt_no, success, error, created_at)
                    values (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (uuid4(), task_id, callback_url, status_code, attempt, success, error, utcnow()),
                )
            conn.commit()

    def list_webhook_deliveries(self, task_id: UUID, limit: int = 50) -> list[WebhookDelivery]:
        limit = max(1, min(int(limit or 50), 300))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select id, task_id, callback_url, status_code, attempt_no, success, error, created_at
                    from public.webhook_deliveries
                    where task_id = %s
                    order by created_at desc
                    limit %s
                    """,
                    (task_id, limit),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [WebhookDelivery(**row) for row in rows]

    def get_openai_interruption(self, interruption_id: str) -> OpenAIInterruptionRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                           decision, decision_actor, decision_note, decision_output, context_capsule,
                           metadata, state_blob, created_at, decided_at, resumed_at
                    from public.openai_interruptions
                    where interruption_id = %s
                    """,
                    (interruption_id,),
                )
                row = cur.fetchone()
            conn.commit()
        return self._openai_interruption_from_row(row) if row else None

    def create_openai_interruption(
        self,
        payload: OpenAIInterruptionIngestRequest,
        task_id: UUID,
        context_capsule: dict,
    ) -> OpenAIInterruptionRecord:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.openai_interruptions
                    (interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                     decision_output, context_capsule, metadata, state_blob, created_at)
                    values (%s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s, %s, %s)
                    on conflict (interruption_id) do nothing
                    """,
                    (
                        payload.interruption_id,
                        payload.run_id,
                        payload.thread_id,
                        payload.agent_name,
                        payload.tool_name,
                        task_id,
                        Json({}),
                        Json(context_capsule),
                        Json(payload.metadata),
                        payload.state_blob,
                        utcnow(),
                    ),
                )
                cur.execute(
                    """
                    select interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                           decision, decision_actor, decision_note, decision_output, context_capsule,
                           metadata, state_blob, created_at, decided_at, resumed_at
                    from public.openai_interruptions
                    where interruption_id = %s
                    """,
                    (payload.interruption_id,),
                )
                row = cur.fetchone()
            conn.commit()
        return self._openai_interruption_from_row(row)

    def decide_openai_interruption(
        self,
        interruption_id: str,
        payload: OpenAIInterruptionDecisionRequest,
    ) -> OpenAIInterruptionRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.openai_interruptions
                    set status = 'decided',
                        decision = %s,
                        decision_actor = %s,
                        decision_note = %s,
                        decision_output = %s,
                        decided_at = now()
                    where interruption_id = %s
                    returning interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                              decision, decision_actor, decision_note, decision_output, context_capsule,
                              metadata, state_blob, created_at, decided_at, resumed_at
                    """,
                    (
                        payload.decision,
                        payload.actor,
                        payload.note,
                        Json(payload.output),
                        interruption_id,
                    ),
                )
                row = cur.fetchone()
            conn.commit()
        return self._openai_interruption_from_row(row) if row else None

    def mark_openai_interruption_resumed(self, interruption_id: str) -> OpenAIResumeResponse | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.openai_interruptions
                    set status = 'resumed',
                        resumed_at = now()
                    where interruption_id = %s and status = 'decided'
                    returning interruption_id, run_id, thread_id, decision, decision_output, decision_note, state_blob, resumed_at
                    """,
                    (interruption_id,),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return OpenAIResumeResponse(
            interruption_id=row["interruption_id"],
            run_id=row["run_id"],
            resume_enqueued=True,
            resumed_at=row["resumed_at"],
            resume_payload={
                "run_id": row["run_id"],
                "thread_id": row.get("thread_id"),
                "interruption_id": row["interruption_id"],
                "decision": row.get("decision"),
                "output": row.get("decision_output") or {},
                "note": row.get("decision_note"),
                "state_blob": row.get("state_blob"),
            },
        )

    def list_openai_interruptions_by_status(self, status: str, limit: int = 100) -> list[OpenAIInterruptionRecord]:
        capped_limit = max(1, min(limit, 500))
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                           decision, decision_actor, decision_note, decision_output, context_capsule,
                           metadata, state_blob, created_at, decided_at, resumed_at
                    from public.openai_interruptions
                    where status = %s
                    order by created_at asc
                    limit %s
                    """,
                    (status, capped_limit),
                )
                rows = cur.fetchall() or []
            conn.commit()
        return [self._openai_interruption_from_row(row) for row in rows]

    def mark_openai_interruption_failed(self, interruption_id: str, note: str | None = None) -> OpenAIInterruptionRecord | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.openai_interruptions
                    set status = 'failed',
                        decision_note = coalesce(%s, decision_note)
                    where interruption_id = %s
                    returning interruption_id, run_id, thread_id, agent_name, tool_name, task_id, status,
                              decision, decision_actor, decision_note, decision_output, context_capsule,
                              metadata, state_blob, created_at, decided_at, resumed_at
                    """,
                    (note, interruption_id),
                )
                row = cur.fetchone()
            conn.commit()
        return self._openai_interruption_from_row(row) if row else None

    def refund_task(self, task_id: UUID, reason: str | None = None) -> Task | None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.tasks
                    set status = 'refunded', updated_at = %s
                    where id = %s and status in ('completed', 'disputed')
                    returning *
                    """,
                    (utcnow(), task_id),
                )
                task_row = cur.fetchone()
                if not task_row:
                    raise RefundNotAllowedError("Task must be completed or disputed for refund")
                account_id = task_row["account_id"]
                cur.execute(
                    """
                    update public.accounts
                    set flow_credits = flow_credits + 1
                    where id = %s
                    """,
                    (account_id,),
                )
                cur.execute(
                    """
                    insert into public.ledger (account_id, task_id, entry_type, amount_usd, meta)
                    values (%s, %s, 'refund', 0, %s)
                    """,
                    (account_id, task_id, Json({"flow_delta": 1, "reason": reason})),
                )
            conn.commit()
            return self._task_from_row(task_row)

    @staticmethod
    def _task_from_row(row: dict) -> Task:
        return Task(
            id=row["id"],
            account_id=row["account_id"],
            worker_id=row.get("worker_id"),
            task_type=TaskType(row["task_type"]),
            status=TaskStatus(row["status"]),
            context=row["context"] or {},
            result=row.get("result"),
            max_price_usd=float(row["max_price_usd"]),
            callback_url=row.get("callback_url"),
            sla_seconds=int(row["sla_seconds"]),
            sla_deadline=row["sla_deadline"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _artifact_from_row(row: dict) -> Artifact:
        return Artifact(
            id=row["id"],
            task_id=row["task_id"],
            artifact_type=ArtifactType(row["artifact_type"]),
            storage_path=row["storage_path"],
            checksum_sha256=row.get("checksum_sha256"),
            metadata=row.get("metadata") or {},
            created_at=row["created_at"],
        )

    @staticmethod
    def _review_from_row(row: dict):
        from app.models import Review
        from app.domain.enums import ReviewStatus

        return Review(
            id=row["id"],
            task_id=row["task_id"],
            auto_check_provider=str(row.get("auto_check_provider") or "heuristic"),
            auto_check_model=row.get("auto_check_model"),
            auto_check_score=float(row["auto_check_score"]),
            auto_check_reason=row.get("auto_check_reason"),
            auto_check_redacted=(
                bool(row.get("auto_check_redacted")) if row.get("auto_check_redacted") is not None else None
            ),
            review_status=ReviewStatus(row["review_status"]),
            manual_verdict=row.get("manual_verdict"),
            refund_flag=bool(row.get("refund_flag", False)),
            claimed_by=row.get("claimed_by"),
            claimed_until=row.get("claimed_until"),
            created_at=row["created_at"],
        )

    @staticmethod
    def _incident_from_row(row: dict) -> OpsIncident:
        return OpsIncident(
            id=row["id"],
            incident_type=row["incident_type"],
            severity=row["severity"],
            status=row["status"],
            title=row["title"],
            description=row.get("description"),
            owner=row.get("owner"),
            source=row.get("source", "manual"),
            postmortem=row.get("postmortem"),
            metadata=row.get("metadata") or {},
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            resolved_at=row.get("resolved_at"),
        )

    @staticmethod
    def _openai_interruption_from_row(row: dict) -> OpenAIInterruptionRecord:
        return OpenAIInterruptionRecord(
            interruption_id=row["interruption_id"],
            run_id=row["run_id"],
            thread_id=row.get("thread_id"),
            agent_name=row.get("agent_name"),
            tool_name=row["tool_name"],
            task_id=row["task_id"],
            status=row["status"],
            decision=row.get("decision"),
            decision_actor=row.get("decision_actor"),
            decision_note=row.get("decision_note"),
            decision_output=row.get("decision_output") or {},
            context_capsule=row.get("context_capsule") or {},
            metadata=row.get("metadata") or {},
            state_blob=row["state_blob"],
            created_at=row["created_at"],
            decided_at=row.get("decided_at"),
            resumed_at=row.get("resumed_at"),
        )

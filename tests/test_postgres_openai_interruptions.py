import os
from pathlib import Path
from uuid import uuid4

import pytest


@pytest.mark.postgres
def test_postgres_openai_interruption_lifecycle() -> None:
    psycopg = pytest.importorskip("psycopg")

    from app.models import (
        CreateTaskRequest,
        OpenAIInterruptionDecisionRequest,
        OpenAIInterruptionIngestRequest,
        PackagePurchaseRequest,
    )
    from app.repositories.postgres import PostgresRepository

    dsn = os.getenv("SHIMLAYER_DB_DSN", "postgresql://shim:shim@localhost:5432/shimlayer")
    schema_path = Path(__file__).resolve().parents[1] / "docs" / "supabase-schema-v0.sql"

    with psycopg.connect(dsn) as conn:
        conn.execute(schema_path.read_text(encoding="utf-8"))
        conn.execute(
            """
            truncate table
              public.openai_interruptions,
              public.webhook_deliveries,
              public.webhook_dead_letters,
              public.webhook_jobs
            restart identity
            """
        )
        conn.commit()

    repo = PostgresRepository(dsn)
    api_key = f"pg-openai-{uuid4()}"
    repo.purchase_package(
        api_key,
        PackagePurchaseRequest(package_code="indie_entry_150", reference=f"inv-{uuid4()}"),
    )
    task = repo.create_task(
        api_key,
        CreateTaskRequest(
            task_type="quick_judgment",
            context={"question": "approve?"},
            sla_seconds=60,
            callback_url="https://example.com/resume",
        ),
    )

    ingest = OpenAIInterruptionIngestRequest(
        run_id="run_1",
        thread_id="thread_1",
        interruption_id="intr_1",
        agent_name="agent",
        tool_name="sendEmail",
        tool_arguments={"subject": "hello"},
        state_blob='{"state":"blob"}',
        metadata={"tenant": "demo"},
        sla_seconds=60,
    )
    created = repo.create_openai_interruption(
        ingest,
        task.id,
        context_capsule={"question": "approve send?", "options": ["approve", "reject"]},
    )
    assert created.status == "pending"
    assert created.task_id == task.id

    fetched = repo.get_openai_interruption("intr_1")
    assert fetched is not None
    assert fetched.status == "pending"

    decided = repo.decide_openai_interruption(
        "intr_1",
        OpenAIInterruptionDecisionRequest(
            decision="approve",
            actor="ops-test",
            note="safe",
            output={"choice": "approve"},
        ),
    )
    assert decided is not None
    assert decided.status == "decided"
    assert decided.decision == "approve"

    listed = repo.list_openai_interruptions_by_status("decided", limit=10)
    assert any(item.interruption_id == "intr_1" for item in listed)

    resumed = repo.mark_openai_interruption_resumed("intr_1")
    assert resumed is not None
    assert resumed.resume_enqueued is True
    assert resumed.resume_payload["decision"] == "approve"


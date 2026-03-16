from datetime import timedelta
import os
from pathlib import Path
from uuid import uuid4

import pytest


@pytest.mark.postgres
def test_postgres_webhook_queue_lifecycle() -> None:
    psycopg = pytest.importorskip("psycopg")

    from app.models import CreateTaskRequest, PackagePurchaseRequest, utcnow
    from app.repositories.postgres import PostgresRepository

    dsn = os.getenv("SHIMLAYER_DB_DSN", "postgresql://shim:shim@localhost:5432/shimlayer")
    schema_path = Path(__file__).resolve().parents[1] / "docs" / "supabase-schema-v0.sql"

    with psycopg.connect(dsn) as conn:
        conn.execute(schema_path.read_text(encoding="utf-8"))
        conn.execute(
            """
            truncate table
              public.webhook_deliveries,
              public.webhook_dead_letters,
              public.webhook_jobs
            restart identity
            """
        )
        conn.commit()

    repo = PostgresRepository(dsn)
    api_key = f"pg-test-{uuid4()}"

    repo.purchase_package(
        api_key,
        PackagePurchaseRequest(package_code="indie_entry_150", reference=f"inv-{uuid4()}"),
    )
    task = repo.create_task(
        api_key,
        CreateTaskRequest(
            task_type="stuck_recovery",
            context={"logs": "loop"},
            sla_seconds=60,
            callback_url="https://example.com/hook",
        ),
    )
    repo.enqueue_task_webhook(task, max_attempts=2)

    claimed = repo.claim_due_webhook_job()
    assert claimed is not None
    assert claimed.task_id == task.id

    repo.mark_webhook_job_retry(
        claimed.id,
        status_code=500,
        error="server error",
        next_attempt_at=utcnow() - timedelta(seconds=1),
    )
    claimed_retry = repo.claim_due_webhook_job()
    assert claimed_retry is not None
    assert claimed_retry.id == claimed.id

    repo.mark_webhook_job_failed(claimed_retry.id, status_code=500, error="still failing")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id from public.webhook_dead_letters where task_id = %s order by created_at desc limit 1",
                (task.id,),
            )
            row = cur.fetchone()
            assert row is not None
            dead_letter_id = row[0]

    assert repo.requeue_dead_letter(dead_letter_id, max_attempts=2) is True
    assert repo.requeue_dead_letter(dead_letter_id, max_attempts=2) is False

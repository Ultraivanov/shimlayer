import psycopg

from app.config import get_settings
from app.services.artifact_storage import delete_local_artifact


def main() -> None:
    settings = get_settings()
    dsn = settings.shimlayer_db_dsn

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                delete from public.api_rate_windows
                where window_start < now() - (%s || ' hours')::interval
                """,
                (settings.shimlayer_retention_api_rate_windows_hours,),
            )
            api_rate_deleted = cur.rowcount
            cur.execute(
                """
                delete from public.operator_rate_windows
                where window_start < now() - (%s || ' hours')::interval
                """,
                (settings.shimlayer_retention_api_rate_windows_hours,),
            )
            operator_rate_deleted = cur.rowcount

            cur.execute(
                """
                delete from public.webhook_deliveries
                where created_at < now() - (%s || ' days')::interval
                """,
                (settings.shimlayer_retention_webhook_deliveries_days,),
            )
            deliveries_deleted = cur.rowcount

            cur.execute(
                """
                delete from public.webhook_jobs
                where status = 'succeeded'
                  and updated_at < now() - (%s || ' days')::interval
                """,
                (settings.shimlayer_retention_succeeded_jobs_days,),
            )
            succeeded_jobs_deleted = cur.rowcount

            cur.execute(
                """
                select storage_path
                from public.artifacts
                where created_at < now() - (%s || ' days')::interval
                  and storage_path like 'local:%'
                """,
                (settings.shimlayer_retention_artifacts_days,),
            )
            artifact_paths = [row[0] for row in cur.fetchall()]
            local_files_deleted = 0
            for storage_path in artifact_paths:
                if delete_local_artifact(base_dir=settings.shimlayer_artifacts_dir, storage_path=str(storage_path)):
                    local_files_deleted += 1

            cur.execute(
                """
                delete from public.artifacts
                where created_at < now() - (%s || ' days')::interval
                """,
                (settings.shimlayer_retention_artifacts_days,),
            )
            artifacts_deleted = cur.rowcount

        conn.commit()

    print(
        "Cleanup done:",
        {
            "api_rate_windows_deleted": api_rate_deleted,
            "operator_rate_windows_deleted": operator_rate_deleted,
            "webhook_deliveries_deleted": deliveries_deleted,
            "succeeded_webhook_jobs_deleted": succeeded_jobs_deleted,
            "artifact_local_files_deleted": local_files_deleted,
            "artifacts_deleted": artifacts_deleted,
        },
    )


if __name__ == "__main__":
    main()

import psycopg

from app.config import get_settings


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

        conn.commit()

    print(
        "Cleanup done:",
        {
            "api_rate_windows_deleted": api_rate_deleted,
            "webhook_deliveries_deleted": deliveries_deleted,
            "succeeded_webhook_jobs_deleted": succeeded_jobs_deleted,
        },
    )


if __name__ == "__main__":
    main()

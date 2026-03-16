from pathlib import Path
import time

import psycopg

from app.config import get_settings


def apply_schema(dsn: str, schema_path: Path, retries: int = 60, delay_seconds: float = 1.0) -> None:
    sql = schema_path.read_text(encoding="utf-8")
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with psycopg.connect(dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
                conn.commit()
            return
        except psycopg.OperationalError as exc:
            last_error = exc
            if attempt == retries:
                break
            time.sleep(delay_seconds)
    if last_error:
        raise last_error


def main() -> None:
    settings = get_settings()
    repo_root = Path(__file__).resolve().parents[2]
    schema_path = repo_root / "docs" / "supabase-schema-v0.sql"
    apply_schema(settings.shimlayer_db_dsn, schema_path)
    print(f"Applied schema from {schema_path}")


if __name__ == "__main__":
    main()

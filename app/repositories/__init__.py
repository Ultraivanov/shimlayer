from app.config import get_settings
from app.repositories.base import Repository
from app.repositories.in_memory import InMemoryRepository

_inmemory_repo = InMemoryRepository()
_postgres_repo: Repository | None = None


def get_repo() -> Repository:
    global _postgres_repo
    settings = get_settings()
    if settings.shimlayer_repository.lower() == "postgres":
        from app.repositories.postgres import PostgresRepository

        if _postgres_repo is None:
            _postgres_repo = PostgresRepository(settings.shimlayer_db_dsn)
        return _postgres_repo
    return _inmemory_repo

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    shimlayer_repository: str = "inmemory"
    shimlayer_db_dsn: str = "postgresql://shim:shim@localhost:5432/shimlayer"
    shimlayer_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    shimlayer_admin_api_key: str = "dev-admin-key"
    shimlayer_webhook_secret: str = "dev-webhook-secret"
    shimlayer_artifacts_dir: str = "./data/artifacts"
    shimlayer_webhook_timeout_seconds: float = 5.0
    shimlayer_webhook_max_attempts: int = 5
    shimlayer_webhook_timestamp_tolerance_seconds: int = 300
    shimlayer_manual_review_lock_seconds: int = 600
    shimlayer_retention_webhook_deliveries_days: int = 30
    shimlayer_retention_succeeded_jobs_days: int = 7
    shimlayer_retention_api_rate_windows_hours: int = 48
    shimlayer_retention_artifacts_days: int = 30
    shimlayer_stripe_secret_key: str | None = None
    shimlayer_stripe_publishable_key: str | None = None
    shimlayer_stripe_webhook_secret: str | None = None
    shimlayer_stripe_api_base: str = "https://api.stripe.com"
    shimlayer_auto_check_pass_threshold: float = 0.8
    shimlayer_auto_check_price_threshold_usd: float = 1.0
    shimlayer_auto_check_min_score_on_price_breach: float = 0.65
    shimlayer_auto_check_mode: str = "heuristic"  # heuristic | hybrid | openai
    shimlayer_openai_api_key: str | None = None
    shimlayer_openai_api_base: str = "https://api.openai.com/v1"
    shimlayer_auto_check_openai_model: str = "gpt-4o-mini"
    shimlayer_auto_check_openai_timeout_seconds: float = 4.0
    shimlayer_auto_check_redact_pii: bool = True
    shimlayer_auto_check_redact_max_string_length: int = 4000
    shimlayer_auto_check_openai_cache_enabled: bool = True
    shimlayer_auto_check_openai_cache_ttl_seconds: int = 600
    shimlayer_auto_check_openai_include_local_snippets: bool = False
    shimlayer_auto_check_openai_max_snippet_bytes: int = 2048
    shimlayer_auto_check_openai_max_snippet_lines: int = 60

    @property
    def security_warnings(self) -> list[str]:
        warnings: list[str] = []
        repo = self.shimlayer_repository.strip().lower()
        if repo not in {"inmemory", "postgres"}:
            warnings.append(f"Unknown SHIMLAYER_REPOSITORY value: {self.shimlayer_repository!r}")
        if self.shimlayer_admin_api_key.strip() in {"", "dev-admin-key"}:
            warnings.append("SHIMLAYER_ADMIN_API_KEY uses default/empty value.")
        if self.shimlayer_webhook_secret.strip() in {"", "dev-webhook-secret"}:
            warnings.append("SHIMLAYER_WEBHOOK_SECRET uses default/empty value.")
        if self.shimlayer_webhook_max_attempts < 1:
            warnings.append("SHIMLAYER_WEBHOOK_MAX_ATTEMPTS should be >= 1.")
        if self.shimlayer_webhook_timeout_seconds <= 0:
            warnings.append("SHIMLAYER_WEBHOOK_TIMEOUT_SECONDS should be > 0.")
        if not (0 <= self.shimlayer_auto_check_pass_threshold <= 1):
            warnings.append("SHIMLAYER_AUTO_CHECK_PASS_THRESHOLD should be between 0 and 1.")
        if self.shimlayer_auto_check_price_threshold_usd <= 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_PRICE_THRESHOLD_USD should be > 0.")
        if not (0 <= self.shimlayer_auto_check_min_score_on_price_breach <= 1):
            warnings.append("SHIMLAYER_AUTO_CHECK_MIN_SCORE_ON_PRICE_BREACH should be between 0 and 1.")
        if self.shimlayer_auto_check_mode.strip().lower() not in {"heuristic", "hybrid", "openai"}:
            warnings.append("SHIMLAYER_AUTO_CHECK_MODE should be one of: heuristic, hybrid, openai.")
        if self.shimlayer_openai_api_base.strip() == "":
            warnings.append("SHIMLAYER_OPENAI_API_BASE should be non-empty when OpenAI auto-check is enabled.")
        if self.shimlayer_auto_check_openai_timeout_seconds <= 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_OPENAI_TIMEOUT_SECONDS should be > 0.")
        if self.shimlayer_auto_check_redact_max_string_length <= 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_REDACT_MAX_STRING_LENGTH should be > 0.")
        if self.shimlayer_auto_check_openai_cache_ttl_seconds < 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_OPENAI_CACHE_TTL_SECONDS should be >= 0.")
        if self.shimlayer_auto_check_openai_max_snippet_bytes <= 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_OPENAI_MAX_SNIPPET_BYTES should be > 0.")
        if self.shimlayer_auto_check_openai_max_snippet_lines <= 0:
            warnings.append("SHIMLAYER_AUTO_CHECK_OPENAI_MAX_SNIPPET_LINES should be > 0.")
        if self.shimlayer_retention_webhook_deliveries_days < 1:
            warnings.append("SHIMLAYER_RETENTION_WEBHOOK_DELIVERIES_DAYS should be >= 1.")
        if self.shimlayer_retention_artifacts_days < 1:
            warnings.append("SHIMLAYER_RETENTION_ARTIFACTS_DAYS should be >= 1.")
        if repo == "postgres" and self.shimlayer_db_dsn.strip() == "":
            warnings.append("SHIMLAYER_DB_DSN is empty while SHIMLAYER_REPOSITORY=postgres.")
        return warnings


_settings = Settings()


def get_settings() -> Settings:
    return _settings

from datetime import timedelta
from time import sleep

from app.repositories.base import Repository
from app.repositories import get_repo
from app.webhooks.dispatcher import WebhookDispatcher, get_dispatcher
from app.config import get_settings


class WebhookWorker:
    def __init__(self, repo: Repository, dispatcher: WebhookDispatcher) -> None:
        self.repo = repo
        self.dispatcher = dispatcher
        self.settings = get_settings()

    def run_once(self, max_jobs: int = 50) -> int:
        processed = 0
        while processed < max_jobs:
            job = self.repo.claim_due_webhook_job()
            if not job:
                break
            result = self.dispatcher.send(job)
            self.repo.record_webhook_delivery(
                task_id=job.task_id,
                callback_url=job.callback_url,
                status_code=result.status_code,
                attempt=job.attempts,
                success=result.success,
                error=result.error,
            )

            if result.success:
                self.repo.mark_webhook_job_success(job.id)
            elif result.retryable and job.attempts < job.max_attempts:
                next_attempt_at = job.next_attempt_at + timedelta(seconds=2 ** (job.attempts - 1))
                self.repo.mark_webhook_job_retry(
                    job.id,
                    status_code=result.status_code,
                    error=result.error,
                    next_attempt_at=next_attempt_at,
                )
            else:
                self.repo.mark_webhook_job_failed(job.id, status_code=result.status_code, error=result.error)
            processed += 1
        return processed

    def run_forever(self, poll_interval_seconds: float = 1.0) -> None:
        while True:
            processed = self.run_once()
            if processed == 0:
                sleep(poll_interval_seconds)


def main() -> None:
    worker = WebhookWorker(get_repo(), get_dispatcher())
    worker.run_forever()


if __name__ == "__main__":
    main()

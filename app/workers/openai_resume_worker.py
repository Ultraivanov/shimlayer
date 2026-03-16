from dataclasses import dataclass
from time import sleep

import httpx

from app.repositories import get_repo
from app.repositories.base import Repository


@dataclass
class ResumeDispatchResult:
    success: bool
    status_code: int | None = None
    error: str | None = None


class OpenAIResumeDispatcher:
    def send(self, callback_url: str, payload: dict) -> ResumeDispatchResult:
        try:
            with httpx.Client(timeout=8.0) as client:
                response = client.post(callback_url, json=payload)
            if 200 <= response.status_code < 300:
                return ResumeDispatchResult(success=True, status_code=response.status_code)
            return ResumeDispatchResult(success=False, status_code=response.status_code, error=response.text[:500])
        except Exception as exc:
            return ResumeDispatchResult(success=False, error=str(exc))


class OpenAIResumeWorker:
    def __init__(self, repo: Repository, dispatcher: OpenAIResumeDispatcher) -> None:
        self.repo = repo
        self.dispatcher = dispatcher

    def run_once(self, max_items: int = 50) -> int:
        processed = 0
        items = self.repo.list_openai_interruptions_by_status("decided", limit=max_items)
        for item in items:
            task = self.repo.get_task(item.task_id)
            callback_url = task.callback_url if task else None
            if not callback_url:
                self.repo.mark_openai_interruption_failed(
                    item.interruption_id,
                    note="resume callback_url is missing on linked task",
                )
                processed += 1
                continue

            payload = {
                "run_id": item.run_id,
                "thread_id": item.thread_id,
                "interruption_id": item.interruption_id,
                "decision": item.decision,
                "output": item.decision_output,
                "note": item.decision_note,
                "state_blob": item.state_blob,
            }
            result = self.dispatcher.send(callback_url, payload)
            if result.success:
                self.repo.mark_openai_interruption_resumed(item.interruption_id)
            else:
                note = result.error or f"resume callback failed status={result.status_code}"
                self.repo.mark_openai_interruption_failed(item.interruption_id, note=note)
            processed += 1
        return processed

    def run_forever(self, poll_interval_seconds: float = 1.0) -> None:
        while True:
            processed = self.run_once()
            if processed == 0:
                sleep(poll_interval_seconds)


def main() -> None:
    worker = OpenAIResumeWorker(get_repo(), OpenAIResumeDispatcher())
    worker.run_forever()


if __name__ == "__main__":
    main()

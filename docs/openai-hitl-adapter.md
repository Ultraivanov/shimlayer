# OpenAI HITL Adapter (MVP)

This adapter maps OpenAI interruption events into ShimLayer tasks and back into a resumable payload.

## Endpoints

- `POST /v1/openai/interruptions/ingest`
  - Input: interruption payload (`run_id`, `interruption_id`, `tool_name`, `tool_arguments`, `state_blob`, etc.).
  - Behavior: composes a context capsule, creates a ShimLayer task, stores interruption linkage.
  - Output: `OpenAIInterruptionRecord`.

- `GET /v1/openai/interruptions/{interruption_id}`
  - Returns current interruption record and linkage to task.

- `POST /v1/openai/interruptions/{interruption_id}/decision`
  - Input: `approve|reject`, note, optional structured output.
  - Behavior: marks interruption as decided and completes linked task with decision result.

- `POST /v1/openai/interruptions/{interruption_id}/resume`
  - Behavior: marks interruption as resumed.
  - Output: resumable payload (`run_id`, `interruption_id`, `decision`, `state_blob`) to pass into external OpenAI run-resume worker.

## Resume worker

- Worker module: `app.workers.openai_resume_worker`
- Behavior:
  - polls interruptions in `decided` status,
  - builds resume payload,
  - sends payload to linked task `callback_url`,
  - marks interruption `resumed` on success or `failed` on dispatch error.
- Docker service: `openai-resume-worker` in `docker-compose.yml`.

## Notes

- Postgres mode stores interruption linkage/state in `public.openai_interruptions`.
- `context capsule` is currently rule-based and deterministic; it can be replaced by a dedicated composer agent later.

# Requester Hybrid Integration (Recommended)

ShimLayer supports a **hybrid delivery model**:

- **Push:** ShimLayer sends signed outbound webhooks to your `callback_url` on task updates.
- **Pull (fallback):** your Requester periodically syncs task updates from ShimLayer and/or polls a specific task by ID.

This hybrid approach gives fast UX (webhook) while staying reliable under outages, deploys, and transient networking issues (pull).

## 0) OpenAI interruptions (resume loop)

If you integrate ShimLayer as a HITL “resume” loop for agent interruptions:

- **Ingest:** `POST /v1/openai/interruptions/ingest` creates a backing ShimLayer task and returns the interruption record (including `task_id`).
- **Decide:** a human (typically Operator) records `approve|reject` via `POST /v1/openai/interruptions/{interruption_id}/decision`.
  - This also completes the backing task (so normal task push/pull behavior applies).
- **Resume:** `POST /v1/openai/interruptions/{interruption_id}/resume` marks the interruption as resumed and returns a `resume_payload` (JSON) you can pass back to your agent/runtime.

Reliability guidance:

- Persist `{interruption_id -> task_id}` so you can always “join” the interruption record to the task timeline.
- For user-facing state, you can either:
  - follow the backing task via `GET /v1/tasks/{task_id}` / `/v1/tasks/sync`, or
  - poll the interruption record directly via `GET /v1/openai/interruptions/{interruption_id}`.

## 1) What to persist in Requester

Minimum state you should persist (durable storage):

- `task_id` for every created task.
- A per-account `sync_cursor` (string) for `/v1/tasks/sync`.
- A dedupe set for webhook deliveries keyed by `Idempotency-Key` (TTL is fine, but durable is better).

## 2) Webhook receiver (push path)

Your webhook handler should do only fast checks, then enqueue the business processing.

- Verify signature (`X-ShimLayer-Signature`, `X-ShimLayer-Timestamp`) with a tight tolerance window.
- Enforce idempotency using `Idempotency-Key`.
- Persist the event payload (or the derived task state).

Example receiver is in `docs/webhook-receiver-example.md`.

## 3) Pull fallback (two loops)

### A) Poll only the active task (UX loop)

After you create a task (`POST /v1/tasks`), you already have `task_id`.

- Poll `GET /v1/tasks/{task_id}` until terminal status:
  - terminal: `completed | failed | disputed | refunded`
  - non-terminal: `queued | claimed`
- Use backoff + jitter:
  - start at `2–5s` for the first minute
  - then exponential backoff to `30–60s`

This loop powers the user-facing “waiting for result” experience.

### B) Cursor sync (reliability loop)

Run a background reconciler that periodically syncs updates:

`GET /v1/tasks/sync?limit=200&cursor=<opaque>`

- Save the returned `next_cursor` and use it on the next call.
- Process every `items[]` row as the current server truth.
- Recommended cadence: every `60–180s`, and always once on service startup.

If you miss a webhook, this loop still discovers the update.

## 4) `/v1/tasks/sync` contract

Request:

- `cursor` (preferred): opaque base64url-encoded JSON `{updated_at, task_id}`
- or `updated_after` (bootstrap): ISO datetime
- optional: `status_filter`, `task_type`
- `limit` (1..200, default 50)

Response:

```json
{
  "items": [/* TaskWithReview[] */],
  "next_cursor": "..."
}
```

Semantics:

- returns tasks where `(updated_at, id)` is **strictly greater** than the cursor tuple
- ordering is `updated_at asc, id asc` (stable for pagination)

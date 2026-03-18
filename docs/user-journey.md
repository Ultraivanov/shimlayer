# ShimLayer User Journey (MVP)

This doc describes the end-to-end path in simple, user-facing terms.

## Roles
- **Requester**: Your product/workflow that creates tasks and receives results.
- **Operator**: Human who resolves tasks and attaches proof.
- **Ops/Reviewer**: Oversees safety, refunds, and manual review queue.

## Happy Path (No Manual Review)
1. **Requester creates a task** (`stuck_recovery` or `quick_judgment`), optionally with a `callback_url`.
2. **Operator claims** the task.
3. **Operator uploads proof** (recommended: upload a local artifact) and **completes** the task with a structured result.
4. **Requester receives the result**:
   - **Push**: webhook delivery to `callback_url` (best for latency).
   - **Pull fallback**: Requester UI/API can poll task state and/or sync the task list (best for reliability).

## OpenAI Interruptions Path (HITL “resume” loop)
This path is for **agent workflows that get interrupted** (e.g., tool call needs approval) and need a human decision before continuing.

1. **Requester ingests an interruption** (creates a backing task automatically).
2. **Operator opens the interruption task** and **Approve/Rejects** the decision.
3. **Requester (or Operator) requests a resume payload** (server marks the interruption as resumed and returns the payload).
4. **Requester resumes the agent run** using that payload (your app sends it to your agent/runtime; optional callback delivery can also be used).

## Safety Path (Auto-check → Manual Review Queue)
1. Task completes and the server runs an **auto-check** (with optional PII redaction before provider calls).
2. If flagged, the flow enters **Manual review**.
3. A reviewer claims a lock, then **Approve/Reject**.
4. Requester sees review outcome via webhook (push) and/or sync/poll (pull).

## Push + Pull (Hybrid Delivery Model)
- **Push** gives near real-time updates but can fail due to receiver downtime, network errors, or signature validation issues.
- **Pull** ensures the Requester can always converge to the correct state even if webhook delivery is delayed or fails.

### Recommended Requester strategy
- Use webhook deliveries for instant updates.
- Run a background **sync loop** to keep the task list consistent.
- When a task is active (queued/claimed), run an **active-task poll** with backoff.

## Sequence (High-level)
```mermaid
sequenceDiagram
  participant R as Requester
  participant S as ShimLayer API
  participant O as Operator
  participant OPS as Ops/Reviewer

  R->>S: Create task (+ optional callback_url)
  O->>S: Claim task
  O->>S: Upload proof artifact(s)
  O->>S: Complete task (structured result)
  S-->>R: Webhook delivery (push)
  R->>S: Sync/poll (pull fallback)
  S-->>R: Current task state + result + proof metadata

  alt Auto-check flags task
    S->>OPS: Enters manual review queue
    OPS->>S: Claim lock + approve/reject
    S-->>R: Webhook delivery (push)
    R->>S: Sync/poll (pull fallback)
  end

  alt OpenAI interruption (resume loop)
    R->>S: Ingest interruption (creates task)
    O->>S: Approve/Reject decision (completes task)
    R->>S: Request resume payload
    S-->>R: Resume payload (JSON)
  end
```

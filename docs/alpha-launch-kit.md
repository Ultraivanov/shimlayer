# ShimLayer Alpha Launch Kit

## 1. Alpha Goal
Validate that ShimLayer can recover real production workflow failures with predictable SLA and acceptable economics for SMB teams.

## 2. ICP and Cohort Mix
- Primary cohort: 8 SMB teams using agentic workflows in production.
- Secondary cohort: 4 indie teams through Indie Entry package.
- Stretch cohort: 2 enterprise design partners (observers/pilot only).

## 3. Onboarding Scenarios
### Scenario A: API-first integration (SMB)
- Provision API key.
- Purchase package (`growth_2000`).
- Integrate `POST /v1/tasks` and webhook receiver.
- Validate signature and idempotency key handling.
- Run 20 synthetic stuck-recovery tasks, then 20 live tasks.

### Scenario B: Quick judgment integration (SMB/indie)
- Purchase package (`indie_entry_150` for indie).
- Integrate `POST /v1/judgments` into one high-volume decision point.
- Measure false escalation rate and resolution latency.

### Scenario C: Reliability test (internal + design partners)
- Enable callback URL with controlled 5xx/timeout failures.
- Verify queue retries, DLQ behavior, and replay procedure.

## 4. Webhook Integration Checklist
- Receiver returns 2xx only after durable processing.
- Validate `X-ShimLayer-Signature` (`HMAC-SHA256`).
- Deduplicate using `Idempotency-Key`.
- Log `event_id`, `task.id`, and final processing status.
- Support replay from dead-letter events.

## 5. Dashboard Metrics (daily)
- `task_create_to_claim_p95`
- `task_claim_to_complete_p95`
- `webhook_delivery_success_rate`
- `webhook_retry_rate`
- `webhook_dlq_count`
- `refund_rate`
- `save_rate` (workflow resumed after HITL)

## 6. Launch Gates
- `claim_p95 <= 90s`
- `resolution_p95 <= 180s` for quick judgment
- `webhook success >= 99%` within retry window
- `dlq_count / total_jobs <= 0.5%`
- `refund_rate <= 5%`

## 7. Incident Runbook (short)
- If `webhook_dlq_count` spikes:
  1. Identify dominant callback domains and HTTP codes.
  2. Replay DLQ after endpoint recovery.
  3. Flag affected accounts and open support thread.
- If `resolution_p95` spikes:
  1. Check worker pool occupancy and claim queue depth.
  2. Temporarily reduce max accepted task volume.

## 8. Alert Thresholds
- `queue_pending > 200` for 5 minutes: page on-call.
- `webhook_delivery_success_rate < 0.98` for 10 minutes: high-priority alert.
- `webhook_dlq_count` delta > 20 in 15 minutes: incident channel + replay runbook.
- `webhook_retry_rate > 0.25` for 15 minutes: investigate callback-domain outages.
- `task_create_to_claim_p95 > 120s` for 15 minutes: throttle intake + rebalance worker pool.
- Run `scripts/check_ops_thresholds.py` every 1-5 minutes via cron/CI and page on non-zero exit.

## 9. Exit Criteria for Beta
- At least 10 paying accounts with weekly recurring usage.
- 2+ SMB accounts upgraded from initial package within 30 days.
- Stable metrics above launch gates for 14 consecutive days.

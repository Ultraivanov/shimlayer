# Ops Runbook

## 1. Triage flow queue
- Open Ops -> `Flows` view.
- Enable `SLA breach queue` for urgent tasks.
- Use search by `task_id/account_id/type/status`.
- Manual review queue: auto-refresh shows last OK time and pauses on errors.
- For bulk downloads, use `Download as one zip` to reduce multiple file prompts.
- Claim the case owner and add internal note before sensitive actions.

## 2. Sensitive actions policy
- `refund` and `force_status` require `reason_code`.
- `fraud_risk` and `policy_violation` require explicit note.
- Prefer `dry-run bulk` before bulk mutation.
- For bulk > 20 items use explicit confirmation flow.

## 3. Incident lifecycle
- Use `Run SLA scan` to auto-open incident if overdue threshold is exceeded.
- Incident states: `open -> triage -> monitoring -> resolved`.
- Assign owner immediately.
- Save postmortem after resolve.

## 4. Webhook degradation
- Open `Observability` and review DLQ count.
- Requeue DLQ items only after callback endpoint is healthy.
- If repeated failures continue, open incident with type `webhook_degradation`.
- `Resend now` enqueues a new delivery attempt; refresh or open attempts to verify.

## 5. Finance checks
- Open `Finance` view.
- Review margin estimate and recent ledger events.
- Validate refund spikes against incident notes.

## 6. Audit requirements
- All sensitive actions must include reason + note where required.
- Never run manual DB updates to mutate audit/event history.

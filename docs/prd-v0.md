# ShimLayer PRD v0

## 1. Product Summary
ShimLayer is an API-first HITL layer for last-mile failures in agentic AI workflows.
When an agent gets stuck or requires low-latency human judgment, ShimLayer routes the task to a human worker, returns a structured response, and provides proof artifacts for verification.

## 2. MVP Scope
In scope:
- Task type `stuck_recovery`
- Task type `quick_judgment`
- Proof-layer for every completed task
- Auto-check using LLM moderation prompt
- Manual review queue for flagged tasks
- Prepaid balance and per-task deduction
- REST API + outbound webhooks

Out of scope (v0):
- Multi-language UI
- Complex worker ranking marketplace
- Native mobile apps
- Fully dynamic pricing engine

## 3. Target Users
- Primary ICP (Phase 1): SMB teams operating agentic workflows in production
- Secondary ICP (entry): Indie developers with smaller but critical workflow volume
- Phase 2 ICP: Enterprise teams requiring advanced compliance and SLA controls

## 4. Core Jobs To Be Done
- Recover from stuck workflows in 1-3 minutes.
- Get quick yes/no judgment with short rationale.
- Receive verifiable proof and auditable logs per task.

## 5. Functional Requirements
### 5.1 Requester API
- Create task with context payload, SLA, max price, callback URL.
- Upload artifacts (logs, screenshot, JSON) before/after execution.
- Receive task status transitions by webhook.
- Retrieve task, review, proof, and billing details.

### 5.2 Worker Operations
- Claim available tasks.
- Submit response payload:
  - `stuck_recovery`: action summary + next step proposal.
  - `quick_judgment`: yes/no + short note.
- Attach proof artifacts for each completion.

### 5.3 Proof-layer
- Persist proof artifacts in object storage.
- Run auto-check model prompt to verify task/proof consistency.
- Route to manual queue if:
  - high price threshold exceeded,
  - low confidence score,
  - requester dispute.
- Support refund decision flow.

## 6. Non-Functional Requirements
- p95 time-to-claim under 90 seconds during alpha windows.
- p95 time-to-resolution under 180 seconds for `quick_judgment`.
- API key auth with tenant isolation.
- Immutable ledger entries for monetary operations.
- Artifact retention default 30 days, configurable to 90.

## 7. Success Metrics (Alpha)
- Fill rate: percentage of tasks claimed within SLA.
- Save rate: percentage of workflows resumed after task completion.
- p50/p95 claim and resolution latency.
- Auto-check precision/recall against manual review outcomes.
- Refund rate and dispute reasons.

## 8. Pricing v0
- Packaging principle:
  - Packages differ only by included flow volume.
  - No package may be priced below floor required for target gross margin.
  - Target margin floor: >=70% gross margin by design.

- Prepaid packages (SMB-first with Indie entry):
  - Indie Entry: 150 flows
  - Growth: 2000 flows
  - Scale: 10000 flows

- Pricing policy:
  - Set package price from current variable cost floor, not from competitor anchors.
  - Overage must remain above floor price.
  - Do not subsidize with infrastructure cost cutting as a primary lever.

- Example package pricing (for validation interviews; adjust to live costs):
  - Indie Entry (150 flows): $255 total ($1.70/flow)
  - Growth (2000 flows): $3360 total ($1.68/flow)
  - Scale (10000 flows): $16500 total ($1.65/flow)

- Why Indie Entry still works:
  - Lower total check size reduces purchase friction.
  - Per-flow pricing remains margin-safe.
  - Suitable for pilot usage before upgrading to Growth.

## 9. Risks and Mitigations
- Worker liquidity risk:
  - Mitigation: focused launch windows and limited SLA tiers.
- Fraud/low-quality submissions:
  - Mitigation: proof requirement + auto-check + manual queue + reputation controls.
- Unit economics pressure:
  - Mitigation: package prepay, minimum charge, price/SLA tiering.
- PII handling:
  - Mitigation: optional blur pre-processor and strict retention policy.

## 10. Milestones
1. Week 1: API + DB schema + webhook skeleton.
2. Week 2: Worker flow + proof upload + auto-check.
3. Week 3: Manual review + refunds + dashboard basics.
4. Week 4: Alpha with selected design partners.

# Alpha Local Runbook

Goal: run ShimLayer locally in a way that is close to production (Postgres + workers), and validate the end-to-end journey (Requester → Operator → Ops), including OpenAI interruptions (resume loop).

## 1) Start stack (Docker + Postgres)

```bash
docker compose up -d --build
```

Services:
- `api` (FastAPI)
- `worker` (webhook dispatcher)
- `openai-resume-worker` (resume dispatcher)
- `postgres` (state)
- `migrate` (applies `docs/supabase-schema-v0.sql`)

## 2) Start UI (optional)

```bash
docker compose --profile ui up -d --build frontend
```

Open UI: `http://localhost:5173`

## 3) Validate health + ops probes

```bash
curl -sS http://localhost:8000/v1/healthz
curl -sS http://localhost:8000/v1/readyz
curl -sS http://localhost:8000/v1/ops/metrics \
  -H "X-API-Key: demo-key" \
  -H "X-Admin-Key: dev-admin-key" \
  -H "X-Admin-Role: admin" \
  -H "X-Admin-User: local-alpha"
```

## 4) Run alpha checks

```bash
./scripts/alpha_readiness_check.sh
./scripts/preflight_all.sh --with-docker
```

## 5) Manual flow spot-check (UI)

### A) Proof + completion (standard task)
1. Requester: purchase package → create task.
2. Operator: claim → upload local proof → complete.
3. Requester: confirm task is completed and bundle download works.

### B) OpenAI interruptions (resume loop)
1. Requester: ingest interruption.
2. Operator: approve/reject.
3. Requester or Operator: generate resume payload and copy it.

### C) Manual review (safety)
1. Complete a task that is flagged for manual review.
2. Ops: take next → approve/reject → verify lock UX + status update.


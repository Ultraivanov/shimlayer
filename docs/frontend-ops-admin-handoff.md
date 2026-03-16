# Frontend Ops/Admin Handoff

## Scope Delivered
- Control Tower KPI tiles (`active_tasks`, `tasks_sla_risk`, `tasks_overdue`, `webhook_dlq_count`)
- Health Banner with levels: `stable`, `attention`, `critical`
- Flow Queue:
  - search, status filter, presets (`overdue`, `disputed`, `sla_risk`)
  - pagination + page size
  - select single/multiple flows
  - sort modes: `priority`, `updated_desc`, `created_desc`
  - Saved Views (save/load/delete in localStorage)
  - keyboard triage (`J/K` navigation, `A/R/D` actions with safeguards)
- Action Center:
  - single actions (`manual_review`, `refund`, `force_status`, `reassign`, `add_note`)
  - bulk actions (`manual_review`, `refund`, `force_status`, `reassign`, dry-run)
  - confirm safeguards for destructive actions
  - role-based UI gating by `adminRole` (action visibility/availability aligned with backend RBAC)
  - role-aware finance fetch (no noisy 403 refresh errors for `ops_agent`)
- Flow Inspector:
  - tabs: `summary`, `context`, `result`, `artifacts`, `timeline`
  - downloads: artifact download (local storage) + one-click flow bundle (zip)
- Incident Board:
  - update owner/status/postmortem
  - lazy-loaded incident events
- Finance panel:
  - margin summary
  - ledger preview
- Observability panel:
  - trend windows (`12/24/48 snapshots`)
  - trend reset
  - sparklines + latest value + delta + last sample timestamp
  - health banner (`stable` / `attention` / `critical`) with quick actions
- Webhook DLQ:
  - list + requeue action
- UX improvements:
  - toasts (success/error)
  - loading/empty states across major panels
  - keyboard triage shortcuts (`J/K`, `A`, `R`, `D`)
  - auto-refresh (`off/15/30/60s`) with pause on hidden tab
  - Gravity UI confirm dialog for destructive/sensitive actions (single + bulk)
  - action consistency polish:
    - single-action buttons have aligned loading/disabled behavior
    - role-blocked actions expose explicit tooltip/title reason
    - incident update buttons are locked while incident mutation is in progress
    - dry-run bulk no longer emits global error state, success toast only
    - flow queue row buttons include `type="button"` + `aria-pressed` for better accessibility

## Main Frontend Entry Points
- `/Users/dmitryivanov/Documents/ShimLayer/frontend/src/pages/OpsPage.tsx`
- `/Users/dmitryivanov/Documents/ShimLayer/frontend/src/api.ts`
- `/Users/dmitryivanov/Documents/ShimLayer/frontend/src/styles.css`

## Manual QA Checklist
1. Open `Ops` tab and verify initial load without JS errors.
2. Verify auto-refresh modes and pause behavior after switching browser tab.
3. Verify Flow Queue priority sort puts overdue/at-risk tasks first.
4. Save two views, reload page, confirm they persist and apply correctly.
5. Run single `refund` and `force_status` and confirm browser confirmation appears.
6. Run bulk dry-run + bulk destructive action and export bulk report JSON.
7. Open Flow Inspector tabs and verify context/result/artifacts render valid JSON.
8. In Incident Board:
   - assign owner
   - move to triage
   - resolve
   - open events and confirm event timeline renders
9. Requeue one DLQ item and verify toast + state update.
10. Validate keyboard shortcuts:
    - `J/K` moves selection
    - `A/R/D` run expected actions (with confirm where required)
    - no shortcut triggers while typing inside inputs/textareas.
11. Validate role gating by switching `VITE_ADMIN_ROLE`:
    - `ops_agent` cannot run refund/force-status
    - `finance` can refund/add_note only
    - `admin` can run all actions

## Build/Run Commands
```bash
cd frontend
npm run build
npm run dev
```

## UI Smoke (Playwright)
- Config: [`/Users/dmitryivanov/Documents/ShimLayer/frontend/playwright.config.ts`](/Users/dmitryivanov/Documents/ShimLayer/frontend/playwright.config.ts)
- Spec: [`/Users/dmitryivanov/Documents/ShimLayer/frontend/e2e/ops-smoke.spec.ts`](/Users/dmitryivanov/Documents/ShimLayer/frontend/e2e/ops-smoke.spec.ts)
- Covered scenarios:
  - queue + inspector
  - single force-status action with confirm dialog
  - bulk dry-run action
  - incident board assign/triage/events
  - DLQ requeue panel flow (route-mocked in e2e)

```bash
cd frontend
npm install
npm run e2e:install
npm run e2e
```

## Remaining Work (Optional Next Iteration)
- Add lightweight E2E UI smoke (Playwright/Cypress) for critical ops flows.
- Add server-side trend storage (instead of local snapshots) for cross-device continuity.

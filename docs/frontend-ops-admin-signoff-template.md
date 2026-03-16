# Frontend Ops/Admin Release Signoff (Template)

- Date:
- Environment: (`local` / `staging` / `prod-like`)
- Candidate version/commit:
- Reviewer:
- Decision: (`GO` / `NO-GO`)

## 1) Scope Confirmation
- [ ] Ops/Admin scope соответствует ожидаемому (Control Tower, Queue, Action Center, Inspector, Incidents, Observability, DLQ).
- [ ] Незапланированных UI/UX изменений нет.

## 2) Functional Validation
- [ ] Flow queue filters/sort/pagination работают корректно.
- [ ] Priority sort корректно поднимает overdue/at-risk кейсы.
- [ ] Saved Views (save/load/delete) работают и сохраняются после reload.
- [ ] Single actions (`manual_review/refund/force_status/reassign/add_note`) работают.
- [ ] Bulk actions (включая dry-run) работают.
- [ ] Destructive actions требуют подтверждение.
- [ ] Flow Inspector (summary/context/result/artifacts/timeline) корректно отображается.
- [ ] Incident update + incident events работают.
- [ ] DLQ requeue работает.

## 3) Reliability/UX
- [ ] Loading/empty states корректны во всех основных панелях.
- [ ] Toast уведомления отображаются для success/error.
- [ ] Auto-refresh (`off/15/30/60`) работает.
- [ ] При скрытой вкладке auto-refresh ставится на паузу.
- [ ] Hotkeys (`J/K/A/R/D`) работают и не срабатывают в input/textarea.
- [ ] Health banner корректно отражает `stable/attention/critical`.

## 4) Security/Access
- [ ] В UI используются admin headers через текущий API-клиент.
- [ ] Нет утечки секретов в интерфейсе/логах.
- [ ] Проверено поведение при 4xx/5xx ответах API.
- [ ] Role-based UI gating соответствует backend RBAC (`ops_agent/ops_manager/finance/admin`).

## 5) Build/Artifacts
- [ ] `npm run build` проходит без ошибок.
- [ ] Bundle size change проверен и приемлем.
- [ ] Release artifacts обновлены.

## 6) Observability Checks
- [ ] Health banner корректно отражает состояние (`stable/attention/critical`).
- [ ] Trend window (`12/24/48`) и reset history работают.
- [ ] Last sample timestamp отображается корректно.

## 7) Open Issues / Risks
- Risk 1:
- Risk 2:
- Mitigation:

## 8) Final Signoff
- Result: (`GO` / `NO-GO`)
- Notes:
- Approved by:

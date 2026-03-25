# Release Summary (ShimLayer MVP)

## Status
Core flows are complete and QA‑ready.

## What’s Done
- **Requester:** create tasks, proof flow (local + external), Open by ID, auto‑refresh, interruptions.
- **Operator:** queue/claim/complete, proof flow, hotkeys, interruptions, Open by ID.
- **Ops:** queue + presets, inspector tabs, manual review queue, webhooks resend/attempts, bulk download (multi + zip), auto‑refresh.

## Validation
- `./scripts/preflight_fast.sh` passed (compileall + pytest suites + frontend build).

## Optional Polish (if time)
- Run UI e2e (`./scripts/preflight_ui.sh`).
- Final 10–15 min manual click‑through (Requester → Operator → Ops).

## Release Checklist
See `docs/release-checklist.md`.

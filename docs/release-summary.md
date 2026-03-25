# Release Summary (ShimLayer MVP)

## Status
Core flows are complete, QA‑ready, and release‑ready.

## What’s Done
- **Requester:** create tasks, proof flow (local + external), Open by ID, auto‑refresh, interruptions.
- **Operator:** queue/claim/complete, proof flow, hotkeys, interruptions, Open by ID.
- **Ops:** queue + presets, inspector tabs, manual review queue, webhooks resend/attempts, bulk download (multi + zip), auto‑refresh.

## Validation
- `./scripts/preflight_fast.sh` passed (compileall + pytest suites + frontend build).
- `./scripts/preflight_ui.sh` passed (Playwright UI smoke).

## Optional Polish (if time)
- Final 10–15 min manual click‑through (Requester → Operator → Ops).

## Release Checklist
See `docs/release-checklist.md`.

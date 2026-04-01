## Operator onboarding (HITL)

### 1) Application intake
- Applicants submit via `POST /v1/operator-applications`.
- Ops reviews in the Ops UI (Operator onboarding tab).

### 2) Approval + operator access
- Approve in Ops UI (role: `ops_manager` or `admin`).
- Approval creates an operator record + access token.
- Share the token with the operator out-of-band.

### 3) Telegram linking (for task notifications)
- Operator opens the bot and sends: `/link <token>`.
- Bot confirms the link and stores `telegram_chat_id` for the operator.
- Ops can now send task pings (buttons include Claim/Skip).

### 4) Operator console access
- Set `VITE_OPERATOR_KEY=<token>` in the operator’s UI environment.
- Operator queue uses `/v1/operator/*` endpoints and requires `X-Operator-Key`.

### 5) Task flow
- Ops sends task ID to operator (Ops UI “Send task”).
- Operator claims the task (UI or Telegram).
- Operator completes task and uploads proof/artifacts.

### Notes
- If a chat is already linked, `/link` will reject to prevent hijacking.
- Chat IDs can still be set manually in the Ops UI before approval.

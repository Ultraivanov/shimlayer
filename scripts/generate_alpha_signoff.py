#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import urllib.request


def fetch_json(url: str, api_key: str) -> dict | list:
    req = urllib.request.Request(url, headers={"X-API-Key": api_key})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    api_url = os.getenv("SHIMLAYER_API_URL", "http://localhost:8000").rstrip("/")
    api_key = os.getenv("SHIMLAYER_API_KEY", "ops-checker")
    out_path = Path(os.getenv("SHIMLAYER_SIGNOFF_PATH", "docs/alpha-signoff-report.md"))
    env_name = os.getenv("SHIMLAYER_ENV", "local")
    reviewer = os.getenv("SHIMLAYER_REVIEWER", "unassigned")

    health = fetch_json(f"{api_url}/v1/healthz", api_key)
    metrics = fetch_json(f"{api_url}/v1/ops/metrics", api_key)
    packages = fetch_json(f"{api_url}/v1/billing/packages", api_key)

    now = datetime.now(timezone.utc).isoformat()
    success_rate = float(metrics.get("webhook_delivery_success_rate", 1.0))
    dlq_count = int(metrics.get("webhook_dlq_count", 0))
    queue_pending = int(metrics.get("queue_pending", 0))
    verdict = "PASS"
    blockers: list[str] = []
    if success_rate < 0.98:
        blockers.append("webhook_delivery_success_rate below 0.98")
    if dlq_count > 20:
        blockers.append("webhook_dlq_count above 20")
    if queue_pending > 200:
        blockers.append("queue_pending above 200")
    if blockers:
        verdict = "FAIL"

    lines = [
        "# Alpha Sign-Off Report",
        "",
        f"- Generated at: `{now}`",
        f"- Environment: `{env_name}`",
        f"- API URL: `{api_url}`",
        f"- Reviewer: `{reviewer}`",
        "",
        "## Verdict",
        f"- Status: `{verdict}`",
        f"- Blocking issues: `{'; '.join(blockers) if blockers else 'none'}`",
        "- Notes: `auto-generated`",
        "",
        "## Health",
        f"- Status: `{health.get('status')}`",
        f"- Timestamp: `{health.get('timestamp')}`",
        "",
        "## Ops Metrics",
    ]
    for key in [
        "queue_pending",
        "queue_processing",
        "queue_total",
        "webhook_delivery_total",
        "webhook_delivery_success_rate",
        "webhook_retry_rate",
        "webhook_dlq_count",
        "task_resolution_p95_seconds",
    ]:
        lines.append(f"- `{key}`: `{metrics.get(key)}`")

    lines.extend(["", "## Packages"])
    for item in packages:
        lines.append(
            f"- `{item.get('code')}`: flows={item.get('flows')}, "
            f"price_usd={item.get('price_usd')}, unit_price_usd={item.get('unit_price_usd')}, "
            f"active={item.get('active')}"
        )

    lines.extend(
        [
            "",
            "## Checks Executed",
            "- `healthz`",
            "- `ops/metrics`",
            "- `billing/packages`",
        ]
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote sign-off report to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

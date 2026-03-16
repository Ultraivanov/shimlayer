#!/usr/bin/env python3
import json
import os
import sys
import urllib.request


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    return float(raw) if raw else default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw else default


def fetch_metrics(api_url: str, api_key: str) -> dict:
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}/v1/ops/metrics",
        headers={"X-API-Key": api_key},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    api_url = os.getenv("SHIMLAYER_API_URL", "http://localhost:8000")
    api_key = os.getenv("SHIMLAYER_API_KEY", "ops-checker")

    thresholds = {
        "queue_pending_max": _env_int("SHIMLAYER_ALERT_QUEUE_PENDING_MAX", 200),
        "success_rate_min": _env_float("SHIMLAYER_ALERT_WEBHOOK_SUCCESS_RATE_MIN", 0.98),
        "retry_rate_max": _env_float("SHIMLAYER_ALERT_WEBHOOK_RETRY_RATE_MAX", 0.25),
        "dlq_max": _env_int("SHIMLAYER_ALERT_WEBHOOK_DLQ_MAX", 20),
        "resolution_p95_max_seconds": _env_float("SHIMLAYER_ALERT_RESOLUTION_P95_MAX_SECONDS", 180.0),
    }

    metrics = fetch_metrics(api_url, api_key)
    violations: list[str] = []

    if metrics.get("queue_pending", 0) > thresholds["queue_pending_max"]:
        violations.append("queue_pending threshold exceeded")
    if metrics.get("webhook_delivery_success_rate", 1.0) < thresholds["success_rate_min"]:
        violations.append("webhook_delivery_success_rate below threshold")
    if metrics.get("webhook_retry_rate", 0.0) > thresholds["retry_rate_max"]:
        violations.append("webhook_retry_rate above threshold")
    if metrics.get("webhook_dlq_count", 0) > thresholds["dlq_max"]:
        violations.append("webhook_dlq_count above threshold")

    p95 = metrics.get("task_resolution_p95_seconds")
    if p95 is not None and float(p95) > thresholds["resolution_p95_max_seconds"]:
        violations.append("task_resolution_p95_seconds above threshold")

    print(json.dumps({"metrics": metrics, "thresholds": thresholds, "violations": violations}, indent=2))
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())

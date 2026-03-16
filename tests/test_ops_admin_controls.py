from fastapi.testclient import TestClient

from app.main import app


def admin_headers(api_key: str, role: str, user: str = "ops-user") -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-Admin-Key": "dev-admin-key",
        "X-Admin-Role": role,
        "X-Admin-User": user,
    }


def seed_completed_task(client: TestClient, api_key: str, max_price_usd: float = 0.48) -> str:
    base_headers = {"X-API-Key": api_key}
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": f"inv-{api_key}"},
        headers=base_headers,
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/tasks",
        json={
            "task_type": "stuck_recovery",
            "context": {"logs": "agent loop"},
            "sla_seconds": 120,
            "max_price_usd": max_price_usd,
        },
        headers=base_headers,
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

    claimed = client.post(f"/v1/tasks/{task_id}/claim", headers=base_headers)
    assert claimed.status_code == 200

    proof = client.post(
        f"/v1/tasks/{task_id}/proof",
        json={
            "artifact_type": "logs",
            "storage_path": f"proofs/{task_id}/logs.txt",
            "checksum_sha256": "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990",
        },
        headers=base_headers,
    )
    assert proof.status_code == 201

    completed = client.post(
        f"/v1/tasks/{task_id}/complete",
        json={"result": {"action_summary": "fixed", "next_step": "resume"}},
        headers=base_headers,
    )
    assert completed.status_code == 200
    return task_id


def test_manual_review_claim_locks_task_between_reviewers() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-claim"
    task_id = seed_completed_task(client, api_key, max_price_usd=1.5)

    reviewer_1 = admin_headers(api_key, role="ops_manager", user="reviewer-1")
    reviewer_2 = admin_headers(api_key, role="ops_manager", user="reviewer-2")

    queue_1 = client.get("/v1/ops/manual-review?limit=10", headers=reviewer_1)
    assert queue_1.status_code == 200
    assert any(row["id"] == task_id for row in queue_1.json())

    claimed = client.post("/v1/ops/manual-review/claim-next", headers=reviewer_1)
    assert claimed.status_code == 200
    assert claimed.json()["id"] == task_id

    queue_2 = client.get("/v1/ops/manual-review?limit=10", headers=reviewer_2)
    assert queue_2.status_code == 200
    assert all(row["id"] != task_id for row in queue_2.json())

    other_verdict = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "manual_review", "manual_verdict": "approved"},
        headers=reviewer_2,
    )
    assert other_verdict.status_code == 409

    ok_verdict = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "manual_review", "manual_verdict": "approved"},
        headers=reviewer_1,
    )
    assert ok_verdict.status_code == 200


def test_manual_review_release_allows_other_reviewer_to_claim() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-release"
    task_id = seed_completed_task(client, api_key, max_price_usd=1.5)

    reviewer_1 = admin_headers(api_key, role="ops_manager", user="reviewer-1")
    reviewer_2 = admin_headers(api_key, role="ops_manager", user="reviewer-2")

    claimed = client.post("/v1/ops/manual-review/claim-next", headers=reviewer_1)
    assert claimed.status_code == 200
    assert claimed.json()["id"] == task_id

    released = client.post(f"/v1/ops/manual-review/{task_id}/release", headers=reviewer_1)
    assert released.status_code == 204

    claimed_by_other = client.post(f"/v1/ops/manual-review/{task_id}/claim", headers=reviewer_2)
    assert claimed_by_other.status_code == 200
    assert claimed_by_other.json()["id"] == task_id


def test_manual_review_release_requires_owner() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-release-owner"
    task_id = seed_completed_task(client, api_key, max_price_usd=1.5)

    reviewer_1 = admin_headers(api_key, role="ops_manager", user="reviewer-1")
    reviewer_2 = admin_headers(api_key, role="ops_manager", user="reviewer-2")

    claimed = client.post("/v1/ops/manual-review/claim-next", headers=reviewer_1)
    assert claimed.status_code == 200
    assert claimed.json()["id"] == task_id

    not_owner = client.post(f"/v1/ops/manual-review/{task_id}/release", headers=reviewer_2)
    assert not_owner.status_code == 409


def test_manual_review_queue_include_locked_shows_claimed_by_other() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-include-locked"
    task_id = seed_completed_task(client, api_key, max_price_usd=1.5)

    reviewer_1 = admin_headers(api_key, role="ops_manager", user="reviewer-1")
    reviewer_2 = admin_headers(api_key, role="ops_manager", user="reviewer-2")

    claimed = client.post("/v1/ops/manual-review/claim-next", headers=reviewer_1)
    assert claimed.status_code == 200
    assert claimed.json()["id"] == task_id

    hidden = client.get("/v1/ops/manual-review?limit=10", headers=reviewer_2)
    assert hidden.status_code == 200
    assert all(row["id"] != task_id for row in hidden.json())

    visible = client.get("/v1/ops/manual-review?limit=10&include_locked=true", headers=reviewer_2)
    assert visible.status_code == 200
    assert any(row["id"] == task_id for row in visible.json())


def test_manual_review_take_over_steals_lock() -> None:
    client = TestClient(app)
    api_key = "ops-manual-review-take-over"
    task_id = seed_completed_task(client, api_key, max_price_usd=1.5)

    reviewer_1 = admin_headers(api_key, role="ops_manager", user="reviewer-1")
    reviewer_2 = admin_headers(api_key, role="ops_manager", user="reviewer-2")

    claimed = client.post("/v1/ops/manual-review/claim-next", headers=reviewer_1)
    assert claimed.status_code == 200
    assert claimed.json()["id"] == task_id

    stolen = client.post(f"/v1/ops/manual-review/{task_id}/take-over", headers=reviewer_2)
    assert stolen.status_code == 200
    assert stolen.json()["id"] == task_id

    old_owner_verdict = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "manual_review", "manual_verdict": "approved"},
        headers=reviewer_1,
    )
    assert old_owner_verdict.status_code == 409


def test_refund_requires_reason_code() -> None:
    client = TestClient(app)
    task_id = seed_completed_task(client, "ops-refund-no-reason")

    response = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "refund", "note": "missing reason"},
        headers=admin_headers("ops-refund-no-reason", role="ops_manager"),
    )
    assert response.status_code == 400
    assert "reason_code" in response.text


def test_ops_agent_cannot_refund() -> None:
    client = TestClient(app)
    task_id = seed_completed_task(client, "ops-agent-cannot-refund")

    response = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "refund", "reason_code": "customer_request", "note": "requested"},
        headers=admin_headers("ops-agent-cannot-refund", role="ops_agent"),
    )
    assert response.status_code == 403


def test_bulk_over_20_requires_confirm_text() -> None:
    client = TestClient(app)
    ids: list[str] = []
    api_key = "ops-bulk-confirm"
    for idx in range(21):
        base_headers = {"X-API-Key": api_key}
        if idx == 0:
            purchase = client.post(
                "/v1/billing/packages/purchase",
                json={"package_code": "indie_entry_150", "reference": "inv-bulk"},
                headers=base_headers,
            )
            assert purchase.status_code == 200

        created = client.post(
            "/v1/tasks",
            json={
                "task_type": "quick_judgment",
                "context": {"question": f"q-{idx}"},
                "sla_seconds": 60,
            },
            headers=base_headers,
        )
        assert created.status_code == 201
        ids.append(created.json()["id"])

    response = client.post(
        "/v1/ops/flows/bulk-actions",
        json={
            "task_ids": ids,
            "action": "force_status",
            "status": "disputed",
            "reason_code": "incident_mitigation",
        },
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert response.status_code == 400
    assert "confirm_text" in response.text


def test_bulk_dry_run_returns_ok_without_mutation() -> None:
    client = TestClient(app)
    task_id = seed_completed_task(client, "ops-bulk-dry-run")

    response = client.post(
        "/v1/ops/flows/bulk-actions",
        json={
            "task_ids": [task_id],
            "action": "force_status",
            "status": "disputed",
            "reason_code": "incident_mitigation",
            "dry_run": True,
        },
        headers=admin_headers("ops-bulk-dry-run", role="ops_manager"),
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["ok"] is True

    detail = client.get(f"/v1/ops/flows/{task_id}", headers=admin_headers("ops-bulk-dry-run", role="ops_manager"))
    assert detail.status_code == 200
    assert detail.json()["status"] == "completed"


def test_incident_create_and_update() -> None:
    client = TestClient(app)
    api_key = "ops-incident-create"
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "inv-incident"},
        headers={"X-API-Key": api_key},
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/ops/incidents",
        json={
            "incident_type": "manual",
            "severity": "medium",
            "title": "Manual triage",
            "description": "Need review",
            "source": "manual",
        },
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert created.status_code == 201
    incident_id = created.json()["id"]

    updated = client.patch(
        f"/v1/ops/incidents/{incident_id}",
        json={"status": "resolved", "owner": "ops-lead", "postmortem": "fixed", "note": "closed"},
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "resolved"


def test_reason_policy_requires_note_for_fraud_risk() -> None:
    client = TestClient(app)
    task_id = seed_completed_task(client, "ops-fraud-note")

    response = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={"action": "refund", "reason_code": "fraud_risk"},
        headers=admin_headers("ops-fraud-note", role="ops_manager"),
    )
    assert response.status_code == 400
    assert "note is required" in response.text


def test_finance_endpoints_rbac() -> None:
    client = TestClient(app)
    api_key = "ops-finance-rbac"
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "inv-finance-rbac"},
        headers={"X-API-Key": api_key},
    )
    assert purchase.status_code == 200

    forbidden = client.get("/v1/ops/finance/ledger?limit=10", headers=admin_headers(api_key, role="ops_agent"))
    assert forbidden.status_code == 403

    ok = client.get("/v1/ops/finance/ledger?limit=10", headers=admin_headers(api_key, role="finance"))
    assert ok.status_code == 200
    assert isinstance(ok.json(), list)


def test_incident_events_present_after_updates() -> None:
    client = TestClient(app)
    api_key = "ops-incident-events"
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "inv-incident-events"},
        headers={"X-API-Key": api_key},
    )
    assert purchase.status_code == 200

    created = client.post(
        "/v1/ops/incidents",
        json={
            "incident_type": "manual",
            "severity": "high",
            "title": "Queue spike",
            "description": "manual incident",
            "source": "manual",
        },
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert created.status_code == 201
    incident_id = created.json()["id"]

    updated = client.patch(
        f"/v1/ops/incidents/{incident_id}",
        json={"status": "triage", "note": "started"},
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert updated.status_code == 200

    events = client.get(
        f"/v1/ops/incidents/{incident_id}/events?limit=20",
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert events.status_code == 200
    payload = events.json()
    assert len(payload) >= 2
    actions = {row["action"] for row in payload}
    assert "incident_created" in actions
    assert "incident_updated" in actions


def test_timeline_endpoint_returns_entries() -> None:
    client = TestClient(app)
    api_key = "ops-timeline"
    task_id = seed_completed_task(client, api_key)

    response = client.get(
        f"/v1/ops/flows/{task_id}/timeline",
        headers=admin_headers(api_key, role="ops_manager"),
    )
    assert response.status_code == 200
    rows = response.json()
    assert isinstance(rows, list)
    assert len(rows) >= 1
    assert "kind" in rows[0]


def test_observability_metrics_prometheus_shape() -> None:
    client = TestClient(app)
    api_key = "ops-observability"
    purchase = client.post(
        "/v1/billing/packages/purchase",
        json={"package_code": "indie_entry_150", "reference": "inv-observability"},
        headers={"X-API-Key": api_key},
    )
    assert purchase.status_code == 200

    response = client.get(
        "/v1/ops/observability/metrics",
        headers=admin_headers(api_key, role="admin"),
    )
    assert response.status_code == 200
    body = response.text
    assert "shimlayer_tasks_overdue" in body
    assert "shimlayer_open_incidents" in body


def test_ops_flow_lifecycle_smoke() -> None:
    client = TestClient(app)
    api_key = "ops-lifecycle-smoke"
    task_id = seed_completed_task(client, api_key)
    headers = admin_headers(api_key, role="ops_manager")

    queue = client.get("/v1/ops/flows?limit=200", headers=headers)
    assert queue.status_code == 200
    queue_ids = {row["id"] for row in queue.json()}
    assert task_id in queue_ids

    detail = client.get(f"/v1/ops/flows/{task_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["status"] == "completed"

    action = client.post(
        f"/v1/ops/flows/{task_id}/actions",
        json={
            "action": "force_status",
            "status": "disputed",
            "reason_code": "incident_mitigation",
            "note": "ops lifecycle smoke",
        },
        headers=headers,
    )
    assert action.status_code == 200
    payload = action.json()
    assert payload["task"]["status"] == "disputed"
    assert payload["audit_entry"] is not None
    assert payload["audit_entry"]["action"] == "force_status"

    audit = client.get(f"/v1/ops/flows/{task_id}/audit?limit=30", headers=headers)
    assert audit.status_code == 200
    assert any(row["action"] == "force_status" for row in audit.json())

    timeline = client.get(f"/v1/ops/flows/{task_id}/timeline", headers=headers)
    assert timeline.status_code == 200
    assert any(row["kind"] == "ops_action" for row in timeline.json())

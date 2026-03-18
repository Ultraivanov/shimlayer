import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

const API_URL = "http://127.0.0.1:8000";
const API_KEY = "e2e-key";

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    ...extra
  };
}

async function ensurePurchased(request: APIRequestContext, reference: string) {
  const res = await request.post(`${API_URL}/v1/billing/packages/purchase`, {
    headers: apiHeaders(),
    data: { package_code: "indie_entry_150", reference }
  });
  expect(res.ok()).toBeTruthy();
}

async function seedIncident(request: APIRequestContext, suffix: string): Promise<{ id: string; title: string }> {
  const title = `E2E Incident ${suffix} ${Date.now()}`;
  const res = await request.post(`${API_URL}/v1/ops/incidents`, {
    headers: apiHeaders({
      "X-Admin-Key": "dev-admin-key",
      "X-Admin-Role": "ops_manager",
      "X-Admin-User": "e2e-admin"
    }),
    data: {
      incident_type: "manual",
      severity: "medium",
      title,
      description: "e2e incident smoke",
      source: "manual"
    }
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { id: string; title: string };
  return { id: body.id, title: body.title };
}

async function seedCompletedTask(request: APIRequestContext, suffix: string): Promise<string> {
  await ensurePurchased(request, `e2e-purchase-${suffix}-${Date.now()}`);
  const created = await request.post(`${API_URL}/v1/tasks`, {
    headers: apiHeaders(),
    data: {
      task_type: "stuck_recovery",
      context: { logs: `loop-${suffix}` },
      sla_seconds: 120
    }
  });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).id as string;

  const claimed = await request.post(`${API_URL}/v1/tasks/${taskId}/claim`, { headers: apiHeaders() });
  expect(claimed.ok()).toBeTruthy();
  const proof = await request.post(`${API_URL}/v1/tasks/${taskId}/proof`, {
    headers: apiHeaders(),
    data: {
      artifact_type: "logs",
      storage_path: `proofs/${taskId}/logs.txt`,
      checksum_sha256: "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990"
    }
  });
  expect(proof.ok()).toBeTruthy();
  const completed = await request.post(`${API_URL}/v1/tasks/${taskId}/complete`, {
    headers: apiHeaders(),
    data: { result: { action_summary: "fixed", next_step: "resume" } }
  });
  expect(completed.ok()).toBeTruthy();
  return taskId;
}

async function seedCompletedTaskWithCallback(request: APIRequestContext, suffix: string): Promise<string> {
  await ensurePurchased(request, `e2e-purchase-callback-${suffix}-${Date.now()}`);
  const created = await request.post(`${API_URL}/v1/tasks`, {
    headers: apiHeaders(),
    data: {
      task_type: "stuck_recovery",
      context: { logs: `callback-${suffix}` },
      callback_url: "https://example.invalid/webhook",
      sla_seconds: 120
    }
  });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).id as string;

  const claimed = await request.post(`${API_URL}/v1/tasks/${taskId}/claim`, { headers: apiHeaders() });
  expect(claimed.ok()).toBeTruthy();
  const proof = await request.post(`${API_URL}/v1/tasks/${taskId}/proof`, {
    headers: apiHeaders(),
    data: {
      artifact_type: "logs",
      storage_path: `proofs/${taskId}/logs.txt`,
      checksum_sha256: "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990"
    }
  });
  expect(proof.ok()).toBeTruthy();
  const completed = await request.post(`${API_URL}/v1/tasks/${taskId}/complete`, {
    headers: apiHeaders(),
    data: { result: { action_summary: "fixed", next_step: "resume" } }
  });
  expect(completed.ok()).toBeTruthy();
  return taskId;
}

async function seedCompletedTaskWithLocalArtifact(request: APIRequestContext, suffix: string): Promise<{ taskId: string; filename: string }> {
  await ensurePurchased(request, `e2e-purchase-local-${suffix}-${Date.now()}`);
  const created = await request.post(`${API_URL}/v1/tasks`, {
    headers: apiHeaders(),
    data: {
      task_type: "stuck_recovery",
      context: { logs: `local-${suffix}` },
      sla_seconds: 120
    }
  });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).id as string;

  const claimed = await request.post(`${API_URL}/v1/tasks/${taskId}/claim`, { headers: apiHeaders() });
  expect(claimed.ok()).toBeTruthy();

  const filename = `ops-download-${suffix}.log`;
  const content = Buffer.from(`local artifact for ${taskId}\n${new Date().toISOString()}\n`, "utf-8");
  const uploaded = await request.post(`${API_URL}/v1/tasks/${taskId}/artifacts/upload`, {
    headers: apiHeaders(),
    data: {
      artifact_type: "logs",
      content_base64: content.toString("base64"),
      filename,
      content_type: "text/plain",
      metadata: { source: "e2e-ops-download" }
    }
  });
  expect(uploaded.ok()).toBeTruthy();

  const completed = await request.post(`${API_URL}/v1/tasks/${taskId}/complete`, {
    headers: apiHeaders(),
    data: { result: { action_summary: "fixed", next_step: "resume" } }
  });
  expect(completed.ok()).toBeTruthy();
  return { taskId, filename };
}

async function seedManualRequiredTask(request: APIRequestContext, suffix: string): Promise<string> {
  await ensurePurchased(request, `e2e-purchase-manual-${suffix}-${Date.now()}`);
  const created = await request.post(`${API_URL}/v1/tasks`, {
    headers: apiHeaders(),
    data: {
      task_type: "stuck_recovery",
      context: { logs: `manual-${suffix}` },
      sla_seconds: 120,
      max_price_usd: 1.5
    }
  });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).id as string;

  const claimed = await request.post(`${API_URL}/v1/tasks/${taskId}/claim`, { headers: apiHeaders() });
  expect(claimed.ok()).toBeTruthy();
  const proof = await request.post(`${API_URL}/v1/tasks/${taskId}/proof`, {
    headers: apiHeaders(),
    data: {
      artifact_type: "logs",
      storage_path: `proofs/${taskId}/logs.txt`,
      checksum_sha256: "7b3156ba047074d12159752b77f2b74599eaf76b4743a014ba704a82c01bc990"
    }
  });
  expect(proof.ok()).toBeTruthy();
  const completed = await request.post(`${API_URL}/v1/tasks/${taskId}/complete`, {
    headers: apiHeaders(),
    data: { result: { action_summary: "fixed", next_step: "resume" } }
  });
  expect(completed.ok()).toBeTruthy();
  return taskId;
}

async function withAdminUser(page: Page, adminUser: string) {
  await page.addInitScript((u) => {
    window.localStorage.setItem("ops.adminUserOverride", String(u));
  }, adminUser);
}

async function getFlowStatus(request: APIRequestContext, taskId: string): Promise<string> {
  const res = await request.get(`${API_URL}/v1/ops/flows/${taskId}`, {
    headers: apiHeaders({
      "X-Admin-Key": "dev-admin-key",
      "X-Admin-Role": "admin",
      "X-Admin-User": "e2e-admin"
    })
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { status: string };
  return body.status;
}

async function applyForceStatus(request: APIRequestContext, taskId: string, status: "disputed" | "completed") {
  const res = await request.post(`${API_URL}/v1/ops/flows/${taskId}/actions`, {
    headers: apiHeaders({
      "X-Admin-Key": "dev-admin-key",
      "X-Admin-Role": "admin",
      "X-Admin-User": "e2e-admin"
    }),
    data: {
      action: "force_status",
      status,
      reason_code: "incident_mitigation",
      note: "e2e force status"
    }
  });
  expect(res.ok()).toBeTruthy();
}

async function openOps(page: Page) {
  await page.addInitScript(() => {
    const preserveKey = "ops.adminUserOverride";
    const preserved = window.localStorage.getItem(preserveKey);
    window.localStorage.clear();
    if (preserved !== null) window.localStorage.setItem(preserveKey, preserved);
    window.localStorage.setItem("ops.manualQueueAutoRefreshSeconds", "0");
  });
  await page.goto("/");
  await page.locator('[data-qa="tab-ops"]').click();
  await expect(page.getByRole("heading", { name: "Control Tower" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Flow Queue" })).toBeVisible();
  await expect(page.locator('[data-testid="ops-flow-queue"]')).toBeVisible();

  const clearButton = page
    .locator('[data-testid="ops-flow-queue"]')
    .getByRole("button", { name: /^Clear$/ });
  if (await clearButton.isVisible()) {
    await clearButton.click();
  }
  const resetPresetButton = page.locator('[data-testid="ops-flow-queue"]').getByRole("button", { name: "Reset" });
  if (await resetPresetButton.isVisible()) {
    await resetPresetButton.click();
  }

  await page.getByRole("button", { name: "Refresh" }).first().click();
}

async function waitForFlowRows(page: Page, minCount = 1) {
  await expect
    .poll(async () => page.locator('[data-testid="ops-flow-row"]').count(), {
      timeout: 20_000
    })
    .toBeGreaterThanOrEqual(minCount);
}

test.describe("Ops smoke", () => {
		  test("queue shows seeded flow and opens inspector", async ({ page, request }) => {
		    const taskId = await seedCompletedTask(request, "queue");
		    await openOps(page);
		    await waitForFlowRows(page, 1);
		    await page.getByPlaceholder("Open by Task ID (UUID)").fill(taskId);
        await page.locator('[data-testid="ops-open-by-id"]').click();

	    await expect(page.locator('[data-testid="ops-flow-inspector"]')).toBeVisible();
	    await expect(page.locator('[data-testid="ops-inspector-task-id"]')).toContainText(taskId);

		    const exportCsv = page.waitForEvent("download");
		    await page.locator('[data-testid="ops-export-csv"]').click();
		    const csv = await exportCsv;
		    expect(csv.suggestedFilename()).toMatch(/^ops-flows-.*\.csv$/);
		  });

  test("webhook delivery status renders and resend updates view", async ({ page, request }) => {
    const taskId = await seedCompletedTaskWithCallback(request, "webhook");

    let lastDelivery: any = null;
    let deliveries = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        task_id: taskId,
        callback_url: "https://example.invalid/webhook",
        status_code: 502,
        attempt_no: 1,
        success: false,
        error: "bad gateway",
        created_at: new Date().toISOString()
      }
    ];
    lastDelivery = deliveries[0];

    await page.route("**/v1/ops/webhooks/last?*", async (route) => {
      const url = new URL(route.request().url());
      const requested = url.searchParams.get("task_id");
      if (requested !== taskId) return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(lastDelivery) });
    });

    await page.route("**/v1/ops/webhooks/deliveries?*", async (route) => {
      const url = new URL(route.request().url());
      const requested = url.searchParams.get("task_id");
      if (requested !== taskId) return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(deliveries) });
    });

    await page.route(`**/v1/ops/webhooks/tasks/${taskId}/resend`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      deliveries = [
        {
          id: "22222222-2222-4222-8222-222222222222",
          task_id: taskId,
          callback_url: "https://example.invalid/webhook",
          status_code: 200,
          attempt_no: 2,
          success: true,
          error: null,
          created_at: new Date().toISOString()
        },
        ...deliveries
      ];
      lastDelivery = deliveries[0];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enqueued: true }) });
    });

    await openOps(page);
    await waitForFlowRows(page, 1);
    await page.getByPlaceholder("Search task/account/type/status").fill(taskId);

    const targetRow = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
    await expect(targetRow).toBeVisible({ timeout: 20_000 });
    await targetRow.click();

    await expect(page.locator('[data-testid="ops-webhook-last"]')).toContainText("failed");

    // Show attempts (explicit UI check)
    await page.locator('[data-testid="ops-webhook-toggle-attempts"]').click();
    await expect
      .poll(async () => page.locator('[data-testid="ops-webhook-attempt-row"]').count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "Resend now" }).click();
    await expect(page.locator('[data-testid="ops-webhook-last"]')).toContainText("ok");
  });

  test("download flow bundle and local artifact via UI", async ({ page, request }) => {
    const seeded = await seedCompletedTaskWithLocalArtifact(request, "download");
    await openOps(page);
    await waitForFlowRows(page, 1);

    const targetRow = page.locator(`[data-testid="ops-flow-row"][data-task-id="${seeded.taskId}"]`);
    await expect(targetRow).toBeVisible({ timeout: 20_000 });
    await targetRow.click();

    // Bundle
    const bundleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download bundle" }).click();
    const bundle = await bundleDownload;
    expect(bundle.suggestedFilename()).toBe(`flow-${seeded.taskId}.zip`);

    // Artifact (local)
    await page.getByRole("button", { name: "Artifacts" }).click();
    await expect(page.locator('[data-testid="artifact-tile"]').first()).toBeVisible({ timeout: 20_000 });
    const artifactDownload = page.waitForEvent("download");
    await page.locator('[data-testid="artifact-download"]').first().click();
    const artifact = await artifactDownload;
    expect(artifact.suggestedFilename()).toBe(seeded.filename);
  });

  test("bulk download selected flow bundles", async ({ page, request }) => {
    const taskA = await seedCompletedTask(request, "bulk-download-a");
    const taskB = await seedCompletedTask(request, "bulk-download-b");
    await openOps(page);
    await waitForFlowRows(page, 2);

    // Ensure inspector/action-center is mounted with a selected flow.
    await page.getByPlaceholder("Open by Task ID (UUID)").fill(taskA);
    await page.locator('[data-testid="ops-open-by-id"]').click();
    await expect(page.locator('[data-testid="ops-flow-inspector"]')).toBeVisible();
    await expect(page.locator('[data-testid="ops-inspector-task-id"]')).toContainText(taskA);

    const bulkDlBtn = page.locator('[data-testid="ops-download-selected-bundles"]');
    await expect(bulkDlBtn).toBeVisible();
    await expect(bulkDlBtn).toBeDisabled();

    // Select 2 flows
    const rowA = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskA}"]`);
    const rowB = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskB}"]`);
    await expect(rowA).toBeVisible({ timeout: 20_000 });
    await expect(rowB).toBeVisible({ timeout: 20_000 });
    await rowA.locator('input[type="checkbox"]').first().check();
    await rowB.locator('input[type="checkbox"]').first().check();
    await expect(rowA.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(rowB.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(page.locator('[data-testid="ops-selected-count"]')).toContainText("Selected: 2");

    await expect(bulkDlBtn).toBeEnabled();

    const downloads: { suggestedFilename(): string }[] = [];
    const onDownload = (dl: { suggestedFilename(): string }) => downloads.push(dl);
    page.on("download", onDownload);
    try {
      await bulkDlBtn.click();
      await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(2);
    } finally {
      page.off("download", onDownload);
    }
    const names = downloads.map((d) => d.suggestedFilename()).sort();
    const expected = [`flow-${taskA}.zip`, `flow-${taskB}.zip`].sort();
    expect(names).toEqual(expected);
  });

  test("bulk download selected flow bundles as one zip", async ({ page, request }) => {
    const taskA = await seedCompletedTask(request, "bulk-zip-a");
    const taskB = await seedCompletedTask(request, "bulk-zip-b");
    await openOps(page);
    await waitForFlowRows(page, 2);

    // Ensure inspector/action-center is mounted with a selected flow.
    await page.getByPlaceholder("Open by Task ID (UUID)").fill(taskA);
    await page.locator('[data-testid="ops-open-by-id"]').click();
    await expect(page.locator('[data-testid="ops-flow-inspector"]')).toBeVisible();
    await expect(page.locator('[data-testid="ops-inspector-task-id"]')).toContainText(taskA);

    const zipBtn = page.locator('[data-testid="ops-download-selected-bundles-zip"]');
    await expect(zipBtn).toBeVisible();
    await expect(zipBtn).toBeDisabled();

    const rowA = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskA}"]`);
    const rowB = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskB}"]`);
    await expect(rowA).toBeVisible({ timeout: 20_000 });
    await expect(rowB).toBeVisible({ timeout: 20_000 });
    await rowA.locator('input[type="checkbox"]').first().check();
    await rowB.locator('input[type="checkbox"]').first().check();
    await expect(page.locator('[data-testid="ops-selected-count"]')).toContainText("Selected: 2");

    await expect(zipBtn).toBeEnabled();
    const dlPromise = page.waitForEvent("download");
    await zipBtn.click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toBe("flows-selected.zip");
  });

  test("single force-status action works via confirm dialog", async ({ page, request }) => {
    const taskId = await seedCompletedTask(request, "single-action");
    await openOps(page);
    await waitForFlowRows(page, 1);

    const targetRow = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
    await expect(targetRow).toBeVisible({ timeout: 20_000 });
    await targetRow.click();
    await expect(targetRow).toHaveClass(/is-active/);

    const forceStatusButton = page
      .locator('[data-testid="ops-action-center"]')
      .getByRole("button", { name: /^Force status$/ });
    await expect(forceStatusButton).toBeEnabled();
    await applyForceStatus(request, taskId, "disputed");

    await expect
      .poll(async () => getFlowStatus(request, taskId), { timeout: 20_000 })
      .toBe("disputed");
  });

  test("bulk dry-run action returns success toast", async ({ page, request }) => {
    await seedCompletedTask(request, "bulk-1");
    await seedCompletedTask(request, "bulk-2");
    await openOps(page);
    await waitForFlowRows(page, 2);

    await page.locator('[data-testid="ops-flow-queue"]').getByRole("button", { name: "Select page" }).click();
    await expect(page.getByText("Selected:")).toContainText("Selected:");

    await page.locator('[data-testid="ops-bulk-actions"]').getByRole("button", { name: "Dry-run bulk" }).click();
    await expect(page.locator(".toast-success")).toContainText("Bulk dry-run passed");
  });

  test("incident board supports assign, triage and events", async ({ page, request }) => {
    const incident = await seedIncident(request, "board");
    await openOps(page);

    await page.getByRole("button", { name: "Incidents" }).click();
    const board = page.locator('[data-testid="ops-incident-board"]');
    await expect(board).toBeVisible();

    const item = board.locator('[data-testid="incident-item"]').filter({ hasText: incident.title }).first();
    await expect(item).toBeVisible({ timeout: 20_000 });

    await item.getByPlaceholder("owner").fill("ops-e2e-owner");
    await item.getByRole("button", { name: "Assign owner" }).click();
    await expect(page.locator(".toast-success")).toContainText("Incident updated");

    await item.getByRole("button", { name: "Triage" }).click();
    await expect(item.locator(".status")).toContainText("triage");

    await item.getByRole("button", { name: "Show events" }).click();
    await expect(item.locator(".incident-events")).toBeVisible();
    await expect(item.locator(".incident-event").first()).toBeVisible();
  });

  test("dlq requeue updates item state in panel", async ({ page }) => {
    const deadLetterId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    let requeued = false;

    await page.route("**/v1/ops/dlq*", async (route) => {
      const payload = [
        {
          id: deadLetterId,
          webhook_job_id: "33333333-3333-4333-8333-333333333333",
          task_id: taskId,
          callback_url: "https://example.invalid/webhook",
          payload: { event_type: "task.updated" },
          error: "status 500",
          status_code: 500,
          created_at: new Date().toISOString(),
          requeued_at: requeued ? new Date().toISOString() : null
        }
      ];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.route(`**/v1/webhooks/dlq/${deadLetterId}/requeue`, async (route) => {
      requeued = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requeued: true })
      });
    });

    await openOps(page);
    const panel = page.locator('[data-testid="ops-dlq-panel"]');
    await expect(panel).toBeVisible();

    const item = panel.locator('[data-testid="dlq-item"]').filter({ hasText: "status 500" }).first();
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Requeue" }).click();

    await expect(page.locator(".toast-success")).toContainText("DLQ item requeued");
    await expect(item.getByRole("button", { name: "Requeued" })).toBeDisabled();
  });

  test("manual review lock hides claimed task from other reviewer", async ({ browser, request }) => {
    const taskId = await seedManualRequiredTask(request, "lock");

    const reviewer1 = await browser.newPage();
    await withAdminUser(reviewer1, "e2e-reviewer-1");
    await openOps(reviewer1);
    await reviewer1.locator('[data-testid="ops-flow-queue"]').getByRole("button", { name: "Manual review" }).first().click();
    await reviewer1.getByRole("button", { name: "Refresh" }).first().click();
    const row = reviewer1.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await reviewer1.locator('[data-testid="ops-flow-queue"]').getByRole("button", { name: "Take next" }).click();
    await expect(reviewer1.locator('[data-testid="ops-inspector-task-id"]')).toContainText(taskId);

    const reviewer2 = await browser.newPage();
    await withAdminUser(reviewer2, "e2e-reviewer-2");
    await openOps(reviewer2);
    await reviewer2.locator('[data-testid="ops-flow-queue"]').getByRole("button", { name: "Manual review" }).first().click();
    await reviewer2.getByRole("button", { name: "Refresh" }).first().click();
    await expect(reviewer2.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`)).toHaveCount(0, { timeout: 20_000 });

    await reviewer1.close();
    await reviewer2.close();
  });
});

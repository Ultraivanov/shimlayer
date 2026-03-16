import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

const API_URL = "http://127.0.0.1:8000";
const API_KEY = "e2e-key";

test.describe.configure({ mode: "serial" });

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
  const taskId = ((await created.json()) as { id: string }).id;

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

async function openOps(page: Page) {
  await page.goto("/");
  await page.locator('[data-qa="tab-ops"]').click();
  await expect(page.locator('[data-testid="ops-flow-queue"]')).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).first().click();
}

async function approveTask(page: Page, taskId: string) {
  const row = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]')).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".toast-success").filter({ hasText: "Manual review: approved" }).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Ops manual review", () => {
  test("hotkeys: 1 approves, 2 rejects", async ({ page, request }) => {
    await seedManualRequiredTask(request, "hk-approve");
    await seedManualRequiredTask(request, "hk-reject");
    await openOps(page);

    await page.locator('[data-testid="ops-preset-manual-review"]').click();

    // Approve via "1"
    await page.locator('[data-testid="ops-manual-take-next"]').click();
    const badge1 = page.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]').first();
    await expect(badge1).toBeVisible({ timeout: 20_000 });
    const claimed1 = await badge1.evaluate((el) => el.closest('[data-testid="ops-flow-row"]')?.getAttribute("data-task-id") ?? "");
    expect(claimed1).toBeTruthy();
    await page.keyboard.press("1");
    await expect(page.locator(".toast-success").filter({ hasText: "Manual review: approved" }).first()).toBeVisible({ timeout: 20_000 });

    const fetchedApproved = await request.get(`${API_URL}/v1/tasks/${claimed1}`, { headers: apiHeaders() });
    expect(fetchedApproved.ok()).toBeTruthy();
    const approvedBody = (await fetchedApproved.json()) as { review?: { review_status?: string } };
    expect(approvedBody.review?.review_status).toBe("approved");

    // Reject via "2"
    await page.locator('[data-testid="ops-manual-take-next"]').click();
    const badge2 = page.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]').first();
    await expect(badge2).toBeVisible({ timeout: 20_000 });
    const claimed2 = await badge2.evaluate((el) => el.closest('[data-testid="ops-flow-row"]')?.getAttribute("data-task-id") ?? "");
    expect(claimed2).toBeTruthy();
    await page.keyboard.press("2");
    await expect(page.locator(".toast-success").filter({ hasText: "Manual review: rejected" }).first()).toBeVisible({ timeout: 20_000 });

    const fetchedRejected = await request.get(`${API_URL}/v1/tasks/${claimed2}`, { headers: apiHeaders() });
    expect(fetchedRejected.ok()).toBeTruthy();
    const rejectedBody = (await fetchedRejected.json()) as { review?: { review_status?: string } };
    expect(rejectedBody.review?.review_status).toBe("rejected");
  });

  test("hotkeys: j/k navigate, a approves", async ({ page, request }) => {
    await seedManualRequiredTask(request, "hk-nav-a");
    await seedManualRequiredTask(request, "hk-nav-b");
    await openOps(page);

    await page.locator('[data-testid="ops-preset-manual-review"]').click();
    await expect.poll(async () => page.locator('[data-testid="ops-flow-row"]').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    const firstRow = page.locator('[data-testid="ops-flow-row"]').first();
    await firstRow.focus();
    await firstRow.press("Enter");
    const activeRow = page.locator('[data-testid="ops-flow-row"][aria-selected="true"]').first();
    await expect(activeRow).toBeVisible({ timeout: 20_000 });
    const beforeId = await activeRow.getAttribute("data-task-id");
    expect(beforeId).toBeTruthy();

    const manualBar = page
      .locator('[data-testid="ops-flow-queue"] .row-tight')
      .filter({ has: page.locator('[data-testid="ops-manual-release"]') })
      .first();
    const prevBtn = manualBar.getByRole("button", { name: /^Previous$/ });
    const nextBtn = manualBar.getByRole("button", { name: /^Next$/ });
    await expect
      .poll(async () => (await prevBtn.isEnabled()) || (await nextBtn.isEnabled()), { timeout: 20_000 })
      .toBeTruthy();
    const canPrev = await prevBtn.isEnabled();
    const canNext = await nextBtn.isEnabled();

    if (canNext) {
      await page.keyboard.press("j");
      await expect
        .poll(async () => page.locator('[data-testid="ops-flow-row"][aria-selected="true"]').first().getAttribute("data-task-id"), {
          timeout: 20_000
        })
        .not.toBe(beforeId);
      await page.keyboard.press("k");
      await expect
        .poll(async () => page.locator('[data-testid="ops-flow-row"][aria-selected="true"]').first().getAttribute("data-task-id"), {
          timeout: 20_000
        })
        .toBe(beforeId);
    } else {
      await page.keyboard.press("k");
      await expect
        .poll(async () => page.locator('[data-testid="ops-flow-row"][aria-selected="true"]').first().getAttribute("data-task-id"), {
          timeout: 20_000
        })
        .not.toBe(beforeId);
      await page.keyboard.press("j");
      await expect
        .poll(async () => page.locator('[data-testid="ops-flow-row"][aria-selected="true"]').first().getAttribute("data-task-id"), {
          timeout: 20_000
        })
        .toBe(beforeId);
    }

    await page.keyboard.press("a");
    await expect(page.locator(".toast-success").filter({ hasText: "Manual review: approved" }).first()).toBeVisible({ timeout: 20_000 });
  });

  test("take next → approve", async ({ page, request }) => {
    const taskId = await seedManualRequiredTask(request, "take-next");
    await openOps(page);

    await page.locator('[data-testid="ops-preset-manual-review"]').click();

    await page.locator('[data-testid="ops-manual-take-next"]').click();

    const row = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    await expect(row.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]')).toBeVisible({
      timeout: 20_000
    });

    await row.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator(".toast-success").filter({ hasText: "Manual review: approved" }).first()).toBeVisible({ timeout: 20_000 });

    await expect(page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`)).toHaveCount(0, { timeout: 20_000 });

    const fetched = await request.get(`${API_URL}/v1/tasks/${taskId}`, { headers: apiHeaders() });
    expect(fetched.ok()).toBeTruthy();
    const fetchedBody = (await fetched.json()) as { review?: { review_status?: string } };
    expect(fetchedBody.review?.review_status).toBe("approved");
  });

  test("take next → release", async ({ page, request }) => {
    const taskId = await seedManualRequiredTask(request, "release");
    await openOps(page);

    await page.locator('[data-testid="ops-preset-manual-review"]').click();
    await page.locator('[data-testid="ops-manual-take-next"]').click();

    const row = page.locator(`[data-testid="ops-flow-row"][data-task-id="${taskId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-testid="ops-manual-release"]').click();
    await expect(page.locator(".toast-success").filter({ hasText: "Released manual review lock" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('[data-testid="ops-claim-badge"]')).toHaveCount(0, { timeout: 20_000 });

    await approveTask(page, taskId);
  });

  test("skip advances to a different task", async ({ page, request }) => {
    const taskA = await seedManualRequiredTask(request, "skip-a");
    const taskB = await seedManualRequiredTask(request, "skip-b");
    await openOps(page);

    await page.locator('[data-testid="ops-preset-manual-review"]').click();
    await page.locator('[data-testid="ops-manual-take-next"]').click();

    const mineBadge = page.locator(
      '[data-testid="ops-flow-row"] [data-testid="ops-claim-badge"][data-claim-state="mine"]'
    ).first();
    await expect(mineBadge).toBeVisible({ timeout: 20_000 });
    const claimedId = await mineBadge.evaluate((el) =>
      el.closest('[data-testid="ops-flow-row"]')?.getAttribute("data-task-id") ?? ""
    );
    expect([taskA, taskB]).toContain(claimedId);
    const otherId = claimedId === taskA ? taskB : taskA;

    await page.locator('[data-testid="ops-manual-skip"]').click();

    const claimedRow = page.locator(`[data-testid="ops-flow-row"][data-task-id="${claimedId}"]`);
    await expect(claimedRow).toBeVisible({ timeout: 20_000 });
    await expect(claimedRow.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]')).toHaveCount(0, { timeout: 20_000 });

    const otherRow = page.locator(`[data-testid="ops-flow-row"][data-task-id="${otherId}"]`);
    await expect(otherRow).toBeVisible({ timeout: 20_000 });
    await expect(otherRow.locator('[data-testid="ops-claim-badge"][data-claim-state="mine"]')).toBeVisible({ timeout: 20_000 });

    await approveTask(page, otherId);
    await approveTask(page, claimedId);
  });
});

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

async function seedQueuedTask(request: APIRequestContext, suffix: string): Promise<string> {
  await ensurePurchased(request, `e2e-operator-purchase-${suffix}-${Date.now()}`);
  const created = await request.post(`${API_URL}/v1/tasks`, {
    headers: apiHeaders(),
    data: {
      task_type: "stuck_recovery",
      context: { logs: `operator-${suffix}` },
      sla_seconds: 120
    }
  });
  expect(created.ok()).toBeTruthy();
  const body = (await created.json()) as { id: string };
  return body.id;
}

async function openOperator(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Operator" }).click();
  await expect(page.locator('[data-testid="operator-queue"]')).toBeVisible();
  await expect(page.locator('[data-testid="operator-actions"]')).toBeVisible();
}

test.describe("Operator smoke", () => {
  test("claim → add proof → complete", async ({ page, request }) => {
    const taskId = await seedQueuedTask(request, "smoke");
    await openOperator(page);

    const row = page.locator(`[data-testid="operator-task-row"][data-task-id="${taskId}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    await page.locator('[data-testid="operator-add-proof"]').click();
    await expect(page.locator('[data-testid="operator-task-summary"]')).toContainText("Proof: present", { timeout: 20_000 });

    await page.locator('[data-testid="operator-claim"]').click();
    await expect(page.locator('[data-testid="operator-task-summary"]')).toContainText("Status: claimed", { timeout: 20_000 });

    await page.locator('[data-testid="operator-complete"]').click();
    await expect(page.locator('[data-testid="operator-task-summary"]')).toContainText("Status: completed", { timeout: 20_000 });
  });
});


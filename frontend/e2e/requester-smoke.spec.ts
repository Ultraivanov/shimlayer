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

async function openRequester(page: Page) {
  await page.goto("/");
  await expect(page.locator('[data-testid="requester-credit-wallet"]')).toBeVisible();
  await expect(page.locator('[data-testid="requester-my-tasks"]')).toBeVisible();
}

test.describe("Requester smoke", () => {
  test("create → upload artifact → complete → download bundle", async ({ page, request }) => {
    await ensurePurchased(request, `e2e-requester-purchase-${Date.now()}`);
    await openRequester(page);

    // Create task via form
    await page.getByRole("button", { name: "Load stuck preset" }).click();
    await page.getByRole("button", { name: "Create task" }).click();

    // Wait for Task Details to show a UUID in the ID field
    const taskDetails = page.locator('[data-testid="requester-task-details"]');
    const idLine = taskDetails.locator('[data-testid="requester-task-summary"] .mono').first();
    await expect(idLine).toBeVisible({ timeout: 20_000 });
    const taskId = (await idLine.textContent())?.trim() ?? "";
    expect(taskId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    // Upload local proof artifact
    await page.locator('[data-testid="requester-artifacts"]').scrollIntoViewIfNeeded();
    const fileInput = page.locator('[data-testid="requester-upload-file"]').first();
    await fileInput.setInputFiles({
      name: "proof.log",
      mimeType: "text/plain",
      buffer: Buffer.from(`proof for ${taskId}\n${new Date().toISOString()}\n`, "utf-8")
    });
    await page.getByRole("button", { name: "Upload artifact" }).click();

    // Complete (wait for proof present)
    const taskDetailsCard = taskDetails;
    const proofLine = taskDetailsCard.locator(".detail-block p").filter({ hasText: "Proof:" }).first();
    await expect(proofLine).toContainText("present", { timeout: 20_000 });
    await taskDetailsCard.getByRole("button", { name: "Complete" }).click();

    const statusChip = taskDetailsCard.locator(".detail-block .status").first();
    await expect(statusChip).toContainText("completed", { timeout: 20_000 });

    // Download bundle
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download bundle" }).click();
    const dl = await downloadPromise;
    expect(dl.suggestedFilename()).toMatch(/^task-.*\.zip$/);
  });
});

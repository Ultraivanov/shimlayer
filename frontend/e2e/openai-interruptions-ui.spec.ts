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
  await expect(page.locator('[data-testid="requester-openai-interruptions"]')).toBeVisible();
}

test.describe("Requester OpenAI interruptions UI", () => {
  test("ingest via UI → approve → resume", async ({ page, request }) => {
    const stamp = Date.now();
    await ensurePurchased(request, `e2e-openai-ui-purchase-${stamp}`);
    await openRequester(page);

    const interruptionId = `int_ui_${stamp}`;
    const runId = `run_ui_${stamp}`;
    const stateBlob = `opaque_state_ui_${stamp}`;

    const panel = page.locator('[data-testid="requester-openai-interruptions"]');
    await panel.locator('[data-testid="requester-openai-ingest"]').scrollIntoViewIfNeeded();

    await panel.getByPlaceholder("interruption_id").fill(interruptionId);
    await panel.getByPlaceholder("run_id").fill(runId);
    await panel.getByPlaceholder("tool_name").fill("cancelOrder");
    await panel.getByPlaceholder("sla_seconds (30..900)").fill("120");
    await panel.getByPlaceholder("state_blob (required)").fill(stateBlob);

    await panel.locator('[data-testid="requester-openai-ingest"]').click();

    const record = panel.locator('[data-testid="requester-openai-record"]');
    await expect(record).toBeVisible({ timeout: 20_000 });
    await expect(record).toContainText(interruptionId);
    await expect(record).toContainText(runId);
    await expect(record).toContainText("pending");

    await record.locator('[data-testid="requester-openai-open-task"]').click();
    const details = page.locator('[data-testid="requester-task-details"]');
    await expect(details).toBeVisible({ timeout: 20_000 });
    await expect(details).toContainText("openai.interruption");

    await record.getByPlaceholder("decision note (optional)").fill("ok");
    await record.locator('[data-testid="requester-openai-decide-approve"]').click();
    await expect(record).toContainText("decided", { timeout: 20_000 });

    await page.locator('[data-testid="requester-my-tasks"]').getByRole("button", { name: "Refresh" }).click();
    await expect(details.locator(".status").first()).toContainText("completed", { timeout: 20_000 });

    await record.locator('[data-testid="requester-openai-resume"]').click();
    await expect(panel.locator('[data-testid="requester-openai-resume-payload"]')).toContainText(stateBlob, { timeout: 20_000 });
    await expect(panel.locator('[data-testid="requester-openai-resume-payload"]')).toContainText("approve");
  });
});


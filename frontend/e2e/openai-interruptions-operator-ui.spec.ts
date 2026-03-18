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

async function openOperator(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Operator" }).click();
  await expect(page.locator('[data-testid="operator-queue"]')).toBeVisible();
  await expect(page.locator('[data-testid="operator-actions"]')).toBeVisible();
}

test.describe("Operator OpenAI interruptions UI", () => {
  test("load via task → claim → approve → resume", async ({ page, request }) => {
    const stamp = Date.now();
    await ensurePurchased(request, `e2e-openai-operator-ui-purchase-${stamp}`);

    const interruptionId = `int_op_ui_${stamp}`;
    const runId = `run_op_ui_${stamp}`;
    const stateBlob = `opaque_state_op_ui_${stamp}`;

    const ingestRes = await request.post(`${API_URL}/v1/openai/interruptions/ingest`, {
      headers: apiHeaders(),
      data: {
        run_id: runId,
        thread_id: `thread_${stamp}`,
        interruption_id: interruptionId,
        agent_name: "support-agent",
        tool_name: "cancelOrder",
        tool_arguments: { orderId: 321 },
        state_blob: stateBlob,
        metadata: { tenant: "e2e" },
        callback_url: "https://example.invalid/openai/resume",
        sla_seconds: 120
      }
    });
    expect(ingestRes.ok()).toBeTruthy();
    const ingestBody = (await ingestRes.json()) as { task_id: string };
    const taskId = ingestBody.task_id;
    expect(taskId).toBeTruthy();

    await openOperator(page);

    const queue = page.locator('[data-testid="operator-queue"]');
    await queue.getByPlaceholder("Open by Task ID (UUID)").fill(taskId);
    await queue.locator('[data-testid="operator-open-by-id"]').click();

    const interruptionPanel = page.locator('[data-testid="operator-openai-interruptions"]');
    await expect(interruptionPanel).toBeVisible();
    const record = page.locator('[data-testid="operator-openai-record"]');
    await expect(record).toBeVisible({ timeout: 20_000 });
    await expect(record).toContainText(interruptionId);
    await expect(record).toContainText("pending");

    await page.locator('[data-testid="operator-claim"]').click();

    await record.getByPlaceholder("decision note (optional)").fill("ok");
    await record.locator('[data-testid="operator-openai-decide-approve"]').click();
    await expect(record).toContainText("decided", { timeout: 20_000 });

    await record.locator('[data-testid="operator-openai-resume"]').click();
    await expect(interruptionPanel.locator('[data-testid="operator-openai-resume-payload"]')).toContainText(stateBlob, { timeout: 20_000 });
    await expect(interruptionPanel.locator('[data-testid="operator-openai-resume-payload"]')).toContainText("approve");
  });
});


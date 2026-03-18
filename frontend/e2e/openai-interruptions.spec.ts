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

test.describe("OpenAI HITL adapter e2e", () => {
  test("ingest → requester sees task → decision → resume", async ({ page, request }) => {
    const stamp = Date.now();
    await ensurePurchased(request, `e2e-openai-purchase-${stamp}`);

    const interruptionId = `int_${stamp}`;
    const runId = `run_${stamp}`;

    const ingest = await request.post(`${API_URL}/v1/openai/interruptions/ingest`, {
      headers: apiHeaders(),
      data: {
        run_id: runId,
        thread_id: `thread_${stamp}`,
        interruption_id: interruptionId,
        agent_name: "e2e-agent",
        tool_name: "selector_click",
        tool_arguments: { selector: "#checkout button.primary", note: "e2e" },
        state_blob: `opaque_state_${stamp}`,
        metadata: { source: "e2e" },
        callback_url: null,
        sla_seconds: 120
      }
    });
    expect(ingest.ok()).toBeTruthy();
    const ingested = (await ingest.json()) as { task_id: string; status: string; interruption_id: string; run_id: string };
    expect(ingested.interruption_id).toBe(interruptionId);
    expect(ingested.run_id).toBe(runId);
    expect(ingested.status).toBe("pending");
    expect(ingested.task_id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    // Idempotency: second ingest returns existing record.
    const ingest2 = await request.post(`${API_URL}/v1/openai/interruptions/ingest`, {
      headers: apiHeaders(),
      data: {
        run_id: runId,
        interruption_id: interruptionId,
        tool_name: "selector_click",
        tool_arguments: {},
        state_blob: `opaque_state_${stamp}`,
        metadata: { source: "e2e-2" }
      }
    });
    expect(ingest2.ok()).toBeTruthy();
    const ingested2 = (await ingest2.json()) as { task_id: string; interruption_id: string };
    expect(ingested2.interruption_id).toBe(interruptionId);
    expect(ingested2.task_id).toBe(ingested.task_id);

    // Requester UI: open by ID and see the interruption context capsule.
    await openRequester(page);
    await page.getByPlaceholder("Open by Task ID").fill(ingested.task_id);
    await page.getByRole("button", { name: "Open" }).click();
    const details = page.locator('[data-testid="requester-task-details"]');
    await expect(details).toBeVisible({ timeout: 20_000 });
    await expect(details).toContainText("openai.interruption");
    await expect(details).toContainText(interruptionId);
    await expect(details).toContainText(runId);

    // Decision completes the linked task and marks interruption as decided.
    const decide = await request.post(`${API_URL}/v1/openai/interruptions/${encodeURIComponent(interruptionId)}/decision`, {
      headers: apiHeaders(),
      data: {
        decision: "approve",
        actor: "e2e",
        note: "ok",
        output: { approved: true }
      }
    });
    expect(decide.ok()).toBeTruthy();
    const decided = (await decide.json()) as { status: string; decision: string; task_id: string };
    expect(decided.task_id).toBe(ingested.task_id);
    expect(decided.status).toBe("decided");
    expect(decided.decision).toBe("approve");

    // Requester UI converges after refresh.
    await page.locator('[data-testid="requester-my-tasks"]').getByRole("button", { name: "Refresh" }).click();
    await expect(details.locator(".status").first()).toContainText("completed", { timeout: 20_000 });

    // Resume returns the resumable payload and marks interruption resumed.
    const resume = await request.post(`${API_URL}/v1/openai/interruptions/${encodeURIComponent(interruptionId)}/resume`, {
      headers: apiHeaders()
    });
    expect(resume.ok()).toBeTruthy();
    const resumed = (await resume.json()) as {
      interruption_id: string;
      run_id: string;
      resume_enqueued: boolean;
      resume_payload: { interruption_id: string; run_id: string; decision: string; state_blob: string };
    };
    expect(resumed.interruption_id).toBe(interruptionId);
    expect(resumed.run_id).toBe(runId);
    expect(resumed.resume_enqueued).toBeTruthy();
    expect(resumed.resume_payload.interruption_id).toBe(interruptionId);
    expect(resumed.resume_payload.run_id).toBe(runId);
    expect(resumed.resume_payload.decision).toBe("approve");
    expect(resumed.resume_payload.state_blob).toBe(`opaque_state_${stamp}`);
  });
});

import type {
  BalanceResponse,
  DeadLetter,
  LedgerEntry,
  WebhookDelivery,
  OpsActionResponse,
  OpsBulkActionResponse,
  OpsTimelineEvent,
  OpsMetrics,
  OpsMetricsHistoryPoint,
  OpsObservability,
  OpsMarginSummary,
  OpsIncidentEvent,
  PackageInfo,
  Task,
  TaskAuditEntry,
  OpsIncident,
  TaskWithReview,
  TaskSyncResponse,
  OpenAIInterruptionRecord,
  OpenAIResumeResponse,
  LeadCreateRequest,
  LeadRecord,
  OperatorApplicationCreateRequest,
  OperatorApplicationRecord,
  OperatorRecord,
  OperatorDeliveryRecord,
  OperatorAuditEntry
} from "./types";

type Config = {
  baseUrl: string;
  apiKey: string;
  adminKey: string;
  adminRole: string;
  adminUser: string;
  operatorKey: string;
};

type OpsFlowListParams = {
  limit?: number;
  status?: string;
  taskType?: string;
  onlyProblem?: boolean;
  onlySlaBreach?: boolean;
  onlyManualReview?: boolean;
};

export const config: Config = {
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  apiKey: import.meta.env.VITE_API_KEY ?? "demo-key",
  adminKey: import.meta.env.VITE_ADMIN_KEY ?? "dev-admin-key",
  adminRole: import.meta.env.VITE_ADMIN_ROLE ?? "admin",
  adminUser: import.meta.env.VITE_ADMIN_USER ?? "local-admin",
  operatorKey: import.meta.env.VITE_OPERATOR_KEY ?? ""
};

const ADMIN_USER_OVERRIDE_KEY = "ops.adminUserOverride";

export function getAdminUser(): string {
  try {
    return localStorage.getItem(ADMIN_USER_OVERRIDE_KEY) ?? config.adminUser;
  } catch {
    return config.adminUser;
  }
}

async function http<T>(path: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  headers.set("X-API-Key", config.apiKey);
  if (admin) {
    headers.set("X-Admin-Key", config.adminKey);
    headers.set("X-Admin-Role", config.adminRole);
    headers.set("X-Admin-User", getAdminUser());
  }
  const res = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

async function httpOperator<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (config.operatorKey) {
    headers.set("X-Operator-Key", config.operatorKey);
  } else {
    headers.set("X-API-Key", config.apiKey);
  }
  const res = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

function parseDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  // RFC 5987 / RFC 6266-ish:
  // - filename*=UTF-8''... (percent-encoded)
  // - filename="..."
  // - filename=...
  const star = value.match(/filename\\*\\s*=\\s*UTF-8''([^;]+)/i) ?? value.match(/filename\\*\\s*=\\s*([^;]+)/i);
  if (star && star[1]) {
    const raw = star[1].trim().replace(/^\"|\"$/g, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const quoted = value.match(/filename\\s*=\\s*\"([^\"]+)\"/i);
  if (quoted && quoted[1]) return quoted[1];
  const bare = value.match(/filename\\s*=\\s*([^;]+)/i);
  if (bare && bare[1]) return bare[1].trim().replace(/^\"|\"$/g, "");
  return null;
}

export const Api = {
  listPackages: () => http<PackageInfo[]>("/v1/billing/packages"),
  createLead: (payload: LeadCreateRequest) =>
    http<LeadRecord>("/v1/leads", { method: "POST", body: JSON.stringify(payload) }),
  createOperatorApplication: (payload: OperatorApplicationCreateRequest) =>
    http<OperatorApplicationRecord>("/v1/operator-applications", { method: "POST", body: JSON.stringify(payload) }),
  purchasePackage: (packageCode: string, reference: string) =>
    http("/v1/billing/packages/purchase", {
      method: "POST",
      body: JSON.stringify({ package_code: packageCode, reference })
    }),
  getBalance: () => http<BalanceResponse>("/v1/billing/balance"),
  listOpsOperatorApplications: (params: { status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status_filter", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<OperatorApplicationRecord[]>(`/v1/ops/operator-applications${suffix}`, {}, true);
  },
  updateOpsOperatorApplication: (applicationId: string, payload: { status: string; decision_note?: string | null; telegram_chat_id?: string | null }) =>
    http<OperatorApplicationRecord>(`/v1/ops/operator-applications/${applicationId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }, true),
  approveOpsOperatorApplication: (applicationId: string, payload: { decision_note?: string | null; telegram_chat_id?: string | null }) =>
    http<{ application: OperatorApplicationRecord; operator: Record<string, unknown>; operator_token: string }>(
      `/v1/ops/operator-applications/${applicationId}/approve`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      true
    ),
  getOpsOperator: (operatorId: string) =>
    http<OperatorRecord>(`/v1/ops/operators/${operatorId}`, {}, true),
  rotateOpsOperatorToken: (operatorId: string) =>
    http<{ operator: OperatorRecord; operator_token: string }>(`/v1/ops/operators/${operatorId}/rotate-token`, { method: "POST" }, true),
  updateOpsOperatorStatus: (operatorId: string, status: "active" | "disabled") =>
    http<OperatorRecord>(
      `/v1/ops/operators/${operatorId}/status`,
      { method: "POST", body: JSON.stringify({ status }) },
      true
    ),
  updateOpsOperatorVerification: (operatorId: string, payload: { verification_status: "pending" | "verified" | "rejected"; verification_note?: string | null }) =>
    http<OperatorRecord>(
      `/v1/ops/operators/${operatorId}/verification`,
      { method: "POST", body: JSON.stringify(payload) },
      true
    ),
  getOpsOperatorLastDelivery: (operatorId: string) =>
    http<OperatorDeliveryRecord | null>(`/v1/ops/operators/${operatorId}/deliveries/last`, {}, true),
  getOpsOperatorAudit: (operatorId: string, limit = 20) =>
    http<OperatorAuditEntry[]>(`/v1/ops/operators/${operatorId}/audit?limit=${limit}`, {}, true),
  unlinkOpsOperatorChat: (operatorId: string) =>
    http<OperatorRecord>(`/v1/ops/operators/${operatorId}/unlink-chat`, { method: "POST" }, true),
  notifyOperatorTask: (operatorId: string, payload: { task_id: string; message?: string | null }) =>
    http(`/v1/ops/operators/${operatorId}/notify-task`, {
      method: "POST",
      body: JSON.stringify(payload)
    }, true),
  listOperatorQueue: (params: { status?: string; taskType?: string; onlyManualReview?: boolean; mineOnly?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    if (params.onlyManualReview) q.set("only_manual_review", "true");
    if (params.mineOnly) q.set("mine_only", "true");
    if (params.limit) q.set("limit", String(params.limit));
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return httpOperator<TaskWithReview[]>(`/v1/operator/queue${suffix}`);
  },
  getOperatorMe: () => httpOperator<OperatorRecord>("/v1/operator/me"),
  getOperatorLastDelivery: () => httpOperator<OperatorDeliveryRecord | null>("/v1/operator/deliveries/last"),
  getOperatorTask: (taskId: string) => httpOperator<TaskWithReview>(`/v1/operator/tasks/${taskId}`),
  claimOperatorTask: (taskId: string) => httpOperator<Task>(`/v1/operator/tasks/${taskId}/claim`, { method: "POST" }),
  completeOperatorTask: (taskId: string, result: Record<string, unknown>, workerNote?: string | null) =>
    httpOperator<Task>(`/v1/operator/tasks/${taskId}/complete`, {
      method: "POST",
      body: JSON.stringify({ result, worker_note: workerNote ?? null })
    }),
  uploadOperatorProof: (taskId: string, payload: Record<string, unknown>) =>
    httpOperator(`/v1/operator/tasks/${taskId}/proof`, { method: "POST", body: JSON.stringify(payload) }),
  uploadOperatorArtifact: (taskId: string, payload: Record<string, unknown>) =>
    httpOperator(`/v1/operator/tasks/${taskId}/artifacts/upload`, { method: "POST", body: JSON.stringify(payload) }),
  createTask: (payload: Record<string, unknown>) =>
    http<Task>("/v1/tasks", { method: "POST", body: JSON.stringify(payload) }),
  createJudgment: (payload: Record<string, unknown>) =>
    http<Task>("/v1/judgments", { method: "POST", body: JSON.stringify(payload) }),
  getTask: (taskId: string) => http<TaskWithReview>(`/v1/tasks/${taskId}`),
  listMyTasks: (params: { limit?: number; status?: string; taskType?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<TaskWithReview[]>(`/v1/tasks${suffix}`);
  },
  syncMyTasks: (params: { limit?: number; cursor?: string; updatedAfter?: string; status?: string; taskType?: string } = {}) => {
    const q = new URLSearchParams();
    q.set("limit", String(params.limit ?? 50));
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.updatedAfter) q.set("updated_after", params.updatedAfter);
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<TaskSyncResponse>(`/v1/tasks/sync${suffix}`);
  },
  claimTask: (taskId: string) => http<Task>(`/v1/tasks/${taskId}/claim`, { method: "POST" }),
  completeTask: (taskId: string, result: Record<string, unknown>, workerNote?: string | null) =>
    http<Task>(`/v1/tasks/${taskId}/complete`, {
      method: "POST",
      body: JSON.stringify({ result, worker_note: workerNote ?? null })
    }),
  uploadProof: (taskId: string, payload: Record<string, unknown>) =>
    http(`/v1/tasks/${taskId}/proof`, { method: "POST", body: JSON.stringify(payload) }),
  uploadArtifact: (taskId: string, payload: Record<string, unknown>) =>
    http(`/v1/tasks/${taskId}/artifacts/upload`, { method: "POST", body: JSON.stringify(payload) }),
  uploadArtifactMultipart: async (taskId: string, artifactType: string, file: File) => {
    const body = new FormData();
    body.set("artifact_type", artifactType);
    body.set("file", file, file.name);
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    const res = await fetch(`${config.baseUrl}/v1/tasks/${taskId}/artifacts/upload-multipart`, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as unknown;
  },
  downloadArtifact: async (taskId: string, artifactId: string, fallbackFilename?: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    const res = await fetch(`${config.baseUrl}/v1/tasks/${taskId}/artifacts/${artifactId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? fallbackFilename ?? "artifact.bin";
    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
    const checksum = res.headers.get("X-Checksum-Sha256") ?? "";
    return { blob, filename, contentType, checksum };
  },
  downloadOpsArtifact: async (taskId: string, artifactId: string, fallbackFilename?: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    headers.set("X-Admin-Key", config.adminKey);
    headers.set("X-Admin-Role", config.adminRole);
    headers.set("X-Admin-User", getAdminUser());
    const res = await fetch(`${config.baseUrl}/v1/ops/flows/${taskId}/artifacts/${artifactId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? fallbackFilename ?? "artifact.bin";
    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
    const checksum = res.headers.get("X-Checksum-Sha256") ?? "";
    return { blob, filename, contentType, checksum };
  },
  downloadOpsFlowBundle: async (taskId: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    headers.set("X-Admin-Key", config.adminKey);
    headers.set("X-Admin-Role", config.adminRole);
    headers.set("X-Admin-User", getAdminUser());
    const res = await fetch(`${config.baseUrl}/v1/ops/flows/${taskId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? `flow-${taskId}.zip`;
    const contentType = res.headers.get("Content-Type") ?? "application/zip";
    return { blob, filename, contentType };
  },
  downloadOpsFlowBundlesZip: async (taskIds: string[]) => {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("X-API-Key", config.apiKey);
    headers.set("X-Admin-Key", config.adminKey);
    headers.set("X-Admin-Role", config.adminRole);
    headers.set("X-Admin-User", getAdminUser());
    const res = await fetch(`${config.baseUrl}/v1/ops/flows/download-bulk`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task_ids: taskIds })
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? "flows-selected.zip";
    const contentType = res.headers.get("Content-Type") ?? "application/zip";
    return { blob, filename, contentType };
  },
  downloadTaskBundle: async (taskId: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    const res = await fetch(`${config.baseUrl}/v1/tasks/${taskId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? `task-${taskId}.zip`;
    const contentType = res.headers.get("Content-Type") ?? "application/zip";
    return { blob, filename, contentType };
  },
  listTaskWebhookDeliveries: (taskId: string, limit = 20) => {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    return http<WebhookDelivery[]>(`/v1/tasks/${encodeURIComponent(taskId)}/webhooks/deliveries?${q.toString()}`);
  },
  getTaskWebhookLastDelivery: (taskId: string) =>
    http<WebhookDelivery | null>(`/v1/tasks/${encodeURIComponent(taskId)}/webhooks/last`),
  refundTask: (taskId: string) => http<Task>(`/v1/tasks/${taskId}/refund`, { method: "POST" }),
  ingestOpenAIInterruption: (payload: Record<string, unknown>) =>
    http<OpenAIInterruptionRecord>("/v1/openai/interruptions/ingest", { method: "POST", body: JSON.stringify(payload) }),
  getOpenAIInterruption: (interruptionId: string) =>
    http<OpenAIInterruptionRecord>(`/v1/openai/interruptions/${encodeURIComponent(interruptionId)}`),
  decideOpenAIInterruption: (interruptionId: string, payload: Record<string, unknown>) =>
    http<OpenAIInterruptionRecord>(
      `/v1/openai/interruptions/${encodeURIComponent(interruptionId)}/decision`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
  resumeOpenAIInterruption: (interruptionId: string) =>
    http<OpenAIResumeResponse>(`/v1/openai/interruptions/${encodeURIComponent(interruptionId)}/resume`, { method: "POST" }),
  getOpsMetrics: () => http<OpsMetrics>("/v1/ops/metrics", {}, true),
  getOpsMetricsHistory: (limit = 48) =>
    http<OpsMetricsHistoryPoint[]>(`/v1/ops/metrics/history?limit=${limit}`, {}, true),
  getDlq: (limit = 20) => http<DeadLetter[]>(`/v1/ops/dlq?limit=${limit}`, {}, true),
  getOpsManualReviewQueue: (params: { limit?: number; status?: string; taskType?: string; includeLocked?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    if (params.includeLocked) q.set("include_locked", "true");
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<TaskWithReview[]>(`/v1/ops/manual-review${suffix}`, {}, true);
  },
  claimNextManualReview: (params: { status?: string; taskType?: string; excludeTaskId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    if (params.excludeTaskId) q.set("exclude_task_id", params.excludeTaskId);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<TaskWithReview | null>(`/v1/ops/manual-review/claim-next${suffix}`, { method: "POST" }, true);
  },
  claimManualReview: (taskId: string) =>
    http<TaskWithReview>(`/v1/ops/manual-review/${taskId}/claim`, { method: "POST" }, true),
  takeOverManualReview: (taskId: string) =>
    http<TaskWithReview>(`/v1/ops/manual-review/${taskId}/take-over`, { method: "POST" }, true),
  releaseManualReview: (taskId: string) =>
    http<void>(`/v1/ops/manual-review/${taskId}/release`, { method: "POST" }, true),
  listOpsFlows: (params: OpsFlowListParams = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.status) q.set("status_filter", params.status);
    if (params.taskType) q.set("task_type", params.taskType);
    if (params.onlyProblem) q.set("only_problem", "true");
    if (params.onlySlaBreach) q.set("only_sla_breach", "true");
    if (params.onlyManualReview) q.set("only_manual_review", "true");
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return http<Task[]>(`/v1/ops/flows${suffix}`, {}, true);
  },
  getOpsFlow: (taskId: string) => http<TaskWithReview>(`/v1/ops/flows/${taskId}`, {}, true),
  getOpsFlowAudit: (taskId: string, limit = 50) =>
    http<TaskAuditEntry[]>(`/v1/ops/flows/${taskId}/audit?limit=${limit}`, {}, true),
  getOpsFlowTimeline: (taskId: string) =>
    http<OpsTimelineEvent[]>(`/v1/ops/flows/${taskId}/timeline`, {}, true),
  listOpsIncidents: (status?: string, limit = 50) => {
    const q = new URLSearchParams();
    if (status) q.set("status_filter", status);
    q.set("limit", String(limit));
    return http<OpsIncident[]>(`/v1/ops/incidents?${q.toString()}`, {}, true);
  },
  createOpsIncident: (payload: Record<string, unknown>) =>
    http<OpsIncident>("/v1/ops/incidents", { method: "POST", body: JSON.stringify(payload) }, true),
  updateOpsIncident: (incidentId: string, payload: Record<string, unknown>) =>
    http<OpsIncident>(`/v1/ops/incidents/${incidentId}`, { method: "PATCH", body: JSON.stringify(payload) }, true),
  getOpsIncidentEvents: (incidentId: string, limit = 100) =>
    http<OpsIncidentEvent[]>(`/v1/ops/incidents/${incidentId}/events?limit=${limit}`, {}, true),
  scanOpsIncidents: (overdueThreshold = 5) =>
    http<OpsIncident | null>("/v1/ops/incidents/scan", { method: "POST", body: JSON.stringify({ overdue_threshold: overdueThreshold }) }, true),
  getOpsLedger: (limit = 100) => http<LedgerEntry[]>(`/v1/ops/finance/ledger?limit=${limit}`, {}, true),
  getOpsMargin: () => http<OpsMarginSummary>("/v1/ops/finance/margin", {}, true),
  getOpsObservability: () => http<OpsObservability>("/v1/ops/observability", {}, true),
  opsAction: (taskId: string, payload: Record<string, unknown>) =>
    http<OpsActionResponse>(`/v1/ops/flows/${taskId}/actions`, { method: "POST", body: JSON.stringify(payload) }, true),
  bulkOpsAction: (payload: Record<string, unknown>) =>
    http<OpsBulkActionResponse>(
      "/v1/ops/flows/bulk-actions",
      { method: "POST", body: JSON.stringify(payload) },
      true
    ),
  requeueDlq: (deadLetterId: string) =>
    http<{ requeued: boolean }>(`/v1/webhooks/dlq/${deadLetterId}/requeue`, { method: "POST" }, true),
  listWebhookDeliveries: (taskId: string, limit = 20) =>
    http<WebhookDelivery[]>(
      `/v1/ops/webhooks/deliveries?task_id=${encodeURIComponent(taskId)}&limit=${encodeURIComponent(String(limit))}`,
      {},
      true
    ),
  getOpsWebhookLastDelivery: (taskId: string) =>
    http<WebhookDelivery | null>(`/v1/ops/webhooks/last?task_id=${encodeURIComponent(taskId)}`, {}, true),
  resendWebhook: (taskId: string) => http<{ enqueued: boolean; reason?: string }>(`/v1/ops/webhooks/tasks/${taskId}/resend`, { method: "POST" }, true)
};

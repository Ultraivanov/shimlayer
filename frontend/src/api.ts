import type {
  BalanceResponse,
  DeadLetter,
  LedgerEntry,
  OpsActionResponse,
  OpsBulkActionResponse,
  OpsTimelineEvent,
  OpsMetrics,
  OpsObservability,
  OpsMarginSummary,
  OpsIncidentEvent,
  PackageInfo,
  Task,
  TaskAuditEntry,
  OpsIncident,
  TaskWithReview
} from "./types";

type Config = {
  baseUrl: string;
  apiKey: string;
  adminKey: string;
  adminRole: string;
  adminUser: string;
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
  adminUser: import.meta.env.VITE_ADMIN_USER ?? "local-admin"
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

function parseDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/filename="([^"]+)"/i);
  if (m && m[1]) return m[1];
  return null;
}

export const Api = {
  listPackages: () => http<PackageInfo[]>("/v1/billing/packages"),
  purchasePackage: (packageCode: string, reference: string) =>
    http("/v1/billing/packages/purchase", {
      method: "POST",
      body: JSON.stringify({ package_code: packageCode, reference })
    }),
  getBalance: () => http<BalanceResponse>("/v1/billing/balance"),
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
  downloadArtifact: async (taskId: string, artifactId: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    const res = await fetch(`${config.baseUrl}/v1/tasks/${taskId}/artifacts/${artifactId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? "artifact.bin";
    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
    const checksum = res.headers.get("X-Checksum-Sha256") ?? "";
    return { blob, filename, contentType, checksum };
  },
  downloadOpsArtifact: async (taskId: string, artifactId: string) => {
    const headers = new Headers();
    headers.set("X-API-Key", config.apiKey);
    headers.set("X-Admin-Key", config.adminKey);
    headers.set("X-Admin-Role", config.adminRole);
    headers.set("X-Admin-User", getAdminUser());
    const res = await fetch(`${config.baseUrl}/v1/ops/flows/${taskId}/artifacts/${artifactId}/download`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const filename = parseDispositionFilename(res.headers.get("Content-Disposition")) ?? "artifact.bin";
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
  refundTask: (taskId: string) => http<Task>(`/v1/tasks/${taskId}/refund`, { method: "POST" }),
  getOpsMetrics: () => http<OpsMetrics>("/v1/ops/metrics", {}, true),
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
    http<{ requeued: boolean }>(`/v1/webhooks/dlq/${deadLetterId}/requeue`, { method: "POST" }, true)
};

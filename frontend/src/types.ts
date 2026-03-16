export type PackageInfo = {
  code: string;
  flows: number;
  price_usd: number;
  unit_price_usd: number;
  active: boolean;
};

export type BalanceResponse = {
  account_id: string;
  balance_usd: number;
  flow_credits: number;
};

export type Task = {
  id: string;
  account_id: string;
  worker_id?: string | null;
  task_type: "stuck_recovery" | "quick_judgment";
  status: string;
  context?: Record<string, unknown>;
  callback_url?: string | null;
  sla_deadline?: string;
  created_at: string;
  updated_at: string;
  result?: Record<string, unknown> | null;
};

export type OpsMetrics = {
  queue_pending: number;
  queue_processing: number;
  queue_total: number;
  webhook_delivery_total: number;
  webhook_delivery_success_rate: number;
  webhook_retry_rate: number;
  webhook_dlq_count: number;
  manual_review_pending: number;
  task_resolution_p95_seconds: number | null;
  active_tasks: number;
  tasks_sla_risk: number;
  tasks_overdue: number;
  task_status_counts: Record<string, number>;
};

export type DeadLetter = {
  id: string;
  webhook_job_id: string;
  task_id: string;
  callback_url: string;
  payload: Record<string, unknown>;
  error: string | null;
  status_code: number | null;
  requeued_at: string | null;
  created_at: string;
};

export type TaskReview = {
  review_status: string;
  manual_verdict: string | null;
  auto_check_provider?: string;
  auto_check_model?: string | null;
  auto_check_score: number;
  auto_check_reason?: string | null;
  auto_check_redacted?: boolean | null;
  claimed_by?: string | null;
  claimed_until?: string | null;
};

export type TaskWithReview = Task & {
  artifacts: Array<Record<string, unknown>>;
  review: TaskReview | null;
};

export type TaskAuditEntry = {
  id: string;
  task_id: string;
  actor: string;
  action: string;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type OpsTimelineEvent = {
  at: string;
  kind: string;
  actor: string;
  message: string;
  metadata: Record<string, unknown>;
};

export type OpsActionResponse = {
  task: TaskWithReview;
  audit_entry: TaskAuditEntry | null;
};

export type OpsBulkActionResultItem = {
  task_id: string;
  ok: boolean;
  error?: string;
  task?: TaskWithReview | null;
  audit_entry?: TaskAuditEntry | null;
};

export type OpsBulkActionResponse = {
  results: OpsBulkActionResultItem[];
};

export type OpsIncident = {
  id: string;
  incident_type: string;
  severity: string;
  status: string;
  title: string;
  description?: string | null;
  owner?: string | null;
  source: string;
  postmortem?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
};

export type OpsIncidentEvent = {
  id: string;
  incident_id: string;
  actor: string;
  action: string;
  note?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LedgerEntry = {
  id: string;
  account_id?: string | null;
  task_id?: string | null;
  entry_type: string;
  amount_usd: number;
  currency: string;
  external_ref?: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export type OpsMarginSummary = {
  period: string;
  flows_used: number;
  refunds_count: number;
  avg_revenue_per_flow_usd: number;
  estimated_cost_per_flow_usd: number;
  estimated_revenue_usd: number;
  estimated_cost_usd: number;
  estimated_gross_profit_usd: number;
};

export type OpsObservability = {
  service: string;
  generated_at: string;
  request_id_echo?: string | null;
  open_incidents: number;
  ops_metrics: OpsMetrics;
};

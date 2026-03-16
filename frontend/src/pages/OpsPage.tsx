import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Dialog, Select, TextArea, TextInput } from "@gravity-ui/uikit";

import { Api, config, getAdminUser } from "../api";
import type {
  DeadLetter,
  LedgerEntry,
  OpsIncident,
  OpsMarginSummary,
  OpsMetrics,
  OpsObservability,
  Task,
  TaskAuditEntry,
  TaskWithReview
} from "../types";

const FORCE_STATUSES = ["queued", "claimed", "completed", "failed", "disputed", "refunded"];
const TASK_TYPES = ["stuck_recovery", "quick_judgment"] as const;
const REASON_CODES = [
  "incident_mitigation",
  "sla_breach",
  "proof_mismatch",
  "customer_request",
  "policy_violation",
  "fraud_risk"
];
const ACTION_PERMISSIONS: Record<string, Set<string>> = {
  ops_agent: new Set(["manual_review", "reassign", "add_note", "recheck_review", "download_artifact", "download_bundle"]),
  ops_manager: new Set(["manual_review", "reassign", "add_note", "refund", "force_status", "recheck_review", "download_artifact", "download_bundle"]),
  finance: new Set(["refund", "add_note"]),
  admin: new Set(["manual_review", "reassign", "add_note", "refund", "force_status", "recheck_review", "download_artifact", "download_bundle"])
};

type SortMode = "updated_desc" | "created_desc" | "priority";
type OpsView = "all" | "flows" | "incidents" | "finance" | "observability";
type FlowInspectorTab = "summary" | "context" | "result" | "artifacts" | "timeline";
type TrendWindow = 12 | 24 | 48;
type AutoRefreshSeconds = 0 | 15 | 30 | 60;
type ToastLevel = "success" | "error";
type SavedView = {
  id: string;
  name: string;
  statusFilter: string;
  taskTypeFilter: string;
  searchQuery: string;
  showOnlyProblem: boolean;
  showSlaBreachQueue: boolean;
  showManualReviewQueue: boolean;
  showLockedManualReview: boolean;
  manualReviewMineOnly: boolean;
  manualReviewLockedOnly: boolean;
  sortMode: SortMode;
  pageSize: number;
};
type MetricsHistoryPoint = {
  at: string;
  tasks_overdue: number;
  tasks_sla_risk: number;
  webhook_dlq_count: number;
  webhook_retry_rate: number;
};

const METRICS_HISTORY_KEY = "ops.metricsHistory.v1";
const SAVED_VIEWS_KEY = "ops.savedViews.v1";

type BulkResult = { task_id: string; ok: boolean; error?: string };
type ToastMessage = { id: string; level: ToastLevel; text: string };
type ConfirmDialogState = {
  open: boolean;
  title: string;
  message: string;
  applyText: string;
  danger: boolean;
};

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function claimStateFromReview(
  review: { claimed_by?: string | null; claimed_until?: string | null } | null | undefined,
  nowMs: number,
  me: string
): { active: boolean; isMine: boolean; isLocked: boolean; claimedBy: string; claimedUntilMs: number } {
  const claimedBy = review?.claimed_by ? String(review.claimed_by) : "";
  const claimedUntilMs = review?.claimed_until ? new Date(String(review.claimed_until)).getTime() : 0;
  const active = Boolean(claimedBy) && claimedUntilMs > nowMs;
  const isMine = active && claimedBy === me;
  const isLocked = active && !isMine;
  return { active, isMine, isLocked, claimedBy, claimedUntilMs };
}

function loadFlag(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

function loadMetricsHistory(): MetricsHistoryPoint[] {
  try {
    const raw = localStorage.getItem(METRICS_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MetricsHistoryPoint[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-48);
  } catch {
    return [];
  }
}

function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<SavedView>>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => ({
      id: String(v.id ?? ""),
      name: String(v.name ?? "Saved view"),
      statusFilter: String(v.statusFilter ?? ""),
      taskTypeFilter: String(v.taskTypeFilter ?? ""),
      searchQuery: String(v.searchQuery ?? ""),
      showOnlyProblem: Boolean(v.showOnlyProblem),
      showSlaBreachQueue: Boolean(v.showSlaBreachQueue),
      showManualReviewQueue: Boolean(v.showManualReviewQueue),
      showLockedManualReview: Boolean(v.showLockedManualReview),
      manualReviewMineOnly: Boolean(v.manualReviewMineOnly),
      manualReviewLockedOnly: Boolean(v.manualReviewLockedOnly),
      sortMode: (v.sortMode as SortMode) || "updated_desc",
      pageSize: Number(v.pageSize ?? 25)
    })).filter((v) => v.id);
  } catch {
    return [];
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  return false;
}

export function OpsPage() {
  const me = getAdminUser();
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [observability, setObservability] = useState<OpsObservability | null>(null);
  const [margin, setMargin] = useState<OpsMarginSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);

  const [dlq, setDlq] = useState<DeadLetter[]>([]);
  const [flows, setFlows] = useState<Task[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState<string>("");
  const [selectedFlow, setSelectedFlow] = useState<TaskWithReview | null>(null);
  const [audit, setAudit] = useState<TaskAuditEntry[]>([]);
  const [timeline, setTimeline] = useState<Array<{ at: string; kind: string; actor: string; message: string }>>([]);
  const [incidents, setIncidents] = useState<OpsIncident[]>([]);

  const [showOnlyProblem, setShowOnlyProblem] = useState<boolean>(() => loadFlag("ops.showOnlyProblem", false));
  const [showSlaBreachQueue, setShowSlaBreachQueue] = useState<boolean>(() => loadFlag("ops.showSlaBreachQueue", false));
  const [showManualReviewQueue, setShowManualReviewQueue] = useState<boolean>(() => loadFlag("ops.showManualReviewQueue", false));
  const [showLockedManualReview, setShowLockedManualReview] = useState<boolean>(() => loadFlag("ops.showLockedManualReview", false));
  const [manualReviewMineOnly, setManualReviewMineOnly] = useState<boolean>(() => loadFlag("ops.manualReviewMineOnly", false));
  const [manualReviewLockedOnly, setManualReviewLockedOnly] = useState<boolean>(() => loadFlag("ops.manualReviewLockedOnly", false));
  const [manualReviewAutoRenew, setManualReviewAutoRenew] = useState<boolean>(() => loadFlag("ops.manualReviewAutoRenew", true));
  const [statusFilter, setStatusFilter] = useState<string>(() => localStorage.getItem("ops.statusFilter") ?? "");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>(() => localStorage.getItem("ops.taskTypeFilter") ?? "");
  const [searchQuery, setSearchQuery] = useState<string>(() => localStorage.getItem("ops.searchQuery") ?? "");
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem("ops.sortMode") as SortMode) || "updated_desc");
  const [activeView, setActiveView] = useState<OpsView>(() => (localStorage.getItem("ops.activeView") as OpsView) || "all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  const [actionNote, setActionNote] = useState("");
  const [manualVerdict, setManualVerdict] = useState<"approved" | "rejected">("approved");
  const [reassignWorkerId, setReassignWorkerId] = useState("");
  const [forceStatus, setForceStatus] = useState<string>("disputed");
  const [reasonCode, setReasonCode] = useState<string>("incident_mitigation");
  const [incidentOwnerDrafts, setIncidentOwnerDrafts] = useState<Record<string, string>>({});
  const [incidentPostmortemDrafts, setIncidentPostmortemDrafts] = useState<Record<string, string>>({});
  const [incidentEventsById, setIncidentEventsById] = useState<Record<string, Array<{ id: string; actor: string; action: string; note?: string | null; created_at: string }>>>({});
  const [expandedIncidentIds, setExpandedIncidentIds] = useState<Record<string, boolean>>({});

  const [lastBulkResults, setLastBulkResults] = useState<BulkResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews());
  const [newSavedViewName, setNewSavedViewName] = useState("");
  const [inspectorTab, setInspectorTab] = useState<FlowInspectorTab>("summary");
  const [metricsHistory, setMetricsHistory] = useState<MetricsHistoryPoint[]>(() => loadMetricsHistory());
  const [trendWindow, setTrendWindow] = useState<TrendWindow>(
    () => Number(localStorage.getItem("ops.trendWindow") ?? "12") as TrendWindow
  );
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<AutoRefreshSeconds>(
    () => Number(localStorage.getItem("ops.autoRefreshSeconds") ?? "30") as AutoRefreshSeconds
  );
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [isClaimRunning, setIsClaimRunning] = useState(false);
  const [isLockRenewing, setIsLockRenewing] = useState(false);
  const [lockRenewBackoffUntilMs, setLockRenewBackoffUntilMs] = useState(0);
  const [lockRenewLastOkAtMs, setLockRenewLastOkAtMs] = useState(0);
  const [lockRenewLastError, setLockRenewLastError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isBulkRunning, setIsBulkRunning] = useState(false);
  const [incidentUpdatingId, setIncidentUpdatingId] = useState<string | null>(null);
  const [incidentEventsLoadingId, setIncidentEventsLoadingId] = useState<string | null>(null);
  const [isIncidentScanRunning, setIsIncidentScanRunning] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: "",
    message: "",
    applyText: "Confirm",
    danger: false
  });
  const refreshRef = useRef<() => Promise<void>>();
  const confirmHandlerRef = useRef<(() => void) | null>(null);
  const pendingManualReviewSelectRef = useRef<string | null>(null);
  const claimedManualReviewIdRef = useRef<string>("");
  const lockRenewInFlightRef = useRef(false);
  const lockRenewLastAtRef = useRef(0);

  const selectedStatusOption = useMemo<string[]>(() => (statusFilter ? [statusFilter] : []), [statusFilter]);
  const selectedForceStatus = useMemo<string[]>(() => [forceStatus], [forceStatus]);
  const selectedReasonCode = useMemo<string[]>(() => [reasonCode], [reasonCode]);
  const role = config.adminRole || "admin";
  const rolePermissions = ACTION_PERMISSIONS[role] ?? ACTION_PERMISSIONS.admin;
  const canManageIncidents = role === "ops_manager" || role === "admin";
  const canViewFinance = role === "finance" || role === "ops_manager" || role === "admin";
  const canSeeClaimOwner = role === "ops_manager" || role === "admin";
  const canTakeOverClaim = role === "ops_manager" || role === "admin";
  const canDownloadArtifact = rolePermissions.has("download_artifact");
  const canDownloadBundle = rolePermissions.has("download_bundle");

  function canAction(action: string): boolean {
    return rolePermissions.has(action);
  }

  function actionDisabledTitle(action: string): string | undefined {
    return canAction(action) ? undefined : `Role "${role}" cannot run "${action}"`;
  }

  useEffect(() => {
    localStorage.setItem("ops.showOnlyProblem", String(showOnlyProblem));
  }, [showOnlyProblem]);

  useEffect(() => {
    localStorage.setItem("ops.showSlaBreachQueue", String(showSlaBreachQueue));
  }, [showSlaBreachQueue]);

  useEffect(() => {
    localStorage.setItem("ops.showManualReviewQueue", String(showManualReviewQueue));
  }, [showManualReviewQueue]);

  useEffect(() => {
    localStorage.setItem("ops.manualReviewAutoRenew", String(manualReviewAutoRenew));
  }, [manualReviewAutoRenew]);
  useEffect(() => {
    localStorage.setItem("ops.showLockedManualReview", String(showLockedManualReview));
  }, [showLockedManualReview]);
  useEffect(() => {
    localStorage.setItem("ops.manualReviewMineOnly", String(manualReviewMineOnly));
  }, [manualReviewMineOnly]);
  useEffect(() => {
    localStorage.setItem("ops.manualReviewLockedOnly", String(manualReviewLockedOnly));
  }, [manualReviewLockedOnly]);
  useEffect(() => {
    if (showManualReviewQueue) {
      claimedManualReviewIdRef.current = "";
    }
  }, [showManualReviewQueue]);

  useEffect(() => {
    localStorage.setItem("ops.statusFilter", statusFilter);
  }, [statusFilter]);
  useEffect(() => {
    localStorage.setItem("ops.taskTypeFilter", taskTypeFilter);
  }, [taskTypeFilter]);
  useEffect(() => {
    localStorage.setItem("ops.searchQuery", searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem("ops.sortMode", sortMode);
  }, [sortMode]);
  useEffect(() => {
    localStorage.setItem("ops.activeView", activeView);
  }, [activeView]);

  const filteredFlows = useMemo(() => {
    let base = flows;
    if (showManualReviewQueue) {
      base = base.filter((t) => {
        const review = (t as any)?.review as { claimed_by?: string | null; claimed_until?: string | null } | undefined;
        const state = claimStateFromReview(review, nowMs, me);
        if (!showLockedManualReview && state.isLocked) return false;
        if (manualReviewMineOnly && !state.isMine) return false;
        if (manualReviewLockedOnly && !state.isLocked) return false;
        return true;
      });
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((t) => {
      const haystack = `${t.id} ${t.account_id} ${t.task_type} ${t.status}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [
    flows,
    manualReviewLockedOnly,
    manualReviewMineOnly,
    nowMs,
    searchQuery,
    showLockedManualReview,
    showManualReviewQueue,
    me
  ]);

  const sortedFlows = useMemo(() => {
    const rows = [...filteredFlows];
    rows.sort((a, b) => {
      const baseCompare = (): number => {
        if (sortMode === "priority") {
          const now = Date.now();
          const score = (t: Task): number => {
            const status = String(t.status);
            const deadline = t.sla_deadline ? new Date(t.sla_deadline).getTime() : Number.POSITIVE_INFINITY;
            const untilDeadline = deadline - now;
            const isOverdue = Number.isFinite(deadline) && untilDeadline <= 0;
            const isAtRisk = Number.isFinite(deadline) && untilDeadline > 0 && untilDeadline <= 2 * 60 * 1000;

            let base = 0;
            if (isOverdue && (status === "queued" || status === "claimed")) base = 1000;
            else if (isAtRisk && (status === "queued" || status === "claimed")) base = 800;
            else if (status === "disputed") base = 700;
            else if (status === "failed") base = 650;
            else if (status === "claimed") base = 500;
            else if (status === "queued") base = 400;
            else base = 100;

            const urgency = Number.isFinite(deadline) ? Math.max(0, 300000 - Math.max(0, untilDeadline)) / 1000 : 0;
            return base + urgency;
          };
          return score(b) - score(a);
        }
        if (sortMode === "created_desc") {
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      };

      if (showManualReviewQueue) {
        const bucket = (t: Task): number => {
          const review = (t as any)?.review as { claimed_by?: string | null; claimed_until?: string | null } | undefined;
          const claimedBy = review?.claimed_by ? String(review.claimed_by) : "";
          const claimedUntilMs = review?.claimed_until ? new Date(String(review.claimed_until)).getTime() : 0;
          const active = Boolean(claimedBy) && claimedUntilMs > nowMs;
          if (!active) return 0; // unclaimed or expired
          if (claimedBy === me) return 1; // claimed by me
          return 2; // locked by other
        };
        const da = bucket(a);
        const db = bucket(b);
        if (da !== db) return da - db;
      }

      return baseCompare();
    });
    return rows;
  }, [filteredFlows, nowMs, showManualReviewQueue, sortMode, me]);

  const pagedFlows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedFlows.slice(start, start + pageSize);
  }, [page, pageSize, sortedFlows]);

  const totalPages = Math.max(1, Math.ceil(sortedFlows.length / pageSize));
  const manualReviewNav = useMemo(() => {
    if (!showManualReviewQueue) return null;
    const total = sortedFlows.length;
    if (total === 0) return { idx: -1, pos: 0, total, canPrev: false, canNext: false };
    const rawIdx = sortedFlows.findIndex((t) => t.id === selectedFlowId);
    const idx = rawIdx >= 0 ? rawIdx : 0;
    return {
      idx,
      pos: idx + 1,
      total,
      canPrev: idx > 0,
      canNext: idx + 1 < total
    };
  }, [selectedFlowId, showManualReviewQueue, sortedFlows]);
  const manualReviewClaimState = useMemo(() => {
    if (!showManualReviewQueue) {
      return { active: false, isMine: false, claimedBy: "", claimedUntilMs: 0 };
    }
    const now = Date.now();
    const fromSelected = selectedFlow?.review;
    const fromList = (flows.find((t) => t.id === selectedFlowId) as any)?.review as
      | { claimed_by?: string | null; claimed_until?: string | null }
      | undefined;
    const claimedBy = String(fromSelected?.claimed_by ?? fromList?.claimed_by ?? "");
    const claimedUntilRaw = fromSelected?.claimed_until ?? fromList?.claimed_until ?? null;
    const claimedUntilMs = claimedUntilRaw ? new Date(String(claimedUntilRaw)).getTime() : 0;
    const active = Boolean(claimedBy) && claimedUntilMs > now;
    const isMine = active && claimedBy === me;
    return { active, isMine, claimedBy, claimedUntilMs };
  }, [flows, selectedFlow, selectedFlowId, showManualReviewQueue, me]);
  const manualReviewClaimRemainingLabel = useMemo(() => {
    if (!manualReviewClaimState.active) return "";
    const ms = manualReviewClaimState.claimedUntilMs - nowMs;
    return formatRemaining(ms);
  }, [manualReviewClaimState.active, manualReviewClaimState.claimedUntilMs, nowMs]);
  const recentTrend = useMemo(() => metricsHistory.slice(-trendWindow), [metricsHistory, trendWindow]);
  const healthState = useMemo(() => {
    if (!metrics) return { level: "stable", title: "System status unavailable", hint: "Waiting for first metrics sample." };
    if (metrics.tasks_overdue >= 5 || metrics.webhook_dlq_count >= 10) {
      return {
        level: "critical",
        title: "Critical ops pressure",
        hint: `Overdue ${metrics.tasks_overdue}, DLQ ${metrics.webhook_dlq_count}. Prioritize overdue and disputed flows.`
      };
    }
    if (metrics.tasks_sla_risk >= 3 || metrics.webhook_dlq_count > 0 || metrics.webhook_retry_rate >= 0.2) {
      return {
        level: "attention",
        title: "Attention required",
        hint: `SLA risk ${metrics.tasks_sla_risk}, retry ${(metrics.webhook_retry_rate * 100).toFixed(1)}%.`
      };
    }
    return {
      level: "stable",
      title: "System stable",
      hint: "No immediate SLA or delivery risks detected."
    };
  }, [metrics]);

  const trendSeries = useMemo(() => {
    const normalize = (values: number[]) => {
      if (values.length === 0) return [];
      const max = Math.max(...values, 1);
      return values.map((v) => Math.max(8, Math.round((v / max) * 44)));
    };
    const overdue = recentTrend.map((p) => p.tasks_overdue);
    const risk = recentTrend.map((p) => p.tasks_sla_risk);
    const dlqCount = recentTrend.map((p) => p.webhook_dlq_count);
    const retryPct = recentTrend.map((p) => Math.round(p.webhook_retry_rate * 1000) / 10);
    return {
      overdue,
      risk,
      dlqCount,
      retryPct,
      overdueBars: normalize(overdue),
      riskBars: normalize(risk),
      dlqBars: normalize(dlqCount),
      retryBars: normalize(retryPct)
    };
  }, [recentTrend]);

  function deltaLabel(values: number[]): string {
    if (values.length < 2) return "n/a";
    const delta = values[values.length - 1] - values[values.length - 2];
    if (delta === 0) return "0";
    return `${delta > 0 ? "+" : ""}${delta}`;
  }

  function deltaClass(values: number[]): string {
    if (values.length < 2) return "neutral";
    const delta = values[values.length - 1] - values[values.length - 2];
    if (delta > 0) return "up";
    if (delta < 0) return "down";
    return "neutral";
  }

  function latestLabel(values: number[], suffix = ""): string {
    if (values.length === 0) return "n/a";
    return `${values[values.length - 1]}${suffix}`;
  }

  function resetTrendHistory() {
    setMetricsHistory([]);
    localStorage.removeItem(METRICS_HISTORY_KEY);
  }

  function pushToast(level: ToastLevel, text: string) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev.slice(-3), { id, level, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  function closeConfirmDialog() {
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    confirmHandlerRef.current = null;
  }

  function openConfirmDialog(options: Omit<ConfirmDialogState, "open">, onConfirm: () => void) {
    confirmHandlerRef.current = onConfirm;
    setConfirmDialog({
      open: true,
      title: options.title,
      message: options.message,
      applyText: options.applyText,
      danger: options.danger
    });
  }

  function prettyJson(value: unknown): string {
    if (value === null || value === undefined) return "{}";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    setIncidentOwnerDrafts((prev) => {
      const next = { ...prev };
      for (const incident of incidents) {
        if (!(incident.id in next)) {
          next[incident.id] = incident.owner ?? "ops-manager-1";
        }
      }
      return next;
    });
    setIncidentPostmortemDrafts((prev) => {
      const next = { ...prev };
      for (const incident of incidents) {
        if (!(incident.id in next)) {
          next[incident.id] = incident.postmortem ?? "";
        }
      }
      return next;
    });
  }, [incidents]);

  useEffect(() => {
    localStorage.setItem("ops.trendWindow", String(trendWindow));
  }, [trendWindow]);

  useEffect(() => {
    localStorage.setItem("ops.autoRefreshSeconds", String(autoRefreshSeconds));
  }, [autoRefreshSeconds]);

  useEffect(() => {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
  }, [savedViews]);

  useEffect(() => {
    const onVisibilityChange = () => setIsPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!metrics) return;
    setMetricsHistory((prev) => {
      const point: MetricsHistoryPoint = {
        at: new Date().toISOString(),
        tasks_overdue: metrics.tasks_overdue,
        tasks_sla_risk: metrics.tasks_sla_risk,
        webhook_dlq_count: metrics.webhook_dlq_count,
        webhook_retry_rate: metrics.webhook_retry_rate
      };
      const next = [...prev, point].slice(-48);
      localStorage.setItem(METRICS_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [metrics]);

  async function claimAndSelectFlow(taskId: string) {
    if (!showManualReviewQueue) {
      setSelectedFlowId(taskId);
      return;
    }
    if (showLockedManualReview) {
      const rowReview = (flows.find((t) => t.id === taskId) as any)?.review as
        | { claimed_by?: string | null; claimed_until?: string | null }
        | undefined;
      const claimedBy = rowReview?.claimed_by ? String(rowReview.claimed_by) : "";
      const claimedUntilMs = rowReview?.claimed_until ? new Date(String(rowReview.claimed_until)).getTime() : 0;
      const active = Boolean(claimedBy) && claimedUntilMs > Date.now();
      if (active && claimedBy !== me) {
        setSelectedFlowId(taskId);
        return;
      }
    }
    setIsClaimRunning(true);
    try {
      const task = await Api.claimManualReview(taskId);
      claimedManualReviewIdRef.current = taskId;
      setSelectedFlowId(taskId);
      setSelectedFlow(task);
      setFlows((prev) => prev.map((t) => (t.id === taskId ? ({ ...(t as any), review: task.review } as any) : t)));
    } catch (e) {
      pushToast("error", `Claim failed: ${String(e)}`);
      await refresh();
    } finally {
      setIsClaimRunning(false);
    }
  }

  async function releaseSelectedManualReview() {
    if (!showManualReviewQueue || !selectedFlowId) return;
    if (!manualReviewClaimState.isMine) {
      pushToast("error", "Cannot release: flow is not claimed by you");
      return;
    }
    setIsClaimRunning(true);
    try {
      await Api.releaseManualReview(selectedFlowId);
      claimedManualReviewIdRef.current = "";
      await refresh();
      pushToast("success", "Released manual review lock");
    } catch (e) {
      pushToast("error", `Release failed: ${String(e)}`);
      await refresh();
    } finally {
      setIsClaimRunning(false);
    }
  }

  async function skipSelectedManualReview() {
    if (!showManualReviewQueue || !selectedFlowId) return;
    if (!manualReviewClaimState.isMine) {
      pushToast("error", "Cannot skip: flow is not claimed by you");
      return;
    }
    setIsClaimRunning(true);
    try {
      await Api.releaseManualReview(selectedFlowId);
      claimedManualReviewIdRef.current = "";
      const next = await Api.claimNextManualReview({
        status: statusFilter || undefined,
        taskType: taskTypeFilter || undefined,
        excludeTaskId: selectedFlowId
      });
      if (next) pendingManualReviewSelectRef.current = next.id;
      await refresh();
      if (!next) pushToast("error", "Manual review queue is empty");
    } catch (e) {
      pushToast("error", `Skip failed: ${String(e)}`);
      await refresh();
    } finally {
      setIsClaimRunning(false);
    }
  }

  async function renewSelectedManualReviewLock() {
    if (!showManualReviewQueue || !selectedFlowId) return;
    if (!manualReviewClaimState.isMine) {
      pushToast("error", "Cannot renew: flow is not claimed by you");
      return;
    }
    setIsClaimRunning(true);
    try {
      const task = await Api.claimManualReview(selectedFlowId);
      setSelectedFlow(task);
      setFlows((prev) => prev.map((t) => (t.id === selectedFlowId ? ({ ...(t as any), review: task.review } as any) : t)));
      pushToast("success", "Lock renewed");
    } catch (e) {
      pushToast("error", `Renew failed: ${String(e)}`);
      await refresh();
    } finally {
      setIsClaimRunning(false);
    }
  }

  async function takeOverSelectedManualReviewLock() {
    if (!showManualReviewQueue || !selectedFlowId) return;
    if (!canTakeOverClaim) return;
    setIsClaimRunning(true);
    try {
      const task = await Api.takeOverManualReview(selectedFlowId);
      claimedManualReviewIdRef.current = selectedFlowId;
      setSelectedFlow(task);
      setFlows((prev) => prev.map((t) => (t.id === selectedFlowId ? ({ ...(t as any), review: task.review } as any) : t)));
      pushToast("success", "Lock taken over");
    } catch (e) {
      pushToast("error", `Take over failed: ${String(e)}`);
      await refresh();
    } finally {
      setIsClaimRunning(false);
    }
  }

  async function loadFlows() {
    const pendingSelectId = pendingManualReviewSelectRef.current;
    const list = showManualReviewQueue
      ? await Api.getOpsManualReviewQueue({
          limit: 300,
          status: statusFilter || undefined,
          taskType: taskTypeFilter || undefined,
          includeLocked: true
        })
      : await Api.listOpsFlows({
          limit: 300,
          onlyProblem: showOnlyProblem,
          onlySlaBreach: showSlaBreachQueue,
          onlyManualReview: showManualReviewQueue,
          status: statusFilter || undefined,
          taskType: taskTypeFilter || undefined
        });
    setFlows(list);
    if (pendingSelectId !== null) {
      pendingManualReviewSelectRef.current = null;
      const nextId = list.some((t) => t.id === pendingSelectId) ? pendingSelectId : (list[0]?.id ?? "");
      setSelectedFlowId(nextId);
      return;
    }
    if (!selectedFlowId && list.length > 0) {
      if (showManualReviewQueue) {
        void claimAndSelectFlow(list[0].id);
      } else {
        setSelectedFlowId(list[0].id);
      }
    }
    if (selectedFlowId && !list.some((t) => t.id === selectedFlowId)) {
      setSelectedFlowId(list[0]?.id ?? "");
    }
  }

  async function loadFlowDetail(taskId: string) {
    const [task, log, line] = await Promise.all([
      Api.getOpsFlow(taskId),
      Api.getOpsFlowAudit(taskId),
      Api.getOpsFlowTimeline(taskId)
    ]);
    setSelectedFlow(task);
    setAudit(log);
    setTimeline(line);
  }

  async function refresh() {
    setIsRefreshing(true);
    setError(null);
    try {
      const jobs: Array<Promise<string | null>> = [
        Api.getOpsMetrics()
          .then(setMetrics)
          .then(() => null)
          .catch((e) => `metrics: ${String(e)}`),
        Api.getOpsObservability()
          .then(setObservability)
          .then(() => null)
          .catch((e) => `observability: ${String(e)}`),
        Api.getDlq(20)
          .then(setDlq)
          .then(() => null)
          .catch((e) => `dlq: ${String(e)}`),
        Api.listOpsIncidents(undefined, 50)
          .then(setIncidents)
          .then(() => null)
          .catch((e) => `incidents: ${String(e)}`),
        loadFlows()
          .then(() => null)
          .catch((e) => `flows: ${String(e)}`)
      ];
      if (canViewFinance) {
        jobs.push(
          Api.getOpsMargin()
            .then(setMargin)
            .then(() => null)
            .catch((e) => `margin: ${String(e)}`),
          Api.getOpsLedger(60)
            .then(setLedger)
            .then(() => null)
            .catch((e) => `ledger: ${String(e)}`)
        );
      } else {
        setMargin(null);
        setLedger([]);
      }

      const errors = (await Promise.all(jobs)).filter((msg): msg is string => Boolean(msg));
      if (errors.length > 0) {
        setError(errors[0]);
        pushToast("error", `Refresh partially failed: ${errors[0]}`);
      }
    } catch (e) {
      setError(String(e));
      pushToast("error", `Refresh failed: ${String(e)}`);
    } finally {
      setIsRefreshing(false);
    }
  }
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    setPage(1);
  }, [
    showOnlyProblem,
    showSlaBreachQueue,
    showManualReviewQueue,
    statusFilter,
    taskTypeFilter,
    sortMode,
    canViewFinance
  ]);

  useEffect(() => {
    if (autoRefreshSeconds === 0 || !isPageVisible) return;
    const timer = window.setInterval(() => {
      void refreshRef.current?.();
    }, autoRefreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshSeconds, isPageVisible]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setSelectedTaskIds((prev) => prev.filter((id) => filteredFlows.some((t) => t.id === id)));
    if (selectedFlowId && !filteredFlows.some((t) => t.id === selectedFlowId)) {
      setSelectedFlowId(filteredFlows[0]?.id ?? "");
    }
  }, [filteredFlows, selectedFlowId]);

  useEffect(() => {
    if (!selectedFlowId) {
      setSelectedFlow(null);
      setAudit([]);
      setTimeline([]);
      setInspectorTab("summary");
      return;
    }
    void loadFlowDetail(selectedFlowId).catch((e) => {
      setError(String(e));
      pushToast("error", `Load flow failed: ${String(e)}`);
    });
  }, [selectedFlowId]);

  useEffect(() => {
    if (!showManualReviewQueue) return;
    if (!selectedFlowId) return;
    if (manualReviewClaimState.active && !manualReviewClaimState.isMine) return;
    if (claimedManualReviewIdRef.current === selectedFlowId) return;
    claimedManualReviewIdRef.current = selectedFlowId;
    setIsClaimRunning(true);
    void Api.claimManualReview(selectedFlowId)
      .then((task) => {
        if (task && task.id === selectedFlowId) setSelectedFlow(task);
      })
      .catch((e) => {
        pushToast("error", `Claim failed: ${String(e)}`);
        return refreshRef.current?.();
      })
      .finally(() => setIsClaimRunning(false));
  }, [manualReviewClaimState.active, manualReviewClaimState.isMine, selectedFlowId, showManualReviewQueue]);

  useEffect(() => {
    if (!showManualReviewQueue) return;
    if (!isPageVisible) return;
    if (!selectedFlowId) return;
    if (!manualReviewClaimState.isMine) return;
    if (!manualReviewAutoRenew) return;
    if (lockRenewInFlightRef.current) return;
    const remainingMs = manualReviewClaimState.claimedUntilMs - nowMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
    if (remainingMs > 25_000) return;
    if (nowMs - lockRenewLastAtRef.current < 5_000) return;
    lockRenewLastAtRef.current = nowMs;
    lockRenewInFlightRef.current = true;
    void Api.claimManualReview(selectedFlowId)
      .then((task) => {
        if (task && task.id === selectedFlowId) {
          setSelectedFlow(task);
          setFlows((prev) => prev.map((t) => (t.id === selectedFlowId ? ({ ...(t as any), review: task.review } as any) : t)));
        }
      })
      .catch((e) => {
        pushToast("error", `Lock renew failed: ${String(e)}`);
        void refreshRef.current?.();
      })
      .finally(() => {
        lockRenewInFlightRef.current = false;
      });
  }, [
    isPageVisible,
    manualReviewAutoRenew,
    manualReviewClaimState.claimedUntilMs,
    manualReviewClaimState.isMine,
    nowMs,
    selectedFlowId,
    showManualReviewQueue
  ]);

  async function requeue(id: string) {
    try {
      await Api.requeueDlq(id);
      await refresh();
      pushToast("success", "DLQ item requeued");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Requeue failed: ${String(e)}`);
    }
  }

  async function runIncidentScan() {
    setIsIncidentScanRunning(true);
    try {
      await Api.scanOpsIncidents(5);
      await refresh();
      pushToast("success", "Incident scan completed");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Incident scan failed: ${String(e)}`);
    } finally {
      setIsIncidentScanRunning(false);
    }
  }

  async function updateIncident(incidentId: string, payload: Record<string, unknown>) {
    setIncidentUpdatingId(incidentId);
    try {
      await Api.updateOpsIncident(incidentId, payload);
      await refresh();
      pushToast("success", "Incident updated");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Incident update failed: ${String(e)}`);
    } finally {
      setIncidentUpdatingId(null);
    }
  }

  async function runAction(
    action: string,
    payload: Record<string, unknown>,
    confirmMessage?: string,
    skipConfirm = false
  ) {
    if (!selectedFlowId) return;
    if (confirmMessage && !skipConfirm) {
      openConfirmDialog(
        {
          title: "Confirm action",
          message: confirmMessage,
          applyText: "Run action",
          danger: action === "refund" || action === "force_status"
        },
        () => {
          void runAction(action, payload, confirmMessage, true);
        }
      );
      return;
    }
    setIsActionRunning(true);
    try {
      await Api.opsAction(selectedFlowId, { action, note: actionNote || undefined, ...payload });
      setActionNote("");
      if (action === "manual_review" && showManualReviewQueue) {
        pendingManualReviewSelectRef.current = pickManualReviewAutoAdvanceId(selectedFlowId);
        await refresh();
      } else {
        await Promise.all([refresh(), loadFlowDetail(selectedFlowId)]);
      }
      pushToast("success", `Action "${action}" applied`);
    } catch (e) {
      setError(String(e));
      pushToast("error", `Action failed: ${String(e)}`);
    } finally {
      setIsActionRunning(false);
    }
  }

  async function runManualReview(taskId: string, verdict: "approved" | "rejected", skipConfirm = false) {
    if (!canAction("manual_review")) return;
    if (verdict === "rejected" && !skipConfirm) {
      openConfirmDialog(
        {
          title: "Confirm manual review",
          message: `Reject flow ${shortId(taskId)}?`,
          applyText: "Reject",
          danger: true
        },
        () => {
          void runManualReview(taskId, verdict, true);
        }
      );
      return;
    }
    setIsActionRunning(true);
    try {
      await Api.opsAction(taskId, { action: "manual_review", manual_verdict: verdict });
      if (showManualReviewQueue && selectedFlowId === taskId) {
        pendingManualReviewSelectRef.current = pickManualReviewAutoAdvanceId(taskId);
      }
      await refresh();
      pushToast("success", `Manual review: ${verdict}`);
    } catch (e) {
      setError(String(e));
      pushToast("error", `Manual review failed: ${String(e)}`);
    } finally {
      setIsActionRunning(false);
    }
  }

  async function runBulkAction(
    action: string,
    payload: Record<string, unknown>,
    dryRun = false,
    confirmMessage?: string,
    skipConfirm = false
  ) {
    if (selectedTaskIds.length === 0) return;
    if (confirmMessage && !skipConfirm) {
      openConfirmDialog(
        {
          title: "Confirm bulk action",
          message: confirmMessage,
          applyText: dryRun ? "Run dry-run" : "Run bulk action",
          danger: action === "refund" || action === "force_status"
        },
        () => {
          void runBulkAction(action, payload, dryRun, confirmMessage, true);
        }
      );
      return;
    }
    setIsBulkRunning(true);
    try {
      const confirmText = selectedTaskIds.length > 20 ? "CONFIRM" : undefined;
      const res = await Api.bulkOpsAction({
        task_ids: selectedTaskIds,
        action,
        dry_run: dryRun,
        confirm_text: confirmText,
        note: actionNote || undefined,
        ...payload
      });
      setLastBulkResults(res.results);
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(`Bulk action completed with ${failed.length} failures.`);
        pushToast("error", `Bulk "${action}" done with ${failed.length} failures`);
      } else if (dryRun) {
        setError(null);
        pushToast("success", "Bulk dry-run passed");
      } else {
        setError(null);
        pushToast("success", `Bulk "${action}" applied to ${res.results.length} flows`);
      }
      setActionNote("");
      await refresh();
      if (selectedFlowId) {
        await loadFlowDetail(selectedFlowId);
      }
    } catch (e) {
      setError(String(e));
      pushToast("error", `Bulk action failed: ${String(e)}`);
    } finally {
      setIsBulkRunning(false);
    }
  }

  async function toggleIncidentEvents(incidentId: string) {
    const isExpanded = !!expandedIncidentIds[incidentId];
    if (isExpanded) {
      setExpandedIncidentIds((prev) => ({ ...prev, [incidentId]: false }));
      return;
    }
    setExpandedIncidentIds((prev) => ({ ...prev, [incidentId]: true }));
    if (incidentEventsById[incidentId]) return;
    setIncidentEventsLoadingId(incidentId);
    try {
      const events = await Api.getOpsIncidentEvents(incidentId, 30);
      setIncidentEventsById((prev) => ({ ...prev, [incidentId]: events }));
    } catch (e) {
      setError(String(e));
      pushToast("error", `Load incident events failed: ${String(e)}`);
    } finally {
      setIncidentEventsLoadingId(null);
    }
  }

  function exportBulkReport() {
    if (lastBulkResults.length === 0) return;
    const blob = new Blob([JSON.stringify(lastBulkResults, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bulk-report-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toggleTaskSelection(taskId: string) {
    setSelectedTaskIds((prev) => (prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]));
  }

  function toggleSelectAllVisible() {
    if (pagedFlows.length === 0) return;
    const allVisible = pagedFlows.map((t) => t.id);
    const allSelected = allVisible.every((id) => selectedTaskIds.includes(id));
    if (allSelected) {
      setSelectedTaskIds((prev) => prev.filter((id) => !allVisible.includes(id)));
      return;
    }
    const merged = Array.from(new Set([...selectedTaskIds, ...allVisible]));
    setSelectedTaskIds(merged);
  }

  function applyFlowPreset(preset: "overdue" | "disputed" | "sla_risk" | "manual_review" | "clear") {
    if (preset === "clear") {
      setStatusFilter("");
      setTaskTypeFilter("");
      setSearchQuery("");
      setShowOnlyProblem(false);
      setShowSlaBreachQueue(false);
      setShowManualReviewQueue(false);
      setShowLockedManualReview(false);
      setManualReviewMineOnly(false);
      setManualReviewLockedOnly(false);
      return;
    }
    if (preset === "overdue") {
      setStatusFilter("");
      setTaskTypeFilter("");
      setSearchQuery("");
      setShowOnlyProblem(true);
      setShowSlaBreachQueue(true);
      setShowManualReviewQueue(false);
      setShowLockedManualReview(false);
      setManualReviewMineOnly(false);
      setManualReviewLockedOnly(false);
      return;
    }
    if (preset === "disputed") {
      setStatusFilter("disputed");
      setTaskTypeFilter("");
      setSearchQuery("");
      setShowOnlyProblem(false);
      setShowSlaBreachQueue(false);
      setShowManualReviewQueue(false);
      setShowLockedManualReview(false);
      setManualReviewMineOnly(false);
      setManualReviewLockedOnly(false);
      return;
    }
    if (preset === "manual_review") {
      setStatusFilter("");
      setTaskTypeFilter("");
      setSearchQuery("");
      setShowOnlyProblem(false);
      setShowSlaBreachQueue(false);
      setShowManualReviewQueue(true);
      setShowLockedManualReview(false);
      setManualReviewMineOnly(false);
      setManualReviewLockedOnly(false);
      return;
    }
    setStatusFilter("");
    setTaskTypeFilter("");
    setSearchQuery("");
    setShowOnlyProblem(false);
    setShowSlaBreachQueue(true);
    setShowManualReviewQueue(false);
    setShowLockedManualReview(false);
    setManualReviewMineOnly(false);
    setManualReviewLockedOnly(false);
  }

  async function openFlowQueuePreset(preset: "overdue" | "disputed" | "sla_risk" | "manual_review" | "clear") {
    setActiveView("flows");
    applyFlowPreset(preset);
    setPage(1);
    await refresh();
  }

  async function openDlqPanel() {
    setActiveView("observability");
    await refresh();
    setTimeout(() => {
      document.querySelector('[data-testid="ops-dlq-panel"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function saveCurrentView() {
    const name = newSavedViewName.trim();
    if (!name) {
      pushToast("error", "Enter a name for saved view");
      return;
    }
    const view: SavedView = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      statusFilter,
      taskTypeFilter,
      searchQuery,
      showOnlyProblem,
      showSlaBreachQueue,
      showManualReviewQueue,
      showLockedManualReview,
      manualReviewMineOnly,
      manualReviewLockedOnly,
      sortMode,
      pageSize
    };
    setSavedViews((prev) => [view, ...prev].slice(0, 12));
    setNewSavedViewName("");
    pushToast("success", `Saved view "${name}"`);
  }

  function applySavedView(view: SavedView) {
    setStatusFilter(view.statusFilter);
    setTaskTypeFilter(view.taskTypeFilter);
    setSearchQuery(view.searchQuery);
    setShowOnlyProblem(view.showOnlyProblem);
    setShowSlaBreachQueue(view.showSlaBreachQueue);
    setShowManualReviewQueue(view.showManualReviewQueue);
    setShowLockedManualReview(view.showLockedManualReview);
    setManualReviewMineOnly(view.manualReviewMineOnly);
    setManualReviewLockedOnly(view.manualReviewLockedOnly);
    setSortMode(view.sortMode);
    setPageSize(view.pageSize);
    setPage(1);
    pushToast("success", `Loaded view "${view.name}"`);
  }

  function deleteSavedView(viewId: string) {
    setSavedViews((prev) => prev.filter((v) => v.id !== viewId));
    pushToast("success", "Saved view deleted");
  }

  function selectNextFlow() {
    if (sortedFlows.length === 0) return;
    const idx = sortedFlows.findIndex((t) => t.id === selectedFlowId);
    const nextIdx = idx < 0 ? 0 : Math.min(sortedFlows.length - 1, idx + 1);
    void claimAndSelectFlow(sortedFlows[nextIdx].id);
  }

  function selectPrevFlow() {
    if (sortedFlows.length === 0) return;
    const idx = sortedFlows.findIndex((t) => t.id === selectedFlowId);
    const prevIdx = idx < 0 ? 0 : Math.max(0, idx - 1);
    void claimAndSelectFlow(sortedFlows[prevIdx].id);
  }

  function pickManualReviewAutoAdvanceId(taskId: string): string | null {
    if (!showManualReviewQueue) return null;
    if (sortedFlows.length === 0) return null;
    const idx = sortedFlows.findIndex((t) => t.id === taskId);
    if (idx < 0) return sortedFlows[0]?.id ?? null;
    if (idx + 1 < sortedFlows.length) return sortedFlows[idx + 1].id;
    if (idx - 1 >= 0) return sortedFlows[idx - 1].id;
    return null;
  }

  useEffect(() => {
    if (!selectedFlowId) return;
    const idx = sortedFlows.findIndex((t) => t.id === selectedFlowId);
    if (idx < 0) return;
    const desiredPage = Math.floor(idx / pageSize) + 1;
    if (desiredPage !== page) setPage(desiredPage);
  }, [page, pageSize, selectedFlowId, sortedFlows]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeView !== "all" && activeView !== "flows") return;
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "j") {
        event.preventDefault();
        selectNextFlow();
        return;
      }
      if (key === "k") {
        event.preventDefault();
        selectPrevFlow();
        return;
      }
      if (key === "s" && showManualReviewQueue) {
        if (!selectedFlowId || isClaimRunning || isActionRunning) return;
        event.preventDefault();
        void skipSelectedManualReview();
        return;
      }
      if (key === "l" && showManualReviewQueue) {
        if (!selectedFlowId || isClaimRunning || isActionRunning) return;
        event.preventDefault();
        void releaseSelectedManualReview();
        return;
      }
      if ((key === "1" || key === "2") && showManualReviewQueue) {
        if (!selectedFlowId || isClaimRunning || isActionRunning) return;
        if (!manualReviewClaimState.isMine) return;
        event.preventDefault();
        void runManualReview(selectedFlowId, key === "1" ? "approved" : "rejected", key === "2");
        return;
      }
      if (!selectedFlowId || isActionRunning) return;
      if (key === "a" && canAction("manual_review")) {
        if (showManualReviewQueue) {
          if (isClaimRunning) return;
          if (!manualReviewClaimState.isMine) return;
          event.preventDefault();
          void runManualReview(selectedFlowId, "approved");
          return;
        }
        event.preventDefault();
        void runAction("manual_review", { manual_verdict: "approved" });
        return;
      }
      if (key === "c" && canAction("recheck_review")) {
        if (!selectedFlow?.review) return;
        if (selectedFlow.review.review_status === "approved" || selectedFlow.review.review_status === "rejected") return;
        if (selectedFlow.status !== "completed" && selectedFlow.status !== "disputed") return;
        event.preventDefault();
        void runAction("recheck_review", {});
        return;
      }
      if (key === "r" && canAction("refund")) {
        event.preventDefault();
        void runAction(
          "refund",
          { reason_code: reasonCode },
          "Confirm refund for selected flow?"
        );
        return;
      }
      if (key === "d" && canAction("force_status")) {
        event.preventDefault();
        void runAction(
          "force_status",
          { status: "disputed", reason_code: reasonCode },
          "Force status to disputed for selected flow?"
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeView,
    isActionRunning,
    isClaimRunning,
    manualReviewClaimState.isMine,
    reasonCode,
    selectedFlowId,
    selectedFlow,
    showManualReviewQueue,
    sortedFlows
  ]);

  return (
    <section className="grid ops-layout">
      <Card className="panel span-2" view="raised">
        <div className="section-head">
          <h2>Control Tower</h2>
          <div className="row-tight">
            <span className="muted">Role: <strong>{role}</strong></span>
            <span className="muted">
              Auto: {autoRefreshSeconds === 0 ? "off" : `${autoRefreshSeconds}s`} {isPageVisible ? "" : "(paused)"}
            </span>
            <Button view={autoRefreshSeconds === 0 ? "action" : "outlined"} onClick={() => setAutoRefreshSeconds(0)}>Off</Button>
            <Button view={autoRefreshSeconds === 15 ? "action" : "outlined"} onClick={() => setAutoRefreshSeconds(15)}>15s</Button>
            <Button view={autoRefreshSeconds === 30 ? "action" : "outlined"} onClick={() => setAutoRefreshSeconds(30)}>30s</Button>
            <Button view={autoRefreshSeconds === 60 ? "action" : "outlined"} onClick={() => setAutoRefreshSeconds(60)}>60s</Button>
            <Button view="flat" onClick={() => void refresh()} loading={isRefreshing}>
              Refresh
            </Button>
          </div>
        </div>
        <div className="metric-grid tower-grid">
          <button
            type="button"
            className="metric-tile metric-tile-button"
            onClick={() => void openFlowQueuePreset("clear")}
            title="Open flow queue"
          >
            <span className="metric-label">Active tasks</span>
            <strong className="metric-value">{metrics?.active_tasks ?? "-"}</strong>
          </button>
          <button
            type="button"
            className="metric-tile metric-tile-button"
            onClick={() => void openFlowQueuePreset("sla_risk")}
            title="Open SLA risk queue"
          >
            <span className="metric-label">SLA at risk (&lt;2 min)</span>
            <strong className="metric-value">{metrics?.tasks_sla_risk ?? "-"}</strong>
          </button>
          <button
            type="button"
            className="metric-tile metric-tile-button"
            onClick={() => void openFlowQueuePreset("overdue")}
            title="Open overdue queue"
          >
            <span className="metric-label">Overdue</span>
            <strong className="metric-value">{metrics?.tasks_overdue ?? "-"}</strong>
          </button>
          <button
            type="button"
            className="metric-tile metric-tile-button"
            onClick={() => void openDlqPanel()}
            title="Open webhook DLQ panel"
          >
            <span className="metric-label">Webhook DLQ</span>
            <strong className="metric-value">{metrics?.webhook_dlq_count ?? "-"}</strong>
          </button>
          <button
            type="button"
            className="metric-tile metric-tile-button"
            onClick={() => void openFlowQueuePreset("manual_review")}
            title="Open manual review queue"
          >
            <span className="metric-label">Manual review</span>
            <strong className="metric-value">{metrics?.manual_review_pending ?? "-"}</strong>
          </button>
        </div>
        <div className="status-chips">
          {Object.entries(metrics?.task_status_counts ?? {}).map(([status, count]) => (
            <button
              type="button"
              key={status}
              className="chip chip-button"
              aria-pressed={statusFilter === status}
              onClick={() => {
                setActiveView("flows");
                setShowOnlyProblem(false);
                setShowSlaBreachQueue(false);
                setShowManualReviewQueue(false);
                setShowLockedManualReview(false);
                setManualReviewMineOnly(false);
                setManualReviewLockedOnly(false);
                setStatusFilter((prev) => (prev === status ? "" : status));
                setPage(1);
                void refresh();
              }}
              title="Filter flow queue by status"
            >
              {status}: {count}
            </button>
          ))}
        </div>
      </Card>

      <Card className={`panel span-2 health-banner health-${healthState.level}`}>
        <div className="section-head">
          <h2>{healthState.title}</h2>
          <div className="row-tight">
            <Button view="flat" onClick={() => applyFlowPreset("overdue")}>Open overdue queue</Button>
            <Button view="flat" onClick={() => setActiveView("observability")}>Open observability</Button>
          </div>
        </div>
        <p className="muted">{healthState.hint}</p>
      </Card>

      <Card className="panel span-2">
        <div className="row-tight">
          <Button view={activeView === "all" ? "action" : "outlined"} onClick={() => setActiveView("all")}>All</Button>
          <Button view={activeView === "flows" ? "action" : "outlined"} onClick={() => setActiveView("flows")}>Flows</Button>
          <Button view={activeView === "incidents" ? "action" : "outlined"} onClick={() => setActiveView("incidents")}>Incidents</Button>
          <Button
            view={activeView === "finance" ? "action" : "outlined"}
            onClick={() => setActiveView("finance")}
            disabled={!canViewFinance}
          >
            Finance {canViewFinance ? "" : "(locked)"}
          </Button>
          <Button view={activeView === "observability" ? "action" : "outlined"} onClick={() => setActiveView("observability")}>Observability</Button>
        </div>
      </Card>

      {(activeView === "all" || activeView === "observability" || activeView === "finance") ? <Card className="panel span-2">
        <div className="section-head">
          <h2>Observability</h2>
          <div className="row-tight">
            <Button view={trendWindow === 12 ? "action" : "outlined"} onClick={() => setTrendWindow(12)}>12</Button>
            <Button view={trendWindow === 24 ? "action" : "outlined"} onClick={() => setTrendWindow(24)}>24</Button>
            <Button view={trendWindow === 48 ? "action" : "outlined"} onClick={() => setTrendWindow(48)}>48</Button>
            <Button view="flat" onClick={resetTrendHistory}>Reset history</Button>
          </div>
        </div>
        <div className="metric-grid">
          <div className="metric-tile">
            <span className="metric-label">Service</span>
            <strong className="metric-value">{observability?.service ?? "-"}</strong>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Open incidents</span>
            <strong className="metric-value">{observability?.open_incidents ?? "-"}</strong>
          </div>
        </div>
        <p className="muted trend-hint">Window: last {trendWindow} snapshots</p>
        <p className="muted trend-hint">
          Last sample: {recentTrend.length > 0 ? new Date(recentTrend[recentTrend.length - 1].at).toLocaleTimeString() : "n/a"} · samples: {recentTrend.length}
        </p>
        <div className="trend-grid">
          <div className="trend-card">
            <div className="dlq-head">
              <strong>Overdue trend</strong>
              <span className={`trend-delta trend-delta-${deltaClass(trendSeries.overdue)}`}>
                {latestLabel(trendSeries.overdue)} · Δ {deltaLabel(trendSeries.overdue)}
              </span>
            </div>
            <div className="sparkline">
              {trendSeries.overdueBars.map((h, i) => <span key={`overdue-${i}`} style={{ height: `${h}px` }} />)}
            </div>
          </div>
          <div className="trend-card">
            <div className="dlq-head">
              <strong>SLA risk trend</strong>
              <span className={`trend-delta trend-delta-${deltaClass(trendSeries.risk)}`}>
                {latestLabel(trendSeries.risk)} · Δ {deltaLabel(trendSeries.risk)}
              </span>
            </div>
            <div className="sparkline">
              {trendSeries.riskBars.map((h, i) => <span key={`risk-${i}`} style={{ height: `${h}px` }} />)}
            </div>
          </div>
          <div className="trend-card">
            <div className="dlq-head">
              <strong>DLQ trend</strong>
              <span className={`trend-delta trend-delta-${deltaClass(trendSeries.dlqCount)}`}>
                {latestLabel(trendSeries.dlqCount)} · Δ {deltaLabel(trendSeries.dlqCount)}
              </span>
            </div>
            <div className="sparkline">
              {trendSeries.dlqBars.map((h, i) => <span key={`dlq-${i}`} style={{ height: `${h}px` }} />)}
            </div>
          </div>
          <div className="trend-card">
            <div className="dlq-head">
              <strong>Retry rate trend</strong>
              <span className={`trend-delta trend-delta-${deltaClass(trendSeries.retryPct)}`}>
                {latestLabel(trendSeries.retryPct, "%")} · Δ {deltaLabel(trendSeries.retryPct)} pp
              </span>
            </div>
            <div className="sparkline">
              {trendSeries.retryBars.map((h, i) => <span key={`retry-${i}`} style={{ height: `${h}px` }} />)}
            </div>
        </div>
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "flows") ? <Card className="panel">
        <div data-testid="ops-flow-queue">
        <div className="section-head">
          <h2>Flow Queue</h2>
          <div className="row-tight">
            <Button view={showOnlyProblem ? "action" : "outlined"} onClick={() => setShowOnlyProblem((v) => !v)}>
              Problems only
            </Button>
            <Button view={showSlaBreachQueue ? "action" : "outlined"} onClick={() => setShowSlaBreachQueue((v) => !v)}>
              SLA breach queue
            </Button>
            <Button view={showManualReviewQueue ? "action" : "outlined"} onClick={() => setShowManualReviewQueue((v) => !v)}>
              Manual review
            </Button>
          </div>
        </div>
        <p className="muted">Shortcuts: <span className="mono">J/K</span> navigate, <span className="mono">A</span> approve, <span className="mono">1/2</span> approve/reject (manual review), <span className="mono">C</span> recheck, <span className="mono">R</span> refund, <span className="mono">D</span> dispute.</p>
        {showManualReviewQueue ? (
          <div className="row-tight">
            <span className="muted" title="Manual review queue prioritizes unclaimed/expired first, then your claimed, and locks held by others last.">
              Order: <span className="mono">unclaimed</span> → <span className="mono">mine</span> → <span className="mono">locked</span>
            </span>
            <Button
              view="action"
              data-testid="ops-manual-take-next"
              onClick={() => {
                setIsClaimRunning(true);
                void Api.claimNextManualReview({ status: statusFilter || undefined, taskType: taskTypeFilter || undefined })
                  .then((task) => {
                    if (!task) {
                      pushToast("error", "Manual review queue is empty");
                      return;
                    }
                    pendingManualReviewSelectRef.current = task.id;
                  })
                  .then(refresh)
                  .catch((e) => pushToast("error", `Claim next failed: ${String(e)}`))
                  .finally(() => setIsClaimRunning(false));
              }}
              disabled={isClaimRunning || isRefreshing}
              loading={isClaimRunning}
            >
              Take next
            </Button>
            <Button
              view={showLockedManualReview ? "action" : "outlined"}
              onClick={() =>
                setShowLockedManualReview((v) => {
                  const next = !v;
                  if (!next) setManualReviewLockedOnly(false);
                  return next;
                })
              }
              disabled={isRefreshing}
              title="Show tasks claimed by other reviewers"
            >
              Show locked
            </Button>
            <Button
              view={manualReviewMineOnly ? "action" : "outlined"}
              onClick={() => {
                setManualReviewMineOnly((v) => {
                  const next = !v;
                  if (next) setManualReviewLockedOnly(false);
                  return next;
                });
              }}
              disabled={isRefreshing}
              title="Show only tasks claimed by you"
            >
              Mine only
            </Button>
            <Button
              view={manualReviewLockedOnly ? "action" : "outlined"}
              onClick={() => {
                setManualReviewLockedOnly((v) => {
                  const next = !v;
                  if (next) {
                    setManualReviewMineOnly(false);
                    setShowLockedManualReview(true);
                  }
                  return next;
                });
              }}
              disabled={isRefreshing}
              title="Show only tasks locked by other reviewers"
            >
              Locked only
            </Button>
            <Button
              view={manualReviewAutoRenew ? "action" : "outlined"}
              data-testid="ops-manual-auto-renew"
              onClick={() => setManualReviewAutoRenew((v) => !v)}
              disabled={isRefreshing}
              title="Automatically renew your lock when it is close to expiring"
            >
              Auto-renew
            </Button>
            <Button
              view="outlined"
              data-testid="ops-manual-release"
              onClick={() => void releaseSelectedManualReview()}
              disabled={!selectedFlowId || isClaimRunning || isRefreshing || !manualReviewClaimState.isMine}
              title={!manualReviewClaimState.isMine ? "Claim the flow to release it" : undefined}
            >
              Release
            </Button>
            <Button
              view="outlined"
              data-testid="ops-manual-skip"
              onClick={() => void skipSelectedManualReview()}
              disabled={!selectedFlowId || isClaimRunning || isRefreshing || !manualReviewClaimState.isMine}
              title={!manualReviewClaimState.isMine ? "Claim the flow to skip it" : undefined}
            >
              Skip
            </Button>
            <Button view="outlined" onClick={selectPrevFlow} disabled={!manualReviewNav?.canPrev || isClaimRunning}>
              Previous
            </Button>
            <Button view="outlined" onClick={selectNextFlow} disabled={!manualReviewNav?.canNext || isClaimRunning}>
              Next
            </Button>
            <span className="muted mono">{manualReviewNav ? `${manualReviewNav.pos}/${manualReviewNav.total}` : "0/0"}</span>
          </div>
        ) : null}
        <div className="row-tight">
          <Select
            width="max"
            placeholder="Filter by status"
            value={selectedStatusOption}
            options={FORCE_STATUSES.map((s) => ({ value: s, content: s }))}
            onUpdate={(items) => setStatusFilter(items[0] ?? "")}
          />
          <Select
            width="max"
            placeholder="Filter by type"
            value={taskTypeFilter ? [taskTypeFilter] : []}
            options={TASK_TYPES.map((t) => ({ value: t, content: t }))}
            onUpdate={(items) => setTaskTypeFilter(items[0] ?? "")}
          />
          <TextInput
            size="m"
            value={searchQuery}
            onUpdate={setSearchQuery}
            placeholder="Search task/account/type/status"
          />
          <Select
            width="max"
            value={[sortMode]}
            options={[
              { value: "priority", content: "Sort: Priority (SLA/incident)" },
              { value: "updated_desc", content: "Sort: Updated" },
              { value: "created_desc", content: "Sort: Created" }
            ]}
            onUpdate={(items) => setSortMode((items[0] as SortMode) ?? "updated_desc")}
          />
          <Button
            view="flat"
            onClick={() => {
              setStatusFilter("");
              setTaskTypeFilter("");
              setSearchQuery("");
              setShowLockedManualReview(false);
              setManualReviewMineOnly(false);
              setManualReviewLockedOnly(false);
            }}
          >
            Clear
          </Button>
          <Button view="outlined" onClick={toggleSelectAllVisible}>Select page</Button>
        </div>
        <div className="row-tight">
          <span className="muted">Presets:</span>
          <Button view="outlined" onClick={() => applyFlowPreset("overdue")}>Only overdue</Button>
          <Button view="outlined" onClick={() => applyFlowPreset("disputed")}>Disputed</Button>
          <Button view="outlined" onClick={() => applyFlowPreset("sla_risk")}>SLA risk</Button>
          <Button view="outlined" data-testid="ops-preset-manual-review" onClick={() => applyFlowPreset("manual_review")}>Manual review</Button>
          <Button view="flat" onClick={() => applyFlowPreset("clear")}>Reset</Button>
        </div>
        <div className="row-tight">
          <TextInput
            size="m"
            value={newSavedViewName}
            onUpdate={setNewSavedViewName}
            placeholder="Save current view as..."
          />
          <Button view="outlined" onClick={saveCurrentView}>Save view</Button>
        </div>
        <div className="list">
          {savedViews.length === 0 ? <p className="muted">No saved views yet.</p> : null}
          {savedViews.map((view) => (
            <div key={view.id} className="saved-view-item">
              <div className="saved-view-main">
                <strong>{view.name}</strong>
                <p className="muted">
                  status: {view.statusFilter || "any"} · type: {view.taskTypeFilter || "any"} · problem: {view.showOnlyProblem ? "yes" : "no"} · sla: {view.showSlaBreachQueue ? "yes" : "no"} · manual: {view.showManualReviewQueue ? "yes" : "no"} · sort: {view.sortMode} · size: {view.pageSize}
                </p>
              </div>
              <div className="row-tight">
                <Button view="flat" onClick={() => applySavedView(view)}>Load</Button>
                <Button view="flat-danger" onClick={() => deleteSavedView(view.id)}>Delete</Button>
              </div>
            </div>
          ))}
        </div>
        <div className="row-tight">
          <Button view="outlined" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
          <span className="muted">Page {page}/{totalPages}</span>
          <Button view="outlined" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          <Button view="flat" disabled={selectedTaskIds.length === 0} onClick={() => setSelectedTaskIds([])}>
            Clear selection
          </Button>
          <Select
            width="max"
            value={[String(pageSize)]}
            options={["10", "25", "50"].map((n) => ({ value: n, content: `Page size ${n}` }))}
            onUpdate={(items) => setPageSize(Number(items[0] ?? "25"))}
          />
        </div>
        <p className="muted">Selected: {selectedTaskIds.length}</p>
        <div className="list">
          {isRefreshing && pagedFlows.length === 0 ? <p className="muted">Loading flows…</p> : null}
          {!isRefreshing && pagedFlows.length === 0 ? <p className="muted">No flows for selected filter.</p> : null}
          {pagedFlows.map((t) => {
            const checked = selectedTaskIds.includes(t.id);
            const review = (t as unknown as { review?: { review_status?: string; auto_check_provider?: string; auto_check_model?: string | null; auto_check_score?: number; auto_check_reason?: string | null; auto_check_redacted?: boolean | null; claimed_by?: string | null; claimed_until?: string | null } }).review;
            const reviewLabel = review?.review_status ? String(review.review_status) : "";
            const providerLabel = review?.auto_check_provider ? String(review.auto_check_provider) : "";
            const reasonLabel = typeof review?.auto_check_reason === "string" ? String(review.auto_check_reason) : "";
            const scoreLabel =
              typeof review?.auto_check_score === "number" ? review.auto_check_score.toFixed(2) : "";
            const artifactsCount = Array.isArray((t as any).artifacts) ? (t as any).artifacts.length : 0;
            const claimedBy = review?.claimed_by ? String(review.claimed_by) : "";
            const claimedUntil = review?.claimed_until ? new Date(String(review.claimed_until)) : null;
            const claimActive = Boolean(claimedBy) && Boolean(claimedUntil) && Boolean(claimedUntil && claimedUntil.getTime() > nowMs);
            const claimIsMine = claimActive && claimedBy === me;
            const claimRemaining = claimActive && claimedUntil ? formatRemaining(claimedUntil.getTime() - nowMs) : "";
            const claimBadgeTitle = claimActive && claimedUntil
              ? `${claimIsMine ? "Claimed by you" : "Locked by another reviewer"} until ${claimedUntil.toLocaleString()}`
              : "";
            const manualReviewButtonsDisabled = claimActive && !claimIsMine;
            const claimedByLabel = claimedBy.length > 18 ? `${claimedBy.slice(0, 18)}…` : claimedBy;
            return (
              <div
                key={t.id}
                data-testid="ops-flow-row"
                data-task-id={t.id}
                className={`task-row ${selectedFlowId === t.id ? "is-active" : ""} ${claimActive ? (claimIsMine ? "claim-mine" : "claim-locked") : ""}`}
                onClick={() => void claimAndSelectFlow(t.id)}
                role="button"
                tabIndex={0}
                aria-selected={selectedFlowId === t.id}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void claimAndSelectFlow(t.id);
                  }
                }}
              >
                <div className="task-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleTaskSelection(t.id)}
                  />
                  <div>
                    <div className="task-type">{t.task_type}</div>
                    <div className="muted mono">{shortId(t.id)} · {shortId(t.account_id)}</div>
                    {reviewLabel ? (
                      <div className="muted">
                        review: <span className="mono">{reviewLabel}</span>
                        {scoreLabel ? (
                          <span className="mono" title={reasonLabel ? `reason: ${reasonLabel}` : undefined}>
                            {" "}· score {scoreLabel}{providerLabel ? ` (${providerLabel})` : ""}
                          </span>
                        ) : null}
                        {artifactsCount ? <span className="mono"> · artifacts {artifactsCount}</span> : null}
                        {showManualReviewQueue && claimActive ? (
                          <>
                            <span
                              data-testid="ops-claim-badge"
                              data-claim-state={claimIsMine ? "mine" : "locked"}
                              className={`claim-badge ${claimIsMine ? "claim-badge-mine" : "claim-badge-locked"}`}
                              title={claimBadgeTitle}
                            >
                              {claimIsMine ? "CLAIMED" : "LOCKED"}
                              {claimRemaining ? ` ${claimRemaining}` : ""}
                            </span>
                            {!claimIsMine && canSeeClaimOwner ? (
                              <span className="muted mono" title={claimedBy}>
                                {" "}by {claimedByLabel}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="row-tight">
                  {showManualReviewQueue && canAction("manual_review") && reviewLabel === "manual_required" ? (
                    <div className="row-tight" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="s"
                        view="action"
                        onClick={() => void runManualReview(t.id, "approved")}
                        disabled={manualReviewButtonsDisabled}
                        title={manualReviewButtonsDisabled ? "Locked by another reviewer" : undefined}
                      >
                        Approve
                      </Button>
                      <Button
                        size="s"
                        view="flat-danger"
                        onClick={() => void runManualReview(t.id, "rejected")}
                        disabled={manualReviewButtonsDisabled}
                        title={manualReviewButtonsDisabled ? "Locked by another reviewer" : undefined}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                  <span className={`status status-${t.status}`}>{t.status}</span>
                </div>
              </div>
            );
          })}
        </div>
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "flows") ? <Card className="panel">
        <div data-testid="ops-action-center">
        <h2>Action Center</h2>
        {!selectedFlow ? <p className="muted">Choose flow to run actions.</p> : null}
        {selectedFlow ? (
          <>
            <TextArea size="l" placeholder="Reason / internal note" value={actionNote} onUpdate={setActionNote} />
            <div className="row-tight">
              <Select
                width="max"
                value={selectedReasonCode}
                options={REASON_CODES.map((code) => ({ value: code, content: code }))}
                onUpdate={(items) => setReasonCode(items[0] ?? "incident_mitigation")}
              />
            </div>
            <div className="row action-row">
              <Button
                view="normal"
                onClick={() => void runAction("manual_review", { manual_verdict: manualVerdict })}
                disabled={!canAction("manual_review") || isActionRunning}
                loading={isActionRunning}
                title={actionDisabledTitle("manual_review")}
              >
                Manual {manualVerdict}
              </Button>
              <Button
                view="outlined"
                onClick={() => void runAction("recheck_review", {})}
                disabled={
                  !canAction("recheck_review") ||
                  isActionRunning ||
                  !selectedFlow.review ||
                  selectedFlow.review.review_status === "approved" ||
                  selectedFlow.review.review_status === "rejected"
                }
                loading={isActionRunning}
                title={
                  selectedFlow.review && (selectedFlow.review.review_status === "approved" || selectedFlow.review.review_status === "rejected")
                    ? "Cannot recheck after manual verdict"
                    : actionDisabledTitle("recheck_review")
                }
              >
                Recheck auto-check
              </Button>
              <Button
                view="outlined-danger"
                onClick={() => void runAction("refund", { reason_code: reasonCode }, "Confirm refund for selected flow?")}
                loading={isActionRunning}
                disabled={!canAction("refund") || isActionRunning}
                title={actionDisabledTitle("refund")}
              >
                Refund
              </Button>
              <Button
                view="flat"
                onClick={() => void runAction("add_note", {})}
                loading={isActionRunning}
                disabled={!canAction("add_note") || isActionRunning}
                title={actionDisabledTitle("add_note")}
              >
                Add note
              </Button>
            </div>
            <div className="row-tight">
              <Select
                width="max"
                value={selectedForceStatus}
                options={FORCE_STATUSES.map((s) => ({ value: s, content: s }))}
                onUpdate={(items) => setForceStatus(items[0] ?? "disputed")}
              />
              <Button
                view="outlined"
                onClick={() =>
                  void runAction(
                    "force_status",
                    { status: forceStatus, reason_code: reasonCode },
                    `Force status to "${forceStatus}" for selected flow?`
                  )
                }
                loading={isActionRunning}
                disabled={!canAction("force_status") || isActionRunning}
                title={actionDisabledTitle("force_status")}
              >
                Force status
              </Button>
            </div>
            <div className="row-tight">
              <TextInput size="l" placeholder="Worker UUID for reassignment" value={reassignWorkerId} onUpdate={setReassignWorkerId} />
              <Button
                view="outlined"
                onClick={() => void runAction("reassign", { worker_id: reassignWorkerId })}
                disabled={!reassignWorkerId || isActionRunning || !canAction("reassign")}
                loading={isActionRunning}
                title={actionDisabledTitle("reassign")}
              >
                Reassign
              </Button>
            </div>
            <div className="row-tight">
              <Button view={manualVerdict === "approved" ? "action" : "outlined"} onClick={() => setManualVerdict("approved")}>
                Approve mode
              </Button>
              <Button view={manualVerdict === "rejected" ? "action" : "outlined-danger"} onClick={() => setManualVerdict("rejected")}>
                Reject mode
              </Button>
            </div>

            <div className="bulk-block">
              <div data-testid="ops-bulk-actions">
              <p className="muted">Bulk actions for selected flows</p>
              <div className="row-tight">
                <Button
                  view="normal"
                  disabled={selectedTaskIds.length === 0 || isBulkRunning || !canAction("manual_review")}
                  onClick={() => void runBulkAction("manual_review", { manual_verdict: manualVerdict })}
                  loading={isBulkRunning}
                  title={actionDisabledTitle("manual_review")}
                >
                  Bulk manual {manualVerdict}
                </Button>
                <Button
                  view="outlined"
                  disabled={selectedTaskIds.length === 0 || isBulkRunning || !canAction("manual_review")}
                  onClick={() => void runBulkAction("manual_review", { manual_verdict: manualVerdict }, true)}
                  loading={isBulkRunning}
                  title={actionDisabledTitle("manual_review")}
                >
                  Dry-run bulk
                </Button>
                <Button
                  view="outlined-danger"
                  disabled={selectedTaskIds.length === 0 || isBulkRunning || !canAction("refund")}
                  onClick={() =>
                    void runBulkAction(
                      "refund",
                      { reason_code: reasonCode },
                      false,
                      `Confirm bulk refund for ${selectedTaskIds.length} flow(s)?`
                    )
                  }
                  loading={isBulkRunning}
                  title={actionDisabledTitle("refund")}
                >
                  Bulk refund
                </Button>
              </div>
              <div className="row-tight">
                <Button
                  view="outlined"
                  disabled={selectedTaskIds.length === 0 || isBulkRunning || !canAction("force_status")}
                  onClick={() =>
                    void runBulkAction(
                      "force_status",
                      { status: forceStatus, reason_code: reasonCode },
                      false,
                      `Confirm bulk force status "${forceStatus}" for ${selectedTaskIds.length} flow(s)?`
                    )
                  }
                  loading={isBulkRunning}
                  title={actionDisabledTitle("force_status")}
                >
                  Bulk force status
                </Button>
                <Button
                  view="outlined"
                  disabled={selectedTaskIds.length === 0 || !reassignWorkerId || isBulkRunning || !canAction("reassign")}
                  onClick={() => void runBulkAction("reassign", { worker_id: reassignWorkerId })}
                  loading={isBulkRunning}
                  title={actionDisabledTitle("reassign")}
                >
                  Bulk reassign
                </Button>
                <Button view="flat" disabled={lastBulkResults.length === 0} onClick={exportBulkReport}>
                  Export bulk report
                </Button>
              </div>
              </div>
            </div>
          </>
        ) : null}
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "flows") ? <Card className="panel span-2">
        <div data-testid="ops-flow-inspector">
        <div className="section-head">
          <h2>Flow Inspector</h2>
          {selectedFlow ? (
            <div className="row-tight">
              {canDownloadBundle ? (
                <Button
                  view="flat"
                  onClick={() => {
                    void Api.downloadOpsFlowBundle(selectedFlow.id)
                      .then(({ blob, filename }) => {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = filename;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        URL.revokeObjectURL(url);
                        pushToast("success", "Downloaded flow bundle");
                      })
                      .catch((e) => pushToast("error", `Bundle download failed: ${String(e)}`));
                  }}
                  title={actionDisabledTitle("download_bundle")}
                >
                  Download bundle
                </Button>
              ) : null}
              <Button view="flat" onClick={() => void copyText(selectedFlow.id)}>Copy flow ID</Button>
            </div>
          ) : null}
        </div>
        {!selectedFlow ? <p className="muted">Select a flow from queue.</p> : null}
        {selectedFlow ? (
          <div className="inspector-wrap">
            <div className="row-tight">
              <Button view={inspectorTab === "summary" ? "action" : "outlined"} onClick={() => setInspectorTab("summary")}>Summary</Button>
              <Button view={inspectorTab === "context" ? "action" : "outlined"} onClick={() => setInspectorTab("context")}>Context</Button>
              <Button view={inspectorTab === "result" ? "action" : "outlined"} onClick={() => setInspectorTab("result")}>Result</Button>
              <Button view={inspectorTab === "artifacts" ? "action" : "outlined"} onClick={() => setInspectorTab("artifacts")}>Artifacts</Button>
              <Button view={inspectorTab === "timeline" ? "action" : "outlined"} onClick={() => setInspectorTab("timeline")}>Timeline</Button>
            </div>

            {inspectorTab === "summary" ? (
              <div className="detail-block">
                <p><strong>ID:</strong> <span className="mono" data-testid="ops-inspector-task-id">{selectedFlow.id}</span></p>
                <p><strong>Account:</strong> <span className="mono">{selectedFlow.account_id}</span></p>
                <p><strong>Worker:</strong> <span className="mono">{selectedFlow.worker_id ?? "unassigned"}</span></p>
                <p><strong>Status:</strong> {selectedFlow.status}</p>
                <p><strong>Type:</strong> {selectedFlow.task_type}</p>
                <p><strong>Review:</strong> {selectedFlow.review?.review_status ?? "none"}</p>
                {selectedFlow.review ? (
                  <p>
                    <strong>Auto-check:</strong>{" "}
                    <span className="mono">
                      {selectedFlow.review.auto_check_score.toFixed(2)}
                      {selectedFlow.review.auto_check_provider ? ` (${selectedFlow.review.auto_check_provider})` : ""}
                    </span>
                    {selectedFlow.review.auto_check_reason ? (
                      <span className="muted mono"> · {selectedFlow.review.auto_check_reason}</span>
                    ) : null}
                    {selectedFlow.review.auto_check_model ? (
                      <span className="muted mono"> · model {selectedFlow.review.auto_check_model}</span>
                    ) : null}
                    {typeof selectedFlow.review.auto_check_redacted === "boolean" ? (
                      <span className="muted mono"> · redaction {selectedFlow.review.auto_check_redacted ? "on" : "off"}</span>
                    ) : null}
                  </p>
                ) : null}
                {showManualReviewQueue ? (
                  <p>
                    <strong>Claim:</strong>{" "}
                    {selectedFlow.review?.claimed_by && selectedFlow.review?.claimed_until ? (
                      <>
                        <span className="mono">
                          {selectedFlow.review.claimed_by === me
                            ? "claimed by me"
                            : canSeeClaimOwner
                              ? `locked by ${selectedFlow.review.claimed_by}`
                              : "locked"}
                        </span>{" "}
                        <span className="muted mono">
                          (until {new Date(selectedFlow.review.claimed_until).toLocaleString()})
                        </span>
                        {selectedFlow.review.claimed_by === me ? (
                          <>
                            {" "}
                            <span className="muted mono">· remaining {manualReviewClaimRemainingLabel}</span>{" "}
                            <Button size="s" view="flat" disabled={isClaimRunning} onClick={() => void renewSelectedManualReviewLock()}>
                              Renew now
                            </Button>
                          </>
                        ) : canTakeOverClaim ? (
                          <>
                            {" "}
                            <Button size="s" view="outlined" disabled={isClaimRunning} onClick={() => void takeOverSelectedManualReviewLock()}>
                              Take over
                            </Button>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">unclaimed</span>
                    )}
                  </p>
                ) : null}
                <p><strong>Artifacts:</strong> {selectedFlow.artifacts?.length ?? 0}</p>
                <p><strong>SLA deadline:</strong> {selectedFlow.sla_deadline ? new Date(selectedFlow.sla_deadline).toLocaleString() : "-"}</p>
                <p><strong>Updated:</strong> {new Date(selectedFlow.updated_at).toLocaleString()}</p>
              </div>
            ) : null}

            {inspectorTab === "context" ? (
              <div className="json-panel">
                <pre className="json-code">{prettyJson(selectedFlow.context ?? {})}</pre>
              </div>
            ) : null}

            {inspectorTab === "result" ? (
              <div className="json-panel">
                <pre className="json-code">{prettyJson(selectedFlow.result ?? {})}</pre>
              </div>
            ) : null}

            {inspectorTab === "artifacts" ? (
              <div className="list">
                {(selectedFlow.artifacts ?? []).length === 0 ? <p className="muted">No artifacts.</p> : null}
                {(selectedFlow.artifacts ?? []).map((artifact, idx) => (
                  <div key={`artifact-${idx}`} className="incident-event">
                    {canDownloadArtifact && "id" in (artifact as any) && "task_id" in (artifact as any) && String((artifact as any).storage_path ?? "").startsWith("local:") ? (
                      <div className="row-tight">
                        <Button
                          size="s"
                          view="outlined"
                          onClick={() => {
                            const taskId = String((artifact as any).task_id);
                            const artifactId = String((artifact as any).id);
                            void Api.downloadOpsArtifact(taskId, artifactId)
                              .then(({ blob, filename }) => {
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement("a");
                                link.href = url;
                                link.download = filename;
                                document.body.appendChild(link);
                                link.click();
                                link.remove();
                                URL.revokeObjectURL(url);
                              })
                              .catch((e) => pushToast("error", `Download failed: ${String(e)}`));
                          }}
                        >
                          Download
                        </Button>
                      </div>
                    ) : null}
                    <pre className="json-code">{prettyJson(artifact)}</pre>
                  </div>
                ))}
              </div>
            ) : null}

            {inspectorTab === "timeline" ? (
              <div className="list">
                {timeline.length === 0 ? <p className="muted">No timeline events.</p> : null}
                {timeline.map((item, idx) => (
                  <div key={`${item.at}-${item.kind}-inspector-${idx}`} className="incident-event">
                    <div className="dlq-head">
                      <strong>{item.kind}</strong>
                      <span className="mono">{new Date(item.at).toLocaleString()}</span>
                    </div>
                    <p className="muted">actor: {item.actor}</p>
                    <p>{item.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "incidents") ? <Card className="panel span-2">
        <div data-testid="ops-incident-board">
        <div className="section-head">
          <h2>Incident Board</h2>
          <Button
            view="outlined"
            onClick={() => void runIncidentScan()}
            disabled={!canManageIncidents || isIncidentScanRunning}
            loading={isIncidentScanRunning}
          >
            Run SLA scan
          </Button>
        </div>
        {!canManageIncidents ? <p className="muted">Your role can view incidents, but cannot mutate them.</p> : null}
        <div className="list">
          {isRefreshing && incidents.length === 0 ? <p className="muted">Loading incidents…</p> : null}
          {!isRefreshing && incidents.length === 0 ? <p className="muted">No incidents.</p> : null}
          {incidents.map((incident) => (
            <article key={incident.id} className="dlq-item" data-testid="incident-item" data-incident-id={incident.id}>
              <div className="dlq-head">
                <strong>{incident.title}</strong>
                <span className={`status status-${incident.status}`}>{incident.status}</span>
              </div>
              <p className="muted">
                {incident.incident_type} · {incident.severity} · owner: {incident.owner ?? "unassigned"}
              </p>
              {incident.description ? <p>{incident.description}</p> : null}
              <div className="row-tight">
                <TextInput
                  size="m"
                  value={incidentOwnerDrafts[incident.id] ?? ""}
                  onUpdate={(value) => setIncidentOwnerDrafts((prev) => ({ ...prev, [incident.id]: value }))}
                  placeholder="owner"
                />
                <Button
                  view="outlined"
                  onClick={() => void updateIncident(incident.id, { owner: incidentOwnerDrafts[incident.id] })}
                  loading={incidentUpdatingId === incident.id}
                  disabled={!canManageIncidents || incidentUpdatingId === incident.id}
                >
                  Assign owner
                </Button>
                <Button
                  view="outlined"
                  onClick={() => void updateIncident(incident.id, { status: "triage", note: "triage started" })}
                  loading={incidentUpdatingId === incident.id}
                  disabled={!canManageIncidents || incidentUpdatingId === incident.id}
                >
                  Triage
                </Button>
                <Button
                  view="action"
                  onClick={() => void updateIncident(incident.id, { status: "resolved", note: "resolved" })}
                  loading={incidentUpdatingId === incident.id}
                  disabled={!canManageIncidents || incidentUpdatingId === incident.id}
                >
                  Resolve
                </Button>
              </div>
              <div className="row-tight">
                <TextArea
                  size="s"
                  value={incidentPostmortemDrafts[incident.id] ?? ""}
                  onUpdate={(value) => setIncidentPostmortemDrafts((prev) => ({ ...prev, [incident.id]: value }))}
                  placeholder="postmortem note"
                />
                <Button
                  view="flat"
                  onClick={() => void updateIncident(incident.id, { postmortem: incidentPostmortemDrafts[incident.id], note: "postmortem updated" })}
                  loading={incidentUpdatingId === incident.id}
                  disabled={!canManageIncidents || incidentUpdatingId === incident.id}
                >
                  Save postmortem
                </Button>
              </div>
              <div className="row-tight">
                <Button view="flat" onClick={() => void toggleIncidentEvents(incident.id)}>
                  {expandedIncidentIds[incident.id] ? "Hide events" : "Show events"}
                </Button>
              </div>
              {expandedIncidentIds[incident.id] ? (
                <div className="incident-events">
                  {incidentEventsLoadingId === incident.id ? <p className="muted">Loading events…</p> : null}
                  {(incidentEventsById[incident.id] ?? []).map((event) => (
                    <div key={event.id} className="incident-event">
                      <div className="dlq-head">
                        <strong>{event.action}</strong>
                        <span className="mono">{new Date(event.created_at).toLocaleString()}</span>
                      </div>
                      <p className="muted">actor: {event.actor}</p>
                      {event.note ? <p>{event.note}</p> : null}
                    </div>
                  ))}
                  {incidentEventsLoadingId !== incident.id && (incidentEventsById[incident.id] ?? []).length === 0 ? (
                    <p className="muted">No incident events.</p>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "finance") ? <Card className="panel span-2">
        <h2>Finance</h2>
        {!canViewFinance ? <p className="muted">Finance access is locked for your role.</p> : null}
        <div className="metric-grid">
          <div className="metric-tile">
            <span className="metric-label">Flows used</span>
            <strong className="metric-value">{margin?.flows_used ?? "-"}</strong>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Gross profit est.</span>
            <strong className="metric-value">{margin ? `$${margin.estimated_gross_profit_usd.toFixed(2)}` : "-"}</strong>
          </div>
        </div>
        <div className="list">
          {isRefreshing && ledger.length === 0 ? <p className="muted">Loading finance ledger…</p> : null}
          {!isRefreshing && ledger.length === 0 ? <p className="muted">No ledger entries.</p> : null}
          {ledger.slice(0, 10).map((entry) => (
            <div key={entry.id} className="dlq-item">
              <div className="dlq-head">
                <strong>{entry.entry_type}</strong>
                <span>{entry.amount_usd.toFixed(2)} {entry.currency}</span>
              </div>
              <p className="muted mono">{entry.task_id ? shortId(entry.task_id) : shortId(entry.account_id ?? "")}</p>
            </div>
          ))}
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "flows") ? <Card className="panel span-2">
        <h2>Case Audit Log</h2>
        <div className="list">
          {selectedFlowId && isRefreshing && audit.length === 0 ? <p className="muted">Loading audit events…</p> : null}
          {!isRefreshing && audit.length === 0 ? <p className="muted">No audit events.</p> : null}
          {audit.map((entry) => (
            <div key={entry.id} className="dlq-item">
              <div className="dlq-head">
                <strong>{entry.action}</strong>
                <span className="mono">{new Date(entry.created_at).toLocaleString()}</span>
              </div>
              <p className="muted">actor: {entry.actor}</p>
              {entry.note ? <p>{entry.note}</p> : null}
            </div>
          ))}
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "flows") ? <Card className="panel span-2">
        <h2>Case Timeline</h2>
        <div className="list">
          {selectedFlowId && isRefreshing && timeline.length === 0 ? <p className="muted">Loading timeline…</p> : null}
          {!isRefreshing && timeline.length === 0 ? <p className="muted">No timeline events.</p> : null}
          {timeline.map((item, idx) => (
            <div key={`${item.at}-${item.kind}-${idx}`} className="dlq-item">
              <div className="dlq-head">
                <strong>{item.kind}</strong>
                <span className="mono">{new Date(item.at).toLocaleString()}</span>
              </div>
              <p className="muted">actor: {item.actor}</p>
              <p>{item.message}</p>
            </div>
          ))}
        </div>
      </Card> : null}

      {(activeView === "all" || activeView === "observability") ? <Card className="panel span-2">
        <div data-testid="ops-dlq-panel">
        <h2>Webhook DLQ</h2>
        <div className="list">
          {isRefreshing && dlq.length === 0 ? <p className="muted">Loading DLQ…</p> : null}
          {!isRefreshing && dlq.length === 0 ? <p className="muted">DLQ is empty.</p> : null}
          {dlq.map((item) => (
            <article key={item.id} className="dlq-item" data-testid="dlq-item" data-dead-letter-id={item.id}>
              <div className="dlq-head">
                <strong>{item.status_code ?? "ERR"}</strong>
                <span className="mono">{shortId(item.task_id)}</span>
              </div>
              <p className="muted">{item.error ?? "Unknown error"}</p>
              <Button view="outlined" disabled={!!item.requeued_at} onClick={() => void requeue(item.id)}>
                {item.requeued_at ? "Requeued" : "Requeue"}
              </Button>
            </article>
          ))}
        </div>
        </div>
      </Card> : null}

      {error ? <p className="error span-2" role="alert">{error}</p> : null}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.level}`} role="status">
            {toast.text}
          </div>
        ))}
      </div>
      <Dialog
        open={confirmDialog.open}
        size="s"
        onClose={closeConfirmDialog}
        onOpenChange={(open) => {
          if (!open) closeConfirmDialog();
        }}
      >
        <Dialog.Header caption={confirmDialog.title} />
        <Dialog.Body>
          <p>{confirmDialog.message}</p>
        </Dialog.Body>
        <Dialog.Footer
          textButtonCancel="Cancel"
          textButtonApply={confirmDialog.applyText}
          preset={confirmDialog.danger ? "danger" : "default"}
          onClickButtonCancel={closeConfirmDialog}
          onClickButtonApply={() => {
            const handler = confirmHandlerRef.current;
            closeConfirmDialog();
            if (handler) handler();
          }}
        />
      </Dialog>
    </section>
  );
}

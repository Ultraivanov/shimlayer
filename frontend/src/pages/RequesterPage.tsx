import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextArea, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { BalanceResponse, OpenAIInterruptionRecord, OpenAIResumeResponse, PackageInfo, Task, TaskWithReview } from "../types";
import { ArtifactTile } from "../components/ArtifactTile";

type Props = {
  pushTask: (task: Task) => void;
};

type ToastLevel = "success" | "error";
type ToastMessage = { id: string; level: ToastLevel; text: string };

type AutoRefreshSeconds = 0 | 5 | 15 | 30 | 60;
type ArtifactsMode = "upload" | "register";
type OpenAIMode = "ingest" | "load";

const SYNC_CURSOR_KEY = "requester.syncCursor.v1";
const SYNC_UPDATED_AFTER_KEY = "requester.syncUpdatedAfter.v1";
const ACTIVE_POLL_ENABLED_KEY = "requester.activePollEnabled.v1";

export function RequesterPage({ pushTask }: Props) {
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [tasks, setTasks] = useState<TaskWithReview[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<string>("");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>("");
  const [taskSearch, setTaskSearch] = useState<string>("");
  const [taskLookupId, setTaskLookupId] = useState<string>("");
  const [taskLookupBusy, setTaskLookupBusy] = useState<boolean>(false);
  const [taskIdForRefund, setTaskIdForRefund] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [createTaskType, setCreateTaskType] = useState<string>("stuck_recovery");
  const [createContextJson, setCreateContextJson] = useState<string>('{"logs":"..."}');
  const [createSlaSeconds, setCreateSlaSeconds] = useState<string>("120");
  const [createMaxPriceUsd, setCreateMaxPriceUsd] = useState<string>("0.48");
  const [createCallbackUrl, setCreateCallbackUrl] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [showDemo, setShowDemo] = useState<boolean>(false);
  const [openAiMode, setOpenAiMode] = useState<OpenAIMode>("ingest");
  const [openAiBusy, setOpenAiBusy] = useState<boolean>(false);
  const [openAiRecord, setOpenAiRecord] = useState<OpenAIInterruptionRecord | null>(null);
  const [openAiResume, setOpenAiResume] = useState<OpenAIResumeResponse | null>(null);
  const [openAiInterruptionId, setOpenAiInterruptionId] = useState<string>("");
  const [openAiRunId, setOpenAiRunId] = useState<string>("");
  const [openAiToolName, setOpenAiToolName] = useState<string>("");
  const [openAiThreadId, setOpenAiThreadId] = useState<string>("");
  const [openAiAgentName, setOpenAiAgentName] = useState<string>("");
  const [openAiStateBlob, setOpenAiStateBlob] = useState<string>("");
  const [openAiToolArgsJson, setOpenAiToolArgsJson] = useState<string>("{}");
  const [openAiMetadataJson, setOpenAiMetadataJson] = useState<string>("{}");
  const [openAiCallbackUrl, setOpenAiCallbackUrl] = useState<string>("");
  const [openAiSlaSeconds, setOpenAiSlaSeconds] = useState<string>("120");
  const [openAiDecisionNote, setOpenAiDecisionNote] = useState<string>("");
  const [uploadArtifactType, setUploadArtifactType] = useState<string>("logs");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  function pushToast(level: ToastLevel, text: string) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev.slice(-3), { id, level, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }
  const [uploadFileError, setUploadFileError] = useState<string>("");
  const [uploadFileSha256, setUploadFileSha256] = useState<string>("");
  const [uploadFileHashing, setUploadFileHashing] = useState(false);
  const [proofArtifactType, setProofArtifactType] = useState<string>("logs");
  const [proofStoragePath, setProofStoragePath] = useState<string>("");
  const [proofChecksum, setProofChecksum] = useState<string>("");
  const [proofMetadataJson, setProofMetadataJson] = useState<string>("{}");
  const [proofBusy, setProofBusy] = useState(false);
  const [proofAllowMetadataOnly, setProofAllowMetadataOnly] = useState<boolean>(false);
  const [artifactsMode, setArtifactsMode] = useState<ArtifactsMode>("upload");
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [workerNoteDraft, setWorkerNoteDraft] = useState<string>("");
  const [stuckActionSummaryDraft, setStuckActionSummaryDraft] = useState<string>("Updated selector and resumed flow.");
  const [stuckNextStepDraft, setStuckNextStepDraft] = useState<string>("Continue automation.");
  const [judgmentDecisionDraft, setJudgmentDecisionDraft] = useState<string>("yes");
  const [judgmentNoteDraft, setJudgmentNoteDraft] = useState<string>("Safe to continue.");
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<AutoRefreshSeconds>(
    () => Number(localStorage.getItem("requester.autoRefreshSeconds") ?? "15") as AutoRefreshSeconds
  );
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  const [lastTasksRefreshAt, setLastTasksRefreshAt] = useState<string>("");
  const [lastBalanceRefreshAt, setLastBalanceRefreshAt] = useState<string>("");
  const [autoRefreshPausedUntilMs, setAutoRefreshPausedUntilMs] = useState<number>(0);
  const [autoRefreshFailureCount, setAutoRefreshFailureCount] = useState<number>(0);
  const [autoRefreshLastError, setAutoRefreshLastError] = useState<string>("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [syncCursor, setSyncCursor] = useState<string>(() => localStorage.getItem(SYNC_CURSOR_KEY) ?? "");
  const [lastSyncAt, setLastSyncAt] = useState<string>("");
  const [isSyncRunning, setIsSyncRunning] = useState(false);
  const [activePollStatus, setActivePollStatus] = useState<string>("");
  const [activePollEnabled, setActivePollEnabled] = useState<boolean>(() => {
    const raw = localStorage.getItem(ACTIVE_POLL_ENABLED_KEY);
    if (raw === null) return true;
    return raw === "true";
  });
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [webhookDeliveries, setWebhookDeliveries] = useState<
    Array<{ id: string; created_at: string; attempt_no: number; success: boolean; status_code: number | null; error: string | null }>
  >([]);
  const [webhookLast, setWebhookLast] = useState<{ created_at: string; success: boolean; status_code: number | null; error: string | null } | null>(null);
  const [webhookDeliveriesLoading, setWebhookDeliveriesLoading] = useState(false);
  const [webhookDeliveriesError, setWebhookDeliveriesError] = useState("");
  const [webhookAttemptsOpen, setWebhookAttemptsOpen] = useState(false);
  const balanceRefreshInFlightRef = useRef(false);
  const autoRefreshPausedUntilMsRef = useRef(0);
  const syncInFlightRef = useRef(false);
  const activePollSessionRef = useRef(0);
  const proofFormRef = useRef<HTMLDivElement | null>(null);

  const TASK_STATUSES = ["any", "pending", "queued", "claimed", "completed", "failed", "disputed", "refunded"] as const;
  const TASK_TYPES = ["any", "stuck_recovery", "quick_judgment"] as const;
  const ARTIFACT_TYPES = ["logs", "screenshot", "json_payload"] as const;
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

  const sortedTasks = useMemo(() => {
    const rows = [...tasks];
    rows.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return rows;
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = taskSearch.trim().toLowerCase();
    return sortedTasks.filter((t) => {
      if (taskStatusFilter && taskStatusFilter !== "any" && t.status !== taskStatusFilter) return false;
      if (taskTypeFilter && taskTypeFilter !== "any" && t.task_type !== taskTypeFilter) return false;
      if (!q) return true;
      const haystack = `${t.id} ${t.task_type} ${t.status}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedTasks, taskSearch, taskStatusFilter, taskTypeFilter]);

  const selectedTask = useMemo(
    () => filteredTasks.find((t) => t.id === selectedTaskId) ?? filteredTasks[0] ?? null,
    [filteredTasks, selectedTaskId]
  );
  const hasQualityProof = useMemo(() => {
    const artifacts = selectedTask?.artifacts ?? [];
    return artifacts.some((a) => {
      const storagePath = String((a as any).storage_path ?? "");
      const checksum = String((a as any).checksum_sha256 ?? "");
      return storagePath.startsWith("local:") || checksum.length === 64;
    });
  }, [selectedTask]);

  useEffect(() => {
    setError(null);
    setWorkerNoteDraft("");
    if (!selectedTask) return;
    if (selectedTask.task_type === "quick_judgment") {
      setJudgmentDecisionDraft("yes");
      setJudgmentNoteDraft("Safe to continue.");
    } else {
      setStuckActionSummaryDraft("Updated selector and resumed flow.");
      setStuckNextStepDraft("Continue automation.");
    }
  }, [selectedTask?.id]);

  function shortId(value: string): string {
    return value.slice(0, 8);
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function formatDurationShort(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m <= 0) return `${s}s`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function prettyJson(value: unknown): string {
    if (value === null || value === undefined) return "{}";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function parseJsonObject(raw: string, label: string): Record<string, unknown> {
    const trimmed = (raw || "").trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
    return parsed as Record<string, unknown>;
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      setError(String(e));
    }
  }

  function upsertTaskInList(task: TaskWithReview) {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [task, ...prev];
      const next = [...prev];
      next[idx] = task;
      return next;
    });
  }

  async function lookupTaskById() {
    const id = taskLookupId.trim();
    if (!id) return;
    if (taskLookupBusy) return;
    setTaskLookupBusy(true);
    setError(null);
    try {
      const task = await Api.getTask(id);
      upsertTaskInList(task);
      setSelectedTaskId(task.id);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.startsWith("404")) {
        setError("Task not found (or not owned by this API key).");
      } else {
        setError(raw);
      }
    } finally {
      setTaskLookupBusy(false);
    }
  }

  async function loadOpenAiInterruption(interruptionId: string) {
    const id = interruptionId.trim();
    if (!id) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const record = await Api.getOpenAIInterruption(id);
      setOpenAiRecord(record);
      setOpenAiResume(null);
      setSelectedTaskId(record.task_id);
      setTaskLookupId(record.task_id);
      pushToast("success", "Loaded interruption");
      await refresh();
    } catch (e) {
      setError(String(e));
      pushToast("error", `Load interruption failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function ingestOpenAiInterruption() {
    if (openAiBusy) return;
    const interruptionId = openAiInterruptionId.trim();
    const runId = openAiRunId.trim();
    const toolName = openAiToolName.trim();
    const stateBlob = openAiStateBlob.trim();
    if (!interruptionId || !runId || !toolName || !stateBlob) {
      pushToast("error", "Missing required fields: interruption_id, run_id, tool_name, state_blob");
      return;
    }
    const slaSeconds = Number(openAiSlaSeconds);
    if (!Number.isFinite(slaSeconds) || slaSeconds < 30 || slaSeconds > 900) {
      pushToast("error", "sla_seconds must be 30..900");
      return;
    }
    setOpenAiBusy(true);
    setError(null);
    try {
      const record = await Api.ingestOpenAIInterruption({
        run_id: runId,
        thread_id: openAiThreadId.trim() ? openAiThreadId.trim() : null,
        interruption_id: interruptionId,
        agent_name: openAiAgentName.trim() ? openAiAgentName.trim() : null,
        tool_name: toolName,
        tool_arguments: parseJsonObject(openAiToolArgsJson, "tool_arguments"),
        state_blob: stateBlob,
        metadata: parseJsonObject(openAiMetadataJson, "metadata"),
        callback_url: openAiCallbackUrl.trim() ? openAiCallbackUrl.trim() : null,
        sla_seconds: slaSeconds,
      });
      setOpenAiRecord(record);
      setOpenAiResume(null);
      setSelectedTaskId(record.task_id);
      setTaskLookupId(record.task_id);
      pushToast("success", "Interruption ingested");
      await refresh();
    } catch (e) {
      setError(String(e));
      pushToast("error", `Ingest failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function decideOpenAiInterruption(decision: "approve" | "reject") {
    if (!openAiRecord) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const record = await Api.decideOpenAIInterruption(openAiRecord.interruption_id, {
        decision,
        actor: "requester",
        note: openAiDecisionNote.trim() ? openAiDecisionNote.trim() : null,
        output: {},
      });
      setOpenAiRecord(record);
      setSelectedTaskId(record.task_id);
      setTaskLookupId(record.task_id);
      pushToast("success", `Decision recorded: ${decision}`);
      await refresh();
    } catch (e) {
      setError(String(e));
      pushToast("error", `Decision failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function resumeOpenAiInterruption() {
    if (!openAiRecord) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const res = await Api.resumeOpenAIInterruption(openAiRecord.interruption_id);
      setOpenAiResume(res);
      pushToast("success", "Resume payload created");
      await loadOpenAiInterruption(openAiRecord.interruption_id);
    } catch (e) {
      setError(String(e));
      pushToast("error", `Resume failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function sha256HexFromFile(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(digest);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  async function refresh() {
    setError(null);
    try {
      const [pkg, bal, myTasks] = await Promise.all([Api.listPackages(), Api.getBalance(), Api.listMyTasks({ limit: 50 })]);
      setPackages(pkg);
      setBalance(bal);
      setTasks(myTasks);
      setLastTasksRefreshAt(new Date().toLocaleTimeString());
      setLastBalanceRefreshAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    }
  }

  function upsertTasksInList(items: TaskWithReview[]) {
    setTasks((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t] as const));
      for (const item of items) byId.set(item.id, item);
      const next = Array.from(byId.values());
      next.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return next.slice(0, 200);
    });
  }

  function computeBootstrapUpdatedAfterIso(): string {
    const stored = localStorage.getItem(SYNC_UPDATED_AFTER_KEY);
    if (stored) return stored;
    const newest = tasks.reduce<number>((max, t) => Math.max(max, new Date(t.updated_at).getTime()), 0);
    if (newest > 0) {
      const iso = new Date(Math.max(0, newest - 1000)).toISOString(); // widen 1s to avoid tie misses
      localStorage.setItem(SYNC_UPDATED_AFTER_KEY, iso);
      return iso;
    }
    const iso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    localStorage.setItem(SYNC_UPDATED_AFTER_KEY, iso);
    return iso;
  }

  async function syncTasksOnce({ silent }: { silent: boolean }) {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setIsSyncRunning(true);
    try {
      const cursor = syncCursor.trim();
      const res = await Api.syncMyTasks(
        cursor
          ? { limit: 200, cursor }
          : { limit: 200, updatedAfter: computeBootstrapUpdatedAfterIso() }
      );
      if (res.items.length > 0) upsertTasksInList(res.items);
      setLastSyncAt(new Date().toLocaleTimeString());

      if (res.next_cursor) {
        setSyncCursor(res.next_cursor);
        localStorage.setItem(SYNC_CURSOR_KEY, res.next_cursor);
        localStorage.removeItem(SYNC_UPDATED_AFTER_KEY);
      } else if (!cursor) {
        const nextAfter = new Date(Date.now() - 1000).toISOString();
        localStorage.setItem(SYNC_UPDATED_AFTER_KEY, nextAfter);
      }
    } catch (e) {
      if (!silent) setError(String(e));
      throw e;
    } finally {
      syncInFlightRef.current = false;
      setIsSyncRunning(false);
    }
  }

  async function refreshWebhookLast(taskId: string) {
    try {
      const last = await Api.getTaskWebhookLastDelivery(taskId);
      setWebhookLast(last ? { created_at: last.created_at, success: last.success, status_code: last.status_code, error: last.error } : null);
    } catch (e) {
      // Keep this lightweight: last-delivery is best-effort for UX; details fetch shows errors.
      setWebhookLast(null);
    }
  }

  async function refreshWebhookAttempts(taskId: string) {
    setWebhookDeliveriesLoading(true);
    setWebhookDeliveriesError("");
    try {
      const rows = await Api.listTaskWebhookDeliveries(taskId, 20);
      setWebhookDeliveries(rows);
      if (rows.length > 0) {
        setWebhookLast({ created_at: rows[0].created_at, success: rows[0].success, status_code: rows[0].status_code, error: rows[0].error });
      }
    } catch (e) {
      setWebhookDeliveriesError(String(e));
    } finally {
      setWebhookDeliveriesLoading(false);
    }
  }

  async function refreshBalanceOnly({ silent }: { silent: boolean }) {
    if (balanceRefreshInFlightRef.current) return;
    balanceRefreshInFlightRef.current = true;
    try {
      const bal = await Api.getBalance();
      setBalance(bal);
      setLastBalanceRefreshAt(new Date().toLocaleTimeString());
    } catch (e) {
      if (!silent) setError(String(e));
      throw e;
    } finally {
      balanceRefreshInFlightRef.current = false;
    }
  }

  function autoBackoffMs(failures: number): number {
    const n = Math.max(1, Math.min(10, failures));
    const base = 4000; // 4s
    const ms = base * Math.pow(2, n - 1);
    return Math.min(ms, 2 * 60 * 1000); // cap 2m
  }

  function recordAutoRefreshSuccess() {
    if (autoRefreshFailureCount !== 0) setAutoRefreshFailureCount(0);
    if (autoRefreshPausedUntilMs !== 0) setAutoRefreshPausedUntilMs(0);
    if (autoRefreshLastError) setAutoRefreshLastError("");
  }

  function recordAutoRefreshFailure(err: unknown) {
    setAutoRefreshFailureCount((c) => {
      const next = c + 1;
      setAutoRefreshPausedUntilMs(Date.now() + autoBackoffMs(next));
      return next;
    });
    setAutoRefreshLastError(err instanceof Error ? err.message : String(err));
  }

  function resetAutoRefreshPause() {
    setAutoRefreshPausedUntilMs(0);
    setAutoRefreshFailureCount(0);
    setAutoRefreshLastError("");
  }

  async function autoRefreshTick() {
    if (!isPageVisible) return;
    if (!autoRefreshSeconds) return;
    const now = Date.now();
    const pausedUntil = autoRefreshPausedUntilMsRef.current;
    if (pausedUntil && now < pausedUntil) return;
    try {
      await Promise.all([syncTasksOnce({ silent: true }), refreshBalanceOnly({ silent: true })]);
      recordAutoRefreshSuccess();
    } catch (e) {
      recordAutoRefreshFailure(e);
    }
  }

  useEffect(() => {
    if (!selectedTaskId && filteredTasks.length > 0) setSelectedTaskId(filteredTasks[0].id);
    if (selectedTaskId && filteredTasks.length > 0 && !filteredTasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0]?.id ?? "");
    }
    if (selectedTaskId && filteredTasks.length === 0) setSelectedTaskId("");
  }, [filteredTasks, selectedTaskId]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    localStorage.setItem("requester.autoRefreshSeconds", String(autoRefreshSeconds));
  }, [autoRefreshSeconds]);

  useEffect(() => {
    function onVisibilityChange() {
      setIsPageVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!isPageVisible) return;
    if (!autoRefreshSeconds) return;
    const ms = autoRefreshSeconds * 1000;
    const id = window.setInterval(() => void autoRefreshTick(), ms);
    return () => window.clearInterval(id);
  }, [autoRefreshSeconds, isPageVisible]);

  useEffect(() => {
    autoRefreshPausedUntilMsRef.current = autoRefreshPausedUntilMs;
  }, [autoRefreshPausedUntilMs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(ACTIVE_POLL_ENABLED_KEY, String(activePollEnabled));
    if (!activePollEnabled) {
      activePollSessionRef.current += 1; // cancel in-flight polls
      setActivePollStatus("");
    }
  }, [activePollEnabled]);

  useEffect(() => {
    if (!selectedTask) {
      setWebhookDeliveries([]);
      setWebhookLast(null);
      setWebhookDeliveriesError("");
      setWebhookAttemptsOpen(false);
      return;
    }
    if (!selectedTask.callback_url) {
      setWebhookDeliveries([]);
      setWebhookLast(null);
      setWebhookDeliveriesError("");
      setWebhookAttemptsOpen(false);
      return;
    }
    void refreshWebhookLast(selectedTask.id);
  }, [selectedTask?.id, selectedTask?.callback_url]);

  useEffect(() => {
    // Avoid carrying proof/upload draft state between tasks.
    if (!selectedTask) return;
    setArtifactsMode("upload");
    setUploadFile(null);
    setUploadFileError("");
    setUploadFileSha256("");
    setProofArtifactType("logs");
    setProofStoragePath("");
    setProofChecksum("");
    setProofMetadataJson("{}");
    setProofAllowMetadataOnly(false);
  }, [selectedTask?.id]);

  useEffect(() => {
    if (!selectedTask) return;
    if (!activePollEnabled) return;
    const status = selectedTask.status;
    if (status !== "queued" && status !== "claimed") {
      setActivePollStatus("");
      return;
    }

    const session = activePollSessionRef.current + 1;
    activePollSessionRef.current = session;
    const startedAt = Date.now();
    let attempt = 0;

    const tick = async () => {
      if (activePollSessionRef.current !== session) return;
      attempt += 1;
      setActivePollStatus(`polling (${attempt})`);
      try {
        const fresh = await Api.getTask(selectedTask.id);
        upsertTaskInList(fresh);
        const freshStatus = fresh.status;
        if (freshStatus !== "queued" && freshStatus !== "claimed") {
          setActivePollStatus("");
          return;
        }
      } catch (e) {
        setActivePollStatus(`poll error: ${String(e)}`);
      }

      const elapsedMs = Date.now() - startedAt;
      let delayMs = 4000;
      if (elapsedMs < 60_000) delayMs = 2500;
      else if (elapsedMs < 5 * 60_000) delayMs = 8000;
      else delayMs = 30_000;
      const jitter = 0.8 + Math.random() * 0.4;
      delayMs = Math.floor(delayMs * jitter);
      window.setTimeout(() => void tick(), delayMs);
    };

    window.setTimeout(() => void tick(), 400);
    return () => {
      if (activePollSessionRef.current === session) activePollSessionRef.current += 1;
    };
  }, [selectedTask?.id, selectedTask?.status]);

  async function buyPackage(code: string) {
    try {
      await Api.purchasePackage(code, `ui-${Date.now()}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createStuckTask() {
    setCreateTaskType("stuck_recovery");
    setCreateContextJson(JSON.stringify({ logs: "Agent loop in checkout", prompt: "retrying forever" }, null, 2));
    setCreateSlaSeconds("120");
    setCreateMaxPriceUsd("0.48");
    setCreateCallbackUrl("https://example.com/webhook");
  }

  async function createQuickJudgment() {
    setCreateTaskType("quick_judgment");
    setCreateContextJson(JSON.stringify({ question: "Approve this automation run?" }, null, 2));
    setCreateSlaSeconds("60");
    setCreateMaxPriceUsd("0.48");
    setCreateCallbackUrl("https://example.com/webhook");
  }

  async function submitCreateTask() {
    if (createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const slaSeconds = Number(createSlaSeconds);
      if (!Number.isFinite(slaSeconds) || slaSeconds < 30 || slaSeconds > 900) {
        throw new Error("sla_seconds must be 30..900");
      }
      const maxPriceUsd = Number(createMaxPriceUsd);
      if (!Number.isFinite(maxPriceUsd) || maxPriceUsd <= 0) {
        throw new Error("max_price_usd must be > 0");
      }
      const parsed = JSON.parse(createContextJson || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("context must be a JSON object");
      }
      const payload = {
        task_type: createTaskType,
        context: parsed as Record<string, unknown>,
        sla_seconds: slaSeconds,
        max_price_usd: maxPriceUsd,
        callback_url: createCallbackUrl.trim() ? createCallbackUrl.trim() : null
      };
      const task = await Api.createTask(payload);
      pushTask(task);
      await refresh();
      setSelectedTaskId(task.id);
      pushToast("success", "Task created");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Create failed: ${String(e)}`);
    } finally {
      setCreateBusy(false);
    }
  }

  async function createDemoTask(kind: "stuck_recovery" | "quick_judgment") {
    if (createBusy) return;
    setError(null);
    if (kind === "stuck_recovery") {
      setCreateTaskType("stuck_recovery");
      setCreateContextJson(JSON.stringify({ logs: "Agent loop in checkout", prompt: "retrying forever", source: "requester-demo" }, null, 2));
      setCreateSlaSeconds("180");
      setCreateMaxPriceUsd("0.48");
      setCreateCallbackUrl("");
    } else {
      setCreateTaskType("quick_judgment");
      setCreateContextJson(JSON.stringify({ question: "Approve this automation run?", source: "requester-demo" }, null, 2));
      setCreateSlaSeconds("90");
      setCreateMaxPriceUsd("0.48");
      setCreateCallbackUrl("");
    }
    await submitCreateTask();
  }

  async function refund() {
    if (!taskIdForRefund) return;
    try {
      const task = await Api.refundTask(taskIdForRefund);
      pushTask(task);
      setTaskIdForRefund("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function uploadSelectedArtifact() {
    if (!selectedTask) return;
    if (!uploadFile) return;
    if (uploadFileError) return;
    setUploadBusy(true);
    setError(null);
    try {
      await Api.uploadArtifactMultipart(selectedTask.id, uploadArtifactType, uploadFile);
      setUploadFile(null);
      setUploadFileError("");
      setUploadFileSha256("");
      await refresh();
      pushToast("success", "Artifact uploaded");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Upload failed: ${String(e)}`);
    } finally {
      setUploadBusy(false);
    }
  }

  async function onSelectUploadFile(file: File | null) {
    setUploadFile(file);
    setUploadFileError("");
    setUploadFileSha256("");
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadFileError(`File too large (${formatBytes(file.size)}). Max is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    const expectedType = uploadArtifactType;
    const name = file.name.toLowerCase();
    const type = String(file.type || "").toLowerCase();
    if (expectedType === "screenshot") {
      if (type && !type.startsWith("image/")) {
        setUploadFileError(`Expected an image file for screenshot, got content-type=${type || "unknown"}.`);
        return;
      }
    } else if (expectedType === "json_payload") {
      const ok = (type && type.includes("json")) || name.endsWith(".json");
      if (!ok) {
        setUploadFileError(`Expected JSON file for json_payload (content-type json or .json filename).`);
        return;
      }
    } else if (expectedType === "logs") {
      const ok = !type || type.startsWith("text/") || name.endsWith(".log") || name.endsWith(".txt");
      if (!ok) {
        setUploadFileError(`Logs usually should be text (.log/.txt). Got content-type=${type || "unknown"}.`);
        return;
      }
    }

    try {
      setUploadFileHashing(true);
      const hash = await sha256HexFromFile(file);
      setUploadFileSha256(hash);
    } catch (e) {
      setUploadFileError(`Failed to compute sha256: ${String(e)}`);
    } finally {
      setUploadFileHashing(false);
    }
  }

  function isSha256Hex(value: string): boolean {
    return /^[0-9a-f]{64}$/i.test(value.trim());
  }

  const proofChecksumError = useMemo(() => {
    const v = proofChecksum.trim();
    if (!v) return "";
    return isSha256Hex(v) ? "" : "Invalid sha256: must be 64 hex chars.";
  }, [proofChecksum]);

  const proofMetadataError = useMemo(() => {
    const raw = proofMetadataJson.trim();
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "metadata must be a JSON object";
      return "";
    } catch {
      return "metadata is not valid JSON";
    }
  }, [proofMetadataJson]);

  const proofCanSubmit = useMemo(() => {
    return Boolean(proofStoragePath.trim()) && !proofChecksumError && !proofMetadataError;
  }, [proofChecksumError, proofMetadataError, proofStoragePath]);

  const proofWouldBeQuality = useMemo(() => {
    const storage = proofStoragePath.trim();
    if (!storage) return false;
    if (storage.startsWith("local:")) return true;
    const checksum = proofChecksum.trim();
    return Boolean(checksum) && isSha256Hex(checksum);
  }, [proofStoragePath, proofChecksum]);

  const proofCanSubmitAsQuality = useMemo(() => {
    if (!proofCanSubmit) return false;
    if (proofWouldBeQuality) return true;
    return proofAllowMetadataOnly;
  }, [proofAllowMetadataOnly, proofCanSubmit, proofWouldBeQuality]);

  useEffect(() => {
    if (proofWouldBeQuality && proofAllowMetadataOnly) setProofAllowMetadataOnly(false);
  }, [proofAllowMetadataOnly, proofWouldBeQuality]);

  const proofStorageScheme = useMemo(() => {
    const v = proofStoragePath.trim();
    if (!v) return "";
    if (v.startsWith("local:")) return "local";
    if (v.startsWith("s3://")) return "s3";
    if (v.startsWith("gs://")) return "gcs";
    if (v.startsWith("https://") || v.startsWith("http://")) return "http";
    return "custom";
  }, [proofStoragePath]);

  function applyProofTemplate(kind: "s3" | "gcs" | "http") {
    if (!selectedTask) return;
    setProofArtifactType("logs");
    const id = selectedTask.id;
    if (kind === "s3") {
      setProofStoragePath(`s3://bucket/proofs/${id}/logs.txt`);
      setProofMetadataJson('{"source":"s3"}');
    } else if (kind === "gcs") {
      setProofStoragePath(`gs://bucket/proofs/${id}/logs.txt`);
      setProofMetadataJson('{"source":"gcs"}');
    } else {
      setProofStoragePath(`https://example.com/proofs/${id}/logs.txt`);
      setProofMetadataJson('{"source":"http"}');
    }
    setProofChecksum("");
  }

  async function registerProofMetadata(): Promise<boolean> {
    if (!selectedTask) return false;
    const storage = proofStoragePath.trim();
    if (!storage) {
      setError("storage_path is required");
      return false;
    }
    const checksum = proofChecksum.trim();
    if (checksum && !isSha256Hex(checksum)) {
      setError("checksum_sha256 must be 64 hex chars");
      return false;
    }
    let meta: Record<string, unknown> = {};
    try {
      const rawMeta = proofMetadataJson.trim();
      const parsed = JSON.parse(rawMeta || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      else throw new Error("metadata must be a JSON object");
    } catch (e) {
      setError(`Invalid metadata JSON: ${String(e)}`);
      return false;
    }
    setProofBusy(true);
    setError(null);
    try {
      await Api.uploadProof(selectedTask.id, {
        artifact_type: proofArtifactType,
        storage_path: storage,
        checksum_sha256: checksum || null,
        metadata: meta
      });
      setProofStoragePath("");
      setProofChecksum("");
      setProofMetadataJson("{}");
      await refresh();
      pushToast("success", proofWouldBeQuality ? "Proof registered (quality)" : "Proof metadata registered");
      return true;
    } catch (e) {
      setError(String(e));
      pushToast("error", `Proof register failed: ${String(e)}`);
      return false;
    } finally {
      setProofBusy(false);
    }
  }

  function prefillProofFromArtifact(artifact: unknown) {
    const a = artifact as any;
    const storage = String(a?.storage_path ?? "").trim();
    if (!storage) return;
    setArtifactsMode("register");
    setProofArtifactType(String(a?.artifact_type ?? "logs") || "logs");
    setProofStoragePath(storage);
    setProofChecksum(String(a?.checksum_sha256 ?? ""));
    try {
      const meta = a?.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? a.metadata : {};
      setProofMetadataJson(JSON.stringify(meta));
    } catch {
      setProofMetadataJson("{}");
    }
    window.setTimeout(() => {
      proofFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function claimSelectedTask() {
    if (!selectedTask) return;
    if (taskActionBusy) return;
    setTaskActionBusy(true);
    setError(null);
    try {
      await Api.claimTask(selectedTask.id);
      await refresh();
      pushToast("success", "Task claimed");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Claim failed: ${String(e)}`);
    } finally {
      setTaskActionBusy(false);
    }
  }

  function friendlyCompleteError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const m = raw.match(/^(\d{3})\s+/);
    const code = m ? Number(m[1]) : null;
    if (code === 409 && raw.toLowerCase().includes("quality proof")) {
      return "Cannot complete: add a quality proof artifact first (upload artifact or register proof with checksum).";
    }
    if (code === 400 && raw.toLowerCase().includes("invalid result payload")) {
      return "Cannot complete: invalid result payload (fill required fields for this task type).";
    }
    if (code === 404 && raw.toLowerCase().includes("invalid state")) {
      return "Cannot complete: task is not in a completable state.";
    }
    return raw;
  }

  async function completeSelectedTask() {
    if (!selectedTask) return;
    if (taskActionBusy) return;
    setTaskActionBusy(true);
    setError(null);
    try {
      const result =
        selectedTask.task_type === "quick_judgment"
          ? { decision: judgmentDecisionDraft, note: judgmentNoteDraft }
          : { action_summary: stuckActionSummaryDraft, next_step: stuckNextStepDraft };
      await Api.completeTask(selectedTask.id, result, workerNoteDraft || null);
      await refresh();
      pushToast("success", "Task completed");
    } catch (e) {
      const msg = friendlyCompleteError(e);
      setError(msg);
      pushToast("error", `Complete failed: ${msg}`);
    } finally {
      setTaskActionBusy(false);
    }
  }

  return (
    <section className="grid two-col">
      <Card className="panel" view="raised" data-testid="requester-credit-wallet">
        <h2>Credit Wallet</h2>
        <p className="muted">Prepaid balance and flow credits for every HITL escalation.</p>
        <div className="metric-grid">
          <div className="metric-tile">
            <span className="metric-label">Flow credits</span>
            <strong className="metric-value">{balance?.flow_credits ?? "-"}</strong>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Balance, USD</span>
            <strong className="metric-value">{balance?.balance_usd ?? "-"}</strong>
          </div>
        </div>
        <p className="muted mono" style={{ marginTop: 8 }}>
          {lastBalanceRefreshAt ? `refreshed ${lastBalanceRefreshAt}` : ""}
        </p>
        {autoRefreshSeconds && autoRefreshPausedUntilMs && nowMs < autoRefreshPausedUntilMs ? (
          <p className="muted mono" style={{ marginTop: 6 }}>
            auto-refresh paused {formatDurationShort(autoRefreshPausedUntilMs - nowMs)}
            {autoRefreshLastError ? <span className="muted"> · {autoRefreshLastError}</span> : null}
            {" · "}
            <Button
              size="s"
              view="flat"
              onClick={() => {
                resetAutoRefreshPause();
                void autoRefreshTick();
              }}
            >
              Resume
            </Button>
          </p>
        ) : null}
      </Card>

      <Card className="panel" view="raised" data-testid="requester-create-task">
        <h2>Create Task</h2>
        <p className="muted">Launch a rescue or quick-judgment flow in one click.</p>
        <div className="row-tight" style={{ alignItems: "center" }}>
          <Select
            width="max"
            value={[createTaskType]}
            options={["stuck_recovery", "quick_judgment"].map((t) => ({ value: t, content: `Type: ${t}` }))}
            onUpdate={(items) => setCreateTaskType(String(items[0] ?? "stuck_recovery"))}
            disabled={createBusy}
          />
          <TextInput
            size="m"
            value={createSlaSeconds}
            onUpdate={setCreateSlaSeconds}
            placeholder="sla_seconds (30..900)"
            disabled={createBusy}
          />
        </div>
        <div className="row-tight" style={{ alignItems: "center", marginTop: 8 }}>
          <TextInput
            size="m"
            value={createMaxPriceUsd}
            onUpdate={setCreateMaxPriceUsd}
            placeholder="max_price_usd"
            disabled={createBusy}
          />
          <TextInput
            size="m"
            value={createCallbackUrl}
            onUpdate={setCreateCallbackUrl}
            placeholder="callback_url (optional)"
            disabled={createBusy}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <TextArea
            value={createContextJson}
            onUpdate={setCreateContextJson}
            placeholder="context JSON"
            minRows={6}
            disabled={createBusy}
          />
        </div>
        <div className="row-tight" style={{ marginTop: 8, alignItems: "center" }}>
          <Button size="m" view="outlined" disabled={createBusy} onClick={createStuckTask}>
            Load stuck preset
          </Button>
          <Button size="m" view="outlined" disabled={createBusy} onClick={createQuickJudgment}>
            Load judgment preset
          </Button>
          <Button size="m" view="action" disabled={createBusy} loading={createBusy} onClick={() => void submitCreateTask()}>
            Create task
          </Button>
        </div>
        <div className="refund-row">
          <TextInput
            size="l"
            placeholder="Task ID for refund"
            value={taskIdForRefund}
            onUpdate={setTaskIdForRefund}
          />
          <Button size="l" view="outlined-danger" onClick={refund}>
            Refund Task
          </Button>
        </div>
      </Card>

      <Card className="panel span-2" view="raised" data-testid="requester-packages">
        <div className="section-head">
          <h2>Packages</h2>
          <Button
            view="flat"
            onClick={() => {
              resetAutoRefreshPause();
              void refresh();
            }}
          >
            Refresh
          </Button>
        </div>
        <div className="cards">
          {packages.map((p) => (
            <article key={p.code} className="price-card">
              <div className="price-top">
                <h3>{p.code}</h3>
                <span className="chip">{p.flows} flows</span>
              </div>
              <p className="price">${p.price_usd.toFixed(2)}</p>
              <p className="muted">${p.unit_price_usd.toFixed(2)} / flow</p>
              <Button view="normal" size="m" width="max" onClick={() => buyPackage(p.code)}>
                Buy package
              </Button>
            </article>
          ))}
        </div>
      </Card>

      <Card className="panel span-2" view="raised" data-testid="requester-my-tasks">
        <div className="section-head">
          <h2>My Tasks</h2>
          <span className="chip">{filteredTasks.length}/{sortedTasks.length}</span>
          <span className="muted mono">{lastTasksRefreshAt ? `refreshed ${lastTasksRefreshAt}` : ""}</span>
          {showDebug ? (
            <span className="muted mono" title={syncCursor ? `cursor ${syncCursor}` : ""}>
              Sync: {isSyncRunning ? "syncing…" : lastSyncAt ? lastSyncAt : "-"}
              {syncCursor ? ` · cursor ${syncCursor.slice(0, 8)}…` : ""}
            </span>
          ) : null}
          <span className="muted mono" title={autoRefreshLastError || ""}>
            Auto: {autoRefreshSeconds === 0 ? "off" : `${autoRefreshSeconds}s`}{" "}
            {autoRefreshSeconds !== 0 && autoRefreshPausedUntilMs > nowMs
              ? `(paused ${formatDurationShort(autoRefreshPausedUntilMs - nowMs)})`
              : isPageVisible
                ? ""
                : "(paused)"}
          </span>
          <TextInput
            size="m"
            value={taskLookupId}
            onUpdate={setTaskLookupId}
            placeholder="Open by Task ID"
            disabled={taskLookupBusy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void lookupTaskById();
              }
            }}
          />
          <Button view="outlined" size="m" disabled={taskLookupBusy || !taskLookupId.trim()} loading={taskLookupBusy} onClick={() => void lookupTaskById()}>
            Open
          </Button>
          <Select
            width="max"
            value={[String(autoRefreshSeconds)]}
            options={[
              { value: "0", content: "Auto: off" },
              { value: "5", content: "Auto: 5s" },
              { value: "15", content: "Auto: 15s" },
              { value: "30", content: "Auto: 30s" },
              { value: "60", content: "Auto: 60s" }
            ]}
            onUpdate={(items) => setAutoRefreshSeconds(Number(items[0] ?? "15") as AutoRefreshSeconds)}
          />
          {autoRefreshSeconds !== 0 && autoRefreshPausedUntilMs > nowMs ? (
            <Button view="flat" onClick={resetAutoRefreshPause}>
              Resume
            </Button>
          ) : null}
          <Button
            view="flat"
            onClick={() => {
              resetAutoRefreshPause();
              void refresh();
            }}
          >
            Refresh
          </Button>
          <Button view={showDemo ? "action" : "outlined"} size="m" onClick={() => setShowDemo((v) => !v)} title="Show/hide demo helpers">
            Demo
          </Button>
        </div>
        {showDemo ? (
          <div className="row-tight" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip chip-muted">demo</span>
            <Button view="outlined" size="m" disabled={createBusy} loading={createBusy} onClick={() => void createDemoTask("stuck_recovery")}>
              Create stuck task
            </Button>
            <Button view="outlined" size="m" disabled={createBusy} loading={createBusy} onClick={() => void createDemoTask("quick_judgment")}>
              Create judgment task
            </Button>
          </div>
        ) : null}
        <div className="row-tight">
          <Select
            width="max"
            value={[taskStatusFilter || "any"]}
            options={TASK_STATUSES.map((s) => ({ value: s, content: `Status: ${s}` }))}
            onUpdate={(items) => setTaskStatusFilter(String(items[0] ?? "any") === "any" ? "" : String(items[0]))}
          />
          <Select
            width="max"
            value={[taskTypeFilter || "any"]}
            options={TASK_TYPES.map((t) => ({ value: t, content: `Type: ${t}` }))}
            onUpdate={(items) => setTaskTypeFilter(String(items[0] ?? "any") === "any" ? "" : String(items[0]))}
          />
          <TextInput
            size="m"
            value={taskSearch}
            onUpdate={setTaskSearch}
            placeholder="Search id/type/status"
          />
          <Button
            view="flat"
            onClick={() => {
              setTaskStatusFilter("");
              setTaskTypeFilter("");
              setTaskSearch("");
            }}
          >
            Clear
          </Button>
        </div>
        <div className="list">
          {filteredTasks.length === 0 ? <p className="muted">No tasks for selected filters.</p> : null}
          {filteredTasks.map((t) => {
            const reviewStatus = t.review?.review_status ? String(t.review.review_status) : "";
            const artifactsCount = Array.isArray(t.artifacts) ? t.artifacts.length : 0;
            return (
              <div
                key={t.id}
                className={`task-row ${selectedTask?.id === t.id ? "is-active" : ""}`}
                role="button"
                tabIndex={0}
                aria-selected={selectedTask?.id === t.id}
                onClick={() => setSelectedTaskId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedTaskId(t.id);
                  }
                }}
              >
                <div className="task-main">
                  <div>
                    <div className="task-type">{t.task_type}</div>
                    <div className="muted mono">{shortId(t.id)} · {new Date(t.updated_at).toLocaleString()}</div>
                    {reviewStatus || artifactsCount ? (
                      <div className="muted">
                        {reviewStatus ? <span className="mono">review {reviewStatus}</span> : null}
                        {artifactsCount ? <span className="mono"> · artifacts {artifactsCount}</span> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="row-tight" onClick={(e) => e.stopPropagation()}>
                  <Button size="s" view="flat" onClick={() => void copyText(t.id)}>
                    Copy ID
                  </Button>
                  <span className={`status status-${t.status}`}>{t.status}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="panel span-2" view="raised" data-testid="requester-task-details">
        <div className="section-head">
          <h2>Task Details</h2>
          {selectedTask ? (
            <div className="row-tight">
              {!hasQualityProof && (selectedTask.status === "queued" || selectedTask.status === "claimed") ? (
                <Button
                  view="action"
                  size="s"
                  onClick={() => {
                    setArtifactsMode("upload");
                    window.setTimeout(() => {
                      document.querySelector('[data-testid="requester-artifacts"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }, 0);
                  }}
                  title="Completion requires quality proof. Upload a local artifact or register external proof with checksum_sha256."
                >
                  Add proof
                </Button>
              ) : null}
              <Button
                view="flat"
                size="s"
                onClick={() => setShowDebug((v) => !v)}
                title="Show/hide debug controls (polling + sync cursor)"
              >
                Debug: {showDebug ? "on" : "off"}
              </Button>
              <Button view="flat" onClick={() => void copyText(selectedTask.id)}>
                Copy ID
              </Button>
              {selectedTask.callback_url ? (
                <Button
                  view="flat"
                  size="s"
                  disabled={webhookDeliveriesLoading}
                  onClick={() => void refreshWebhookAttempts(selectedTask.id)}
                  title="Refresh webhook delivery attempts"
                >
                  Delivery attempts
                </Button>
              ) : null}
              <Button
                view="outlined"
                disabled={taskActionBusy || selectedTask.status !== "queued"}
                loading={taskActionBusy}
                onClick={() => void claimSelectedTask()}
              >
                Claim
              </Button>
              <Button
                view="action"
                disabled={taskActionBusy || !hasQualityProof || !(selectedTask.status === "queued" || selectedTask.status === "claimed")}
                loading={taskActionBusy}
                onClick={() => void completeSelectedTask()}
              >
                Complete
              </Button>
              <Button
                view="flat"
                onClick={() => {
                  void Api.downloadTaskBundle(selectedTask.id).then(({ blob, filename }) => {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                  }).catch((e) => setError(String(e)));
                }}
              >
                Download bundle
              </Button>
            </div>
          ) : null}
        </div>
        {selectedTask && showDebug ? (
          <div className="detail-block" style={{ paddingTop: 0 }}>
            <div className="row-tight" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <span className="chip chip-muted" title="Debug-only controls">debug</span>
              <span className="muted mono" title={activePollStatus || undefined}>
                active poll {activePollEnabled ? "on" : "off"}{activePollStatus ? ` · ${activePollStatus}` : ""}
              </span>
              <Button
                view="flat"
                size="s"
                onClick={() => setActivePollEnabled((v) => !v)}
                title="When off, the UI will not poll the active task; background sync still runs."
              >
                Toggle active poll
              </Button>
              <span className="muted mono" title={syncCursor ? `cursor ${syncCursor}` : undefined}>
                sync {isSyncRunning ? "running" : "idle"}{lastSyncAt ? ` · last ${lastSyncAt}` : ""}{syncCursor ? ` · cursor ${syncCursor.slice(0, 8)}…` : ""}
              </span>
            </div>
          </div>
        ) : null}
        {!selectedTask ? <p className="muted">Select a task from the list.</p> : null}
        {selectedTask ? (
          <>
            <div className="detail-block">
              <div data-testid="requester-task-summary">
              <p><strong>ID:</strong> <span className="mono">{selectedTask.id}</span></p>
              <p><strong>Status:</strong> <span className={`status status-${selectedTask.status}`}>{selectedTask.status}</span></p>
              <p><strong>Type:</strong> {selectedTask.task_type}</p>
              <p><strong>Review:</strong> {selectedTask.review?.review_status ?? "none"}</p>
              <p>
                <strong>Proof:</strong>{" "}
                {hasQualityProof ? (
                  <span className="chip chip-ok">quality present</span>
                ) : (
                  <span className="chip chip-warn">missing</span>
                )}
              </p>
              <p><strong>Callback:</strong> {selectedTask.callback_url ? <span className="mono">{selectedTask.callback_url}</span> : <span className="muted">none</span>}</p>
              {selectedTask.callback_url ? (
                <p>
                  <strong>Delivery:</strong>{" "}
                  {webhookDeliveriesLoading ? (
                    <span className="muted">loading…</span>
                  ) : webhookDeliveriesError ? (
                    <span className="muted">error: {webhookDeliveriesError}</span>
                  ) : webhookLast === null ? (
                    <span className="muted">no attempts yet</span>
                  ) : (
                    <>
                      <span className="mono">
                        {webhookLast.success ? "ok" : "failed"} {webhookLast.status_code ?? "-"}
                      </span>{" "}
                      <span className="muted mono">· {new Date(webhookLast.created_at).toLocaleString()}</span>
                      {webhookLast.error ? <span className="muted mono"> · {webhookLast.error}</span> : null}
                    </>
                  )}
                  {" "}
                  <Button size="s" view="flat" onClick={() => setWebhookAttemptsOpen((v) => !v)}>
                    {webhookAttemptsOpen ? "Hide attempts" : "Show attempts"}
                  </Button>
                </p>
              ) : null}
              {selectedTask.callback_url && webhookAttemptsOpen ? (
                <div className="list" style={{ marginTop: 8 }}>
                  {webhookDeliveries.length === 0 ? <p className="muted">Open details to load attempts.</p> : null}
                  {webhookDeliveries.map((d) => (
                    <div key={d.id} className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <span className="mono">
                        {new Date(d.created_at).toLocaleString()} · attempt {d.attempt_no} · {d.success ? "ok" : "failed"}{" "}
                        {d.status_code ?? "-"}
                      </span>
                      {d.error ? <span className="muted mono" style={{ marginLeft: 12 }}>{d.error}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {selectedTask.review ? (
                <p>
                  <strong>Auto-check:</strong>{" "}
                  <span className="mono">
                    {selectedTask.review.auto_check_score.toFixed(2)}
                    {selectedTask.review.auto_check_provider ? ` (${selectedTask.review.auto_check_provider})` : ""}
                  </span>
                  {selectedTask.review.auto_check_reason ? (
                    <span className="muted mono"> · {selectedTask.review.auto_check_reason}</span>
                  ) : null}
                  {selectedTask.review.auto_check_model ? (
                    <span className="muted mono"> · model {selectedTask.review.auto_check_model}</span>
                  ) : null}
                  {typeof selectedTask.review.auto_check_redacted === "boolean" ? (
                    <span className="muted mono"> · redaction {selectedTask.review.auto_check_redacted ? "on" : "off"}</span>
                  ) : null}
                </p>
              ) : null}
              <p><strong>Artifacts:</strong> {selectedTask.artifacts?.length ?? 0}</p>
              <p><strong>Updated:</strong> {new Date(selectedTask.updated_at).toLocaleString()}</p>
              </div>
            </div>
            {(selectedTask.status === "queued" || selectedTask.status === "claimed") ? (
              <Card className="panel span-2" view="raised">
                <h3>Complete task</h3>
                {selectedTask.task_type === "quick_judgment" ? (
                  <div className="row-tight" style={{ alignItems: "center" }}>
                    <Select
                      width="max"
                      value={[judgmentDecisionDraft]}
                      options={["yes", "no"].map((d) => ({ value: d, content: `Decision: ${d}` }))}
                      onUpdate={(items) => setJudgmentDecisionDraft(String(items[0] ?? "yes"))}
                      disabled={taskActionBusy}
                    />
                    <TextInput
                      size="m"
                      value={judgmentNoteDraft}
                      onUpdate={setJudgmentNoteDraft}
                      placeholder="note (optional)"
                      disabled={taskActionBusy}
                    />
                  </div>
                ) : (
                  <>
                    <TextInput
                      size="m"
                      value={stuckActionSummaryDraft}
                      onUpdate={setStuckActionSummaryDraft}
                      placeholder="action_summary"
                      disabled={taskActionBusy}
                    />
                    <div style={{ height: 8 }} />
                    <TextInput
                      size="m"
                      value={stuckNextStepDraft}
                      onUpdate={setStuckNextStepDraft}
                      placeholder="next_step"
                      disabled={taskActionBusy}
                    />
                  </>
                )}
                <div style={{ height: 8 }} />
                <TextArea
                  value={workerNoteDraft}
                  onUpdate={setWorkerNoteDraft}
                  placeholder="worker_note (optional)"
                  disabled={taskActionBusy}
                  minRows={2}
                />
                <p className="muted" style={{ marginTop: 6 }}>
                  Completion requires quality proof: at least one artifact with `local:` storage or a valid `checksum_sha256`.
                </p>
              </Card>
            ) : null}
            <div className="grid two-col">
              <Card className="panel" view="raised">
                <h3>Context</h3>
                <pre className="json-code">{JSON.stringify(selectedTask.context ?? {}, null, 2)}</pre>
              </Card>
              <Card className="panel" view="raised">
                <h3>Result</h3>
                <pre className="json-code">{JSON.stringify(selectedTask.result ?? {}, null, 2)}</pre>
              </Card>
            </div>
	            <Card className="panel span-2" view="raised" data-testid="requester-artifacts">
	              <h3>Artifacts</h3>
	              <div className="row-tight" style={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
	                <div className="segmented" role="radiogroup" aria-label="Artifacts mode" data-testid="requester-artifacts-mode">
                  <button
	                    type="button"
	                    className={`segmented-btn ${artifactsMode === "upload" ? "is-active" : ""}`}
	                    role="radio"
	                    aria-checked={artifactsMode === "upload"}
	                    onClick={() => setArtifactsMode("upload")}
	                  >
	                    Upload file
	                  </button>
	                  <button
	                    type="button"
	                    className={`segmented-btn ${artifactsMode === "register" ? "is-active" : ""}`}
	                    role="radio"
	                    aria-checked={artifactsMode === "register"}
	                    onClick={() => setArtifactsMode("register")}
	                  >
	                    Link external proof
	                  </button>
	                </div>
                  <span className="row-tight" style={{ alignItems: "center" }}>
                    <span className={`chip ${hasQualityProof ? "chip-ok" : "chip-warn"}`} title={hasQualityProof ? "Quality proof is present" : "Completion is blocked: add quality proof"}>
                      proof {hasQualityProof ? "quality" : "missing"}
                    </span>
                    <span className="muted mono">artifacts {selectedTask.artifacts?.length ?? 0}</span>
                  </span>
	              </div>

	              {artifactsMode === "register" ? (
	                <div className="detail-block">
	                  <div ref={proofFormRef} />
	                  <h4 style={{ margin: "0 0 6px 0" }}>Link external proof</h4>
                    <div className={`callout ${proofWouldBeQuality ? "callout-ok" : "callout-warn"}`} style={{ marginBottom: 8 }}>
                      <p className="muted">
                        ShimLayer stores a reference (it does not fetch the file). To unblock completion, provide a valid <span className="mono">checksum_sha256</span> (unless <span className="mono">storage_path</span> is <span className="mono">local:</span>).
                      </p>
                    </div>
	                  <div className="row-tight" style={{ alignItems: "center" }}>
	                    <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("s3")}>
	                      S3 template
	                    </Button>
	                    <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("gcs")}>
	                      GCS template
	                    </Button>
	                    <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("http")}>
	                      HTTP(S) template
	                    </Button>
	                    {proofStorageScheme ? <span className="chip">scheme {proofStorageScheme}</span> : null}
	                  </div>
	                  <div className="row-tight" style={{ alignItems: "center" }}>
	                    <Select
	                      width="max"
	                      value={[proofArtifactType]}
	                      options={ARTIFACT_TYPES.map((t) => ({ value: t, content: `Type: ${t}` }))}
	                      onUpdate={(items) => setProofArtifactType(String(items[0] ?? "logs"))}
	                      disabled={proofBusy}
	                    />
	                    <TextInput
	                      size="m"
	                      value={proofStoragePath}
	                      onUpdate={setProofStoragePath}
	                      placeholder='storage_path (e.g. "s3://bucket/path" or "local:...")'
	                      disabled={proofBusy}
	                    />
	                  </div>
	                  <div className="row-tight" style={{ alignItems: "center" }}>
	                    <TextInput
	                      size="m"
	                      value={proofChecksum}
	                      onUpdate={setProofChecksum}
	                      placeholder="checksum_sha256 (required for quality proof unless local:)"
	                      disabled={proofBusy}
	                    />
			                    <Button
			                      view="action"
			                      disabled={proofBusy || !proofCanSubmitAsQuality}
			                      loading={proofBusy}
                            title={
                              proofBusy
                                ? "Registering…"
                                : !proofStoragePath.trim()
                                  ? "Enter storage_path to register proof"
                                  : proofChecksumError
                                    ? proofChecksumError
                                    : proofMetadataError
                                      ? proofMetadataError
                                      : !proofWouldBeQuality && !proofAllowMetadataOnly
                                        ? "Add checksum_sha256 (or use local:) to unblock completion"
                                        : "Register proof link"
                            }
			                      onClick={() =>
			                        void registerProofMetadata().then((ok) => {
			                          if (ok && proofWouldBeQuality) setArtifactsMode("upload");
			                        })
		                      }
		                    >
		                      {proofWouldBeQuality ? "Register proof" : proofAllowMetadataOnly ? "Register metadata (won’t unblock)" : "Add checksum to register"}
		                    </Button>
	                  </div>
                    {!proofWouldBeQuality ? (
                      <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <input
                          type="checkbox"
                          checked={proofAllowMetadataOnly}
                          onChange={(e) => setProofAllowMetadataOnly(e.currentTarget.checked)}
                          disabled={proofBusy}
                        />
                        Allow metadata-only link (won’t unblock completion)
                      </label>
                    ) : null}
	                  <div style={{ marginTop: 6 }}>
	                    <TextArea
	                      value={proofMetadataJson}
	                      onUpdate={setProofMetadataJson}
	                      placeholder='metadata JSON (e.g. {"source":"s3"})'
	                      disabled={proofBusy}
	                      minRows={4}
	                    />
	                  </div>
                    {proofChecksumError || proofMetadataError ? (
                      <p className="muted" style={{ marginTop: 6 }}>
                        {proofChecksumError ? <span className="muted">checksum: {proofChecksumError}</span> : null}
                        {proofChecksumError && proofMetadataError ? <span className="muted"> · </span> : null}
                        {proofMetadataError ? <span className="muted">metadata: {proofMetadataError}</span> : null}
                      </p>
                    ) : null}
	                  <p className="muted" style={{ marginTop: 6 }}>
	                    Tip: if <span className="mono">storage_path</span> starts with <span className="mono">local:</span>, the server can verify/fill <span className="mono">checksum_sha256</span>.
	                  </p>
	                  <p className="muted" style={{ marginTop: 6 }}>
	                    Quality proof: <span className="mono">{proofWouldBeQuality ? "yes" : "no"}</span>{" "}
	                    {!proofWouldBeQuality ? (
	                      <span className="muted">
	                        · add a valid checksum (sha256) or use a `local:` artifact
	                      </span>
	                    ) : null}
	                  </p>
	                </div>
	              ) : null}

	              {artifactsMode === "upload" ? (
	                <>
	                  <div className="row-tight" style={{ alignItems: "center" }}>
	                    <Select
	                      width="max"
	                      value={[uploadArtifactType]}
	                      options={ARTIFACT_TYPES.map((t) => ({ value: t, content: `Type: ${t}` }))}
	                      onUpdate={(items) => {
	                        setUploadArtifactType(String(items[0] ?? "logs"));
	                        setUploadFile(null);
	                        setUploadFileError("");
	                        setUploadFileSha256("");
	                      }}
	                      disabled={uploadBusy}
	                    />
	                    <input
	                      type="file"
	                      data-testid="requester-upload-file"
	                      accept={
	                        uploadArtifactType === "screenshot"
	                          ? "image/*"
	                          : uploadArtifactType === "json_payload"
	                            ? "application/json,.json"
	                            : ".log,.txt,text/plain,text/*"
	                      }
	                      onChange={(e) => void onSelectUploadFile(e.currentTarget.files?.[0] ?? null)}
	                      disabled={uploadBusy}
	                    />
	                    <Button
	                      view="action"
	                      disabled={!uploadFile || uploadBusy || Boolean(uploadFileError)}
	                      loading={uploadBusy}
                        title={
                          uploadBusy
                            ? "Uploading…"
                            : !uploadFile
                              ? "Choose a file to upload"
                              : uploadFileError
                                ? uploadFileError
                                : uploadFileHashing
                                  ? "Computing sha256 (optional)…"
                                  : "Upload local artifact (quality proof)"
                        }
	                      onClick={() => void uploadSelectedArtifact()}
	                    >
	                      Upload artifact
	                    </Button>
	                  </div>
	                  {uploadFile ? (
	                    <p className={uploadFileError ? "error" : "muted"} style={{ marginTop: 6 }}>
	                      Selected: <span className="mono">{uploadFile.name}</span>{" "}
	                      <span className="muted mono">({formatBytes(uploadFile.size)}{uploadFile.type ? `, ${uploadFile.type}` : ""})</span>
	                      {uploadFileHashing ? <span className="muted mono"> · sha256 computing…</span> : null}
	                      {uploadFileSha256 ? <span className="muted mono"> · sha256 {uploadFileSha256.slice(0, 16)}…</span> : null}
	                      {uploadFileError ? <span> · {uploadFileError}</span> : null}
	                    </p>
	                  ) : null}
	                  <p className="muted" style={{ marginTop: 6 }}>
	                    Upload only proof-safe artifacts (avoid secrets/PII unless required and permitted).
	                  </p>
	                  <p className="muted" style={{ marginTop: 6 }}>
	                    Uploads are stored as <span className="mono">local:</span> and count as quality proof (recommended).
	                  </p>
	                </>
	              ) : null}
              {(selectedTask.artifacts ?? []).length === 0 ? <p className="muted">No artifacts.</p> : null}
              {(selectedTask.artifacts ?? []).map((a, idx) => (
                <ArtifactTile
                  key={`artifact-${idx}`}
                  artifact={a}
                  onDownload={(taskId, artifactId) =>
                    Api.downloadArtifact(taskId, artifactId, String((a as any)?.metadata?.filename ?? ""))
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
                      .catch((e) => setError(String(e)))
                  }
                  notify={(level, message) => {
                    if (level === "error") setError(message);
                  }}
                  extraActions={
                    String((a as any)?.storage_path ?? "").startsWith("local:") ? null : (
                      <Button size="s" view="flat" onClick={() => prefillProofFromArtifact(a)} data-testid="artifact-register-proof">
                        Use for register
                      </Button>
                    )
                  }
                />
              ))}
            </Card>
          </>
        ) : null}
      </Card>

      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.level}`} role="status">
            {toast.text}
          </div>
        ))}
      </div>
      {error ? <p className="error span-2">{error}</p> : null}
    </section>
  );
}

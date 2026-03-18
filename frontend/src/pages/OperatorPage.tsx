import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextArea, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { OpenAIInterruptionRecord, OpenAIResumeResponse, Task, TaskWithReview } from "../types";
import { ArtifactTile } from "../components/ArtifactTile";

type ToastLevel = "success" | "error";
type ToastMessage = { id: string; level: ToastLevel; text: string };

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [contenteditable='true']")) return true;
  return false;
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function OperatorPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskWithReview | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [openTaskId, setOpenTaskId] = useState<string>("");
  const [openTaskBusy, setOpenTaskBusy] = useState<boolean>(false);
  const [createBusy, setCreateBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<0 | 15 | 30 | 60>(() => {
    const raw = Number(localStorage.getItem("operator.autoRefreshSeconds") ?? "15");
    if (raw === 0 || raw === 15 || raw === 30 || raw === 60) return raw;
    return 15;
  });
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  const [autoRefreshPausedUntilMs, setAutoRefreshPausedUntilMs] = useState<number>(0);
  const [autoRefreshFailureCount, setAutoRefreshFailureCount] = useState<number>(0);
  const [autoRefreshLastError, setAutoRefreshLastError] = useState<string>("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshInFlightRef = useRef(false);
  const [showMoreActions, setShowMoreActions] = useState<boolean>(false);

  const proofFormRef = useRef<HTMLDivElement | null>(null);
  const [proofArtifactType, setProofArtifactType] = useState<string>("logs");
  const [proofStoragePath, setProofStoragePath] = useState<string>("");
  const [proofChecksum, setProofChecksum] = useState<string>("");
  const [proofMetadataJson, setProofMetadataJson] = useState<string>("{}");
  const [proofBusy, setProofBusy] = useState<boolean>(false);
  const [proofAllowMetadataOnly, setProofAllowMetadataOnly] = useState<boolean>(false);
  const [proofAdvancedOpen, setProofAdvancedOpen] = useState<boolean>(false);

  const [openAiInterruptionId, setOpenAiInterruptionId] = useState<string>("");
  const [openAiRecord, setOpenAiRecord] = useState<OpenAIInterruptionRecord | null>(null);
  const [openAiResume, setOpenAiResume] = useState<OpenAIResumeResponse | null>(null);
  const [openAiDecisionNote, setOpenAiDecisionNote] = useState<string>("");
  const [openAiBusy, setOpenAiBusy] = useState<boolean>(false);

  const TASK_STATUSES = ["any", "pending", "queued", "claimed", "completed", "failed", "disputed", "refunded"] as const;
  const TASK_TYPES = ["any", "stuck_recovery", "quick_judgment"] as const;
  const PROOF_ARTIFACT_TYPES = ["logs", "screenshot", "recording", "other"] as const;

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter && statusFilter !== "any" && t.status !== statusFilter) return false;
      if (taskTypeFilter && taskTypeFilter !== "any" && t.task_type !== taskTypeFilter) return false;
      if (!q) return true;
      const haystack = `${t.id} ${t.task_type} ${t.status}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [tasks, searchQuery, statusFilter, taskTypeFilter]);

  const selectedTask = useMemo(
    () => filteredTasks.find((t) => t.id === selectedTaskId) ?? filteredTasks[0],
    [filteredTasks, selectedTaskId]
  );

  function isUuidLike(value: string): boolean {
    const v = String(value || "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      setError(String(e));
    }
  }

  function pushToast(level: ToastLevel, text: string) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev.slice(-3), { id, level, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  async function refresh() {
    setError(null);
    if (refreshInFlightRef.current) return { ok: false, error: "refresh already in progress" };
    refreshInFlightRef.current = true;
    try {
      const list = await Api.listMyTasks({ limit: 100 });
      setTasks(list);
      if (selectedTaskId) {
        try {
          const detail = await Api.getTask(selectedTaskId);
          setSelectedTaskDetail(detail);
        } catch {
          // Ignore detail refresh errors; list refresh is still useful.
        }
      }
      return { ok: true as const };
    } catch (e) {
      const msg = String(e);
      setError(msg);
      return { ok: false as const, error: msg };
    } finally {
      refreshInFlightRef.current = false;
    }
  }

  async function createDemoTask(kind: "stuck_recovery" | "quick_judgment") {
    if (createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const payload =
        kind === "quick_judgment"
          ? {
              task_type: "quick_judgment",
              context: { question: "Approve this automation run?", source: "operator-demo" },
              sla_seconds: 90,
              max_price_usd: 0.48,
              callback_url: null
            }
          : {
              task_type: "stuck_recovery",
              context: { logs: "Agent loop in checkout", prompt: "retrying forever", source: "operator-demo" },
              sla_seconds: 180,
              max_price_usd: 0.48,
              callback_url: null
            };
      const task = await Api.createTask(payload);
      setTasks((prev) => [task, ...prev]);
      setSelectedTaskId(task.id);
      try {
        const detail = await Api.getTask(task.id);
        setSelectedTaskDetail(detail);
      } catch {
        // ignore
      }
    } catch (e) {
      setError(`Create failed: ${String(e)}`);
    } finally {
      setCreateBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    localStorage.setItem("operator.autoRefreshSeconds", String(autoRefreshSeconds));
  }, [autoRefreshSeconds]);

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
    // Reduce visual noise: collapse "More" when switching tasks.
    setShowMoreActions(false);
    setProofAdvancedOpen(false);
  }, [selectedTaskId]);

  async function openById() {
    const id = openTaskId.trim();
    if (!id) return;
    if (!isUuidLike(id)) {
      setError("Invalid Task ID (expected UUID)");
      return;
    }
    if (openTaskBusy) return;
    setOpenTaskBusy(true);
    setError(null);
    try {
      const task = await Api.getTask(id);
      setSelectedTaskId(task.id);
      setSelectedTaskDetail(task);
      setTasks((prev) => {
        const next = [task as unknown as Task, ...prev.filter((t) => t.id !== task.id)];
        return next;
      });
      setOpenTaskId("");
    } catch (e) {
      setError(`Open failed: ${String(e)}`);
    } finally {
      setOpenTaskBusy(false);
    }
  }

  async function openTask(taskId: string) {
    const id = String(taskId || "").trim();
    if (!id) return;
    if (!isUuidLike(id)) {
      setError("Invalid Task ID (expected UUID)");
      return;
    }
    setError(null);
    try {
      const task = await Api.getTask(id);
      setSelectedTaskId(task.id);
      setSelectedTaskDetail(task);
      setTasks((prev) => {
        const next = [task as unknown as Task, ...prev.filter((t) => t.id !== task.id)];
        return next;
      });
    } catch (e) {
      setError(`Open failed: ${String(e)}`);
    }
  }

  const openAiFromSelectedTask = useMemo(() => {
    const ctx = selectedTaskDetail?.context ?? null;
    const src = ctx && typeof ctx === "object" ? (ctx as any).source : null;
    if (src !== "openai.interruption") return null;
    const interruptionId = typeof (ctx as any).interruption_id === "string" ? String((ctx as any).interruption_id) : "";
    const runId = typeof (ctx as any).run_id === "string" ? String((ctx as any).run_id) : "";
    const toolName = typeof (ctx as any).tool_name === "string" ? String((ctx as any).tool_name) : "";
    return { interruptionId, runId, toolName };
  }, [selectedTaskDetail]);

  const isOpenAiInterruptionTask = Boolean(openAiFromSelectedTask?.interruptionId);

  async function loadOpenAiInterruption(interruptionId: string, opts?: { preserveResume?: boolean }) {
    const id = interruptionId.trim();
    if (!id) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const record = await Api.getOpenAIInterruption(id);
      setOpenAiRecord(record);
      if (!opts?.preserveResume) setOpenAiResume(null);
      setOpenAiInterruptionId(record.interruption_id);
      pushToast("success", "Loaded interruption");
      await refresh();
    } catch (e) {
      setError(String(e));
      pushToast("error", `Load interruption failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function decideOpenAiInterruption(decision: "approve" | "reject") {
    const id = (openAiRecord?.interruption_id || openAiInterruptionId).trim();
    if (!id) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const record = await Api.decideOpenAIInterruption(id, {
        decision,
        actor: "operator",
        note: openAiDecisionNote.trim() ? openAiDecisionNote.trim() : null,
        output: {},
      });
      setOpenAiRecord(record);
      pushToast("success", `Decision recorded: ${decision}`);
      await refresh();
      await openTask(record.task_id);
    } catch (e) {
      setError(String(e));
      pushToast("error", `Decision failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  async function resumeOpenAiInterruption() {
    const id = (openAiRecord?.interruption_id || openAiInterruptionId).trim();
    if (!id) return;
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setError(null);
    try {
      const res = await Api.resumeOpenAIInterruption(id);
      setOpenAiResume(res);
      pushToast("success", "Resume payload created");
      await loadOpenAiInterruption(id, { preserveResume: true });
    } catch (e) {
      setError(String(e));
      pushToast("error", `Resume failed: ${String(e)}`);
    } finally {
      setOpenAiBusy(false);
    }
  }

  function formatDurationShort(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m <= 0) return `${s}s`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function resetAutoRefreshPause() {
    setAutoRefreshPausedUntilMs(0);
    setAutoRefreshFailureCount(0);
    setAutoRefreshLastError("");
  }

  useEffect(() => {
    if (autoRefreshSeconds === 0 || !isPageVisible) return;
    const timer = window.setInterval(() => {
      if (isWorking || proofBusy || openAiBusy) return;
      if (Date.now() < autoRefreshPausedUntilMs) return;
      void refresh().then((res) => {
        if (res.ok) {
          if (autoRefreshFailureCount > 0 || autoRefreshLastError || autoRefreshPausedUntilMs > 0) resetAutoRefreshPause();
          return;
        }
        const nextFailures = autoRefreshFailureCount + 1;
        setAutoRefreshFailureCount(nextFailures);
        setAutoRefreshLastError(res.error ?? "unknown error");
        const pauseSeconds = Math.min(120, 10 * 2 ** Math.min(4, nextFailures - 1));
        setAutoRefreshPausedUntilMs(Date.now() + pauseSeconds * 1000);
      });
    }, autoRefreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [
    autoRefreshSeconds,
    isPageVisible,
    isWorking,
    openAiBusy,
    proofBusy,
    autoRefreshFailureCount,
    autoRefreshLastError,
    autoRefreshPausedUntilMs
  ]);

  useEffect(() => {
    if (!selectedTaskId && filteredTasks.length > 0) setSelectedTaskId(filteredTasks[0].id);
    if (selectedTaskId && filteredTasks.length > 0 && !filteredTasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0]?.id ?? "");
    }
    if (selectedTaskId && filteredTasks.length === 0) setSelectedTaskId("");
  }, [filteredTasks, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedTaskDetail(null);
      return;
    }
    setError(null);
    void Api.getTask(selectedTaskId)
      .then((t) => setSelectedTaskDetail(t))
      .catch((e) => setError(String(e)));
  }, [selectedTaskId]);

  async function claim() {
    if (!selectedTask) return;
    if (isWorking) return;
    setIsWorking(true);
    try {
      const updated = await Api.claimTask(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setSelectedTaskId(updated.id);
      await refresh();
      pushToast("success", "Task claimed");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Claim failed: ${String(e)}`);
    } finally {
      setIsWorking(false);
    }
  }

  async function complete() {
    if (!selectedTask) return;
    if (isWorking) return;
    setIsWorking(true);
    try {
      const result =
        selectedTask.task_type === "quick_judgment"
          ? { decision: "yes", note: "Safe to continue." }
          : { action_summary: "Updated selector and resumed flow.", next_step: "Continue automation." };
      const updated = await Api.completeTask(selectedTask.id, result, null);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      await refresh();
      pushToast("success", "Task completed");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Complete failed: ${String(e)}`);
    } finally {
      setIsWorking(false);
    }
  }

  async function addProof() {
    if (!selectedTask) return;
    if (isWorking) return;
    setIsWorking(true);
    try {
      const content = `Operator proof for ${selectedTask.id}\ncreated_at=${new Date().toISOString()}\n`;
      await Api.uploadArtifact(selectedTask.id, {
        artifact_type: "logs",
        content_base64: toBase64Utf8(content),
        filename: `operator-proof-${selectedTask.id.slice(0, 8)}.txt`,
        content_type: "text/plain",
        metadata: { source: "operator-console" }
      });
      await refresh();
      pushToast("success", "Local proof uploaded");
    } catch (e) {
      setError(String(e));
      pushToast("error", `Proof upload failed: ${String(e)}`);
    } finally {
      setIsWorking(false);
    }
  }

  function scrollToProofForm() {
    window.setTimeout(() => proofFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function prefillProofFromArtifact(artifact: unknown) {
    const a = artifact as any;
    const storage = String(a?.storage_path ?? "").trim();
    if (!storage) return;
    setProofArtifactType(String(a?.artifact_type ?? "logs") || "logs");
    setProofStoragePath(storage);
    setProofChecksum(String(a?.checksum_sha256 ?? ""));
    setProofAllowMetadataOnly(false);
    try {
      const meta = a?.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? a.metadata : {};
      setProofMetadataJson(JSON.stringify(meta));
    } catch {
      setProofMetadataJson("{}");
    }
    scrollToProofForm();
  }

  function loadProofPreset(kind: "s3" | "gcs" | "http") {
    if (!selectedTask) return;
    setProofArtifactType("logs");
    setProofAllowMetadataOnly(false);
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
    scrollToProofForm();
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
      setProofAllowMetadataOnly(false);
      setProofAdvancedOpen(false);
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

  const hasQualityProof = useMemo(() => {
    const artifacts = selectedTaskDetail?.artifacts ?? [];
    return artifacts.some((a) => {
      const storagePath = String((a as any).storage_path ?? "");
      const checksum = String((a as any).checksum_sha256 ?? "");
      return storagePath.startsWith("local:") || checksum.length === 64;
    });
  }, [selectedTaskDetail]);

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
  }, [proofChecksum, proofStoragePath]);

  const proofCanSubmitAsQuality = useMemo(() => {
    if (!proofCanSubmit) return false;
    if (proofWouldBeQuality) return true;
    return proofAllowMetadataOnly;
  }, [proofAllowMetadataOnly, proofCanSubmit, proofWouldBeQuality]);

  useEffect(() => {
    if (proofWouldBeQuality && proofAllowMetadataOnly) setProofAllowMetadataOnly(false);
  }, [proofAllowMetadataOnly, proofWouldBeQuality]);

  const reviewStatus = selectedTaskDetail?.review?.review_status ? String(selectedTaskDetail.review.review_status) : "";
  const artifactsCount = (selectedTaskDetail?.artifacts ?? []).length;
  const isActionable = selectedTask?.status === "queued" || selectedTask?.status === "claimed";

  useEffect(() => {
    if (!openAiFromSelectedTask?.interruptionId) return;
    setOpenAiInterruptionId(openAiFromSelectedTask.interruptionId);
    setOpenAiDecisionNote("");
    void loadOpenAiInterruption(openAiFromSelectedTask.interruptionId);
  }, [openAiFromSelectedTask?.interruptionId]);

  const hotkeyStateRef = useRef({
    isWorking: false,
    filteredTasks: [] as Task[],
    selectedTaskId: "",
    selectedTask: null as Task | null,
    hasQualityProof: false,
    isOpenAiInterruptionTask: false,
  });
  useEffect(() => {
    hotkeyStateRef.current = {
      isWorking,
      filteredTasks,
      selectedTaskId,
      selectedTask: selectedTask ?? null,
      hasQualityProof,
      isOpenAiInterruptionTask,
    };
  }, [filteredTasks, hasQualityProof, isOpenAiInterruptionTask, isWorking, selectedTask, selectedTaskId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const s = hotkeyStateRef.current;
      if (s.isWorking) return;
      if (isTypingTarget(event.target)) return;
      if (!s.filteredTasks.length) return;

      const key = event.key.toLowerCase();
      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        const idx = Math.max(0, s.filteredTasks.findIndex((t) => t.id === s.selectedTaskId));
        const next = s.filteredTasks[Math.min(s.filteredTasks.length - 1, idx + 1)];
        if (next) setSelectedTaskId(next.id);
        return;
      }
      if (key === "k" || key === "arrowup") {
        event.preventDefault();
        const idx = Math.max(0, s.filteredTasks.findIndex((t) => t.id === s.selectedTaskId));
        const prev = s.filteredTasks[Math.max(0, idx - 1)];
        if (prev) setSelectedTaskId(prev.id);
        return;
      }
      if (key === "c") {
        if (s.selectedTask && s.selectedTask.status === "queued") {
          event.preventDefault();
          void claim();
        }
        return;
      }
      if (key === "p") {
        if (s.selectedTask && (s.selectedTask.status === "queued" || s.selectedTask.status === "claimed") && !s.hasQualityProof) {
          event.preventDefault();
          void addProof();
        }
        return;
      }
      if (key === "enter" && event.shiftKey) {
        if (!s.isOpenAiInterruptionTask && s.selectedTask && (s.selectedTask.status === "queued" || s.selectedTask.status === "claimed") && s.hasQualityProof) {
          event.preventDefault();
          void complete();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <section className="grid two-col">
      <Card className="panel" view="raised" data-testid="operator-queue">
        <div className="section-head">
          <h2>Queue</h2>
          <span className="chip">{filteredTasks.length}/{tasks.length}</span>
          <div className="row-tight" style={{ alignItems: "center" }}>
            <span className="muted" title={autoRefreshLastError || undefined}>
              Auto: {autoRefreshSeconds === 0 ? "off" : `${autoRefreshSeconds}s`}{" "}
              {autoRefreshSeconds !== 0 && autoRefreshPausedUntilMs > nowMs
                ? `(paused ${formatDurationShort(autoRefreshPausedUntilMs - nowMs)})`
                : isPageVisible
                  ? ""
                  : "(paused)"}
            </span>
            <Button view={autoRefreshSeconds === 0 ? "action" : "outlined"} size="s" onClick={() => setAutoRefreshSeconds(0)}>Off</Button>
            <Button view={autoRefreshSeconds === 15 ? "action" : "outlined"} size="s" onClick={() => setAutoRefreshSeconds(15)}>15s</Button>
            <Button view={autoRefreshSeconds === 30 ? "action" : "outlined"} size="s" onClick={() => setAutoRefreshSeconds(30)}>30s</Button>
            <Button view={autoRefreshSeconds === 60 ? "action" : "outlined"} size="s" onClick={() => setAutoRefreshSeconds(60)}>60s</Button>
            {autoRefreshSeconds !== 0 && autoRefreshPausedUntilMs > nowMs ? (
              <Button view="flat" size="s" onClick={resetAutoRefreshPause}>
                Resume
              </Button>
            ) : null}
            <Button
              view="flat"
              size="s"
              onClick={() => {
                resetAutoRefreshPause();
                void refresh();
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
        <div className="row-tight" style={{ alignItems: "center" }}>
          <TextInput
            size="m"
            value={openTaskId}
            onUpdate={setOpenTaskId}
            placeholder="Open by Task ID (UUID)"
            disabled={openTaskBusy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openById();
              }
            }}
          />
          <Button
            view="outlined"
            size="m"
            disabled={openTaskBusy || !openTaskId.trim()}
            loading={openTaskBusy}
            onClick={() => void openById()}
            data-testid="operator-open-by-id"
          >
            Open
          </Button>
        </div>
        <div className="row-tight">
          <Select
            width="max"
            value={[statusFilter || "any"]}
            options={TASK_STATUSES.map((s) => ({ value: s, content: `Status: ${s}` }))}
            onUpdate={(items) => setStatusFilter(String(items[0] ?? "any") === "any" ? "" : String(items[0]))}
          />
          <Select
            width="max"
            value={[taskTypeFilter || "any"]}
            options={TASK_TYPES.map((t) => ({ value: t, content: `Type: ${t}` }))}
            onUpdate={(items) => setTaskTypeFilter(String(items[0] ?? "any") === "any" ? "" : String(items[0]))}
          />
          <TextInput
            size="m"
            value={searchQuery}
            onUpdate={setSearchQuery}
            placeholder="Search id/type/status"
          />
          <Button
            view="flat"
            onClick={() => {
              setStatusFilter("");
              setTaskTypeFilter("");
              setSearchQuery("");
            }}
          >
            Clear
          </Button>
        </div>
        <div className="list">
          {tasks.length === 0 ? <p className="muted">No tasks yet.</p> : null}
          {filteredTasks.map((t) => (
            <button
              key={t.id}
              className={`task-row ${selectedTask?.id === t.id ? "is-active" : ""}`}
              onClick={() => setSelectedTaskId(t.id)}
              data-testid="operator-task-row"
              data-task-id={t.id}
            >
              <span className="task-type">{t.task_type}</span>
              <span className="muted mono">{t.id.slice(0, 8)}</span>
              <span className={`status status-${t.status}`}>{t.status}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="panel" view="raised" data-testid="operator-actions">
        <h2>Operator Actions</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Hotkeys: <span className="mono">j/k</span> navigate · <span className="mono">c</span> claim · <span className="mono">p</span> add proof · <span className="mono">Shift+Enter</span> complete
        </p>
        {!selectedTask ? <p className="muted">Select a task from queue.</p> : null}
      {selectedTask ? (
          <>
            <p className="muted mono">{selectedTask.id}</p>
            <div className="detail-block" data-testid="operator-task-summary">
              <p>
                <strong>Type:</strong> {selectedTask.task_type}
              </p>
              <p>
                <strong>Status:</strong> {selectedTask.status}
              </p>
              <p>
                <strong>Review:</strong> {reviewStatus || "none"}
              </p>
              <p>
                <strong>Artifacts:</strong> {artifactsCount}
              </p>
              <p>
                <strong>Proof:</strong> {hasQualityProof ? <span className="mono">present</span> : <span className="muted">missing</span>}
              </p>
            </div>
            <div className="detail-block" data-testid="operator-openai-interruptions">
              <div className="section-head">
                <p className="muted" style={{ margin: 0 }}>
                  OpenAI interruption
                </p>
                <div className="row-tight">
                  <Button
                    size="s"
                    view="outlined"
                    disabled={openAiBusy || !openAiInterruptionId.trim()}
                    loading={openAiBusy}
                    onClick={() => void loadOpenAiInterruption(openAiInterruptionId)}
                    data-testid="operator-openai-load"
                  >
                    Load
                  </Button>
                  {openAiRecord ? (
                    <Button
                      size="s"
                      view="outlined"
                      disabled={openAiBusy}
                      onClick={() => void openTask(openAiRecord.task_id)}
                      data-testid="operator-openai-open-task"
                    >
                      Open task
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="row-tight" style={{ alignItems: "center", marginTop: 8 }}>
                <TextInput
                  size="m"
                  value={openAiInterruptionId}
                  onUpdate={setOpenAiInterruptionId}
                  placeholder="interruption_id"
                  disabled={openAiBusy}
                />
                <Button
                  size="m"
                  view="flat"
                  disabled={openAiBusy || !openAiInterruptionId.trim()}
                  onClick={() => void copyText(openAiInterruptionId.trim())}
                  title="Copy interruption_id"
                >
                  Copy
                </Button>
              </div>

              {openAiFromSelectedTask ? (
                <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                  From task: <span className="mono">{openAiFromSelectedTask.runId || "run_id?"}</span> · <span className="mono">{openAiFromSelectedTask.toolName || "tool_name?"}</span>
                </p>
              ) : (
                <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                  Tip: open an <span className="mono">openai.interruption</span> task to auto-load its interruption_id.
                </p>
              )}

              {openAiRecord ? (
                <div className="detail-block" style={{ marginTop: 8 }} data-testid="operator-openai-record">
                  <p className="muted" style={{ marginTop: 0 }}>
                    <span className="mono">{openAiRecord.interruption_id}</span> · status: <span className="mono">{openAiRecord.status}</span>
                    {openAiRecord.decision ? (
                      <>
                        {" "}
                        · decision: <span className="mono">{openAiRecord.decision}</span>
                        {openAiRecord.decision_actor ? <> (by <span className="mono">{openAiRecord.decision_actor}</span>)</> : null}
                      </>
                    ) : null}
                  </p>
                  {openAiRecord.decision_note ? (
                    <p className="muted" style={{ marginTop: 0, marginBottom: 0 }}>
                      note “{openAiRecord.decision_note}”
                    </p>
                  ) : null}
                  <div className="row-tight" style={{ alignItems: "center" }}>
                    <TextInput
                      size="m"
                      value={openAiDecisionNote}
                      onUpdate={setOpenAiDecisionNote}
                      placeholder="decision note (optional)"
                      disabled={openAiBusy}
                    />
                    <Button
                      size="m"
                      view="action"
                      disabled={openAiBusy || openAiRecord.status !== "pending"}
                      onClick={() => void decideOpenAiInterruption("approve")}
                      data-testid="operator-openai-decide-approve"
                    >
                      Approve
                    </Button>
                    <Button
                      size="m"
                      view="outlined"
                      disabled={openAiBusy || openAiRecord.status !== "pending"}
                      onClick={() => void decideOpenAiInterruption("reject")}
                      data-testid="operator-openai-decide-reject"
                    >
                      Reject
                    </Button>
                    <Button
                      size="m"
                      view="outlined"
                      disabled={openAiBusy || openAiRecord.status !== "decided"}
                      onClick={() => void resumeOpenAiInterruption()}
                      data-testid="operator-openai-resume"
                    >
                      Resume
                    </Button>
                  </div>
                </div>
              ) : null}

              {openAiResume ? (
                <div className="detail-block" style={{ marginTop: 8 }}>
                  <div className="row-tight" style={{ alignItems: "center", justifyContent: "space-between" }}>
                    <p className="muted" style={{ marginTop: 0 }}>Resume payload</p>
                    <Button size="s" view="flat" onClick={() => void copyText(prettyJson(openAiResume.resume_payload))}>
                      Copy payload
                    </Button>
                  </div>
                  <pre className="json-code" data-testid="operator-openai-resume-payload">{prettyJson(openAiResume.resume_payload)}</pre>
                </div>
              ) : null}
            </div>
            {!isActionable ? <p className="muted">This task is not actionable (terminal state).</p> : null}
            {isActionable && !hasQualityProof && !isOpenAiInterruptionTask ? (
              <p className="muted">
                Completion requires quality proof. Upload a local file (recommended) or register an external proof with <span className="mono">checksum_sha256</span>.
              </p>
            ) : null}
            {isActionable && !hasQualityProof && !isOpenAiInterruptionTask ? (
              <div className="row-tight" style={{ flexWrap: "wrap" }}>
                <Button
                  size="s"
                  view="action"
                  disabled={isWorking}
                  loading={isWorking}
                  onClick={() => void addProof()}
                  title="Upload local proof artifact (quality proof)"
                >
                  Upload local proof
                </Button>
                <Button
                  size="s"
                  view="outlined"
                  disabled={proofBusy || isWorking}
                  onClick={scrollToProofForm}
                  title="Register external proof link (requires checksum_sha256 to unblock completion)"
                >
                  Link external proof
                </Button>
              </div>
            ) : null}
            {!isOpenAiInterruptionTask ? (
              <div className="detail-block" ref={proofFormRef} data-testid="operator-proof">
              <div className="section-head">
                <p className="muted" style={{ margin: 0 }}>Proof</p>
                <div className="row-tight">
                  <Button size="s" view="outlined" disabled={!selectedTask || !isActionable || proofBusy || isWorking} onClick={() => loadProofPreset("s3")}>
                    S3 preset
                  </Button>
                  <Button size="s" view="outlined" disabled={!selectedTask || !isActionable || proofBusy || isWorking} onClick={() => loadProofPreset("gcs")}>
                    GCS preset
                  </Button>
                  <Button size="s" view="outlined" disabled={!selectedTask || !isActionable || proofBusy || isWorking} onClick={() => loadProofPreset("http")}>
                    HTTP preset
                  </Button>
                  <Button
                    size="s"
                    view={proofAdvancedOpen ? "action" : "flat"}
                    disabled={proofBusy || isWorking}
                    onClick={() => setProofAdvancedOpen((v) => !v)}
                    title="Show/hide advanced fields"
                  >
                    Advanced
                  </Button>
                </div>
              </div>
              <div className={`callout ${proofWouldBeQuality ? "callout-ok" : "callout-warn"}`} style={{ marginTop: 8 }}>
                <p className="muted">
                  To unblock completion, provide a valid <span className="mono">checksum_sha256</span> (unless <span className="mono">storage_path</span> is <span className="mono">local:</span>).
                </p>
              </div>
              <div className="row-tight" style={{ alignItems: "center" }}>
                <Select
                  width="max"
                  value={[proofArtifactType]}
                  options={PROOF_ARTIFACT_TYPES.map((t) => ({ value: t, content: `artifact_type: ${t}` }))}
                  onUpdate={(items) => setProofArtifactType(String(items[0] ?? "logs"))}
                  disabled={!isActionable || proofBusy}
                />
                <TextInput
                  size="m"
                  value={proofStoragePath}
                  onUpdate={setProofStoragePath}
                  placeholder="storage_path (s3://…, gs://…, https://…)"
                  disabled={!isActionable || proofBusy}
                />
              </div>
              <div className="row-tight" style={{ alignItems: "center", marginTop: 8 }}>
                <TextInput
                  size="m"
                  value={proofChecksum}
                  onUpdate={setProofChecksum}
                  placeholder="checksum_sha256 (required for quality proof unless local:)"
                  disabled={!isActionable || proofBusy}
                />
	                <Button
	                  size="m"
	                  view="action"
	                  disabled={!isActionable || proofBusy || !proofCanSubmitAsQuality}
	                  loading={proofBusy}
                    title={
                      proofBusy
                        ? "Registering…"
                        : !isActionable
                          ? "Task is not actionable"
                          : !proofStoragePath.trim()
                            ? "Enter storage_path to register proof"
                            : proofChecksumError
                              ? proofChecksumError
                              : proofMetadataError
                                ? proofMetadataError
                                : !proofWouldBeQuality && !proofAllowMetadataOnly
                                  ? "Add checksum_sha256 (or use local:) to unblock completion"
                                  : "Register proof"
                    }
	                  onClick={() => void registerProofMetadata()}
	                  data-testid="operator-register-proof"
	                >
	                  {proofWouldBeQuality ? "Register proof" : proofAllowMetadataOnly ? "Register metadata (won’t unblock)" : "Add checksum to register"}
	                </Button>
              </div>
              {proofAdvancedOpen || proofAllowMetadataOnly || proofMetadataJson.trim() !== "{}" ? (
                <div style={{ marginTop: 8 }}>
                  <TextArea
                    value={proofMetadataJson}
                    onUpdate={setProofMetadataJson}
                    placeholder="metadata JSON (optional)"
                    minRows={4}
                    disabled={!isActionable || proofBusy}
                  />
                </div>
              ) : null}
              {proofChecksumError || proofMetadataError ? (
                <p className="muted" style={{ marginTop: 6 }}>
                  {proofChecksumError ? <span className="muted">checksum: {proofChecksumError}</span> : null}
                  {proofChecksumError && proofMetadataError ? <span className="muted"> · </span> : null}
                  {proofMetadataError ? <span className="muted">metadata: {proofMetadataError}</span> : null}
                </p>
              ) : null}
              {proofAdvancedOpen || proofAllowMetadataOnly ? (
                !proofWouldBeQuality ? (
                  <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={proofAllowMetadataOnly}
                      onChange={(e) => setProofAllowMetadataOnly(e.currentTarget.checked)}
                      disabled={proofBusy}
                    />
                    Allow metadata-only registration (won’t unblock completion)
                  </label>
                ) : null
              ) : null}
              </div>
            ) : (
              <p className="muted">
                This is an <span className="mono">openai.interruption</span> task. Use <span className="mono">Approve/Reject</span> above to complete it; proof upload is optional.
              </p>
            )}
            {selectedTaskDetail?.context ? (
              <div className="detail-block">
                <p className="muted">Context</p>
                <pre className="json-code">{JSON.stringify(selectedTaskDetail.context, null, 2)}</pre>
              </div>
            ) : null}
            {selectedTaskDetail?.result ? (
              <div className="detail-block">
                <p className="muted">Result</p>
                <pre className="json-code">{JSON.stringify(selectedTaskDetail.result, null, 2)}</pre>
              </div>
            ) : null}
            {(selectedTaskDetail?.artifacts ?? []).length > 0 ? (
              <div className="detail-block" data-testid="operator-artifacts">
                <p className="muted">Artifacts</p>
                {(selectedTaskDetail?.artifacts ?? []).map((a, idx) => (
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
                    extraActions={
                      <Button
                        size="s"
                        view="flat"
                        onClick={() => prefillProofFromArtifact(a)}
                        title="Use this artifact’s storage_path/checksum/metadata to prefill the proof form"
                        data-testid="operator-artifact-use-for-proof"
                      >
                        Use for proof
                      </Button>
                    }
                    notify={(level, message) => {
                      if (level === "error") setError(message);
                    }}
                  />
                ))}
              </div>
            ) : null}
            <div className="row">
              <Button
                size="l"
                view="action"
                onClick={claim}
                disabled={isWorking || selectedTask.status !== "queued"}
                loading={isWorking}
                data-testid="operator-claim"
                title={selectedTask.status !== "queued" ? "Only queued tasks can be claimed" : "Claim selected task"}
              >
                Claim
              </Button>
              <Button
                size="l"
                view="action"
                onClick={complete}
                disabled={!isActionable || !hasQualityProof || isWorking || isOpenAiInterruptionTask}
                loading={isWorking}
                data-testid="operator-complete"
                title={
                  isOpenAiInterruptionTask
                    ? "Use OpenAI interruption Approve/Reject instead of completing directly"
                    : !hasQualityProof
                      ? "Completion requires quality proof (upload local proof or register proof with checksum)"
                      : "Complete selected task"
                }
              >
                Complete
              </Button>
              <Button
                size="l"
                view="normal"
                onClick={addProof}
                disabled={!isActionable || isWorking || hasQualityProof}
                loading={isWorking}
                data-testid="operator-add-proof"
                title={hasQualityProof ? "Quality proof already present" : "Upload local proof artifact (quality proof)"}
              >
                Upload local proof
              </Button>
              <Button size="l" view={showMoreActions ? "action" : "outlined"} onClick={() => setShowMoreActions((v) => !v)}>
                More
              </Button>
            </div>
            {showMoreActions ? (
              <div className="row-tight" style={{ marginTop: 8, flexWrap: "wrap" }}>
                <Button size="m" view="flat" onClick={() => void copyText(selectedTask.id)}>
                  Copy ID
                </Button>
                <Button
                  size="m"
                  view="flat"
                  onClick={() => {
                    void Api.downloadTaskBundle(selectedTask.id)
                      .then(({ blob, filename }) => {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = filename;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        URL.revokeObjectURL(url);
                        pushToast("success", "Downloaded task bundle");
                      })
                      .catch((e) => {
                        setError(String(e));
                        pushToast("error", `Bundle download failed: ${String(e)}`);
                      });
                  }}
                >
                  Download bundle
                </Button>
                <span className="chip chip-muted" title="Local demo tools for testing the Operator flow">demo</span>
                <Button size="m" view="outlined" disabled={createBusy} loading={createBusy} onClick={() => void createDemoTask("stuck_recovery")}>
                  Create stuck task
                </Button>
                <Button size="m" view="outlined" disabled={createBusy} loading={createBusy} onClick={() => void createDemoTask("quick_judgment")}>
                  Create judgment task
                </Button>
              </div>
            ) : null}
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

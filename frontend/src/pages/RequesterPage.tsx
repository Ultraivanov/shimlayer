import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextArea, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { BalanceResponse, PackageInfo, Task, TaskWithReview } from "../types";

type Props = {
  pushTask: (task: Task) => void;
};

type AutoRefreshSeconds = 0 | 5 | 15 | 30 | 60;

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
  const [createTaskType, setCreateTaskType] = useState<string>("stuck_recovery");
  const [createContextJson, setCreateContextJson] = useState<string>('{"logs":"..."}');
  const [createSlaSeconds, setCreateSlaSeconds] = useState<string>("120");
  const [createMaxPriceUsd, setCreateMaxPriceUsd] = useState<string>("0.48");
  const [createCallbackUrl, setCreateCallbackUrl] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [uploadArtifactType, setUploadArtifactType] = useState<string>("logs");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadFileError, setUploadFileError] = useState<string>("");
  const [uploadFileSha256, setUploadFileSha256] = useState<string>("");
  const [uploadFileHashing, setUploadFileHashing] = useState(false);
  const [proofArtifactType, setProofArtifactType] = useState<string>("logs");
  const [proofStoragePath, setProofStoragePath] = useState<string>("");
  const [proofChecksum, setProofChecksum] = useState<string>("");
  const [proofMetadataJson, setProofMetadataJson] = useState<string>("{}");
  const [proofBusy, setProofBusy] = useState(false);
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
  const refreshInFlightRef = useRef(false);
  const balanceRefreshInFlightRef = useRef(false);

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

  async function refreshTasksOnly({ silent }: { silent: boolean }) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const myTasks = await Api.listMyTasks({ limit: 50 });
      setTasks(myTasks);
      setLastTasksRefreshAt(new Date().toLocaleTimeString());
    } catch (e) {
      if (!silent) setError(String(e));
      throw e;
    } finally {
      refreshInFlightRef.current = false;
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

  async function autoRefreshTick() {
    if (!isPageVisible) return;
    if (!autoRefreshSeconds) return;
    const now = Date.now();
    if (autoRefreshPausedUntilMs && now < autoRefreshPausedUntilMs) return;
    try {
      await Promise.all([refreshTasksOnly({ silent: true }), refreshBalanceOnly({ silent: true })]);
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
  }, [autoRefreshSeconds, isPageVisible, autoRefreshPausedUntilMs]);

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
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateBusy(false);
    }
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
    } catch (e) {
      setError(String(e));
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

  const proofWouldBeQuality = useMemo(() => {
    const storage = proofStoragePath.trim();
    if (!storage) return false;
    if (storage.startsWith("local:")) return true;
    const checksum = proofChecksum.trim();
    return Boolean(checksum) && isSha256Hex(checksum);
  }, [proofStoragePath, proofChecksum]);

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

  async function registerProofMetadata() {
    if (!selectedTask) return;
    const storage = proofStoragePath.trim();
    if (!storage) {
      setError("storage_path is required");
      return;
    }
    const checksum = proofChecksum.trim();
    if (checksum && !isSha256Hex(checksum)) {
      setError("checksum_sha256 must be 64 hex chars");
      return;
    }
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(proofMetadataJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      else throw new Error("metadata must be a JSON object");
    } catch (e) {
      setError(`Invalid metadata JSON: ${String(e)}`);
      return;
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
    } catch (e) {
      setError(String(e));
    } finally {
      setProofBusy(false);
    }
  }

  async function claimSelectedTask() {
    if (!selectedTask) return;
    if (taskActionBusy) return;
    setTaskActionBusy(true);
    setError(null);
    try {
      await Api.claimTask(selectedTask.id);
      await refresh();
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(friendlyCompleteError(e));
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
        {autoRefreshSeconds && autoRefreshPausedUntilMs && Date.now() < autoRefreshPausedUntilMs ? (
          <p className="muted mono" style={{ marginTop: 6 }}>
            auto-refresh paused until {new Date(autoRefreshPausedUntilMs).toLocaleTimeString()}
            {autoRefreshLastError ? <span className="muted"> · {autoRefreshLastError}</span> : null}
            {" · "}
            <Button
              size="s"
              view="flat"
              onClick={() => {
                setAutoRefreshPausedUntilMs(0);
                setAutoRefreshFailureCount(0);
                setAutoRefreshLastError("");
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
          <Button view="flat" onClick={() => void refresh()}>
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
          {autoRefreshSeconds && autoRefreshPausedUntilMs && Date.now() < autoRefreshPausedUntilMs ? (
            <span className="muted mono" title={autoRefreshLastError || ""}>
              paused until {new Date(autoRefreshPausedUntilMs).toLocaleTimeString()}
            </span>
          ) : null}
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
          <Button view="flat" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
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
              <Button view="flat" onClick={() => void copyText(selectedTask.id)}>
                Copy ID
              </Button>
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
        {!selectedTask ? <p className="muted">Select a task from the list.</p> : null}
        {selectedTask ? (
          <>
            <div className="detail-block">
              <div data-testid="requester-task-summary">
              <p><strong>ID:</strong> <span className="mono">{selectedTask.id}</span></p>
              <p><strong>Status:</strong> <span className={`status status-${selectedTask.status}`}>{selectedTask.status}</span></p>
              <p><strong>Type:</strong> {selectedTask.task_type}</p>
              <p><strong>Review:</strong> {selectedTask.review?.review_status ?? "none"}</p>
              <p><strong>Proof:</strong> {hasQualityProof ? <span className="mono">present</span> : <span className="muted">missing</span>}</p>
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
              <div className="detail-block">
                <h4 style={{ margin: "0 0 6px 0" }}>Register proof metadata</h4>
                <div className="row-tight" style={{ alignItems: "center" }}>
                  <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("s3")}>
                    S3 template
                  </Button>
                  <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("gcs")}>
                    GCS template
                  </Button>
                  <Button size="s" view="flat" disabled={proofBusy || !selectedTask} onClick={() => applyProofTemplate("http")}>
                    HTTPS template
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
                    placeholder="checksum_sha256 (optional)"
                    disabled={proofBusy}
                  />
                  <Button view="action" disabled={proofBusy || !proofStoragePath.trim()} loading={proofBusy} onClick={() => void registerProofMetadata()}>
                    Register proof
                  </Button>
                </div>
                <div style={{ marginTop: 6 }}>
                  <TextInput
                    size="m"
                    value={proofMetadataJson}
                    onUpdate={setProofMetadataJson}
                    placeholder='metadata JSON (e.g. {"source":"s3"})'
                    disabled={proofBusy}
                  />
                </div>
                <p className="muted" style={{ marginTop: 6 }}>
                  If `storage_path` starts with `local:`, the server can verify/fill `checksum_sha256`.
                </p>
                <p className="muted" style={{ marginTop: 6 }}>
                  External `storage_path` is stored as metadata only (ShimLayer does not fetch it). Provide `checksum_sha256` if you want it to count as quality proof.
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
                  accept={uploadArtifactType === "screenshot" ? "image/*" : uploadArtifactType === "json_payload" ? "application/json,.json" : ".log,.txt,text/plain,text/*"}
                  onChange={(e) => void onSelectUploadFile(e.currentTarget.files?.[0] ?? null)}
                  disabled={uploadBusy}
                />
                <Button
                  view="action"
                  disabled={!uploadFile || uploadBusy || Boolean(uploadFileError)}
                  loading={uploadBusy}
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
              {(selectedTask.artifacts ?? []).length === 0 ? <p className="muted">No artifacts.</p> : null}
              {(selectedTask.artifacts ?? []).map((a, idx) => (
                <div key={`artifact-${idx}`} className="incident-event">
                  {(() => {
                    const storagePath = String((a as any).storage_path ?? "");
                    const checksum = String((a as any).checksum_sha256 ?? "");
                    const artifactType = String((a as any).artifact_type ?? "");
                    const isLocal = storagePath.startsWith("local:");
                    const hasChecksum = checksum.length === 64;
                    const isQuality = isLocal || hasChecksum;
                    const canDownload = "id" in (a as any) && "task_id" in (a as any) && isLocal;
                    return (
                      <>
                        <div className="row-tight" style={{ alignItems: "center" }}>
                          {artifactType ? <span className="chip">type {artifactType}</span> : null}
                          <span className="chip">{isLocal ? "local" : "external"}</span>
                          <span
                            className="chip"
                            style={{
                              background: isQuality ? "rgba(46, 204, 113, 0.18)" : "rgba(241, 196, 15, 0.16)",
                              border: `1px solid ${isQuality ? "rgba(46, 204, 113, 0.35)" : "rgba(241, 196, 15, 0.3)"}`
                            }}
                            title={isQuality ? "Counts as quality proof" : "Does not count as quality proof"}
                          >
                            {isQuality ? "quality proof" : "not quality"}
                          </span>
                          {hasChecksum ? <span className="chip mono">sha256 ok</span> : <span className="chip muted">no sha256</span>}
                          {canDownload ? (
                            <Button
                              size="s"
                              view="outlined"
                              onClick={() => {
                                const taskId = String((a as any).task_id);
                                const artifactId = String((a as any).id);
                                void Api.downloadArtifact(taskId, artifactId).then(({ blob, filename }) => {
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
                              Download
                            </Button>
                          ) : null}
                        </div>
                        {!isQuality ? (
                          <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                            This artifact won’t unblock completion. Upload a `local:` artifact or register proof with a valid `checksum_sha256`.
                          </p>
                        ) : null}
                      </>
                    );
                  })()}
                  <pre className="json-code">{JSON.stringify(a, null, 2)}</pre>
                </div>
              ))}
            </Card>
          </>
        ) : null}
      </Card>

      {error ? <p className="error span-2">{error}</p> : null}
    </section>
  );
}

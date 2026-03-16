import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { Task, TaskWithReview } from "../types";
import { ArtifactTile } from "../components/ArtifactTile";

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function OperatorPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskWithReview | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
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

  const TASK_STATUSES = ["any", "pending", "queued", "claimed", "completed", "failed", "disputed", "refunded"] as const;
  const TASK_TYPES = ["any", "stuck_recovery", "quick_judgment"] as const;

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
  }, [autoRefreshSeconds, isPageVisible, autoRefreshFailureCount, autoRefreshLastError, autoRefreshPausedUntilMs]);

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
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
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
    } catch (e) {
      setError(String(e));
    } finally {
      setIsWorking(false);
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

  const reviewStatus = selectedTaskDetail?.review?.review_status ? String(selectedTaskDetail.review.review_status) : "";
  const artifactsCount = (selectedTaskDetail?.artifacts ?? []).length;

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
                    notify={(level, message) => {
                      if (level === "error") setError(message);
                    }}
                  />
                ))}
              </div>
            ) : null}
            <div className="row">
              <Button size="l" view="action" onClick={claim} loading={isWorking} data-testid="operator-claim">
                Claim
              </Button>
              <Button size="l" view="normal" onClick={complete} disabled={!hasQualityProof || isWorking} loading={isWorking} data-testid="operator-complete">
                Complete
              </Button>
              <Button size="l" view="outlined" onClick={addProof} disabled={isWorking || hasQualityProof} loading={isWorking} data-testid="operator-add-proof">
                Add Proof
              </Button>
            </div>
          </>
        ) : null}
      </Card>

      {error ? <p className="error span-2">{error}</p> : null}
    </section>
  );
}

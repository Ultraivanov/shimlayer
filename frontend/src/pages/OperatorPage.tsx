import { useEffect, useMemo, useState } from "react";
import { Button, Card, Select, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { Task, TaskWithReview } from "../types";

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
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

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
          <Button view="flat" onClick={() => void refresh()}>
            Refresh
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
                  <div key={`artifact-${idx}`} className="incident-event">
                    {"id" in (a as any) && "task_id" in (a as any) && String((a as any).storage_path ?? "").startsWith("local:") ? (
                      <div className="row-tight">
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
                      </div>
                    ) : null}
                    <pre className="json-code">{JSON.stringify(a, null, 2)}</pre>
                  </div>
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

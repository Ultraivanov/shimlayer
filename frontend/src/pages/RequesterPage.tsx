import { useEffect, useMemo, useState } from "react";
import { Button, Card, Select, TextInput } from "@gravity-ui/uikit";

import { Api } from "../api";
import type { BalanceResponse, PackageInfo, Task, TaskWithReview } from "../types";

type Props = {
  pushTask: (task: Task) => void;
};

export function RequesterPage({ pushTask }: Props) {
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [tasks, setTasks] = useState<TaskWithReview[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<string>("");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>("");
  const [taskSearch, setTaskSearch] = useState<string>("");
  const [taskIdForRefund, setTaskIdForRefund] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadArtifactType, setUploadArtifactType] = useState<string>("logs");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  const TASK_STATUSES = ["any", "pending", "queued", "claimed", "completed", "failed", "disputed", "refunded"] as const;
  const TASK_TYPES = ["any", "stuck_recovery", "quick_judgment"] as const;
  const ARTIFACT_TYPES = ["logs", "screenshot", "json_payload"] as const;

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

  function shortId(value: string): string {
    return value.slice(0, 8);
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refresh() {
    setError(null);
    try {
      const [pkg, bal, myTasks] = await Promise.all([Api.listPackages(), Api.getBalance(), Api.listMyTasks({ limit: 50 })]);
      setPackages(pkg);
      setBalance(bal);
      setTasks(myTasks);
    } catch (e) {
      setError(String(e));
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

  async function buyPackage(code: string) {
    try {
      await Api.purchasePackage(code, `ui-${Date.now()}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createStuckTask() {
    try {
      const task = await Api.createTask({
        task_type: "stuck_recovery",
        context: { logs: "Agent loop in checkout", prompt: "retrying forever" },
        sla_seconds: 120,
        callback_url: "https://example.com/webhook"
      });
      pushTask(task);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createQuickJudgment() {
    try {
      const task = await Api.createJudgment({
        context: { question: "Approve this automation run?" },
        sla_seconds: 60,
        callback_url: "https://example.com/webhook"
      });
      pushTask(task);
      await refresh();
    } catch (e) {
      setError(String(e));
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
    setUploadBusy(true);
    setError(null);
    try {
      await Api.uploadArtifactMultipart(selectedTask.id, uploadArtifactType, uploadFile);
      setUploadFile(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <section className="grid two-col">
      <Card className="panel" view="raised">
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
      </Card>

      <Card className="panel" view="raised">
        <h2>Create Task</h2>
        <p className="muted">Launch a rescue or quick-judgment flow in one click.</p>
        <div className="row">
          <Button size="l" view="action" onClick={createStuckTask}>
            New Stuck Recovery
          </Button>
          <Button size="l" view="normal" onClick={createQuickJudgment}>
            New Quick Judgment
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

      <Card className="panel span-2" view="raised">
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

      <Card className="panel span-2" view="raised">
        <div className="section-head">
          <h2>My Tasks</h2>
          <span className="chip">{filteredTasks.length}/{sortedTasks.length}</span>
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

      <Card className="panel span-2" view="raised">
        <div className="section-head">
          <h2>Task Details</h2>
          {selectedTask ? (
            <div className="row-tight">
              <Button view="flat" onClick={() => void copyText(selectedTask.id)}>
                Copy ID
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
              <p><strong>ID:</strong> <span className="mono">{selectedTask.id}</span></p>
              <p><strong>Status:</strong> <span className={`status status-${selectedTask.status}`}>{selectedTask.status}</span></p>
              <p><strong>Type:</strong> {selectedTask.task_type}</p>
              <p><strong>Review:</strong> {selectedTask.review?.review_status ?? "none"}</p>
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
            <Card className="panel span-2" view="raised">
              <h3>Artifacts</h3>
              <div className="row-tight" style={{ alignItems: "center" }}>
                <Select
                  width="max"
                  value={[uploadArtifactType]}
                  options={ARTIFACT_TYPES.map((t) => ({ value: t, content: `Type: ${t}` }))}
                  onUpdate={(items) => setUploadArtifactType(String(items[0] ?? "logs"))}
                  disabled={uploadBusy}
                />
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.currentTarget.files?.[0] ?? null)}
                  disabled={uploadBusy}
                />
                <Button
                  view="action"
                  disabled={!uploadFile || uploadBusy}
                  loading={uploadBusy}
                  onClick={() => void uploadSelectedArtifact()}
                >
                  Upload artifact
                </Button>
              </div>
              <p className="muted" style={{ marginTop: 6 }}>
                Upload only proof-safe artifacts (avoid secrets/PII unless required and permitted).
              </p>
              {(selectedTask.artifacts ?? []).length === 0 ? <p className="muted">No artifacts.</p> : null}
              {(selectedTask.artifacts ?? []).map((a, idx) => (
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
            </Card>
          </>
        ) : null}
      </Card>

      {error ? <p className="error span-2">{error}</p> : null}
    </section>
  );
}

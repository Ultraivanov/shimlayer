import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@gravity-ui/uikit";

type NotifyLevel = "info" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function shortMiddle(value: string, head = 22, tail = 14): string {
  const v = String(value || "");
  if (v.length <= head + tail + 3) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

export type ArtifactTileDownloadFn = (taskId: string, artifactId: string) => void | Promise<void>;

export function ArtifactTile(props: {
  artifact: unknown;
  onDownload?: ArtifactTileDownloadFn;
  extraActions?: ReactNode;
  notify?: (level: NotifyLevel, message: string) => void;
  defaultExpanded?: boolean;
  "data-testid"?: string;
}) {
  const [expanded, setExpanded] = useState(Boolean(props.defaultExpanded));

  const artifact = useMemo(() => (isRecord(props.artifact) ? props.artifact : {}), [props.artifact]);

  const storagePath = String(artifact.storage_path ?? "");
  const checksum = String(artifact.checksum_sha256 ?? "");
  const artifactType = String(artifact.artifact_type ?? "");

  const isLocal = storagePath.startsWith("local:");
  const hasChecksum = isSha256Hex(checksum);
  const isQuality = isLocal || hasChecksum;

  const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
  const filename = typeof metadata.filename === "string" ? metadata.filename : "";
  const contentType = typeof metadata.content_type === "string" ? metadata.content_type : "";
  const sizeBytes = typeof metadata.size_bytes === "number" ? metadata.size_bytes : null;

  const createdAt = typeof artifact.created_at === "string" ? artifact.created_at : "";

  const canDownload =
    Boolean(props.onDownload) &&
    isLocal &&
    typeof artifact.id === "string" &&
    typeof artifact.task_id === "string";

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      props.notify?.("error", `Copy failed: ${String(e)}`);
    }
  }

  return (
    <div
      className="incident-event artifact-tile"
      data-testid={props["data-testid"] ?? "artifact-tile"}
      data-artifact-id={typeof artifact.id === "string" ? artifact.id : undefined}
      data-task-id={typeof artifact.task_id === "string" ? artifact.task_id : undefined}
    >
      <div className="row-tight" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <div className="row-tight" style={{ alignItems: "center", flexWrap: "wrap" }}>
          {artifactType ? <span className="chip">type {artifactType}</span> : null}
          {storagePath ? <span className="chip">{isLocal ? "local" : "external"}</span> : <span className="chip muted">no storage_path</span>}
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
          {filename ? <span className="chip mono">{shortMiddle(filename, 18, 10)}</span> : null}
          {typeof sizeBytes === "number" ? <span className="chip mono">{formatBytes(sizeBytes)}</span> : null}
          {contentType ? <span className="chip mono">{shortMiddle(contentType, 18, 10)}</span> : null}
        </div>

        <div className="row-tight" style={{ alignItems: "center" }}>
          {storagePath ? (
            <Button size="s" view="flat" onClick={() => void copyToClipboard(storagePath)} data-testid="artifact-copy-storage">
              Copy path
            </Button>
          ) : null}
          {hasChecksum ? (
            <Button size="s" view="flat" onClick={() => void copyToClipboard(checksum)} data-testid="artifact-copy-checksum">
              Copy sha256
            </Button>
          ) : null}
          {canDownload ? (
            <Button
              size="s"
              view="outlined"
              onClick={() => void props.onDownload?.(String(artifact.task_id), String(artifact.id))}
              data-testid="artifact-download"
            >
              Download
            </Button>
          ) : null}
          {props.extraActions}
          <Button
            size="s"
            view="outlined"
            onClick={() => setExpanded((v) => !v)}
            data-testid="artifact-toggle-details"
          >
            {expanded ? "Hide" : "Details"}
          </Button>
        </div>
      </div>

      {createdAt ? (
        <p className="muted mono" style={{ marginTop: 6 }}>
          created_at {new Date(createdAt).toLocaleString()}
        </p>
      ) : null}

      {storagePath ? (
        <p className="muted mono" style={{ marginTop: 6 }}>
          storage_path {shortMiddle(storagePath, 40, 18)}
        </p>
      ) : null}

      {hasChecksum ? (
        <p className="muted mono" style={{ marginTop: 6 }}>
          checksum_sha256 {checksum.slice(0, 16)}…
        </p>
      ) : null}

      {!isQuality ? (
        <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
          This artifact won’t unblock completion. Upload a <span className="mono">local:</span> artifact or register proof with a valid{" "}
          <span className="mono">checksum_sha256</span>.
        </p>
      ) : null}

      {expanded ? <pre className="json-code artifact-json">{JSON.stringify(props.artifact, null, 2)}</pre> : null}
    </div>
  );
}

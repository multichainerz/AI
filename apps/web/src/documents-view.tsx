import type {
  DocumentClassification,
  DocumentDetail,
  DocumentMetrics,
  DocumentStatus,
  DocumentSummary,
} from "@orcasynapse/contracts";
import { DOCUMENT_UPLOAD_ACCEPT, SUPPORTED_DOCUMENT_TYPES } from "@orcasynapse/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  deleteDocument,
  getDocument,
  getDocumentMetrics,
  getDocuments,
  uploadDocument,
} from "./api.js";
import {
  Alert, Button, EmptyState, Field, HeroBanner, Input, LockedScreen,
  PageHeader, Panel, PanelHeading, Select, StatusText, Textarea, Tile, cn, toneFor,
} from "./ui/index.js";

interface DocumentsViewProps {
  unlocked: boolean;
  administrator: boolean;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

const processingStatuses = new Set<DocumentStatus>(["QUEUED", "CONVERTING"]);

// Derived from the contract so this label can never advertise a format the
// API rejects or omit one it accepts.
const SUPPORTED_FORMAT_LABEL = SUPPORTED_DOCUMENT_TYPES
  .map(({ extension }) => extension.slice(1).toUpperCase())
  .join(", ");

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 ** 2).toFixed(1)} MB`;
}

function formatStatus(status: DocumentStatus): string {
  if (status === "QUEUED" || status === "CONVERTING") return "Indexing";
  return status.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function statusTone(status: DocumentStatus): string {
  if (status === "READY") return "ready";
  if (status === "FAILED" || status === "REJECTED") return "failed";
  if (processingStatuses.has(status)) return "processing";
  return "neutral";
}

export function DocumentsView(props: DocumentsViewProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const activeId = useRef<string | null>(null);
  const documentsRef = useRef<DocumentSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [active, setActive] = useState<DocumentDetail | null>(null);
  const [metrics, setMetrics] = useState<DocumentMetrics | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [classification, setClassification] = useState<DocumentClassification>("INTERNAL");
  const [retentionDays, setRetentionDays] = useState(365);
  const [deletionReason, setDeletionReason] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validRetention = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3_650;

  const handleError = (cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) props.onSessionExpired();
    setError(cause instanceof Error ? cause.message : fallback);
  };

  const refresh = async (preserveId: string | null | undefined = undefined) => {
    const [{ items }, nextMetrics] = await Promise.all([
      getDocuments(),
      props.administrator ? getDocumentMetrics().catch(() => null) : Promise.resolve(null),
    ]);
    documentsRef.current = items;
    setDocuments(items);
    setMetrics(nextMetrics);
    const requestedId = preserveId === undefined ? activeId.current : preserveId;
    const target = requestedId ? items.find(({ id }) => id === requestedId) ?? items[0] : items[0];
    const detail = target ? await getDocument(target.id) : null;
    activeId.current = detail?.id ?? null;
    setActive(detail);
  };

  useEffect(() => {
    if (!props.unlocked) {
      setDocuments([]);
      documentsRef.current = [];
      activeId.current = null;
      setActive(null);
      setMetrics(null);
      return;
    }
    let current = true;
    setBusy(true);
    void refresh(null)
      .catch((cause) => current && handleError(cause, "Unable to load knowledge."))
      .finally(() => current && setBusy(false));
    const timer = window.setInterval(() => {
      if (current && documentsRef.current.some(({ status }) => processingStatuses.has(status))) {
        void refresh().catch(() => undefined);
      }
    }, 5_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [props.unlocked, props.administrator]);

  const select = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await getDocument(id);
      activeId.current = detail.id;
      setActive(detail);
    } catch (cause) { handleError(cause, "Unable to open the knowledge record."); }
    finally { setBusy(false); }
  };

  const submitUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !validRetention || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await uploadDocument(file, classification, retentionDays);
      await refresh(created.id);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadOpen(false);
    } catch (cause) { handleError(cause, "Unable to index the source."); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!active || busy) return;
    const beforeRetention = new Date(active.retentionUntil) > new Date();
    if (beforeRetention && !props.administrator) {
      setError("This knowledge record is still inside its retention period.");
      return;
    }
    if (beforeRetention && deletionReason.trim().length < 3) {
      setError("Enter a deletion reason before overriding retention.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteDocument(active.id, beforeRetention, beforeRetention ? deletionReason.trim() : undefined);
      setDeletionReason("");
      await refresh(null);
    } catch (cause) { handleError(cause, "Unable to delete the knowledge record."); }
    finally { setBusy(false); }
  };

  if (!props.unlocked) {
    return <LockedScreen
      kicker="Enterprise knowledge"
      title="Knowledge"
      mark="KN"
      headline={props.oidcConfigured ? "Sign in to use Knowledge" : "Enterprise access is not configured"}
      reason="OrcaSynapse extracts and embeds each authorized source into its private knowledge index. Original files are never retained."
      actionLabel={props.oidcConfigured ? "Sign in with OrcaSynapse" : "Manage Agentic System"}
      onAction={props.oidcConfigured ? props.onSignIn : props.onConfigure}
      {...(props.oidcConfigured
        ? { secondaryLabel: "Manage Agentic System", onSecondary: props.onConfigure }
        : {})}
    />;
  }

  return <div className="grid gap-5">
    <PageHeader
      kicker="Enterprise knowledge"
      title="Knowledge"
      description="Extracted knowledge lives in OrcaSynapse's private vector index while authoritative files remain in enterprise storage."
      actions={
        <Button variant="primary" onClick={() => setUploadOpen((value) => !value)}>
          {uploadOpen ? "Close" : "Add source"}
        </Button>
      }
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

    {uploadOpen && <Panel>
      <form className="grid gap-3" onSubmit={submitUpload}>
        <PanelHeading
          kicker="Private knowledge ingestion"
          title="Add a knowledge source"
          description="OrcaSynapse checks identity and policy, extracts the text in flight, and embeds it into the local knowledge index. Only chunks and metadata are kept — never the file."
        />
        <label className="grid cursor-pointer gap-1 rounded border border-dashed border-border-strong bg-raised px-4 py-5 text-center">
          <span className="text-label font-semibold text-text">{file ? file.name : "Choose a source file"}</span>
          <small className="text-caption text-muted">{SUPPORTED_FORMAT_LABEL} · up to 50 MB</small>
          <input className="sr-only" ref={fileInput} type="file" required accept={DOCUMENT_UPLOAD_ACCEPT} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        {/* Stated up front rather than as a failure later: a scanned PDF is the
            most common thing someone tries and the least obvious thing to fail. */}
        <div className="rounded border border-warn/40 bg-warn/10 p-3">
          <strong className="block text-caption font-semibold text-warn">Local extraction compatibility</strong>
          <span className="mt-1 block text-body leading-relaxed text-muted">
            Text is extracted on the control plane, then BGE-M3 embeds it locally for retrieval. There is no OCR:
            scanned or image-only PDFs carry no extractable text and will fail indexing. Image files are not accepted.
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Classification">
            <Select value={classification} onChange={(event) => setClassification(event.target.value as DocumentClassification)}>
              <option value="INTERNAL">Internal</option>
              <option value="CONFIDENTIAL">Confidential</option>
              <option value="RESTRICTED">Restricted</option>
            </Select>
          </Field>
          <Field label="Metadata retention (days)">
            <Input type="number" min={1} max={3650} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} />
          </Field>
        </div>
        <Button variant="primary" type="submit" className="justify-self-end" disabled={!file || !validRetention || busy}>
          {busy ? "Indexing…" : "Add to knowledge"}
        </Button>
      </form>
    </Panel>}

    {/*
      * The plain banner variant: a count is a fact, not an achievement, so the
      * sources figure sits large on the card rather than on the accent block.
      */}
    <HeroBanner
      tone="plain"
      aria-label="Knowledge summary"
      highlight={{
        label: "Sources",
        value: metrics?.total ?? documents.length,
        caption: "Indexed for owner-scoped retrieval",
      }}
      metrics={[
        {
          label: "Indexing",
          value: metrics?.processing ?? documents.filter(({ status }) => processingStatuses.has(status)).length,
        },
        {
          label: "Ready",
          tone: "good",
          value: metrics?.ready ?? documents.filter(({ status }) => status === "READY").length,
        },
        // Zero is the claim, not a placeholder: the original file never lands.
        { label: "Source bytes retained", value: "0 B", caption: "Chunks and metadata only" },
      ]}
    />

    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
      <Panel aria-label="Knowledge source list">
        <PanelHeading
          kicker="Knowledge index"
          title="Sources"
          actions={<Button size="sm" onClick={() => void refresh()} disabled={busy}>Refresh</Button>}
        />
        {documents.length === 0 && !busy && (
          <EmptyState title="No knowledge sources">Add a file or keep using Chat without private knowledge.</EmptyState>
        )}
        <div className="grid gap-1">
          {documents.map((document) => <button
            key={document.id}
            type="button"
            aria-current={active?.id === document.id ? "true" : undefined}
            className={cn(
              "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded border p-2.5 text-left transition-colors",
              active?.id === document.id ? "border-border-strong bg-raised" : "border-transparent hover:bg-raised",
            )}
            onClick={() => void select(document.id)}
          >
            <span className="grid h-8 w-11 place-items-center rounded border border-border bg-surface font-mono text-micro font-bold text-muted">
              {extLabel(document.fileName)}
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-label font-semibold text-text">{document.fileName}</strong>
              <small className="mt-0.5 block truncate text-caption text-faint">
                {formatBytes(document.sizeBytes)} · {document.classification.toLowerCase()}
              </small>
            </span>
            <StatusText dot tone={toneFor(statusTone(document.status))}>{formatStatus(document.status)}</StatusText>
          </button>)}
        </div>
      </Panel>

      <Panel>
        {!active
          ? <EmptyState title="Select a source">Index status, provenance, and retention will appear here.</EmptyState>
          : <>
          <PanelHeading
            kicker="Knowledge record"
            title={active.fileName}
            actions={<StatusText dot tone={toneFor(statusTone(active.status))}>{formatStatus(active.status)}</StatusText>}
          />
          <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border">
            {[
              { label: "Classification", value: active.classification.toLowerCase() },
              { label: "Type", value: extLabel(active.fileName) },
              { label: "Size", value: formatBytes(active.sizeBytes) },
              { label: "Metadata until", value: new Date(active.retentionUntil).toLocaleDateString() },
            ].map((fact) => (
              <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
                <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{fact.value}</dd>
              </div>
            ))}
          </dl>

          {processingStatuses.has(active.status) && (
            <Tile strong className="mt-3">
              <StatusText dot tone="accent">OrcaSynapse is indexing this source</StatusText>
              <small className="mt-1.5 block text-caption text-muted">
                Extraction, chunking, and embedding run locally; no copy leaves the control plane.
              </small>
            </Tile>
          )}
          {(active.status === "FAILED" || active.status === "REJECTED") && (
            <div className="mt-3 rounded border border-bad/40 bg-bad/10 p-3">
              <strong className="block text-micro font-semibold uppercase tabular-nums text-bad">{active.failureCode ?? "INDEXING_FAILED"}</strong>
              <span className="mt-1.5 block text-body leading-relaxed text-muted">
                {active.failureMessage ?? "OrcaSynapse could not extract indexable text from this source. Re-upload after correcting the file."}
              </span>
            </div>
          )}

          <div className="mt-3 rounded border border-good/40 bg-good/10 p-3">
            <strong className="block text-caption font-semibold text-good">No source bytes retained by OrcaSynapse</strong>
            <span className="mt-1 block text-body leading-relaxed text-muted">
              PostgreSQL contains ownership, classification, checksum, projected status, retention, and audit metadata only.
            </span>
          </div>

          {["READY", "FAILED", "REJECTED"].includes(active.status) && <div className="mt-3 grid gap-2">
            {props.administrator && new Date(active.retentionUntil) > new Date() && (
              <Field label="Retention override reason">
                <Textarea value={deletionReason} onChange={(event) => setDeletionReason(event.target.value)} maxLength={1000} rows={2} placeholder="Record why this source must be deleted early" />
              </Field>
            )}
            <Button variant="danger" className="justify-self-end" disabled={busy} onClick={() => void remove()}>
              Delete knowledge record
            </Button>
          </div>}
        </>}
      </Panel>
    </div>
  </div>;
}

function extLabel(fileName: string): string {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension.slice(0, 5).toUpperCase() : "FILE";
}

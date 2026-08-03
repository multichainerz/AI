import type {
  DocumentClassification,
  DocumentDetail,
  DocumentMetrics,
  DocumentStatus,
  DocumentSummary,
} from "@orcasynapse/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  deleteDocument,
  getDocument,
  getDocumentMetrics,
  getDocuments,
  uploadDocument,
} from "./api.js";

interface DocumentsViewProps {
  unlocked: boolean;
  administrator: boolean;
  serviceReady: boolean | null;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onUnauthorized: () => void;
}

const processingStatuses = new Set<DocumentStatus>(["QUEUED", "CONVERTING"]);

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
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) props.onUnauthorized();
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
    if (!file || !validRetention || busy || props.serviceReady === false) return;
    setBusy(true);
    setError(null);
    try {
      const created = await uploadDocument(file, classification, retentionDays);
      await refresh(created.id);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadOpen(false);
    } catch (cause) { handleError(cause, "Unable to send the source to Supermemory."); }
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
    return <section className="documents-locked panel">
      <div className="document-lock-mark" aria-hidden="true">KN</div>
      <div>
        <p className="page-kicker">Enterprise knowledge</p>
        <h1>{props.oidcConfigured ? "Sign in to use Knowledge" : "Enterprise access is not configured"}</h1>
        <p>OrcaSynapse authorizes each source and streams it to Supermemory. Source bytes are not retained by the control plane.</p>
      </div>
      <div className="document-lock-actions">
        {props.oidcConfigured && <button className="primary-button" type="button" onClick={props.onSignIn}>Sign in with OrcaSynapse</button>}
        <button className="text-button" type="button" onClick={props.onConfigure}>Manage Agentic System</button>
      </div>
    </section>;
  }

  return <section className="documents-workspace knowledge-workspace">
    <header className="documents-header">
      <div>
        <p className="page-kicker">Enterprise knowledge</p>
        <h1>Knowledge</h1>
        <p>Authorize sources into Supermemory while authoritative files remain in enterprise storage.</p>
      </div>
      <button className="primary-button" type="button" disabled={props.serviceReady === false} onClick={() => setUploadOpen((value) => !value)}>{uploadOpen ? "Close" : props.serviceReady === false ? "Memory unavailable" : "Add source"}</button>
    </header>

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
    {props.serviceReady === false && <div className="workspace-guidance" role="status">
      <div><strong>Supermemory needs attention</strong><span>Existing metadata remains visible, but new sources cannot be indexed until the VM2 memory service is healthy.</span></div>
      <button className="secondary-button" type="button" onClick={props.onConfigure}>Review Agentic System</button>
    </div>}

    {uploadOpen && props.serviceReady !== false && <form className="document-upload panel knowledge-upload" onSubmit={submitUpload}>
      <div className="knowledge-upload-intro">
        <p className="section-kicker">Direct Supermemory ingestion</p>
        <h2>Add a knowledge source</h2>
        <p>The browser sends the file to OrcaSynapse for identity and policy checks. OrcaSynapse relays the stream to VM2 and keeps metadata only.</p>
      </div>
      <label className="document-file-field">
        <span>{file ? file.name : "Choose a source file"}</span>
        <small>TXT, Markdown, HTML, PDF, DOCX, PNG, JPEG, or WebP · up to 50 MB</small>
        <input ref={fileInput} type="file" required accept=".txt,.md,.html,.pdf,.docx,.png,.jpg,.jpeg,.webp,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </label>
      <div className="knowledge-capability-note">
        <strong>Local extraction compatibility</strong>
        <span>Text files and text-based documents use the local OpenAI-compatible model on VM2. Scanned PDFs, image-heavy documents, and images require an optional Gemini or Vertex document-understanding provider. OrcaSynapse never retains a retry copy.</span>
      </div>
      <label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value as DocumentClassification)}><option value="INTERNAL">Internal</option><option value="CONFIDENTIAL">Confidential</option><option value="RESTRICTED">Restricted</option></select></label>
      <label>Metadata retention<input type="number" min={1} max={3650} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>
      <button className="primary-button" type="submit" disabled={!file || !validRetention || busy}>{busy ? "Sending…" : "Send to Supermemory"}</button>
    </form>}

    <div className="document-metrics" aria-label="Knowledge summary">
      <article><span>Sources</span><strong>{metrics?.total ?? documents.length}</strong></article>
      <article><span>Indexing</span><strong>{metrics?.processing ?? documents.filter(({ status }) => processingStatuses.has(status)).length}</strong></article>
      <article><span>Ready</span><strong>{metrics?.ready ?? documents.filter(({ status }) => status === "READY").length}</strong></article>
      <article><span>Source bytes retained</span><strong>0 B</strong></article>
    </div>

    <div className="documents-layout">
      <section className="document-list panel" aria-label="Knowledge source list">
        <div className="document-section-heading"><div><p className="section-kicker">Knowledge index</p><h2>Sources</h2></div><button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
        {documents.length === 0 && !busy && <div className="document-empty"><strong>No knowledge sources</strong><span>Add a file or keep using Chat without private knowledge.</span></div>}
        {documents.map((document) => <button key={document.id} type="button" className={active?.id === document.id ? "selected" : ""} onClick={() => void select(document.id)}>
          <span className="document-type">{extLabel(document.fileName)}</span>
          <span className="document-list-copy"><strong>{document.fileName}</strong><small>{formatBytes(document.sizeBytes)} · {document.classification.toLowerCase()}</small></span>
          <span className={`document-status ${statusTone(document.status)}`}>{formatStatus(document.status)}</span>
        </button>)}
      </section>

      <section className="document-detail panel">
        {!active ? <div className="document-empty"><strong>Select a source</strong><span>Index status, provenance, and retention will appear here.</span></div> : <>
          <div className="document-detail-title"><div><p className="section-kicker">Knowledge record</p><h2>{active.fileName}</h2></div><span className={`document-status ${statusTone(active.status)}`}>{formatStatus(active.status)}</span></div>
          <dl className="document-facts"><div><dt>Classification</dt><dd>{active.classification.toLowerCase()}</dd></div><div><dt>Type</dt><dd>{extLabel(active.fileName)}</dd></div><div><dt>Size</dt><dd>{formatBytes(active.sizeBytes)}</dd></div><div><dt>Metadata until</dt><dd>{new Date(active.retentionUntil).toLocaleDateString()}</dd></div></dl>

          {processingStatuses.has(active.status) && <div className="document-progress"><span /><div><strong>Supermemory is indexing this source</strong><small>Status is projected from VM2; OrcaSynapse is not holding a retry copy.</small></div></div>}
          {(active.status === "FAILED" || active.status === "REJECTED") && <div className="document-failure"><strong>{active.failureCode ?? "SUPERMEMORY_PROCESSING_FAILED"}</strong><span>{active.failureMessage ?? "The installed Supermemory extractor could not process this source. Re-upload after correcting VM2 extraction compatibility."}</span></div>}

          <div className="document-staging ready"><strong>No source bytes retained by OrcaSynapse</strong><span>PostgreSQL contains ownership, classification, checksum, projected status, retention, and audit metadata only.</span></div>

          {["READY", "FAILED", "REJECTED"].includes(active.status) && <div className="document-actions">
            {props.administrator && new Date(active.retentionUntil) > new Date() && <label>Retention override reason<textarea value={deletionReason} onChange={(event) => setDeletionReason(event.target.value)} maxLength={1000} rows={2} placeholder="Record why this source must be deleted early" /></label>}
            <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>Delete from Supermemory</button>
          </div>}
        </>}
      </section>
    </div>
  </section>;
}

function extLabel(fileName: string): string {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension.slice(0, 5).toUpperCase() : "FILE";
}

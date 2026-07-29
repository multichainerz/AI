import type {
  DocumentClassification,
  DocumentDetail,
  DocumentMetrics,
  DocumentStatus,
  DocumentSummary,
} from "@aihub/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  decideDocumentQuarantine,
  deleteDocument,
  getDocument,
  getDocumentMetrics,
  getDocuments,
  reprocessDocument,
  uploadDocument,
} from "./api.js";

interface DocumentsViewProps {
  unlocked: boolean;
  administrator: boolean;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onUnauthorized: () => void;
}

const processingStatuses = new Set<DocumentStatus>([
  "QUEUED", "CONVERTING", "OCR_PENDING", "OCR_PROCESSING",
]);

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_024 ** 2).toFixed(1)} MB`;
}

function formatStatus(status: DocumentStatus): string {
  return status.replaceAll("_", " ").toLowerCase();
}

function statusTone(status: DocumentStatus): string {
  if (status === "READY") return "ready";
  if (status === "FAILED" || status === "REJECTED") return "failed";
  if (status === "QUARANTINED") return "quarantined";
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
  const [reviewReason, setReviewReason] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validRetention = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3_650;

  const handleError = (cause: unknown, fallback: string) => {
    if (cause instanceof AIHubApiError && cause.status === 401) props.onUnauthorized();
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
    const target = requestedId
      ? items.find(({ id }) => id === requestedId) ?? items[0]
      : items[0];
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
      .catch((cause) => current && handleError(cause, "Unable to load documents."))
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
    }
    catch (cause) { handleError(cause, "Unable to open the document."); }
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
    } catch (cause) {
      handleError(cause, "Unable to upload the document.");
    } finally { setBusy(false); }
  };

  const review = async (decision: "APPROVE" | "REJECT") => {
    if (!active || reviewReason.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await decideDocumentQuarantine(active.id, {
        decision,
        reason: reviewReason.trim(),
      });
      setReviewReason("");
      await refresh(updated.id);
    } catch (cause) { handleError(cause, "Unable to review the document."); }
    finally { setBusy(false); }
  };

  const reprocess = async () => {
    if (!active || busy) return;
    setBusy(true);
    setError(null);
    try { await reprocessDocument(active.id); await refresh(active.id); }
    catch (cause) { handleError(cause, "Unable to reprocess the document."); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!active || busy) return;
    const beforeRetention = new Date(active.retentionUntil) > new Date();
    if (beforeRetention && !props.administrator) {
      setError("This document is still inside its retention period.");
      return;
    }
    if (beforeRetention && reviewReason.trim().length < 3) {
      setError("Enter a deletion reason before forcing retention override.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteDocument(active.id, beforeRetention, beforeRetention ? reviewReason.trim() : undefined);
      setReviewReason("");
      await refresh(null);
    } catch (cause) { handleError(cause, "Unable to delete the document."); }
    finally { setBusy(false); }
  };

  if (!props.unlocked) {
    return (
      <section className="documents-locked panel">
        <div className="document-lock-mark" aria-hidden="true">DOC</div>
        <div>
          <p className="page-kicker">Governed document pipeline</p>
          <h1>{props.oidcConfigured ? "Sign in to manage documents" : "Enterprise access is not configured"}</h1>
          <p>Uploads remain quarantined until review, then flow through on-premise conversion, Unlimited OCR, and SeaweedFS storage.</p>
        </div>
        <div className="document-lock-actions">
          {props.oidcConfigured && <button className="primary-button" type="button" onClick={props.onSignIn}>Sign in with MPM</button>}
          <button className="text-button" type="button" onClick={props.onConfigure}>Administrator setup</button>
        </div>
      </section>
    );
  }

  return (
    <section className="documents-workspace">
      <header className="documents-header">
        <div><p className="page-kicker">Content operations</p><h1>Documents</h1><p>Quarantine, convert, extract, retain, and review on-premise content.</p></div>
        <button className="primary-button" type="button" onClick={() => setUploadOpen((value) => !value)}>{uploadOpen ? "Close upload" : "Upload document"}</button>
      </header>

      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      {uploadOpen && (
        <form className="document-upload panel" onSubmit={submitUpload}>
          <label className="document-file-field">
            <span>{file ? file.name : "Choose an approved document"}</span>
            <small>PDF, Office, PNG, JPEG, or TXT · up to 50 MB</small>
            <input ref={fileInput} type="file" required accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)}/>
          </label>
          <label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value as DocumentClassification)}><option value="INTERNAL">Internal</option><option value="CONFIDENTIAL">Confidential</option><option value="RESTRICTED">Restricted</option></select></label>
          <label>Retention days<input type="number" min={1} max={3650} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}/></label>
          <button className="primary-button" type="submit" disabled={!file || !validRetention || busy}>{busy ? "Uploading…" : "Upload to quarantine"}</button>
        </form>
      )}

      <div className="document-metrics" aria-label="Document operations summary">
        <article><span>Total documents</span><strong>{metrics?.total ?? documents.length}</strong></article>
        <article><span>Quarantined</span><strong>{metrics?.quarantined ?? documents.filter(({ status }) => status === "QUARANTINED").length}</strong></article>
        <article><span>Processing</span><strong>{metrics?.processing ?? documents.filter(({ status }) => processingStatuses.has(status)).length}</strong></article>
        <article><span>Ready</span><strong>{metrics?.ready ?? documents.filter(({ status }) => status === "READY").length}</strong></article>
      </div>

      <div className="documents-layout">
        <section className="document-list panel" aria-label="Document list">
          <div className="document-section-heading"><div><p className="section-kicker">Repository</p><h2>Managed files</h2></div><button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
          {documents.length === 0 && !busy && <div className="document-empty"><strong>No documents yet</strong><span>Upload a file to begin the governed pipeline.</span></div>}
          {documents.map((document) => (
            <button key={document.id} type="button" className={active?.id === document.id ? "selected" : ""} onClick={() => void select(document.id)}>
              <span className="document-type">{extLabel(document.fileName)}</span>
              <span className="document-list-copy"><strong>{document.fileName}</strong><small>{formatBytes(document.sizeBytes)} · {document.classification.toLowerCase()}</small></span>
              <span className={`document-status ${statusTone(document.status)}`}>{formatStatus(document.status)}</span>
            </button>
          ))}
        </section>

        <section className="document-detail panel">
          {!active ? (
            <div className="document-empty"><strong>Select a document</strong><span>Lifecycle and normalized content will appear here.</span></div>
          ) : (
            <>
              <div className="document-detail-title"><div><p className="section-kicker">Document record</p><h2>{active.fileName}</h2></div><span className={`document-status ${statusTone(active.status)}`}>{formatStatus(active.status)}</span></div>
              <dl className="document-facts"><div><dt>Classification</dt><dd>{active.classification.toLowerCase()}</dd></div><div><dt>Pages</dt><dd>{active.pageCount ?? "—"}</dd></div><div><dt>Size</dt><dd>{formatBytes(active.sizeBytes)}</dd></div><div><dt>Retain until</dt><dd>{new Date(active.retentionUntil).toLocaleDateString()}</dd></div></dl>

              {processingStatuses.has(active.status) && <div className="document-progress"><span/><div><strong>Processing generation {active.processingGeneration}</strong><small>Conversion and OCR run asynchronously through pg-boss.</small></div></div>}
              {(active.status === "FAILED" || active.status === "REJECTED") && <div className="document-failure"><strong>{active.failureCode ?? "PROCESSING_FAILED"}</strong><span>{active.failureMessage ?? "Document processing did not complete."}</span></div>}

              {active.textPreview && <div className="document-preview"><span>Extracted text preview</span><p>{active.textPreview}</p></div>}

              <div className="document-artifacts"><div><strong>Managed artifacts</strong><span>{active.artifacts.length} stored</span></div>{active.artifacts.map((artifact) => <a key={artifact.id} href={`/api/v1/documents/${active.id}/artifacts/${artifact.id}/download`}><span>{artifact.kind.replaceAll("_", " ").toLowerCase()}{artifact.pageNumber ? ` · page ${artifact.pageNumber}` : ""}</span><small>{formatBytes(artifact.sizeBytes)}</small></a>)}</div>

              {(props.administrator || ["QUARANTINED", "READY", "FAILED", "REJECTED"].includes(active.status)) && (
                <div className="document-actions">
                  {props.administrator && (active.status === "QUARANTINED" || (["READY", "FAILED", "REJECTED"].includes(active.status) && new Date(active.retentionUntil) > new Date())) && <label>Review or override reason<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} maxLength={1000} rows={2} placeholder="Record the operational reason"/></label>}
                  {props.administrator && active.status === "QUARANTINED" && <div><button className="primary-button" type="button" disabled={busy || reviewReason.trim().length < 3} onClick={() => void review("APPROVE")}>Approve processing</button><button className="danger-button" type="button" disabled={busy || reviewReason.trim().length < 3} onClick={() => void review("REJECT")}>Reject</button></div>}
                  {(active.status === "FAILED" || active.status === "READY") && <button type="button" disabled={busy} onClick={() => void reprocess()}>Reprocess</button>}
                  {["QUARANTINED", "READY", "FAILED", "REJECTED"].includes(active.status) && <button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>Delete document</button>}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function extLabel(fileName: string): string {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension.slice(0, 4).toUpperCase() : "DOC";
}

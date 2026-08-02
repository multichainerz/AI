import type { MemoryMetrics, MemoryPublication } from "@orcasynapse/contracts";
import { useEffect, useRef, useState } from "react";
import { OrcaSynapseApiError, getMemoryMetrics, getMemoryPublications, reindexMemoryDocument } from "./api.js";

interface MemoryViewProps {
  unlocked: boolean;
  onConfigure: () => void;
  onUnauthorized: () => void;
}

const activeStatuses = new Set(["QUEUED", "PROCESSING", "DELETE_PENDING"]);

function tone(status: MemoryPublication["status"]): string {
  if (status === "READY") return "ready";
  if (status === "FAILED") return "failed";
  if (activeStatuses.has(status)) return "processing";
  return "neutral";
}

export function MemoryView({ unlocked, onConfigure, onUnauthorized }: MemoryViewProps) {
  const publicationsRef = useRef<MemoryPublication[]>([]);
  const [publications, setPublications] = useState<MemoryPublication[]>([]);
  const [metrics, setMetrics] = useState<MemoryMetrics | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [list, nextMetrics] = await Promise.all([getMemoryPublications(), getMemoryMetrics()]);
    publicationsRef.current = list.items;
    setPublications(list.items);
    setMetrics(nextMetrics);
  };

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : "Unable to load memory operations.");
  };

  useEffect(() => {
    if (!unlocked) {
      publicationsRef.current = [];
      setPublications([]);
      setMetrics(null);
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => {
      if (active && publicationsRef.current.some(({ status }) => activeStatuses.has(status))) {
        void load().catch(() => undefined);
      }
    }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked]);

  const reindex = async (documentId: string) => {
    if (busyId) return;
    setBusyId(documentId);
    setError(null);
    try {
      await reindexMemoryDocument(documentId);
      await load();
    } catch (cause) { fail(cause); }
    finally { setBusyId(null); }
  };

  if (!unlocked) {
    return (
      <section className="operations-lock panel">
        <div className="lock-mark">SM</div>
        <div><h2>Memory operations are administrator-only</h2><p>Unlock the control plane to inspect Supermemory publication, failures, and deletion synchronization.</p></div>
        <button className="primary-button" type="button" onClick={onConfigure}>Administrator setup</button>
      </section>
    );
  }

  return (
    <section className="memory-workspace">
      <header className="documents-header">
        <div><p className="page-kicker">Semantic operations</p><h1>Knowledge memory</h1><p>Supermemory is the sole semantic index. PostgreSQL tracks publication state, access provenance, and recovery.</p></div>
        <button className="secondary-button" type="button" onClick={() => void load()}>Refresh</button>
      </header>
      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="document-metrics" aria-label="Memory synchronization summary">
        <article><span>Publications</span><strong>{metrics?.total ?? publications.length}</strong></article>
        <article><span>Ready</span><strong>{metrics?.ready ?? 0}</strong></article>
        <article><span>Synchronizing</span><strong>{(metrics?.queued ?? 0) + (metrics?.processing ?? 0)}</strong></article>
        <article><span>Failed</span><strong>{metrics?.failed ?? 0}</strong></article>
      </div>
      <section className="memory-publications panel">
        <div className="document-section-heading"><div><p className="section-kicker">Private knowledge scopes</p><h2>Document publications</h2></div><span>{publications.length} records</span></div>
        {publications.length === 0 && <div className="document-empty"><strong>No publications yet</strong><span>Approved ready documents are queued automatically after normalization.</span></div>}
        <div className="memory-list">{publications.map((publication) => (
          <article key={publication.documentId}>
            <span className="document-type">SM</span>
            <div><strong>{publication.fileName}</strong><small>Generation {publication.generation} &middot; {publication.classification.toLowerCase()}</small>{publication.failureMessage && <p>{publication.failureMessage}</p>}</div>
            <span className={`document-status ${tone(publication.status)}`}>{publication.status.replaceAll("_", " ").toLowerCase()}</span>
            {publication.retryable && <button type="button" disabled={busyId !== null} onClick={() => void reindex(publication.documentId)}>{busyId === publication.documentId ? "Queuing..." : "Retry sync"}</button>}
          </article>
        ))}</div>
      </section>
    </section>
  );
}

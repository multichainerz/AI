import type { JobOperationsSnapshot } from "@aihub/contracts";
import { useState } from "react";

interface OperationsViewProps {
  busy: boolean;
  error: string | null;
  message: string | null;
  snapshot: JobOperationsSnapshot | null;
  unlocked: boolean;
  onConfigure: () => void;
  onProbe: () => void;
  onRedrive: () => void;
  onRefresh: () => void;
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function OperationsView(props: OperationsViewProps) {
  const [confirmRedrive, setConfirmRedrive] = useState(false);
  const queues = props.snapshot?.queues ?? [];
  const workers = props.snapshot?.workers ?? [];
  const onlineWorkers = workers.filter(({ status }) => status === "ONLINE").length;
  const readyJobs = queues.reduce((total, queue) => total + queue.readyCount, 0);
  const activeJobs = queues.reduce((total, queue) => total + queue.activeCount, 0);
  const failedJobs = queues.reduce((total, queue) => total + queue.failedCount, 0);
  const deadLetters = queues.find(({ name }) => name === "aihub.dead-letter")?.readyCount ?? 0;
  const processingOnline = props.snapshot?.status === "ONLINE";
  const probeQueueConfigured =
    queues.find(({ name }) => name === "aihub.system.probe")?.configured ?? false;

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <p className="page-kicker">Job operations</p>
          <h1>Processing health</h1>
          <p>Inspect PostgreSQL-backed queues, worker liveness, and controlled recovery actions.</p>
        </div>
        <div className="topbar-actions">
          <span className={`status-chip ${processingOnline ? "online" : "offline"}`}>
            <i />{props.snapshot ? `Processing ${processingOnline ? "online" : "degraded"}` : "Operations locked"}
          </span>
          <button className="secondary-button" type="button" onClick={props.unlocked ? props.onRefresh : props.onConfigure} disabled={props.busy}>
            {props.busy ? "Refreshing…" : props.unlocked ? "Refresh" : "Unlock"}
          </button>
        </div>
      </header>

      {!props.unlocked ? (
        <section className="operations-lock panel">
          <div className="lock-mark" aria-hidden="true">M</div>
          <div><h2>Administrator access required</h2><p>Unlock an administrator session to inspect job state and run recovery actions.</p></div>
          <button className="primary-button" type="button" onClick={props.onConfigure}>Unlock operations</button>
        </section>
      ) : (
        <>
          <div className="operations-feedback" aria-live="polite">
            {props.error && <div className="operations-alert error">{props.error}</div>}
            {props.message && <div className="operations-alert success">{props.message}</div>}
            {props.snapshot?.statusReasons.map((reason) => (
              <div className="operations-alert warning" key={reason}>{reason}</div>
            ))}
          </div>

          <section className="metrics operations-metrics" aria-label="Job operations summary">
            <article><span>Online workers</span><strong>{onlineWorkers}</strong><small>{workers.length} recorded in this view</small></article>
            <article><span>Ready jobs</span><strong>{readyJobs}</strong><small>Runnable backlog</small></article>
            <article><span>Active jobs</span><strong>{activeJobs}</strong><small>Currently executing</small></article>
            <article><span>Failed jobs</span><strong className={failedJobs > 0 ? "text-bad" : "text-good"}>{failedJobs}</strong><small>Retained by pg-boss</small></article>
          </section>

          <section className="panel queue-panel">
            <div className="panel-heading">
              <div><p className="section-kicker">PostgreSQL queues</p><h2>Queue health</h2><p>{props.snapshot ? `Snapshot captured ${relativeTime(props.snapshot.capturedAt)}` : "Waiting for the first snapshot."}</p></div>
              <button className="text-button" type="button" onClick={props.onProbe} disabled={props.busy || !probeQueueConfigured}>Run system probe</button>
            </div>
            {props.snapshot ? (
              <div className="queue-table-wrap">
                <table className="queue-table">
                  <thead><tr><th scope="col">Queue</th><th scope="col">Ready</th><th scope="col">Deferred</th><th scope="col">Active</th><th scope="col">Failed</th><th scope="col">Total</th></tr></thead>
                  <tbody>
                    {queues.map((queue) => (
                      <tr key={queue.name}>
                        <th scope="row"><strong>{queue.displayName}</strong><span>{queue.configured ? queue.name : `${queue.name} · not configured`}</span></th>
                        <td data-label="Ready">{queue.readyCount}</td>
                        <td data-label="Deferred">{queue.deferredCount}</td>
                        <td data-label="Active">{queue.activeCount}</td>
                        <td data-label="Failed" className={queue.failedCount > 0 ? "cell-bad" : ""}>{queue.failedCount}</td>
                        <td data-label="Total">{queue.totalCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="empty-state">{props.busy ? "Loading queue state…" : "Queue state is unavailable."}</p>}
          </section>

          <div className="operations-grid">
            <section className="panel workers-panel">
              <div className="panel-heading"><div><p className="section-kicker">Execution nodes</p><h2>Workers</h2><p>A worker is stale after 45 seconds without a heartbeat.</p></div></div>
              <div className="worker-list">
                {workers.map((worker) => (
                  <article key={worker.id}>
                    <span className={`worker-dot ${worker.status.toLowerCase()}`} />
                    <div><strong>{worker.name}</strong><small>{worker.queues.length} queue{worker.queues.length === 1 ? "" : "s"} · version {worker.version}</small></div>
                    <div className="worker-state"><strong>{worker.status.toLowerCase()}</strong><span>{relativeTime(worker.lastSeenAt)}</span></div>
                  </article>
                ))}
                {workers.length === 0 && <p className="empty-state">No worker heartbeat has been recorded.</p>}
              </div>
            </section>

            <section className="panel recovery-panel">
              <div className="panel-heading"><div><p className="section-kicker">Controlled recovery</p><h2>Dead-letter queue</h2><p>Return retained jobs to their original queues after the cause has been resolved.</p></div></div>
              <div className="recovery-count"><strong>{deadLetters}</strong><span>job{deadLetters === 1 ? "" : "s"} ready to redrive</span></div>
              {confirmRedrive ? (
                <div className="recovery-confirmation" role="alert">
                  <p>Confirm that the underlying failure is resolved before returning up to 100 retained jobs.</p>
                  <div>
                    <button type="button" onClick={() => setConfirmRedrive(false)}>Cancel</button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={props.busy}
                      onClick={() => {
                        setConfirmRedrive(false);
                        props.onRedrive();
                      }}
                    >Confirm redrive</button>
                  </div>
                </div>
              ) : (
                <button className="secondary-button" type="button" onClick={() => setConfirmRedrive(true)} disabled={props.busy || deadLetters === 0}>Redrive up to 100</button>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

import {
  EVALUATION_CATEGORIES,
  type AdminScope,
  type AiOpsOverview,
  type EvaluationCategory,
  type EvaluationRun,
  type OperationalIncident,
  type ProductionReadiness,
  type ProductionReadinessControl,
  type ProductionReadinessControlStatus,
} from "@orcasynapse/contracts";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  completeEvaluationRun,
  createEvaluationRun,
  createOperationalIncident,
  decideOperationalIncident,
  getAiOpsOverview,
  getEvaluationRuns,
  getOperationalIncidents,
  getProductionReadiness,
  promoteEvaluationRun,
  recordProductionReadinessApproval,
  updateProductionReadinessControl,
} from "./api.js";

interface OperationsViewProps {
  unlocked: boolean;
  scopes: readonly AdminScope[];
  onConfigure: () => void;
  onUnauthorized: () => void;
}

type OperationsTab = "control" | "incidents" | "evaluations" | "readiness";
type IncidentAction = { id: string; action: "acknowledge" | "resolve" } | null;
type EvidenceDraft = Partial<Record<EvaluationCategory, {
  totalCases: string;
  passedCases: string;
  criticalFailures: string;
  evidenceRef: string;
}>>;

const numberFormatter = new Intl.NumberFormat();

function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function percentage(value: number | null): string {
  return value === null ? "--" : `${Math.round(value * 1000) / 10}%`;
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  if (value < 1_073_741_824) return `${Math.round(value / 1_048_576)} MB`;
  return `${Math.round(value / 1_073_741_824 * 10) / 10} GB`;
}

function humanLabel(value: string): string {
  const special: Partial<Record<string, string>> = { MCP: "MCP", OIDC: "OIDC", SIEM: "SIEM", TOOL_USE: "Tool use", MODEL_ACCESS: "Model access", DATA_EGRESS: "Data egress" };
  return special[value] ?? value.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function incidentSort(items: OperationalIncident[]): OperationalIncident[] {
  return [...items].sort((left, right) => {
    const statusWeight = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 } as const;
    if (left.status !== right.status) return statusWeight[left.status] - statusWeight[right.status];
    if (left.severity !== right.severity) return left.severity === "CRITICAL" ? -1 : 1;
    return right.detectedAt.localeCompare(left.detectedAt);
  });
}

export function OperationsView({ unlocked, scopes, onConfigure, onUnauthorized }: OperationsViewProps) {
  const [tab, setTab] = useState<OperationsTab>("control");
  const [overview, setOverview] = useState<AiOpsOverview | null>(null);
  const [incidents, setIncidents] = useState<OperationalIncident[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationRun[]>([]);
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [incidentAction, setIncidentAction] = useState<IncidentAction>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [showIncidentForm, setShowIncidentForm] = useState(false);
  const [showEvaluationForm, setShowEvaluationForm] = useState(false);
  const [evidenceRunId, setEvidenceRunId] = useState<string | null>(null);
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft>({});
  const [confirmPromotionId, setConfirmPromotionId] = useState<string | null>(null);
  const [promotionReason, setPromotionReason] = useState("");
  const [readinessControlKey, setReadinessControlKey] = useState<string | null>(null);
  const [showApprovalForm, setShowApprovalForm] = useState(false);

  const canOperate = scopes.includes("operations:execute");
  const canReadEvaluations = scopes.includes("evaluations:read");
  const canManageEvaluations = scopes.includes("evaluations:manage");
  const canPromoteEvaluations = scopes.includes("evaluations:promote");
  const canReadReadiness = scopes.includes("readiness:read");
  const canManageReadiness = scopes.includes("readiness:manage");
  const canApproveReadiness = scopes.includes("readiness:approve");

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : fallback);
  }, [onUnauthorized]);

  const refresh = useCallback(async () => {
    if (!unlocked) return;
    setBusy(true);
    setError(null);
    try {
      const [nextOverview, nextIncidents, nextEvaluations, nextReadiness] = await Promise.all([
        getAiOpsOverview(),
        getOperationalIncidents(),
        canReadEvaluations ? getEvaluationRuns() : Promise.resolve({ items: [] }),
        canReadReadiness ? getProductionReadiness() : Promise.resolve(null),
      ]);
      setOverview(nextOverview);
      setIncidents(incidentSort(nextIncidents.items));
      setEvaluations(nextEvaluations.items);
      setReadiness(nextReadiness);
    } catch (cause) {
      handleError(cause, "AI operations state could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [canReadEvaluations, canReadReadiness, handleError, unlocked]);

  useEffect(() => { void refresh(); }, [refresh]);

  const workloads = overview?.runtime?.workloads ?? [];
  const executors = overview?.runtime?.executors ?? [];
  const pendingWork = workloads.reduce((total, workload) => total + workload.pendingCount, 0);
  const failedWork = workloads.reduce((total, workload) => total + workload.failedCount, 0);
  const readinessControlsAccepted = readiness !== null && readiness.controls.length > 0
    && readiness.controls.every(({ status }) => status === "VERIFIED" || status === "WAIVED");
  const sortedComponents = useMemo(() => [...(overview?.components ?? [])].sort((left, right) => {
    const weight = { UNAVAILABLE: 0, DEGRADED: 1, NOT_VERIFIED: 2, NOT_CONFIGURED: 3, HEALTHY: 4 } as const;
    return weight[left.status] - weight[right.status] || left.label.localeCompare(right.label);
  }), [overview]);

  const decideIncident = async (event: FormEvent) => {
    event.preventDefault();
    if (!incidentAction) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await decideOperationalIncident(incidentAction.id, incidentAction.action, { note: decisionNote });
      setMessage(`Incident ${incidentAction.action === "resolve" ? "resolved" : "acknowledged"}.`);
      setIncidentAction(null); setDecisionNote("");
      await refresh();
    } catch (cause) { handleError(cause, "The incident decision could not be recorded."); }
    finally { setBusy(false); }
  };

  const createIncident = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      await createOperationalIncident({
        title: String(data.get("title") ?? ""),
        severity: data.get("severity") === "CRITICAL" ? "CRITICAL" : "WARNING",
        component: String(data.get("component") ?? ""),
        summary: String(data.get("summary") ?? ""),
        owner: String(data.get("owner") ?? "").trim() || null,
      });
      setShowIncidentForm(false); setMessage("Operational incident created.");
      await refresh();
    } catch (cause) { handleError(cause, "The incident could not be created."); }
    finally { setBusy(false); }
  };

  const createEvaluation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      await createEvaluationRun({
        name: String(data.get("name") ?? ""),
        targetType: String(data.get("targetType") ?? "MODEL") as "MODEL" | "PROMPT" | "POLICY" | "AGENT",
        targetReference: String(data.get("targetReference") ?? ""),
        targetVersion: String(data.get("targetVersion") ?? ""),
        minimumPassRate: Number(data.get("minimumPassRate") ?? 95) / 100,
        requiredCategories: [...EVALUATION_CATEGORIES],
      });
      setShowEvaluationForm(false); setMessage("Evaluation candidate created with all six evidence categories.");
      await refresh();
    } catch (cause) { handleError(cause, "The evaluation candidate could not be created."); }
    finally { setBusy(false); }
  };

  const openEvidence = (run: EvaluationRun) => {
    setEvidenceRunId(run.id);
    setEvidenceDraft(Object.fromEntries(run.requiredCategories.map((category) => [category, {
      totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "",
    }])) as EvidenceDraft);
  };

  const recordEvidence = async (event: FormEvent) => {
    event.preventDefault();
    const run = evaluations.find(({ id }) => id === evidenceRunId);
    if (!run) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await completeEvaluationRun(run.id, { results: run.requiredCategories.map((category) => {
        const value = evidenceDraft[category];
        return {
          category,
          totalCases: Number(value?.totalCases ?? 0),
          passedCases: Number(value?.passedCases ?? 0),
          criticalFailures: Number(value?.criticalFailures ?? 0),
          evidenceRefs: [value?.evidenceRef.trim() ?? ""],
        };
      }) });
      setEvidenceRunId(null); setMessage("Immutable evaluation evidence recorded.");
      await refresh();
    } catch (cause) { handleError(cause, "Evaluation evidence could not be recorded."); }
    finally { setBusy(false); }
  };

  const promote = async (event: FormEvent, id: string) => {
    event.preventDefault();
    setBusy(true); setError(null); setMessage(null);
    try {
      await promoteEvaluationRun(id, promotionReason);
      setConfirmPromotionId(null); setPromotionReason(""); setMessage("Evaluation candidate promoted with retained evidence and decision rationale.");
      await refresh();
    } catch (cause) { handleError(cause, "The evaluation candidate could not be promoted."); }
    finally { setBusy(false); }
  };

  const updateReadiness = async (event: FormEvent<HTMLFormElement>, control: ProductionReadinessControl) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const status = String(data.get("status") ?? "NOT_STARTED") as ProductionReadinessControlStatus;
    const evidenceRefs = String(data.get("evidenceRefs") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    setBusy(true); setError(null); setMessage(null);
    try {
      await updateProductionReadinessControl(control.key, {
        status,
        owner: String(data.get("owner") ?? "").trim() || null,
        evidenceRefs,
        note: String(data.get("note") ?? "").trim() || null,
        expectedRevision: control.revision,
      });
      setReadinessControlKey(null); setMessage("Pilot-readiness control and evidence updated.");
      await refresh();
    } catch (cause) { handleError(cause, "The readiness control could not be updated."); }
    finally { setBusy(false); }
  };

  const submitReadinessApproval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      await recordProductionReadinessApproval({
        role: String(data.get("role") ?? "SECURITY") as "SECURITY" | "INFRASTRUCTURE" | "PRODUCT" | "BUSINESS",
        decision: data.get("decision") === "REJECTED" ? "REJECTED" : "APPROVED",
        authority: String(data.get("authority") ?? ""),
        evidenceRef: String(data.get("evidenceRef") ?? ""),
        reason: String(data.get("reason") ?? ""),
      });
      setShowApprovalForm(false); setMessage("External authority decision appended to the readiness ledger.");
      await refresh();
    } catch (cause) { handleError(cause, "The external approval could not be recorded."); }
    finally { setBusy(false); }
  };

  if (!unlocked) {
    return (
      <>
        <header className="topbar"><div className="page-heading"><p className="page-kicker">AI operations</p><h1>Operational control room</h1><p>One view for service health, workflows, guardrails, incidents, and release evidence.</p></div></header>
        <section className="operations-lock panel">
          <div className="lock-mark" aria-hidden="true">M</div>
          <div><h2>Administrator access required</h2><p>Unlock the control plane to inspect protected operational telemetry and recovery controls.</p></div>
          <button className="primary-button" type="button" onClick={onConfigure}>Unlock operations</button>
        </section>
      </>
    );
  }

  const metrics = overview?.metrics;
  return (
    <>
      <header className="topbar aiops-topbar">
        <div className="page-heading">
          <p className="page-kicker">AI operations</p>
          <h1>Operational control room</h1>
          <p>Trace service degradation to affected AI workflows and gate releases on retained evaluation evidence.</p>
        </div>
        <div className="topbar-actions">
          <span className={`status-chip ${overview?.status === "HEALTHY" ? "online" : "offline"}`}><i />{overview ? humanLabel(overview.status) : "Loading"}</span>
          <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing..." : "Refresh"}</button>
        </div>
      </header>

      <div className="operations-feedback" aria-live="polite">
        {error && <div className="operations-alert error">{error}</div>}
        {message && <div className="operations-alert success">{message}</div>}
      </div>

      <nav className="aiops-tabs" aria-label="AI operations views">
        <button className={tab === "control" ? "active" : ""} type="button" onClick={() => setTab("control")}>Control room</button>
        <button className={tab === "incidents" ? "active" : ""} type="button" onClick={() => setTab("incidents")}>Incidents <span>{overview?.incidents.open ?? 0}</span></button>
        <button className={tab === "evaluations" ? "active" : ""} type="button" onClick={() => setTab("evaluations")} disabled={!canReadEvaluations}>Release gates</button>
        <button className={tab === "readiness" ? "active" : ""} type="button" onClick={() => setTab("readiness")} disabled={!canReadReadiness}>Pilot readiness <span>{readiness?.summary.blockedControls ?? 0}</span></button>
      </nav>

      {tab === "control" && <>
        <section className="metrics aiops-metrics" aria-label="AI operations summary">
          <article><span>Services needing attention</span><strong>{overview?.components.filter(({ status }) => status !== "HEALTHY").length ?? "--"}</strong><small>{overview?.components.length ?? 0} observed components</small></article>
          <article><span>Open incidents</span><strong className={overview?.incidents.critical ? "text-bad" : undefined}>{overview?.incidents.open ?? "--"}</strong><small>{overview?.incidents.critical ?? 0} critical</small></article>
          <article><span>Hermes runs pending</span><strong>{numberFormatter.format(pendingWork)}</strong><small>{failedWork} retained agent-run failures</small></article>
          <article><span>Release evidence</span><strong>{overview?.evaluations.passed ?? "--"}</strong><small>{overview?.evaluations.drafts ?? 0} draft / {overview?.evaluations.promoted ?? 0} promoted</small></article>
        </section>

        <div className="aiops-primary-grid">
          <section className="panel component-panel">
            <div className="panel-heading"><div><p className="section-kicker">Infrastructure</p><h2>Service topology</h2><p>Live state is distinguished from dashboard configuration and last-verified connection tests.</p></div><span className="snapshot-time">Snapshot {relativeTime(overview?.generatedAt ?? null)}</span></div>
            <div className="component-grid">
              {sortedComponents.map((component) => (
                <article className={`component-card ${component.status.toLowerCase()}`} key={component.id}>
                  <div><span className="component-indicator" /><strong>{component.label}</strong><small>{humanLabel(component.status)}</small></div>
                  <p>{component.summary}</p>
                  <footer><span>{component.source === "LAST_VERIFIED" ? `Verified ${relativeTime(component.observedAt)}` : humanLabel(component.source)}</span><span>{component.affectedWorkflows.length ? component.affectedWorkflows.map(humanLabel).join(" / ") : "Platform support"}</span></footer>
                </article>
              ))}
              {!overview && <p className="empty-state">Loading component state...</p>}
            </div>
          </section>

          <aside className="panel incident-rail">
            <div className="panel-heading"><div><p className="section-kicker">Active response</p><h2>Incident queue</h2><p>Automated degradation and operator-raised context.</p></div><button className="text-button" type="button" onClick={() => setTab("incidents")}>View all</button></div>
            <div className="incident-compact-list">
              {(overview?.incidents.items ?? []).slice(0, 5).map((item) => <article key={item.id}>
                <span className={`severity-dot ${item.severity.toLowerCase()}`} />
                <div><strong>{item.title}</strong><small>{humanLabel(item.status)} / {relativeTime(item.lastObservedAt)}</small></div>
              </article>)}
              {overview?.incidents.items.length === 0 && <p className="empty-state">No active incidents.</p>}
            </div>
          </aside>
        </div>

        <section className="panel guardrail-panel">
          <div className="panel-heading"><div><p className="section-kicker">Layered policy</p><h2>Guardrail posture</h2><p>Application controls are reported separately from target-environment evidence.</p></div></div>
          <div className="guardrail-grid">{overview?.guardrails.map((control) => <article key={control.layer}>
            <header><span>{humanLabel(control.layer)}</span><strong className={control.status.toLowerCase()}>{humanLabel(control.status)}</strong></header>
            <h3>{control.label}</h3><p>{control.summary}</p><small>{control.evidence}</small>
          </article>)}</div>
        </section>

        <section className="panel workload-panel">
          <div className="panel-heading"><div><p className="section-kicker">Workflows</p><h2>24-hour and retained workload signals</h2><p>Counts retain their domain meaning; all-time values are not presented as live error rates.</p></div></div>
          <div className="workload-grid">
            <article><span>Chat responses / 24h</span><strong>{metrics?.chat?.responses ?? "--"}</strong><small>{percentage(metrics?.chat?.failureRate ?? null)} failed / {metrics?.chat?.averageLatencyMs ?? "--"} ms average</small></article>
            <article><span>Knowledge indexing</span><strong>{metrics?.documents?.processing ?? "--"}</strong><small>{metrics?.documents?.ready ?? 0} ready / {metrics?.documents?.failed ?? 0} need attention</small></article>
            <article><span>Hermes runs</span><strong>{metrics?.agents?.runningRuns ?? "--"}</strong><small>{metrics?.agents?.queuedRuns ?? 0} queued / {metrics?.agents?.failedRuns ?? 0} retained failures</small></article>
            <article><span>Governed tools</span><strong>{metrics?.tools?.executingCalls ?? "--"}</strong><small>{metrics?.tools?.pendingApprovals ?? 0} pending review / {metrics?.tools?.deniedCalls ?? 0} denied</small></article>
            <article><span>Source bytes retained</span><strong>{metrics?.documents ? bytes(metrics.documents.retainedSourceBytes) : "--"}</strong><small>Knowledge is kept as extracted chunks and embeddings, never originals</small></article>
          </div>
        </section>

        <section className="panel queue-panel">
          <div className="panel-heading"><div><p className="section-kicker">PostgreSQL coordination</p><h2>Durable runtime state</h2><p>{overview?.runtime ? `Captured ${relativeTime(overview.runtime.capturedAt)} from domain state` : "Runtime state is unavailable."}</p></div><button className="text-button" type="button" onClick={() => void refresh()} disabled={busy}>Refresh state</button></div>
          <div className="queue-table-wrap"><table className="queue-table"><thead><tr><th scope="col">Workload</th><th scope="col">Pending</th><th scope="col">Active</th><th scope="col">Failed</th><th scope="col">Retained</th></tr></thead><tbody>{workloads.map((workload) => <tr key={workload.name}>
            <th scope="row"><strong>{workload.displayName}</strong><span>{workload.name}</span></th>
            <td data-label="Pending">{workload.pendingCount}</td><td data-label="Active">{workload.activeCount}</td><td data-label="Failed" className={workload.failedCount ? "cell-bad" : ""}>{workload.failedCount}</td><td data-label="Retained">{workload.totalCount}</td>
          </tr>)}</tbody></table></div>
          <div className="queue-footer">
            <div className="worker-list">{executors.map((executor) => <article key={executor.id}><span className={`worker-dot ${executor.status.toLowerCase()}`} /><div><strong>{executor.name}</strong><small>{executor.workloads.length} workloads / version {executor.version}</small></div><div className="worker-state"><strong>{humanLabel(executor.status)}</strong><span>{relativeTime(executor.lastSeenAt)}</span></div></article>)}{executors.length === 0 && <p className="empty-state">No runtime executor heartbeat has been recorded.</p>}</div>
          </div>
        </section>
      </>}

      {tab === "incidents" && <section className="aiops-section">
        <div className="section-toolbar"><div><h2>Operational incidents</h2><p>Automatic observations and manual context share one durable response ledger.</p></div>{canOperate && <button className="secondary-button" type="button" onClick={() => setShowIncidentForm((shown) => !shown)}>{showIncidentForm ? "Cancel" : "Create incident"}</button>}</div>
        {showIncidentForm && <form className="panel aiops-form" onSubmit={(event) => void createIncident(event)}>
          <label><span>Title</span><input name="title" minLength={3} maxLength={160} required /></label>
          <label><span>Severity</span><select name="severity"><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option></select></label>
          <label><span>Component</span><input name="component" minLength={1} maxLength={80} placeholder="e.g. hermes-vm2" required /></label>
          <label><span>Owner</span><input name="owner" maxLength={160} placeholder="Optional team or operator" /></label>
          <label className="wide"><span>Summary</span><textarea name="summary" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="wide form-actions"><button className="primary-button" type="submit" disabled={busy}>Create incident</button></div>
        </form>}
        <div className="incident-list">{incidents.map((item) => <article className={`panel incident-card ${item.status.toLowerCase()}`} key={item.id}>
          <header><span className={`incident-severity ${item.severity.toLowerCase()}`}>{humanLabel(item.severity)}</span><span>{item.automated ? "Automatic observation" : "Operator raised"}</span><time>{relativeTime(item.detectedAt)}</time></header>
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <dl><div><dt>Status</dt><dd>{humanLabel(item.status)}</dd></div><div><dt>Component</dt><dd>{item.component}</dd></div><div><dt>Owner</dt><dd>{item.owner ?? "Unassigned"}</dd></div><div><dt>Last observed</dt><dd>{relativeTime(item.lastObservedAt)}</dd></div></dl>
          {item.resolutionNote && <blockquote>{item.resolutionNote}</blockquote>}
          {canOperate && item.status !== "RESOLVED" && <div className="incident-actions"><button type="button" onClick={() => { setIncidentAction({ id: item.id, action: "acknowledge" }); setDecisionNote(""); }} disabled={item.status !== "OPEN"}>Acknowledge</button><button type="button" onClick={() => { setIncidentAction({ id: item.id, action: "resolve" }); setDecisionNote(""); }}>Resolve</button></div>}
          {incidentAction?.id === item.id && <form className="incident-decision" onSubmit={(event) => void decideIncident(event)}><label><span>Operator note</span><textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} minLength={3} maxLength={1000} rows={2} required /></label><div><button type="button" onClick={() => setIncidentAction(null)}>Cancel</button><button className="secondary-button" type="submit" disabled={busy}>Record {incidentAction.action}</button></div></form>}
        </article>)}{incidents.length === 0 && <p className="empty-state">No operational incidents have been recorded.</p>}</div>
      </section>}

      {tab === "evaluations" && <section className="aiops-section">
        <div className="section-toolbar"><div><h2>Release evidence</h2><p>Evidence is immutable after completion. Promotion is a separate, permissioned decision.</p></div>{canManageEvaluations && <button className="secondary-button" type="button" onClick={() => setShowEvaluationForm((shown) => !shown)}>{showEvaluationForm ? "Cancel" : "New candidate"}</button>}</div>
        {showEvaluationForm && <form className="panel aiops-form evaluation-create" onSubmit={(event) => void createEvaluation(event)}>
          <label><span>Candidate name</span><input name="name" minLength={3} maxLength={160} required /></label>
          <label><span>Target type</span><select name="targetType"><option>MODEL</option><option>PROMPT</option><option>POLICY</option><option>AGENT</option></select></label>
          <label><span>Target reference</span><input name="targetReference" placeholder="laguna-s / hermes-policy" maxLength={240} required /></label>
          <label><span>Version</span><input name="targetVersion" placeholder="Immutable version or digest" maxLength={120} required /></label>
          <label><span>Minimum pass rate</span><input name="minimumPassRate" type="number" min={50} max={100} step={0.1} defaultValue={95} required /></label>
          <div className="evaluation-categories"><span>Required evidence</span><p>{EVALUATION_CATEGORIES.map(humanLabel).join(" / ")}</p></div>
          <div className="wide form-actions"><button className="primary-button" type="submit" disabled={busy}>Create candidate</button></div>
        </form>}
        <div className="evaluation-list">{evaluations.map((run) => <article className="panel evaluation-card" key={run.id}>
          <header><div><span>{humanLabel(run.targetType)}</span><h3>{run.name}</h3></div><strong className={run.status.toLowerCase()}>{humanLabel(run.status)}</strong></header>
          <p className="evaluation-target">{run.targetReference}<span>/ {run.targetVersion}</span></p>
          <div className="evaluation-score"><div><strong>{percentage(run.passRate)}</strong><span>observed pass rate</span></div><div><strong>{run.passedCases}/{run.totalCases}</strong><span>cases passed</span></div><div><strong>{run.criticalFailures}</strong><span>critical failures</span></div><div><strong>{percentage(run.minimumPassRate)}</strong><span>required minimum</span></div></div>
          <div className="evaluation-tags">{run.requiredCategories.map((category) => <span key={category}>{humanLabel(category)}</span>)}</div>
          {run.promotionReason && <blockquote className="promotion-reason"><strong>Promotion rationale</strong><span>{run.promotionReason}</span></blockquote>}
          <footer><span>Created {relativeTime(run.createdAt)}{run.promotedAt ? ` / promoted ${relativeTime(run.promotedAt)}` : ""}</span><div>{run.status === "DRAFT" && canManageEvaluations && <button type="button" onClick={() => openEvidence(run)}>Record evidence</button>}{run.status === "PASSED" && canPromoteEvaluations && <button type="button" onClick={() => { setConfirmPromotionId(run.id); setPromotionReason(""); }}>Promote</button>}</div></footer>
          {confirmPromotionId === run.id && <form className="promotion-confirm" onSubmit={(event) => void promote(event, run.id)}><label><span>Promotion rationale</span><textarea value={promotionReason} onChange={(event) => setPromotionReason(event.target.value)} minLength={3} maxLength={1000} rows={2} placeholder="Why this exact evidence is approved for release" required /></label><div><button type="button" onClick={() => { setConfirmPromotionId(null); setPromotionReason(""); }}>Cancel</button><button className="secondary-button" type="submit" disabled={busy}>Confirm promotion</button></div></form>}
          {evidenceRunId === run.id && <form className="evidence-form" onSubmit={(event) => void recordEvidence(event)}><div className="evidence-heading"><div><strong>Record immutable results</strong><span>Every required category needs an evidence artifact reference.</span></div><button type="button" onClick={() => setEvidenceRunId(null)}>Close</button></div>{run.requiredCategories.map((category) => {
            const draft = evidenceDraft[category];
            const update = (field: "totalCases" | "passedCases" | "criticalFailures" | "evidenceRef", value: string) => setEvidenceDraft((current) => ({ ...current, [category]: { totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "", ...current[category], [field]: value } }));
            return <fieldset key={category}><legend>{humanLabel(category)}</legend><label><span>Total</span><input type="number" min={1} value={draft?.totalCases ?? ""} onChange={(event) => update("totalCases", event.target.value)} required /></label><label><span>Passed</span><input type="number" min={0} value={draft?.passedCases ?? ""} onChange={(event) => update("passedCases", event.target.value)} required /></label><label><span>Critical</span><input type="number" min={0} value={draft?.criticalFailures ?? "0"} onChange={(event) => update("criticalFailures", event.target.value)} required /></label><label className="evidence-ref"><span>Evidence reference</span><input value={draft?.evidenceRef ?? ""} onChange={(event) => update("evidenceRef", event.target.value)} placeholder="Report ID or immutable URI" required /></label></fieldset>;
          })}<div className="form-actions"><button className="primary-button" type="submit" disabled={busy}>Complete evaluation</button></div></form>}
        </article>)}{evaluations.length === 0 && <p className="empty-state">No evaluation candidates have been created.</p>}</div>
      </section>}

      {tab === "readiness" && <section className="aiops-section readiness-section">
        <div className="section-toolbar"><div><h2>Production pilot readiness</h2><p>Evidence-backed controls and externally issued OrcaSynapse decisions. OrcaSynapse records approvals; it does not grant them.</p></div>{canApproveReadiness && <button className="secondary-button" type="button" onClick={() => setShowApprovalForm((shown) => !shown)}>{showApprovalForm ? "Cancel" : "Record sign-off"}</button>}</div>
        <section className={`panel readiness-hero ${readiness?.status.toLowerCase() ?? "not_ready"}`}>
          <div><p className="section-kicker">Derived gate</p><h3>{readiness ? humanLabel(readiness.status) : "Loading"}</h3><p>Ready requires every control to be verified or formally waived and the latest Security, Infrastructure, Product, and Business decisions to be approved.</p></div>
          <dl><div><dt>Controls accepted</dt><dd>{readiness ? readiness.summary.verifiedControls + readiness.summary.waivedControls : "--"}<span> / {readiness?.summary.totalControls ?? 0}</span></dd></div><div><dt>External approvals</dt><dd>{readiness?.summary.approvedRoles ?? "--"}<span> / {readiness?.summary.requiredApprovals ?? 4}</span></dd></div><div><dt>Blocked controls</dt><dd>{readiness?.summary.blockedControls ?? "--"}</dd></div></dl>
        </section>

        {showApprovalForm && <form className="panel aiops-form readiness-approval-form" onSubmit={(event) => void submitReadinessApproval(event)}>
          <div className="readiness-form-note wide"><strong>External decision record</strong><span>The authority is the OrcaSynapse body that made the decision. Your signed-in OrcaSynapse identity is retained separately as the recorder. {readinessControlsAccepted ? "All controls are accepted for an approval snapshot." : "Approval remains disabled until every control is verified or waived; rejection can still be recorded."}</span></div>
          <label><span>Approval role</span><select name="role"><option>SECURITY</option><option>INFRASTRUCTURE</option><option>PRODUCT</option><option>BUSINESS</option></select></label>
          <label><span>Decision</span><select name="decision" defaultValue={readinessControlsAccepted ? "APPROVED" : "REJECTED"}><option value="APPROVED" disabled={!readinessControlsAccepted}>APPROVED</option><option value="REJECTED">REJECTED</option></select></label>
          <label><span>Approving authority</span><input name="authority" minLength={1} maxLength={160} placeholder="OrcaSynapse Security Review Board" required /></label>
          <label><span>Approval evidence</span><input name="evidenceRef" minLength={1} maxLength={500} placeholder="Approval ID or immutable artifact reference" required /></label>
          <label className="wide"><span>Decision rationale</span><textarea name="reason" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="wide form-actions"><button className="primary-button" type="submit" disabled={busy}>Append authority decision</button></div>
        </form>}

        <div className="readiness-layout">
          <div className="readiness-controls">{readiness?.controls.map((control) => <article className={`panel readiness-control ${control.status.toLowerCase()}`} key={control.key}>
            <header><span>{humanLabel(control.domain)}</span><strong>{humanLabel(control.status)}</strong></header>
            <div className="readiness-control-copy"><h3>{control.title}</h3><p>{control.description}</p></div>
            <dl><div><dt>Owner</dt><dd>{control.owner ?? "Unassigned"}</dd></div><div><dt>Evidence</dt><dd>{control.evidenceRefs.length} reference{control.evidenceRefs.length === 1 ? "" : "s"}</dd></div><div><dt>Updated</dt><dd>{relativeTime(control.updatedAt)}</dd></div></dl>
            {control.note && <blockquote>{control.note}</blockquote>}
            {canManageReadiness && <button className="text-button readiness-edit" type="button" onClick={() => setReadinessControlKey((current) => current === control.key ? null : control.key)}>{readinessControlKey === control.key ? "Close" : "Update evidence"}</button>}
            {readinessControlKey === control.key && <form className="readiness-control-form" onSubmit={(event) => void updateReadiness(event, control)}>
              <label><span>Status</span><select name="status" defaultValue={control.status}><option>NOT_STARTED</option><option>IN_PROGRESS</option><option>BLOCKED</option><option>VERIFIED</option><option>WAIVED</option></select></label>
              <label><span>Owner</span><input name="owner" defaultValue={control.owner ?? ""} maxLength={160} placeholder="Required after work starts" /></label>
              <label className="wide"><span>Evidence references, one per line</span><textarea name="evidenceRefs" defaultValue={control.evidenceRefs.join("\n")} rows={3} maxLength={10020} placeholder="Immutable report, ticket, backup, or approval reference" /></label>
              <label className="wide"><span>Decision note</span><textarea name="note" defaultValue={control.note ?? ""} rows={2} minLength={3} maxLength={1000} placeholder="Required for blocked, verified, or waived status" /></label>
              <div className="wide form-actions"><button className="secondary-button" type="submit" disabled={busy}>Save control</button></div>
            </form>}
          </article>)}{readiness?.controls.length === 0 && <p className="empty-state">The production-readiness checklist has not been migrated.</p>}</div>

          <aside className="readiness-side">
            <section className="panel readiness-approvals"><div className="panel-heading"><div><p className="section-kicker">Latest authority decisions</p><h2>Formal sign-offs</h2></div></div><div>{(["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const).map((role) => {
              const approval = readiness?.approvals.find((item) => item.role === role);
              return <article key={role}><header><strong>{humanLabel(role)}</strong><span className={!approval ? "missing" : approval.isCurrent ? approval.decision.toLowerCase() : "stale"}>{approval ? `${humanLabel(approval.decision)}${approval.isCurrent ? "" : " / stale"}` : "Not recorded"}</span></header>{approval ? <><p>{approval.authority}</p><small>Recorded by {approval.recordedBy} / {relativeTime(approval.recordedAt)}</small><code>{approval.evidenceRef}</code></> : <p>No external authority decision is retained.</p>}</article>;
            })}</div></section>
            <section className="panel readiness-blockers"><div className="panel-heading"><div><p className="section-kicker">Open gate conditions</p><h2>Readiness blockers</h2></div><strong>{readiness?.blockers.length ?? 0}</strong></div><ol>{readiness?.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ol>{readiness?.blockers.length === 0 && <p className="empty-state">No derived blockers remain.</p>}</section>
          </aside>
        </div>
      </section>}
    </>
  );
}

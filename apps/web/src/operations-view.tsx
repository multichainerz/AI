import {
  type AdministratorSession,
  EVALUATION_CATEGORIES,
  type AiOpsOverview,
  type EvaluationCategory,
  type EvaluationRun,
  type OperationalIncident,
  type ProductionReadiness,
  type ProductionReadinessControl,
  type ProductionReadinessControlStatus,
} from "@orcasynapse/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, HeroBanner, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, PanelHeading, StatusText, cn, toneFor,
} from "./ui/index.js";

interface OperationsViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
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

export function OperationsView({ session, onConfigure, onSessionExpired }: OperationsViewProps) {
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

  const { unlocked, scopes } = adminAccess(session);
  const canOperate = scopes.includes("operations:execute");
  const canReadEvaluations = scopes.includes("evaluations:read");
  const canManageEvaluations = scopes.includes("evaluations:manage");
  const canPromoteEvaluations = scopes.includes("evaluations:promote");
  const canReadReadiness = scopes.includes("readiness:read");
  const canManageReadiness = scopes.includes("readiness:manage");
  const canApproveReadiness = scopes.includes("readiness:approve");

  // Held in a ref so `handleError` keeps one identity for the life of the view.
  //
  // App re-renders on its own poll and passes a fresh `onSessionExpired` arrow
  // every few seconds. Depending on that identity propagated through
  // handleError -> refresh -> the load effect, so Operations refetched all four
  // endpoints on a loop: each cycle set `busy`, which disables every submit
  // button, and cleared the error an operator was still reading.
  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => {
    latestOnSessionExpired.current = onSessionExpired;
  }, [onSessionExpired]);

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

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
      <LockedScreen
        kicker="AI operations"
        title="Operations"
        mark="OP"
        reason="Unlock the control plane to inspect protected operational telemetry and recovery controls."
        actionLabel="Open platform settings"
        onAction={onConfigure}
      />
    );
  }

  const metrics = overview?.metrics;
  return (
    <>
      <PageHeader
        kicker="AI operations"
        title="Operational control room"
        description="Trace service degradation to affected AI workflows and gate releases on retained evaluation evidence."
        actions={<>
          <StatusText dot tone={overview?.status === "HEALTHY" ? "good" : "warn"} className="h-9 items-center border border-border bg-surface px-3">
            {overview ? humanLabel(overview.status) : "Loading"}
          </StatusText>
          <Button onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing..." : "Refresh"}</Button>
        </>}
      />

      <div aria-live="polite">
        {error && <Alert className="mb-4">{error}</Alert>}
        {message && <Alert tone="good" className="mb-4">{message}</Alert>}
      </div>

      {/* The counts ride on the tab, so a blocked control or an open incident
          is visible from whichever tab you are on. */}
      <nav className="mb-5 flex flex-wrap gap-1 rounded border border-border bg-surface p-1" aria-label="AI operations views">
        {([
          { key: "control", label: "Control room", count: null, enabled: true },
          { key: "incidents", label: "Incidents", count: overview?.incidents.open ?? 0, enabled: true },
          { key: "evaluations", label: "Release gates", count: null, enabled: canReadEvaluations },
          { key: "readiness", label: "Pilot readiness", count: readiness?.summary.blockedControls ?? 0, enabled: canReadReadiness },
        ] as const).map((entry) => (
          <button
            className={cn(
              "flex items-center gap-2 rounded px-3 py-1.5 text-body transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              tab === entry.key ? "bg-raised text-text" : "text-muted hover:text-text",
            )}
            key={entry.key}
            type="button"
            aria-current={tab === entry.key ? "page" : undefined}
            disabled={!entry.enabled}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            {entry.count !== null && entry.count > 0 && (
              <span className="rounded border border-warn/50 bg-warn/10 px-1.5 font-mono text-micro text-warn">{entry.count}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "control" && <div className="grid gap-5">
        <HeroBanner
          tone="plain"
          aria-label="AI operations summary"
          highlight={{
            label: "Services needing attention",
            value: overview?.components.filter(({ status }) => status !== "HEALTHY").length ?? "--",
            caption: `${overview?.components.length ?? 0} observed components`,
          }}
          metrics={[
            {
              label: "Open incidents",
              tone: overview?.incidents.critical ? "bad" : "neutral",
              value: overview?.incidents.open ?? "--",
              caption: `${overview?.incidents.critical ?? 0} critical`,
            },
            {
              label: "Hermes runs pending",
              value: numberFormatter.format(pendingWork),
              caption: `${failedWork} retained agent-run failures`,
            },
            {
              label: "Release evidence",
              value: overview?.evaluations.passed ?? "--",
              caption: `${overview?.evaluations.drafts ?? 0} draft / ${overview?.evaluations.promoted ?? 0} promoted`,
            },
          ]}
        />

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)]">
          <Panel>
            <PanelHeading
              kicker="Infrastructure"
              title="Service topology"
              description="Live state is distinguished from dashboard configuration and last-verified connection tests."
              actions={<StatusText>Snapshot {relativeTime(overview?.generatedAt ?? null)}</StatusText>}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              {sortedComponents.map((component) => (
                <article className="grid gap-2 rounded border border-border bg-raised p-3" key={component.id}>
                  <div className="flex items-center gap-2.5">
                    <StatusText dot tone={toneFor(component.status.toLowerCase())} />
                    <strong className="min-w-0 truncate text-[12px] font-semibold text-text">{component.label}</strong>
                    <StatusText className="ml-auto shrink-0">{humanLabel(component.status)}</StatusText>
                  </div>
                  <p className="mb-0 text-caption leading-relaxed text-muted">{component.summary}</p>
                  <footer className="flex flex-wrap justify-between gap-2 font-mono text-micro text-faint">
                    <span>{component.source === "LAST_VERIFIED" ? `Verified ${relativeTime(component.observedAt)}` : humanLabel(component.source)}</span>
                    <span>{component.affectedWorkflows.length ? component.affectedWorkflows.map(humanLabel).join(" / ") : "Platform support"}</span>
                  </footer>
                </article>
              ))}
              {!overview && <p className="m-0 text-body text-faint">Loading component state...</p>}
            </div>
          </Panel>

          <Panel>
            <PanelHeading
              kicker="Active response"
              title="Incident queue"
              actions={<Button variant="ghost" size="sm" onClick={() => setTab("incidents")}>View all</Button>}
            />
            <div className="grid gap-1.5">
              {(overview?.incidents.items ?? []).slice(0, 5).map((item) => <article
                className="flex items-start gap-2.5 rounded border border-border bg-raised p-2.5"
                key={item.id}
              >
                <span
                  aria-hidden="true"
                  className={cn("mt-1 h-1.5 w-1.5 shrink-0", item.severity === "CRITICAL" ? "bg-bad" : "bg-warn")}
                />
                <div className="min-w-0">
                  <strong className="block text-caption font-semibold text-text">{item.title}</strong>
                  <small className="mt-0.5 block font-mono text-micro text-faint">
                    {humanLabel(item.status)} / {relativeTime(item.lastObservedAt)}
                  </small>
                </div>
              </article>)}
              {overview?.incidents.items.length === 0 && (
                <EmptyState title="No active incidents">Automated degradation and operator-raised context appear here.</EmptyState>
              )}
            </div>
          </Panel>
        </div>

        <Panel>
          <PanelHeading
            kicker="Layered policy"
            title="Guardrail posture"
            description="Application controls are reported separately from target-environment evidence."
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{overview?.guardrails.map((control) => <article
            className="grid gap-1.5 rounded border border-border bg-raised p-3"
            key={control.layer}
          >
            <header className="flex items-center justify-between gap-3">
              <MicroLabel>{humanLabel(control.layer)}</MicroLabel>
              <StatusText dot tone={toneFor(control.status.toLowerCase())}>{humanLabel(control.status)}</StatusText>
            </header>
            <h3 className="m-0 text-[12px] font-semibold text-text">{control.label}</h3>
            <p className="mb-0 text-caption leading-relaxed text-muted">{control.summary}</p>
            <small className="font-mono text-micro text-faint">{control.evidence}</small>
          </article>)}</div>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="Workflows"
            title="24-hour and retained workload signals"
            description="Counts retain their domain meaning; all-time values are not presented as live error rates."
          />
          <MetricRow className="border-b-0 pb-0 lg:grid-cols-5">
            <Metric label="Chat responses / 24h" value={metrics?.chat?.responses ?? "--"} caption={`${percentage(metrics?.chat?.failureRate ?? null)} failed / ${metrics?.chat?.averageLatencyMs ?? "--"} ms average`} />
            <Metric label="Knowledge indexing" value={metrics?.documents?.processing ?? "--"} caption={`${metrics?.documents?.ready ?? 0} ready / ${metrics?.documents?.failed ?? 0} need attention`} />
            <Metric label="Hermes runs" value={metrics?.agents?.runningRuns ?? "--"} caption={`${metrics?.agents?.queuedRuns ?? 0} queued / ${metrics?.agents?.failedRuns ?? 0} retained failures`} />
            <Metric label="Governed tools" value={metrics?.tools?.executingCalls ?? "--"} caption={`${metrics?.tools?.pendingApprovals ?? 0} pending review / ${metrics?.tools?.deniedCalls ?? 0} denied`} />
            <Metric label="Source bytes retained" value={metrics?.documents ? bytes(metrics.documents.retainedSourceBytes) : "--"} caption="Chunks and embeddings, never originals" />
          </MetricRow>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="PostgreSQL coordination"
            title="Durable runtime state"
            description={overview?.runtime ? `Captured ${relativeTime(overview.runtime.capturedAt)} from domain state` : "Runtime state is unavailable."}
            actions={<Button size="sm" onClick={() => void refresh()} disabled={busy}>Refresh state</Button>}
          />
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full min-w-[560px] border-collapse text-body">
              <thead>
                <tr className="border-b border-border bg-raised">
                  {["Workload", "Pending", "Active", "Failed", "Retained"].map((head) => (
                    <th className="px-3 py-2 text-left font-mono text-micro font-medium uppercase text-faint" scope="col" key={head}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>{workloads.map((workload) => <tr className="border-b border-border last:border-b-0" key={workload.name}>
                <th className="px-3 py-2 text-left font-normal" scope="row">
                  <strong className="block text-caption font-semibold text-text">{workload.displayName}</strong>
                  <span className="block font-mono text-micro text-faint">{workload.name}</span>
                </th>
                <td className="px-3 py-2 font-mono text-caption tabular-nums text-muted">{workload.pendingCount}</td>
                <td className="px-3 py-2 font-mono text-caption tabular-nums text-muted">{workload.activeCount}</td>
                <td className={cn("px-3 py-2 font-mono text-caption tabular-nums", workload.failedCount ? "text-bad" : "text-muted")}>{workload.failedCount}</td>
                <td className="px-3 py-2 font-mono text-caption tabular-nums text-muted">{workload.totalCount}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-1.5">
            {executors.map((executor) => <article
              className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-raised p-2.5"
              key={executor.id}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <StatusText dot tone={toneFor(executor.status.toLowerCase())} />
                <div className="min-w-0">
                  <strong className="block truncate text-caption font-semibold text-text">{executor.name}</strong>
                  <small className="block font-mono text-micro text-faint">
                    {executor.workloads.length} workloads / version {executor.version}
                  </small>
                </div>
              </div>
              <div className="text-right">
                <StatusText tone={toneFor(executor.status.toLowerCase())}>{humanLabel(executor.status)}</StatusText>
                <span className="mt-0.5 block font-mono text-micro text-faint">{relativeTime(executor.lastSeenAt)}</span>
              </div>
            </article>)}
            {executors.length === 0 && (
              <EmptyState title="No executor heartbeat">No runtime executor heartbeat has been recorded.</EmptyState>
            )}
          </div>
        </Panel>
      </div>}

      {tab === "incidents" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Operational incidents</h2><p>Automatic observations and manual context share one durable response ledger.</p></div>{canOperate && <button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => setShowIncidentForm((shown) => !shown)}>{showIncidentForm ? "Cancel" : "Create incident"}</button>}</div>
        {showIncidentForm && <form className="ops-form grid gap-3 rounded border border-border bg-surface p-5 sm:grid-cols-2" onSubmit={(event) => void createIncident(event)}>
          <label><span>Title</span><input name="title" minLength={3} maxLength={160} required /></label>
          <label><span>Severity</span><select name="severity"><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option></select></label>
          <label><span>Component</span><input name="component" minLength={1} maxLength={80} placeholder="e.g. hermes-vm2" required /></label>
          <label><span>Owner</span><input name="owner" maxLength={160} placeholder="Optional team or operator" /></label>
          <label className="sm:col-span-2"><span>Summary</span><textarea name="summary" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="flex justify-end sm:col-span-2"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-accent bg-accent px-3.5 text-body font-medium text-[#0a0a0b] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Create incident</button></div>
        </form>}
        <div className="grid gap-3">{incidents.map((item) => <article className={cn("grid gap-3 rounded border border-l-2 border-border bg-surface p-4",
            item.status === "RESOLVED" ? "border-l-good" : item.severity === "CRITICAL" ? "border-l-bad" : "border-l-warn")} key={item.id}>
          <header><span className={cn("rounded border px-1.5 py-0.5 font-mono text-micro uppercase",
            item.severity === "CRITICAL" ? "border-bad/50 bg-bad/10 text-bad" : "border-warn/50 bg-warn/10 text-warn")}>{humanLabel(item.severity)}</span><span>{item.automated ? "Automatic observation" : "Operator raised"}</span><time>{relativeTime(item.detectedAt)}</time></header>
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <dl><div><dt>Status</dt><dd>{humanLabel(item.status)}</dd></div><div><dt>Component</dt><dd>{item.component}</dd></div><div><dt>Owner</dt><dd>{item.owner ?? "Unassigned"}</dd></div><div><dt>Last observed</dt><dd>{relativeTime(item.lastObservedAt)}</dd></div></dl>
          {item.resolutionNote && <blockquote>{item.resolutionNote}</blockquote>}
          {canOperate && item.status !== "RESOLVED" && <div className="flex justify-end gap-2"><button type="button" onClick={() => { setIncidentAction({ id: item.id, action: "acknowledge" }); setDecisionNote(""); }} disabled={item.status !== "OPEN"}>Acknowledge</button><button type="button" onClick={() => { setIncidentAction({ id: item.id, action: "resolve" }); setDecisionNote(""); }}>Resolve</button></div>}
          {incidentAction?.id === item.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void decideIncident(event)}><label><span>Operator note</span><textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} minLength={3} maxLength={1000} rows={2} required /></label><div><button type="button" onClick={() => setIncidentAction(null)}>Cancel</button><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Record {incidentAction.action}</button></div></form>}
        </article>)}{incidents.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No operational incidents have been recorded.</p>}</div>
      </section>}

      {tab === "evaluations" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Release evidence</h2><p>Evidence is immutable after completion. Promotion is a separate, permissioned decision.</p></div>{canManageEvaluations && <button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => setShowEvaluationForm((shown) => !shown)}>{showEvaluationForm ? "Cancel" : "New candidate"}</button>}</div>
        {showEvaluationForm && <form className="ops-form grid gap-3 rounded border border-border bg-surface p-5 sm:grid-cols-2" onSubmit={(event) => void createEvaluation(event)}>
          <label><span>Candidate name</span><input name="name" minLength={3} maxLength={160} required /></label>
          <label><span>Target type</span><select name="targetType"><option>MODEL</option><option>PROMPT</option><option>POLICY</option><option>AGENT</option></select></label>
          <label><span>Target reference</span><input name="targetReference" placeholder="laguna-s / hermes-policy" maxLength={240} required /></label>
          <label><span>Version</span><input name="targetVersion" placeholder="Immutable version or digest" maxLength={120} required /></label>
          <label><span>Minimum pass rate</span><input name="minimumPassRate" type="number" min={50} max={100} step={0.1} defaultValue={95} required /></label>
          <div className="ops-form grid gap-1 rounded border border-border bg-raised p-3 sm:col-span-2"><span>Required evidence</span><p>{EVALUATION_CATEGORIES.map(humanLabel).join(" / ")}</p></div>
          <div className="flex justify-end sm:col-span-2"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-accent bg-accent px-3.5 text-body font-medium text-[#0a0a0b] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Create candidate</button></div>
        </form>}
        <div className="grid gap-3">{evaluations.map((run) => <article className="rounded-card border border-border bg-surface p-5 shadow-card" key={run.id}>
          <header><div><span>{humanLabel(run.targetType)}</span><h3>{run.name}</h3></div><strong className={run.status.toLowerCase()}>{humanLabel(run.status)}</strong></header>
          <p className="m-0 font-mono text-caption text-muted">{run.targetReference}<span>/ {run.targetVersion}</span></p>
          <div className="grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4"><div><strong>{percentage(run.passRate)}</strong><span>observed pass rate</span></div><div><strong>{run.passedCases}/{run.totalCases}</strong><span>cases passed</span></div><div><strong>{run.criticalFailures}</strong><span>critical failures</span></div><div><strong>{percentage(run.minimumPassRate)}</strong><span>required minimum</span></div></div>
          <div className="flex flex-wrap gap-1.5">{run.requiredCategories.map((category) => <span key={category}>{humanLabel(category)}</span>)}</div>
          {run.promotionReason && <blockquote className="m-0 rounded border border-l-2 border-border border-l-accent p-3"><strong>Promotion rationale</strong><span>{run.promotionReason}</span></blockquote>}
          <footer><span>Created {relativeTime(run.createdAt)}{run.promotedAt ? ` / promoted ${relativeTime(run.promotedAt)}` : ""}</span><div>{run.status === "DRAFT" && canManageEvaluations && <button type="button" onClick={() => openEvidence(run)}>Record evidence</button>}{run.status === "PASSED" && canPromoteEvaluations && <button type="button" onClick={() => { setConfirmPromotionId(run.id); setPromotionReason(""); }}>Promote</button>}</div></footer>
          {confirmPromotionId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void promote(event, run.id)}><label><span>Promotion rationale</span><textarea value={promotionReason} onChange={(event) => setPromotionReason(event.target.value)} minLength={3} maxLength={1000} rows={2} placeholder="Why this exact evidence is approved for release" required /></label><div><button type="button" onClick={() => { setConfirmPromotionId(null); setPromotionReason(""); }}>Cancel</button><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Confirm promotion</button></div></form>}
          {evidenceRunId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void recordEvidence(event)}><div className="flex items-start justify-between gap-4"><div><strong>Record immutable results</strong><span>Every required category needs an evidence artifact reference.</span></div><button type="button" onClick={() => setEvidenceRunId(null)}>Close</button></div>{run.requiredCategories.map((category) => {
            const draft = evidenceDraft[category];
            const update = (field: "totalCases" | "passedCases" | "criticalFailures" | "evidenceRef", value: string) => setEvidenceDraft((current) => ({ ...current, [category]: { totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "", ...current[category], [field]: value } }));
            return <fieldset key={category}><legend>{humanLabel(category)}</legend><label><span>Total</span><input type="number" min={1} value={draft?.totalCases ?? ""} onChange={(event) => update("totalCases", event.target.value)} required /></label><label><span>Passed</span><input type="number" min={0} value={draft?.passedCases ?? ""} onChange={(event) => update("passedCases", event.target.value)} required /></label><label><span>Critical</span><input type="number" min={0} value={draft?.criticalFailures ?? "0"} onChange={(event) => update("criticalFailures", event.target.value)} required /></label><label className="sm:col-span-3"><span>Evidence reference</span><input value={draft?.evidenceRef ?? ""} onChange={(event) => update("evidenceRef", event.target.value)} placeholder="Report ID or immutable URI" required /></label></fieldset>;
          })}<div className="flex justify-end sm:col-span-2"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-accent bg-accent px-3.5 text-body font-medium text-[#0a0a0b] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Complete evaluation</button></div></form>}
        </article>)}{evaluations.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No evaluation candidates have been created.</p>}</div>
      </section>}

      {tab === "readiness" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Production pilot readiness</h2><p>Evidence-backed controls and externally issued OrcaSynapse decisions. OrcaSynapse records approvals; it does not grant them.</p></div>{canApproveReadiness && <button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => setShowApprovalForm((shown) => !shown)}>{showApprovalForm ? "Cancel" : "Record sign-off"}</button>}</div>
        <section className={cn("grid gap-3 rounded border border-l-2 border-border bg-surface p-5",
          readiness?.status === "READY" ? "border-l-good" : "border-l-warn")}>
          <div><p className="font-mono text-micro uppercase text-faint">Derived gate</p><h3>{readiness ? humanLabel(readiness.status) : "Loading"}</h3><p>Ready requires every control to be verified or formally waived and the latest Security, Infrastructure, Product, and Business decisions to be approved.</p></div>
          <dl><div><dt>Controls accepted</dt><dd>{readiness ? readiness.summary.verifiedControls + readiness.summary.waivedControls : "--"}<span> / {readiness?.summary.totalControls ?? 0}</span></dd></div><div><dt>External approvals</dt><dd>{readiness?.summary.approvedRoles ?? "--"}<span> / {readiness?.summary.requiredApprovals ?? 4}</span></dd></div><div><dt>Blocked controls</dt><dd>{readiness?.summary.blockedControls ?? "--"}</dd></div></dl>
        </section>

        {showApprovalForm && <form className="ops-form grid gap-3 rounded border border-border bg-surface p-5 sm:grid-cols-2" onSubmit={(event) => void submitReadinessApproval(event)}>
          <div className="sm:col-span-2 text-body text-muted"><strong>External decision record</strong><span>The authority is the OrcaSynapse body that made the decision. Your signed-in OrcaSynapse identity is retained separately as the recorder. {readinessControlsAccepted ? "All controls are accepted for an approval snapshot." : "Approval remains disabled until every control is verified or waived; rejection can still be recorded."}</span></div>
          <label><span>Approval role</span><select name="role"><option>SECURITY</option><option>INFRASTRUCTURE</option><option>PRODUCT</option><option>BUSINESS</option></select></label>
          <label><span>Decision</span><select name="decision" defaultValue={readinessControlsAccepted ? "APPROVED" : "REJECTED"}><option value="APPROVED" disabled={!readinessControlsAccepted}>APPROVED</option><option value="REJECTED">REJECTED</option></select></label>
          <label><span>Approving authority</span><input name="authority" minLength={1} maxLength={160} placeholder="OrcaSynapse Security Review Board" required /></label>
          <label><span>Approval evidence</span><input name="evidenceRef" minLength={1} maxLength={500} placeholder="Approval ID or immutable artifact reference" required /></label>
          <label className="sm:col-span-2"><span>Decision rationale</span><textarea name="reason" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="flex justify-end sm:col-span-2"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-accent bg-accent px-3.5 text-body font-medium text-[#0a0a0b] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Append authority decision</button></div>
        </form>}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
          <div className="grid gap-2">{readiness?.controls.map((control) => <article className={cn("grid gap-2 rounded border border-l-2 border-border bg-surface p-3.5",
            { good: "border-l-good", warn: "border-l-warn", bad: "border-l-bad", accent: "border-l-accent", neutral: "border-l-border-strong" }[toneFor(control.status.toLowerCase())])} key={control.key}>
            <header><span>{humanLabel(control.domain)}</span><strong>{humanLabel(control.status)}</strong></header>
            <div className="min-w-0"><h3>{control.title}</h3><p>{control.description}</p></div>
            <dl><div><dt>Owner</dt><dd>{control.owner ?? "Unassigned"}</dd></div><div><dt>Evidence</dt><dd>{control.evidenceRefs.length} reference{control.evidenceRefs.length === 1 ? "" : "s"}</dd></div><div><dt>Updated</dt><dd>{relativeTime(control.updatedAt)}</dd></div></dl>
            {control.note && <blockquote>{control.note}</blockquote>}
            {canManageReadiness && <button className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded border border-transparent px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => setReadinessControlKey((current) => current === control.key ? null : control.key)}>{readinessControlKey === control.key ? "Close" : "Update evidence"}</button>}
            {readinessControlKey === control.key && <form className="ops-form mt-2 grid gap-3 rounded border border-border-strong bg-surface p-3" onSubmit={(event) => void updateReadiness(event, control)}>
              <label><span>Status</span><select name="status" defaultValue={control.status}><option>NOT_STARTED</option><option>IN_PROGRESS</option><option>BLOCKED</option><option>VERIFIED</option><option>WAIVED</option></select></label>
              <label><span>Owner</span><input name="owner" defaultValue={control.owner ?? ""} maxLength={160} placeholder="Required after work starts" /></label>
              <label className="sm:col-span-2"><span>Evidence references, one per line</span><textarea name="evidenceRefs" defaultValue={control.evidenceRefs.join("\n")} rows={3} maxLength={10020} placeholder="Immutable report, ticket, backup, or approval reference" /></label>
              <label className="sm:col-span-2"><span>Decision note</span><textarea name="note" defaultValue={control.note ?? ""} rows={2} minLength={3} maxLength={1000} placeholder="Required for blocked, verified, or waived status" /></label>
              <div className="flex justify-end sm:col-span-2"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="submit" disabled={busy}>Save control</button></div>
            </form>}
          </article>)}{readiness?.controls.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">The production-readiness checklist has not been migrated.</p>}</div>

          <aside className="grid gap-4">
            <Panel className="readiness-approvals"><PanelHeading kicker="Latest authority decisions" title="Formal sign-offs" /><div>{(["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const).map((role) => {
              const approval = readiness?.approvals.find((item) => item.role === role);
              return <article key={role}><header><strong>{humanLabel(role)}</strong><span className={!approval ? "missing" : approval.isCurrent ? approval.decision.toLowerCase() : "stale"}>{approval ? `${humanLabel(approval.decision)}${approval.isCurrent ? "" : " / stale"}` : "Not recorded"}</span></header>{approval ? <><p>{approval.authority}</p><small>Recorded by {approval.recordedBy} / {relativeTime(approval.recordedAt)}</small><code>{approval.evidenceRef}</code></> : <p>No external authority decision is retained.</p>}</article>;
            })}</div></Panel>
            <Panel className="readiness-blockers"><PanelHeading kicker="Open gate conditions" title="Readiness blockers" actions={<strong className="font-display text-[19px] font-semibold tabular-nums text-text">{readiness?.blockers.length ?? 0}</strong>} /><ol>{readiness?.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ol>{readiness?.blockers.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No derived blockers remain.</p>}</Panel>
          </aside>
        </div>
      </section>}
    </>
  );
}

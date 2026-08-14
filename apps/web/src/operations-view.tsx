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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  Alert, Button, EmptyState, HeroBanner, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, PanelHeading, Select, StatusText, Textarea, Tile, cn, toneFor,
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
          <Button
            variant={tab === entry.key ? "secondary" : "ghost"}
            size="sm"
            className={cn(
              "gap-2 px-3 text-body",
              tab === entry.key && "bg-raised text-text",
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
          </Button>
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
                <Tile as="article" className="grid gap-2" key={component.id}>
                  <div className="flex items-center gap-2.5">
                    <StatusText dot tone={toneFor(component.status.toLowerCase())} />
                    <strong className="min-w-0 truncate text-label font-semibold text-text">{component.label}</strong>
                    <StatusText className="ml-auto shrink-0">{humanLabel(component.status)}</StatusText>
                  </div>
                  <p className="mb-0 text-caption leading-relaxed text-muted">{component.summary}</p>
                  <footer className="flex flex-wrap justify-between gap-2 font-mono text-micro text-faint">
                    <span>{component.source === "LAST_VERIFIED" ? `Verified ${relativeTime(component.observedAt)}` : humanLabel(component.source)}</span>
                    <span>{component.affectedWorkflows.length ? component.affectedWorkflows.map(humanLabel).join(" / ") : "Platform support"}</span>
                  </footer>
                </Tile>
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
              {(overview?.incidents.items ?? []).slice(0, 5).map((item) => <Tile as="article" pad="sm" className="flex items-start gap-2.5" key={item.id}>
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
              </Tile>)}
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
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{overview?.guardrails.map((control) => <Tile as="article" className="grid gap-1.5" key={control.layer}>
            <header className="flex items-center justify-between gap-3">
              <MicroLabel>{humanLabel(control.layer)}</MicroLabel>
              <StatusText dot tone={toneFor(control.status.toLowerCase())}>{humanLabel(control.status)}</StatusText>
            </header>
            <h3 className="m-0 font-display text-label font-semibold text-text">{control.label}</h3>
            <p className="mb-0 text-caption leading-relaxed text-muted">{control.summary}</p>
            <small className="font-mono text-micro text-faint">{control.evidence}</small>
          </Tile>)}</div>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="Workflows"
            title="24-hour and retained workload signals"
            description="Counts retain their domain meaning; all-time values are not presented as live error rates."
          />
          <MetricRow className="border-b-0 pb-0 lg:grid-cols-3">
            <Metric label="Chat responses / 24h" value={metrics?.chat?.responses ?? "--"} caption={`${percentage(metrics?.chat?.failureRate ?? null)} failed / ${metrics?.chat?.averageLatencyMs ?? "--"} ms average`} />
            <Metric label="Hermes runs" value={metrics?.agents?.runningRuns ?? "--"} caption={`${metrics?.agents?.queuedRuns ?? 0} queued / ${metrics?.agents?.failedRuns ?? 0} retained failures`} />
            <Metric label="Governed tools" value={metrics?.tools?.executingCalls ?? "--"} caption={`${metrics?.tools?.pendingApprovals ?? 0} pending review / ${metrics?.tools?.deniedCalls ?? 0} denied`} />
          </MetricRow>
        </Panel>

        <Panel>
          <PanelHeading
            kicker="PostgreSQL coordination"
            title="Durable runtime state"
            description={overview?.runtime ? `Captured ${relativeTime(overview.runtime.capturedAt)} from domain state` : "Runtime state is unavailable."}
            actions={<Button size="sm" onClick={() => void refresh()} disabled={busy}>Refresh state</Button>}
          />
          <div className="overflow-hidden rounded border border-border">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow className="bg-raised hover:bg-raised">
                  {["Workload", "Pending", "Active", "Failed", "Retained"].map((head) => (
                    <TableHead className="tabular-nums" scope="col" key={head}>{head}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>{workloads.map((workload) => <TableRow key={workload.name}>
                <TableCell className="font-normal">
                  <strong className="block text-caption font-semibold text-text">{workload.displayName}</strong>
                  <span className="block font-mono text-micro text-faint">{workload.name}</span>
                </TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.pendingCount}</TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.activeCount}</TableCell>
                <TableCell className={cn("font-mono text-caption tabular-nums", workload.failedCount ? "text-bad" : "text-muted")}>{workload.failedCount}</TableCell>
                <TableCell className="font-mono text-caption tabular-nums text-muted">{workload.totalCount}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>
          <div className="mt-3 grid gap-1.5">
            {executors.map((executor) => <Tile as="article" pad="sm" className="flex flex-wrap items-center justify-between gap-3" key={executor.id}>
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
            </Tile>)}
            {executors.length === 0 && (
              <EmptyState title="No executor heartbeat">No runtime executor heartbeat has been recorded.</EmptyState>
            )}
          </div>
        </Panel>
      </div>}

      {tab === "incidents" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Operational incidents</h2><p>Automatic observations and manual context share one durable response ledger.</p></div>{canOperate && <Button onClick={() => setShowIncidentForm((shown) => !shown)}>{showIncidentForm ? "Cancel" : "Create incident"}</Button>}</div>
        {showIncidentForm && <form className="ops-form grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2" onSubmit={(event) => void createIncident(event)}>
          <label><span>Title</span><Input name="title" minLength={3} maxLength={160} required /></label>
          <label><span>Severity</span><Select name="severity"><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option></Select></label>
          <label><span>Component</span><Input name="component" minLength={1} maxLength={80} placeholder="e.g. hermes-vm2" required /></label>
          <label><span>Owner</span><Input name="owner" maxLength={160} placeholder="Optional team or operator" /></label>
          <label className="sm:col-span-2"><span>Summary</span><Textarea name="summary" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Create incident</Button></div>
        </form>}
        <div className="grid gap-3">{incidents.map((item) => <article className={cn("grid gap-3 rounded border border-l-2 border-border bg-surface p-4",
            item.status === "RESOLVED" ? "border-l-good" : item.severity === "CRITICAL" ? "border-l-bad" : "border-l-warn")} key={item.id}>
          <header><span className={cn("rounded border px-1.5 py-0.5 text-micro font-semibold uppercase tabular-nums",
            item.severity === "CRITICAL" ? "border-bad/50 bg-bad/10 text-bad" : "border-warn/50 bg-warn/10 text-warn")}>{humanLabel(item.severity)}</span><span>{item.automated ? "Automatic observation" : "Operator raised"}</span><time>{relativeTime(item.detectedAt)}</time></header>
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <dl><div><dt>Status</dt><dd>{humanLabel(item.status)}</dd></div><div><dt>Component</dt><dd>{item.component}</dd></div><div><dt>Owner</dt><dd>{item.owner ?? "Unassigned"}</dd></div><div><dt>Last observed</dt><dd>{relativeTime(item.lastObservedAt)}</dd></div></dl>
          {item.resolutionNote && <blockquote>{item.resolutionNote}</blockquote>}
          {canOperate && item.status !== "RESOLVED" && <div className="flex justify-end gap-2"><Button size="sm" onClick={() => { setIncidentAction({ id: item.id, action: "acknowledge" }); setDecisionNote(""); }} disabled={item.status !== "OPEN"}>Acknowledge</Button><Button size="sm" onClick={() => { setIncidentAction({ id: item.id, action: "resolve" }); setDecisionNote(""); }}>Resolve</Button></div>}
          {incidentAction?.id === item.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void decideIncident(event)}><label><span>Operator note</span><Textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} minLength={3} maxLength={1000} rows={2} required /></label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setIncidentAction(null)}>Cancel</Button><Button type="submit" disabled={busy}>Record {incidentAction.action}</Button></div></form>}
        </article>)}{incidents.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No operational incidents have been recorded.</p>}</div>
      </section>}

      {tab === "evaluations" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Release evidence</h2><p>Evidence is immutable after completion. Promotion is a separate, permissioned decision.</p></div>{canManageEvaluations && <Button onClick={() => setShowEvaluationForm((shown) => !shown)}>{showEvaluationForm ? "Cancel" : "New candidate"}</Button>}</div>
        {showEvaluationForm && <form className="ops-form grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2" onSubmit={(event) => void createEvaluation(event)}>
          <label><span>Candidate name</span><Input name="name" minLength={3} maxLength={160} required /></label>
          <label><span>Target type</span><Select name="targetType"><option>MODEL</option><option>PROMPT</option><option>POLICY</option><option>AGENT</option></Select></label>
          <label><span>Target reference</span><Input name="targetReference" placeholder="laguna-s / hermes-policy" maxLength={240} required /></label>
          <label><span>Version</span><Input name="targetVersion" placeholder="Immutable version or digest" maxLength={120} required /></label>
          <label><span>Minimum pass rate</span><Input name="minimumPassRate" type="number" min={50} max={100} step={0.1} defaultValue={95} required /></label>
          <Tile className="ops-form grid gap-1 sm:col-span-2"><span>Required evidence</span><p>{EVALUATION_CATEGORIES.map(humanLabel).join(" / ")}</p></Tile>
          <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Create candidate</Button></div>
        </form>}
        <div className="grid gap-3">{evaluations.map((run) => <article className="rounded-card border border-border bg-surface p-5 shadow-card" key={run.id}>
          <header><div><span>{humanLabel(run.targetType)}</span><h3>{run.name}</h3></div><strong className={run.status.toLowerCase()}>{humanLabel(run.status)}</strong></header>
          <p className="m-0 font-mono text-caption text-muted">{run.targetReference}<span>/ {run.targetVersion}</span></p>
          <div className="grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4"><div><strong>{percentage(run.passRate)}</strong><span>observed pass rate</span></div><div><strong>{run.passedCases}/{run.totalCases}</strong><span>cases passed</span></div><div><strong>{run.criticalFailures}</strong><span>critical failures</span></div><div><strong>{percentage(run.minimumPassRate)}</strong><span>required minimum</span></div></div>
          <div className="flex flex-wrap gap-1.5">{run.requiredCategories.map((category) => <span key={category}>{humanLabel(category)}</span>)}</div>
          {run.promotionReason && <blockquote className="m-0 rounded border border-l-2 border-border border-l-accent p-3"><strong>Promotion rationale</strong><span>{run.promotionReason}</span></blockquote>}
          <footer><span>Created {relativeTime(run.createdAt)}{run.promotedAt ? ` / promoted ${relativeTime(run.promotedAt)}` : ""}</span><div className="flex gap-2">{run.status === "DRAFT" && canManageEvaluations && <Button size="sm" onClick={() => openEvidence(run)}>Record evidence</Button>}{run.status === "PASSED" && canPromoteEvaluations && <Button size="sm" onClick={() => { setConfirmPromotionId(run.id); setPromotionReason(""); }}>Promote</Button>}</div></footer>
          {confirmPromotionId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void promote(event, run.id)}><label><span>Promotion rationale</span><Textarea value={promotionReason} onChange={(event) => setPromotionReason(event.target.value)} minLength={3} maxLength={1000} rows={2} placeholder="Why this exact evidence is approved for release" required /></label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setConfirmPromotionId(null); setPromotionReason(""); }}>Cancel</Button><Button type="submit" disabled={busy}>Confirm promotion</Button></div></form>}
          {evidenceRunId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void recordEvidence(event)}><div className="flex items-start justify-between gap-4"><div><strong>Record immutable results</strong><span>Every required category needs an evidence artifact reference.</span></div><Button variant="ghost" size="sm" onClick={() => setEvidenceRunId(null)}>Close</Button></div>{run.requiredCategories.map((category) => {
            const draft = evidenceDraft[category];
            const update = (field: "totalCases" | "passedCases" | "criticalFailures" | "evidenceRef", value: string) => setEvidenceDraft((current) => ({ ...current, [category]: { totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "", ...current[category], [field]: value } }));
            return <fieldset key={category}><legend>{humanLabel(category)}</legend><label><span>Total</span><Input type="number" min={1} value={draft?.totalCases ?? ""} onChange={(event) => update("totalCases", event.target.value)} required /></label><label><span>Passed</span><Input type="number" min={0} value={draft?.passedCases ?? ""} onChange={(event) => update("passedCases", event.target.value)} required /></label><label><span>Critical</span><Input type="number" min={0} value={draft?.criticalFailures ?? "0"} onChange={(event) => update("criticalFailures", event.target.value)} required /></label><label className="sm:col-span-3"><span>Evidence reference</span><Input value={draft?.evidenceRef ?? ""} onChange={(event) => update("evidenceRef", event.target.value)} placeholder="Report ID or immutable URI" required /></label></fieldset>;
          })}<div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Complete evaluation</Button></div></form>}
        </article>)}{evaluations.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No evaluation candidates have been created.</p>}</div>
      </section>}

      {tab === "readiness" && <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-6"><div><h2>Production pilot readiness</h2><p>Evidence-backed controls and externally issued OrcaSynapse decisions. OrcaSynapse records approvals; it does not grant them.</p></div>{canApproveReadiness && <Button onClick={() => setShowApprovalForm((shown) => !shown)}>{showApprovalForm ? "Cancel" : "Record sign-off"}</Button>}</div>
        <section className={cn("grid gap-3 rounded border border-l-2 border-border bg-surface p-5",
          readiness?.status === "READY" ? "border-l-good" : "border-l-warn")}>
          <div><p className="text-micro font-semibold uppercase tabular-nums text-faint">Derived gate</p><h3>{readiness ? humanLabel(readiness.status) : "Loading"}</h3><p>Ready requires every control to be verified or formally waived and the latest Security, Infrastructure, Product, and Business decisions to be approved.</p></div>
          <dl><div><dt>Controls accepted</dt><dd>{readiness ? readiness.summary.verifiedControls + readiness.summary.waivedControls : "--"}<span> / {readiness?.summary.totalControls ?? 0}</span></dd></div><div><dt>External approvals</dt><dd>{readiness?.summary.approvedRoles ?? "--"}<span> / {readiness?.summary.requiredApprovals ?? 4}</span></dd></div><div><dt>Blocked controls</dt><dd>{readiness?.summary.blockedControls ?? "--"}</dd></div></dl>
        </section>

        {showApprovalForm && <form className="ops-form grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2" onSubmit={(event) => void submitReadinessApproval(event)}>
          <div className="sm:col-span-2 text-body text-muted"><strong>External decision record</strong><span>The authority is the OrcaSynapse body that made the decision. Your signed-in OrcaSynapse identity is retained separately as the recorder. {readinessControlsAccepted ? "All controls are accepted for an approval snapshot." : "Approval remains disabled until every control is verified or waived; rejection can still be recorded."}</span></div>
          <label><span>Approval role</span><Select name="role"><option>SECURITY</option><option>INFRASTRUCTURE</option><option>PRODUCT</option><option>BUSINESS</option></Select></label>
          <label><span>Decision</span><Select name="decision" defaultValue={readinessControlsAccepted ? "APPROVED" : "REJECTED"}><option value="APPROVED" disabled={!readinessControlsAccepted}>APPROVED</option><option value="REJECTED">REJECTED</option></Select></label>
          <label><span>Approving authority</span><Input name="authority" minLength={1} maxLength={160} placeholder="OrcaSynapse Security Review Board" required /></label>
          <label><span>Approval evidence</span><Input name="evidenceRef" minLength={1} maxLength={500} placeholder="Approval ID or immutable artifact reference" required /></label>
          <label className="sm:col-span-2"><span>Decision rationale</span><Textarea name="reason" minLength={3} maxLength={1000} rows={3} required /></label>
          <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Append authority decision</Button></div>
        </form>}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
          <div className="grid gap-2">{readiness?.controls.map((control) => <article className={cn("grid gap-2 rounded border border-l-2 border-border bg-surface p-3.5",
            { good: "border-l-good", warn: "border-l-warn", bad: "border-l-bad", accent: "border-l-accent", neutral: "border-l-border-strong" }[toneFor(control.status.toLowerCase())])} key={control.key}>
            <header><span>{humanLabel(control.domain)}</span><strong>{humanLabel(control.status)}</strong></header>
            <div className="min-w-0"><h3>{control.title}</h3><p>{control.description}</p></div>
            <dl><div><dt>Owner</dt><dd>{control.owner ?? "Unassigned"}</dd></div><div><dt>Evidence</dt><dd>{control.evidenceRefs.length} reference{control.evidenceRefs.length === 1 ? "" : "s"}</dd></div><div><dt>Updated</dt><dd>{relativeTime(control.updatedAt)}</dd></div></dl>
            {control.note && <blockquote>{control.note}</blockquote>}
            {canManageReadiness && <Button variant="ghost" size="sm" onClick={() => setReadinessControlKey((current) => current === control.key ? null : control.key)}>{readinessControlKey === control.key ? "Close" : "Update evidence"}</Button>}
            {readinessControlKey === control.key && <form className="ops-form mt-2 grid gap-3 rounded border border-border-strong bg-surface p-3" onSubmit={(event) => void updateReadiness(event, control)}>
              <label><span>Status</span><Select name="status" defaultValue={control.status}><option>NOT_STARTED</option><option>IN_PROGRESS</option><option>BLOCKED</option><option>VERIFIED</option><option>WAIVED</option></Select></label>
              <label><span>Owner</span><Input name="owner" defaultValue={control.owner ?? ""} maxLength={160} placeholder="Required after work starts" /></label>
              <label className="sm:col-span-2"><span>Evidence references, one per line</span><Textarea name="evidenceRefs" defaultValue={control.evidenceRefs.join("\n")} rows={3} maxLength={10020} placeholder="Immutable report, ticket, backup, or approval reference" /></label>
              <label className="sm:col-span-2"><span>Decision note</span><Textarea name="note" defaultValue={control.note ?? ""} rows={2} minLength={3} maxLength={1000} placeholder="Required for blocked, verified, or waived status" /></label>
              <div className="flex justify-end sm:col-span-2"><Button type="submit" disabled={busy}>Save control</Button></div>
            </form>}
          </article>)}{readiness?.controls.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">The production-readiness checklist has not been migrated.</p>}</div>

          <aside className="grid gap-4">
            {/*
              * Styled on the primitives rather than through class names whose
              * rules were deleted in v1.2.0: `readiness-approvals` and
              * `readiness-blockers` survived as attributes matching nothing, so
              * this aside rendered as unformatted running text.
              */}
            <Panel><PanelHeading kicker="Latest authority decisions" title="Formal sign-offs" /><div className="grid gap-2">{(["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const).map((role) => {
              const approval = readiness?.approvals.find((item) => item.role === role);
              const tone = !approval ? "neutral" : approval.isCurrent ? toneFor(approval.decision.toLowerCase()) : "warn";
              return <Tile as="article" key={role}>
                <header className="flex items-baseline justify-between gap-3">
                  <strong className="text-label font-semibold text-text">{humanLabel(role)}</strong>
                  <StatusText tone={tone}>{approval ? `${humanLabel(approval.decision)}${approval.isCurrent ? "" : " / stale"}` : "Not recorded"}</StatusText>
                </header>
                {approval ? <>
                  <p className="mb-0 mt-1.5 text-body text-muted">{approval.authority}</p>
                  <small className="mt-1 block text-caption text-faint">Recorded by {approval.recordedBy} / {relativeTime(approval.recordedAt)}</small>
                  <code className="mt-1.5 block truncate font-mono text-caption text-muted">{approval.evidenceRef}</code>
                </> : <p className="mb-0 mt-1.5 text-body text-faint">No external authority decision is retained.</p>}
              </Tile>;
            })}</div></Panel>
            <Panel><PanelHeading kicker="Open gate conditions" title="Readiness blockers" actions={<strong className="font-display text-[19px] font-semibold tabular-nums text-text">{readiness?.blockers.length ?? 0}</strong>} /><ol className="m-0 grid list-none gap-1.5 p-0">{readiness?.blockers.map((blocker) => <li className="flex gap-2.5 rounded border border-border bg-raised p-2.5 text-body text-muted" key={blocker}><span aria-hidden="true" className="mt-1.5 h-[5px] w-[5px] shrink-0 rounded-full bg-warn" />{blocker}</li>)}</ol>{readiness?.blockers.length === 0 && <p className="m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted">No derived blockers remain.</p>}</Panel>
          </aside>
        </div>
      </section>}
    </>
  );
}

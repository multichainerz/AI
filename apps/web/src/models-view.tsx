import type {
  AdministratorSession,
  CreateModelDeployment,
  ModelDeployment,
  ModelWorkload,
  ServiceConnectionSummary,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  changeModelDeploymentState,
  createModelDeployment,
  getModelDeployments,
  updateModelDeployment,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  LockedScreen,
  Metric,
  MetricRow,
  MicroLabel,
  PageHeader,
  Panel,
  Select,
  StatusText,
  cn,
  toneFor,
} from "./ui/index.js";

interface ModelsViewProps {
  session: AdministratorSession | null;
  connections: ServiceConnectionSummary[];
  onConfigureConnections: () => void;
  onOpenOperations: () => void;
  onSessionExpired: () => void;
}

interface ModelDraft extends CreateModelDeployment {}

const initialDraft: ModelDraft = {
  slug: "laguna-hermes",
  displayName: "Laguna Hermes",
  modelAlias: "hermes-agent",
  workload: "AGENT",
  connectionId: "",
  version: "2.1-nvfp4",
  license: null,
  contextWindowTokens: 131_072,
  maxOutputTokens: 8_192,
  maxConcurrentRequests: 2,
};

const connectionKinds: Readonly<Record<ModelWorkload, readonly string[]>> = {
  CHAT: ["INFERENCE"],
  AGENT: ["INFERENCE"],
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function modelTone(model: ModelDeployment): string {
  if (model.status === "ACTIVE") return "healthy";
  if (model.status === "SUSPENDED") return "degraded";
  return "not_tested";
}

export function ModelsView({
  session,
  connections,
  onConfigureConnections,
  onOpenOperations,
  onSessionExpired,
}: ModelsViewProps) {
  const [models, setModels] = useState<ModelDeployment[]>([]);
  const [draft, setDraft] = useState<ModelDraft>(initialDraft);
  const [editing, setEditing] = useState<ModelDeployment | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [decision, setDecision] = useState<{ id: string; action: "activate" | "suspend"; reason: string; makeDefault: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  const canManage = can("models:manage");

  const eligibleConnections = useMemo(
    () => connections.filter(({ kind }) => connectionKinds[draft.workload].includes(kind)),
    [connections, draft.workload],
  );

  const load = async (): Promise<ModelDeployment[]> => {
    if (!unlocked) return models;
    try {
      const { items } = await getModelDeployments();
      setModels(items);
      setError(null);
      return items;
    } catch (loadError) {
      if (loadError instanceof OrcaSynapseApiError && loadError.status === 401) onSessionExpired();
      else setError(loadError instanceof Error ? loadError.message : "Unable to load model routes.");
      return models;
    }
  };

  useEffect(() => { void load(); }, [session]);

  /**
   * A 409 means another operator saved first, so the revision this screen is
   * holding can never succeed again. Refetch, and re-point the open editor at
   * what was actually saved: this screen has no Refresh control and load() runs
   * only on [session], so without this every retry resends the revision that
   * already lost and the only way out is to navigate away and back.
   */
  const resyncAfterConflict = async (cause: unknown) => {
    if (!(cause instanceof OrcaSynapseApiError) || cause.status !== 409) return;
    const items = await load();
    setEditing((current) => (current ? items.find(({ id }) => id === current.id) ?? current : null));
  };

  useEffect(() => {
    if (eligibleConnections.some(({ id }) => id === draft.connectionId)) return;
    setDraft((current) => ({ ...current, connectionId: eligibleConnections[0]?.id ?? "" }));
  }, [eligibleConnections, draft.connectionId]);

  const startCreate = () => {
    setEditing(null);
    setDraft({ ...initialDraft, connectionId: connections.find(({ kind }) => kind === "INFERENCE")?.id ?? "" });
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const startEdit = (model: ModelDeployment) => {
    setEditing(model);
    setDraft({
      slug: model.slug,
      displayName: model.displayName,
      modelAlias: model.modelAlias,
      workload: model.workload,
      connectionId: model.connection.id,
      version: model.version,
      license: model.license,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      maxConcurrentRequests: model.maxConcurrentRequests,
    });
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.connectionId) {
      setError("Configure a compatible serving connection before saving this route.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (editing) {
        await updateModelDeployment(editing.id, {
          displayName: draft.displayName,
          modelAlias: draft.modelAlias,
          connectionId: draft.connectionId,
          version: draft.version,
          license: draft.license,
          contextWindowTokens: draft.contextWindowTokens,
          maxOutputTokens: draft.maxOutputTokens,
          maxConcurrentRequests: draft.maxConcurrentRequests,
          expectedRevision: editing.revision,
        });
        setMessage("Model route updated. Material changes require matching evaluation evidence before activation.");
      } else {
        await createModelDeployment({ ...draft, slug: slugify(draft.slug) });
        setMessage("Draft model route created.");
      }
      setShowEditor(false);
      setEditing(null);
      await load();
    } catch (saveError) {
      if (saveError instanceof OrcaSynapseApiError && saveError.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(saveError);
        setError(saveError instanceof Error ? saveError.message : "Unable to save the model route.");
      }
    } finally {
      setBusy(false);
    }
  };

  const applyDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    const model = models.find(({ id }) => id === decision.id);
    if (!model) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await changeModelDeploymentState(model.id, decision.action, {
        expectedRevision: model.revision,
        reason: decision.reason.trim(),
        makeDefault: decision.action === "activate" && decision.makeDefault,
      });
      setMessage(decision.action === "activate" ? "Model route activated." : "Model route suspended.");
      setDecision(null);
      await load();
    } catch (decisionError) {
      if (decisionError instanceof OrcaSynapseApiError && decisionError.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(decisionError);
        setError(decisionError instanceof Error ? decisionError.message : "Unable to change the model route state.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Inference control"
      title="Models"
      mark="M"
      reason="Sign in as an administrator to view or change model routes; the workspace session you already have stays active. Serving credentials remain inside the encrypted credential store."
      actionLabel="Open platform settings"
      onAction={onConfigureConnections}
    />;
  }

  const activeCount = models.filter(({ status }) => status === "ACTIVE").length;
  const defaultCount = models.filter(({ isDefault }) => isDefault).length;
  const workloadCount = new Set(models.map(({ workload }) => workload)).size;

  return <div className="grid gap-5">
    <PageHeader
      kicker="AI Inference control"
      title="Models"
      description="Approve Chat and Hermes aliases on healthy model-serving connections."
      actions={<>
        <Button onClick={onOpenOperations}>Evaluation evidence</Button>
        {canManage && <Button variant="primary" onClick={startCreate}>New model route</Button>}
      </>}
    />

    <MetricRow className="lg:grid-cols-4" aria-label="Model catalogue summary">
      <Metric label="Catalogue routes" value={models.length} caption="Versioned records" />
      <Metric label="Active routes" value={activeCount} tone={activeCount > 0 ? "good" : "neutral"} caption="Evaluation gated" />
      <Metric label="Defaults" value={defaultCount} caption="Per workload" />
      <Metric label="Workloads" value={workloadCount} caption="Chat and agent" />
    </MetricRow>

    <Panel className="flex items-center gap-4 border-l-2 border-l-accent">
      <div className="min-w-0 flex-1">
        <MicroLabel className="block">Control boundary</MicroLabel>
        <strong className="mt-1.5 block text-label font-semibold text-text">
          OrcaSynapse approves routes; AI Inference remains the serving plane.
        </strong>
        <p className="mb-0 mt-1 text-body text-muted">
          Activation never modifies upstream configuration. The alias must already exist at the selected endpoint and the
          exact model version must have promoted evaluation evidence.
        </p>
      </div>
      <Button className="shrink-0" onClick={onConfigureConnections}>Manage serving connections</Button>
    </Panel>

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    {showEditor && <Panel>
      <form onSubmit={(event) => void save(event)}>
        <header className="mb-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
              {editing ? `Edit ${editing.displayName}` : "New model route"}
            </h2>
            <p className="mb-0 mt-1.5 text-body text-muted">
              {editing
                ? "Active routes must be suspended before editing."
                : "New routes remain draft until exact evaluation evidence is promoted."}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowEditor(false)}>Cancel</Button>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Display name"><Input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="Slug"><Input value={draft.slug} required disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, slug: slugAsTyped(event.target.value) })} onBlur={() => setDraft((current) => ({ ...current, slug: slugify(current.slug) }))} /></Field>
          <Field label="Workload"><Select value={draft.workload} disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, workload: event.target.value as ModelWorkload })}><option value="CHAT">Chat</option><option value="AGENT">Hermes agent</option></Select></Field>
          <Field label="Serving connection"><Select value={draft.connectionId} required onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}><option value="">Select a connection</option>{eligibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} - {connection.kind}</option>)}</Select></Field>
          <Field label="Model alias"><Input value={draft.modelAlias} required onChange={(event) => setDraft({ ...draft, modelAlias: event.target.value })} /></Field>
          <Field label="Immutable version"><Input value={draft.version} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></Field>
          <Field label="Context window"><Input type="number" min={1024} max={4194304} value={draft.contextWindowTokens} required onChange={(event) => setDraft({ ...draft, contextWindowTokens: Number(event.target.value) })} /></Field>
          <Field label="Maximum output"><Input type="number" min={64} max={131072} value={draft.maxOutputTokens} required onChange={(event) => setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })} /></Field>
          <Field label="Concurrency limit"><Input type="number" min={1} max={1024} value={draft.maxConcurrentRequests} required onChange={(event) => setDraft({ ...draft, maxConcurrentRequests: Number(event.target.value) })} /></Field>
          <Field label="License / approval"><Input value={draft.license ?? ""} placeholder="Optional approved license reference" onChange={(event) => setDraft({ ...draft, license: event.target.value.trim() || null })} /></Field>
        </div>
        <Button variant="primary" type="submit" className="mt-4" disabled={busy || editing?.status === "ACTIVE" || eligibleConnections.length === 0}>
          {busy ? "Saving..." : editing ? "Save new revision" : "Create draft route"}
        </Button>
      </form>
    </Panel>}

    <section className="grid items-start gap-3 lg:grid-cols-2" aria-label="Configured model routes">
      {models.length === 0 && (
        <EmptyState
          className="lg:col-span-2"
          title="No model routes yet"
          action={canManage ? <Button onClick={startCreate}>Create the first route</Button> : undefined}
        >
          Legacy connection aliases remain active until the first catalogue route is created.
        </EmptyState>
      )}
      {models.map((model) => <Panel className="grid min-w-0 gap-4" key={model.id}>
        <header className="flex items-center gap-3">
          <MicroLabel className="rounded border border-border bg-raised px-1.5 py-0.5">{model.workload}</MicroLabel>
          <StatusText dot tone={toneFor(modelTone(model))}>{model.status.toLowerCase()}</StatusText>
          {/* "Which route answers by default" is not derivable from anything
              else on the card, so it is stated rather than implied. */}
          {model.isDefault && <StatusText tone="accent" className="ml-auto">Default</StatusText>}
        </header>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded border border-border-strong bg-raised font-mono text-[10px] font-bold text-accent"
          >
            {model.displayName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="m-0 truncate font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{model.displayName}</h2>
            <p className="mb-0 mt-0.5 truncate font-mono text-caption text-muted">{model.modelAlias}</p>
          </div>
        </div>
        {/* Hairlines from the gap, so no cell needs a border and none double
            against the panel edge. */}
        <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-3">
          {[
            { label: "Version", value: model.version },
            { label: "Connection", value: model.connection.displayName },
            { label: "Context", value: compactNumber(model.contextWindowTokens) },
            { label: "Output", value: compactNumber(model.maxOutputTokens) },
            { label: "Concurrency", value: model.maxConcurrentRequests },
            { label: "Evidence", value: model.activationEvaluationId ? "Promoted" : "Required" },
          ].map((fact) => (
            <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
              <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
              <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <footer className="flex items-center justify-between gap-2.5">
          <StatusText>Revision {model.revision}</StatusText>
          {canManage && <div className="flex gap-1.5">
            {model.status !== "ACTIVE" && <Button size="sm" onClick={() => startEdit(model)}>Edit</Button>}
            <Button
              size="sm"
              variant={model.status === "ACTIVE" ? "danger" : "secondary"}
              onClick={() => setDecision({ id: model.id, action: model.status === "ACTIVE" ? "suspend" : "activate", reason: "", makeDefault: model.workload === "CHAT" })}
            >
              {model.status === "ACTIVE" ? "Suspend" : "Activate"}
            </Button>
          </div>}
        </footer>
        {decision?.id === model.id && <form
          className={cn(
            "grid gap-3 rounded border p-3",
            decision.action === "suspend" ? "border-bad/40 bg-bad/10" : "border-border-strong bg-raised",
          )}
          onSubmit={(event) => void applyDecision(event)}
        >
          <div>
            <strong className="block text-label font-semibold text-text">
              {decision.action === "activate" ? "Activate evaluated route" : "Suspend route"}
            </strong>
            <span className="mt-1 block text-body text-muted">
              {decision.action === "activate"
                ? `Requires promoted target model:${model.slug} version ${model.version}.`
                : "Existing conversations or profiles may stop accepting new work."}
            </span>
          </div>
          {decision.action === "activate" && <label className="flex cursor-pointer items-center gap-2.5 rounded border border-border bg-surface p-2.5">
            <input type="checkbox" checked={decision.makeDefault} onChange={(event) => setDecision({ ...decision, makeDefault: event.target.checked })} />
            <span className="text-body text-text">Make default for {model.workload.toLowerCase()}</span>
          </label>}
          <Field label="Operator reason">
            <Input minLength={3} maxLength={500} required value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button
              variant={decision.action === "suspend" ? "danger" : "primary"}
              type="submit"
              disabled={busy || decision.reason.trim().length < 3}
            >
              {busy ? "Applying..." : "Confirm"}
            </Button>
          </div>
        </form>}
      </Panel>)}
    </section>
  </div>;
}

import type {
  AdministratorSession,
  CreateModelDeployment,
  ModelDeployment,
  ModelInputModality,
  ModelObservation,
  ModelWorkload,
  ServiceConnectionSummary,
} from "@orcasynapse/contracts";
import { Boxes } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Switch } from "@/components/ui/switch";
import {
  OrcaSynapseApiError,
  changeModelDeploymentState,
  createModelDeployment,
  getModelDeployments,
  getModelObservations,
  refreshConnectionModels,
  updateModelDeployment,
} from "./api.js";
import { isOpenRouterEndpoint } from "@orcasynapse/contracts";
import { adminAccess } from "./admin-access.js";
import { admitLimits, setupAgentDeploymentSlug } from "./setup-agent-model.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  LockedScreen,
  MicroLabel,
  Panel,
  Select,
  StatusText,
  WorkspaceIntro,
  cn,
  toneFor,
} from "./ui/index.js";

interface ModelsViewProps {
  session: AdministratorSession | null;
  connections: ServiceConnectionSummary[];
  onConfigureConnections: () => void;
  onSessionExpired: () => void;
}

type LimitValue = number | "";

interface ModelDraft {
  slug: string;
  displayName: string;
  modelAlias: string;
  workload: ModelWorkload;
  connectionId: string;
  version: string;
  license: string | null;
  contextWindowTokens: LimitValue;
  maxOutputTokens: LimitValue;
  maxConcurrentRequests: number;
}

const connectionKinds: Readonly<Record<ModelWorkload, readonly string[]>> = {
  CHAT: ["INFERENCE"],
  AGENT: ["INFERENCE"],
};

const modalityLabels: Record<ModelInputModality, string> = {
  text: "Text",
  image: "Vision",
  audio: "Audio",
  file: "File",
};

function emptyDraft(connectionId: string): ModelDraft {
  return {
    slug: "",
    displayName: "",
    modelAlias: "",
    workload: "AGENT",
    connectionId,
    version: "",
    license: null,
    contextWindowTokens: "",
    maxOutputTokens: "",
    maxConcurrentRequests: 2,
  };
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function modelTone(model: ModelDeployment): string {
  if (model.status === "ACTIVE" && model.missingFromUpstream) return "degraded";
  if (model.status === "ACTIVE") return "healthy";
  if (model.status === "SUSPENDED") return "degraded";
  return "not_tested";
}

function probablyNotChat(alias: string): boolean {
  const id = alias.toLowerCase();
  return ["text-embedding-", "whisper-", "dall-e-", "tts-"].some((token) => id.includes(token));
}

function admittedLabel(workloads: ModelWorkload[]): string {
  const chat = workloads.includes("CHAT");
  const agent = workloads.includes("AGENT");
  if (chat && agent) return "both";
  if (chat) return "CHAT";
  if (agent) return "AGENT";
  return "no";
}

function draftFromObservation(observation: ModelObservation, workload: ModelWorkload): ModelDraft {
  const limits = admitLimits(observation);
  const name = (observation.displayName ?? observation.alias).slice(0, 120);
  return {
    slug: setupAgentDeploymentSlug(observation.alias),
    displayName: name.length >= 2 ? name : observation.alias.slice(0, 120).padEnd(2, "x"),
    modelAlias: observation.alias,
    workload,
    connectionId: observation.connectionId,
    version: "observed",
    license: null,
    contextWindowTokens: limits.contextWindowTokens,
    maxOutputTokens: limits.maxOutputTokens,
    maxConcurrentRequests: 2,
  };
}

function usedFallbackLimits(observation: ModelObservation): boolean {
  const limits = admitLimits(observation);
  return observation.observedContextWindowTokens !== limits.contextWindowTokens
    || observation.observedMaxOutputTokens !== limits.maxOutputTokens;
}

function asLimit(value: LimitValue): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseLimitInput(value: string): LimitValue {
  if (value.trim() === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
}

export function ModelsView({
  session,
  connections,
  onConfigureConnections,
  onSessionExpired,
}: ModelsViewProps) {
  const [models, setModels] = useState<ModelDeployment[]>([]);
  const [observations, setObservations] = useState<ModelObservation[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<ModelDraft>(emptyDraft(""));
  const [editing, setEditing] = useState<ModelDeployment | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [decision, setDecision] = useState<{ id: string; action: "activate" | "suspend"; reason: string; makeDefault: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  const canManage = can("models:manage");

  const inferenceConnections = useMemo(
    () => connections.filter(({ kind }) => kind === "INFERENCE"),
    [connections],
  );
  const healthyInference = useMemo(
    () => inferenceConnections.filter(({ enabled, status }) => enabled && status === "HEALTHY"),
    [inferenceConnections],
  );
  const refreshConnection = healthyInference.length === 1 ? healthyInference[0]! : null;

  const eligibleConnections = useMemo(
    () => connections.filter(({ kind }) => connectionKinds[draft.workload].includes(kind)),
    [connections, draft.workload],
  );

  const load = async (): Promise<{ models: ModelDeployment[]; observations: ModelObservation[] }> => {
    if (!unlocked) return { models, observations };
    try {
      const [{ items }, observed] = await Promise.all([
        getModelDeployments(),
        refreshConnection
          ? getModelObservations(refreshConnection.id)
          : Promise.resolve({ items: [] as ModelObservation[], refreshedAt: null, connectionId: "" }),
      ]);
      setModels(items);
      setObservations(observed.items);
      setRefreshedAt(observed.refreshedAt);
      setError(null);
      return { models: items, observations: observed.items };
    } catch (loadError) {
      if (loadError instanceof OrcaSynapseApiError && loadError.status === 401) onSessionExpired();
      else setError(loadError instanceof Error ? loadError.message : "Unable to load model routes.");
      return { models, observations };
    }
  };

  const resyncAfterConflict = async (cause: unknown) => {
    if (!(cause instanceof OrcaSynapseApiError) || cause.status !== 409) return;
    const loaded = await load();
    setEditing((current) => (current ? loaded.models.find(({ id }) => id === current.id) ?? current : null));
  };

  useEffect(() => {
    if (eligibleConnections.some(({ id }) => id === draft.connectionId)) return;
    setDraft((current) => ({ ...current, connectionId: eligibleConnections[0]?.id ?? "" }));
  }, [eligibleConnections, draft.connectionId]);

  const startAdmit = (observation: ModelObservation) => {
    setEditing(null);
    setDraft(draftFromObservation(observation, "AGENT"));
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
    const contextWindowTokens = asLimit(draft.contextWindowTokens);
    const maxOutputTokens = asLimit(draft.maxOutputTokens);
    if (contextWindowTokens === null || maxOutputTokens === null) {
      setError("Type enforced context and maximum output before saving this route.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const payload: CreateModelDeployment = {
        slug: slugify(draft.slug),
        displayName: draft.displayName,
        modelAlias: draft.modelAlias,
        workload: draft.workload,
        connectionId: draft.connectionId,
        version: draft.version,
        license: draft.license,
        contextWindowTokens,
        maxOutputTokens,
        maxConcurrentRequests: draft.maxConcurrentRequests,
      };
      if (editing) {
        await updateModelDeployment(editing.id, {
          displayName: payload.displayName,
          modelAlias: payload.modelAlias,
          connectionId: payload.connectionId,
          version: payload.version,
          license: payload.license,
          contextWindowTokens: payload.contextWindowTokens,
          maxOutputTokens: payload.maxOutputTokens,
          maxConcurrentRequests: payload.maxConcurrentRequests,
          expectedRevision: editing.revision,
        });
        setMessage("Model route updated. Material changes return the route to draft and require reactivation.");
      } else {
        await createModelDeployment(payload);
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

  const refresh = async (options: { silent?: boolean } = {}) => {
    if (!refreshConnection) {
      setError("Exactly one healthy inference connection is required to refresh.");
      return;
    }
    setBusy(true);
    if (!options.silent) {
      setError(null);
      setMessage(null);
    }
    try {
      const result = await refreshConnectionModels(refreshConnection.id);
      setObservations(result.items);
      setRefreshedAt(result.refreshedAt);
      if (result.backfill) setModels((current) => [result.backfill!, ...current.filter(({ id }) => id !== result.backfill!.id)]);
      else if (!options.silent) await load();
      if (!options.silent) {
        setMessage(`Refreshed ${result.upserted} observed model${result.upserted === 1 ? "" : "s"}.`);
      }
    } catch (refreshError) {
      if (refreshError instanceof OrcaSynapseApiError && refreshError.status === 401) onSessionExpired();
      else setError(refreshError instanceof Error ? refreshError.message : "Unable to refresh the model catalogue.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await load();
      if (cancelled || !refreshConnection) return;
      if (!can("models:manage") && !can("connections:test")) return;
      await refresh({ silent: true });
    };
    void run();
    return () => { cancelled = true; };
    // Catalogue identity is the unique healthy inference connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, refreshConnection?.id]);

  if (!unlocked) {
    return <LockedScreen
      kicker="Inference control"
      title="Models"
      mark="M"
      reason="Sign in as an administrator to view or change model routes; the workspace session you already have stays active. Serving credentials remain inside the encrypted credential store."
      actionLabel="Open Settings"
      onAction={onConfigureConnections}
    />;
  }

  const query = filter.trim().toLowerCase();
  const visibleObservations = observations.filter((item) => {
    if (!query) return true;
    return item.alias.toLowerCase().includes(query)
      || (item.displayName ?? "").toLowerCase().includes(query);
  });
  const openRouter = isOpenRouterEndpoint(refreshConnection?.baseUrl);
  const admitChoices = observations.filter((item) => !item.missingFromUpstream);
  const selectedObservation = admitChoices.find((item) => item.alias === draft.modelAlias) ?? null;

  return <div className="workspace-stack models-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
    <WorkspaceIntro
      icon={<Boxes className="size-4" aria-hidden="true" />}
      title="Models"
      actions={canManage ? (
          <Button variant="primary" onClick={() => void refresh()} disabled={busy || !refreshConnection}>
            {busy ? "Refreshing..." : "Refresh from endpoint"}
          </Button>
        ) : undefined}
    >
      <p className="mb-0 text-body text-muted">
        {openRouter
          ? "What this deployment is allowed to send Hermes. The live OpenRouter catalogue is fetched on this screen; Admit fills the route from that payload."
          : "What this deployment is allowed to send Hermes. The live catalogue is fetched from the connected inference server; Admit fills the route from that payload."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {refreshConnection ? (
          <StatusText dot tone={toneFor("healthy")}>{refreshConnection.displayName}</StatusText>
        ) : healthyInference.length > 1 ? (
          <StatusText tone="warn">Multiple healthy inference connections</StatusText>
        ) : (
          <StatusText tone="warn">No healthy inference connection</StatusText>
        )}
        <StatusText>{refreshedAt ? `Last refresh ${new Date(refreshedAt).toLocaleString()}` : "Never refreshed"}</StatusText>
      </div>
    </WorkspaceIntro>

    {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert className="shrink-0" tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    {showEditor && <Panel className="flex min-h-0 flex-col">
      <form className="flex min-h-0 flex-col" onSubmit={(event) => void save(event)}>
        <header className="mb-4 flex shrink-0 items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
              {editing ? `Edit ${editing.displayName}` : "Admit model route"}
            </h2>
            <p className="mb-0 mt-1.5 text-body text-muted">
              {editing
                ? "Active routes must be suspended before editing."
                : "New routes remain draft until they are activated. Name, alias, and limits come from the live catalogue; edit only if you need to override them."}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowEditor(false)}>Cancel</Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="route-editor-body">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!editing && admitChoices.length > 0 ? (
            <Field label="Served model" className="sm:col-span-2 lg:col-span-3">
              <Select
                aria-label="Served model"
                value={draft.modelAlias}
                onChange={(event) => {
                  const observation = admitChoices.find((item) => item.alias === event.target.value);
                  if (observation) setDraft(draftFromObservation(observation, draft.workload));
                }}
              >
                {admitChoices.map((item) => (
                  <option key={item.id} value={item.alias}>
                    {item.displayName ? `${item.displayName} (${item.alias})` : item.alias}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Display name"><Input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="Slug"><Input value={draft.slug} required disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, slug: slugAsTyped(event.target.value) })} onBlur={() => setDraft((current) => ({ ...current, slug: slugify(current.slug) }))} /></Field>
          <Field label="Workload"><Select value={draft.workload} disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, workload: event.target.value as ModelWorkload })}><option value="CHAT">Chat</option><option value="AGENT">Hermes agent</option></Select></Field>
          <Field label="Serving connection"><Select value={draft.connectionId} required onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}><option value="">Select a connection</option>{eligibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} - {connection.kind}</option>)}</Select></Field>
          {editing ? (
            <Field label="Model alias"><Input value={draft.modelAlias} required onChange={(event) => setDraft({ ...draft, modelAlias: event.target.value })} /></Field>
          ) : null}
          <Field label="Immutable version"><Input value={draft.version} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></Field>
          <Field label="Context window"><Input type="number" min={1024} max={4194304} value={draft.contextWindowTokens} required onChange={(event) => setDraft({ ...draft, contextWindowTokens: parseLimitInput(event.target.value) })} /></Field>
          <Field label="Maximum output"><Input type="number" min={64} max={131072} value={draft.maxOutputTokens} required onChange={(event) => setDraft({ ...draft, maxOutputTokens: parseLimitInput(event.target.value) })} /></Field>
          <Field label="Concurrency limit"><Input type="number" min={1} max={1024} value={draft.maxConcurrentRequests} required onChange={(event) => setDraft({ ...draft, maxConcurrentRequests: Number(event.target.value) })} /></Field>
          <Field label="License / approval"><Input value={draft.license ?? ""} placeholder="Optional approved license reference" onChange={(event) => setDraft({ ...draft, license: event.target.value.trim() || null })} /></Field>
        </div>
        {!editing && selectedObservation && usedFallbackLimits(selectedObservation) ? (
          <p className="mb-0 mt-3 text-caption leading-relaxed text-muted">
            This endpoint did not publish both limits. Context and maximum output are filled with safe defaults you can edit.
          </p>
        ) : null}
        </div>
        <Button variant="primary" type="submit" className="mt-4 shrink-0" disabled={busy || editing?.status === "ACTIVE" || eligibleConnections.length === 0}>
          {busy ? "Saving..." : editing ? "Save new revision" : "Create draft route"}
        </Button>
      </form>
    </Panel>}

    <Panel className="flex min-h-0 flex-col">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">Observed catalogue</h2>
        <Field label="Filter" className="min-w-[16rem]">
          <Input value={filter} placeholder="Alias or name" onChange={(event) => setFilter(event.target.value)} />
        </Field>
      </header>
      {observations.length === 0 ? (
        <EmptyState
          title="Refresh from the connected inference server"
          action={canManage && refreshConnection ? <Button variant="primary" onClick={() => void refresh()}>Refresh from endpoint</Button> : undefined}
        >
          Observed ids, modalities and limits come from the connected endpoint. Admit a row to fill a draft route from that payload.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" role="table" aria-label="Observed models">
          <div className="grid min-w-[64rem] grid-cols-[minmax(12rem,1.4fr)_minmax(10rem,1fr)_minmax(10rem,0.9fr)_6rem_6rem_5rem_auto] gap-2 border-b border-border pb-2 text-micro font-semibold uppercase tabular-nums text-faint" role="row">
            <span>Alias</span>
            <span>Name</span>
            <span>Modalities</span>
            <span>Context</span>
            <span>Max out</span>
            <span>Admitted</span>
            <span>Action</span>
          </div>
          {visibleObservations.map((item) => (
            <div
              key={item.id}
              className="grid min-w-[64rem] grid-cols-[minmax(12rem,1.4fr)_minmax(10rem,1fr)_minmax(10rem,0.9fr)_6rem_6rem_5rem_auto] items-center gap-2 border-b border-border py-2"
              role="row"
            >
              <div className="min-w-0">
                <p className="m-0 truncate font-mono text-caption text-text">{item.alias}</p>
                {probablyNotChat(item.alias) && <MicroLabel>probably not chat</MicroLabel>}
                {item.missingFromUpstream && <StatusText tone="warn">Missing upstream</StatusText>}
              </div>
              <p className="m-0 truncate text-caption text-muted">{item.displayName ?? "—"}</p>
              <div className="flex flex-wrap gap-1">
                {item.inputModalities.length === 0
                  ? <MicroLabel>Unknown</MicroLabel>
                  : item.inputModalities.map((modality) => <MicroLabel key={modality}>{modalityLabels[modality]}</MicroLabel>)}
              </div>
              <span className="font-mono text-caption tabular-nums text-muted">{item.observedContextWindowTokens ? compactNumber(item.observedContextWindowTokens) : "—"}</span>
              <span className="font-mono text-caption tabular-nums text-muted">{item.observedMaxOutputTokens ? compactNumber(item.observedMaxOutputTokens) : "—"}</span>
              <span className="text-caption text-muted">{admittedLabel(item.admittedWorkloads)}</span>
              {canManage && item.admittedWorkloads.length < 2 && (
                <Button size="sm" onClick={() => startAdmit(item)}>Admit</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>

    <section className="grid min-h-0 content-start items-start gap-3 overflow-y-auto lg:grid-cols-2" aria-label="Configured model routes">
      {models.length === 0 && observations.length > 0 && (
        <EmptyState className="lg:col-span-2" title="No admitted routes yet">
          Admit an observed id from the catalogue.
        </EmptyState>
      )}
      {models.map((model) => <Panel className="grid min-w-0 gap-4" key={model.id}>
        <header className="flex items-center gap-3">
          <MicroLabel className="rounded border border-border bg-raised px-1.5 py-0.5">{model.workload}</MicroLabel>
          <StatusText dot tone={toneFor(modelTone(model))}>{model.status.toLowerCase()}</StatusText>
          {model.status === "ACTIVE" && model.missingFromUpstream && <StatusText tone="warn">Degraded</StatusText>}
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
        <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-3">
          {[
            { label: "Version", value: model.version },
            { label: "Connection", value: model.connection.displayName },
            { label: "Context", value: compactNumber(model.contextWindowTokens) },
            { label: "Output", value: compactNumber(model.maxOutputTokens) },
            { label: "Concurrency", value: model.maxConcurrentRequests },
            { label: "Activation", value: model.firstActivatedAt ? "Started" : "Never active" },
          ].map((fact) => (
            <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
              <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
              <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted">{fact.value}</dd>
            </div>
          ))}
        </dl>
        {(model.observedContextWindowTokens !== null || model.observedMaxOutputTokens !== null) && (
          (model.observedContextWindowTokens !== model.contextWindowTokens || model.observedMaxOutputTokens !== model.maxOutputTokens) ? (
            <p className="mb-0 text-caption text-muted">
              upstream said {model.observedContextWindowTokens ? compactNumber(model.observedContextWindowTokens) : "unknown"} context / {model.observedMaxOutputTokens ? compactNumber(model.observedMaxOutputTokens) : "unknown"} max out
            </p>
          ) : null
        )}
        <footer className="flex items-center justify-between gap-2.5">
          <StatusText>Revision {model.revision}</StatusText>
          {canManage && <div className="flex gap-1.5">
            {model.status !== "ACTIVE" && <Button size="sm" onClick={() => startEdit(model)}>Edit</Button>}
            <Button
              size="sm"
              variant={model.status === "ACTIVE" ? "danger" : "secondary"}
              onClick={() => setDecision({ id: model.id, action: model.status === "ACTIVE" ? "suspend" : "activate", reason: "", makeDefault: model.workload === "AGENT" })}
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
              {decision.action === "activate" ? "Activate route" : "Suspend route"}
            </strong>
            <span className="mt-1 block text-body text-muted">
              {decision.action === "activate"
                ? `Routes ${model.workload.toLowerCase()} to target model:${model.slug} version ${model.version}. The serving connection must be enabled and healthy.`
                : "Existing conversations or profiles may stop accepting new work."}
            </span>
          </div>
          {decision.action === "activate" && <label className="flex cursor-pointer items-center gap-2.5 rounded border border-border bg-surface p-2.5">
            <Switch checked={decision.makeDefault} onCheckedChange={(checked) => setDecision({ ...decision, makeDefault: checked })} />
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

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
import { LockedScreen } from "./ui/index.js";

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

  const load = async () => {
    if (!unlocked) return;
    try {
      setModels((await getModelDeployments()).items);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof OrcaSynapseApiError && loadError.status === 401) onSessionExpired();
      else setError(loadError instanceof Error ? loadError.message : "Unable to load model routes.");
    }
  };

  useEffect(() => { void load(); }, [session]);

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
        await createModelDeployment(draft);
        setMessage("Draft model route created.");
      }
      setShowEditor(false);
      setEditing(null);
      await load();
    } catch (saveError) {
      if (saveError instanceof OrcaSynapseApiError && saveError.status === 401) onSessionExpired();
      else setError(saveError instanceof Error ? saveError.message : "Unable to save the model route.");
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
      else setError(decisionError instanceof Error ? decisionError.message : "Unable to change the model route state.");
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Inference control"
      title="Models"
      mark="M"
      reason="Claim or sign in to OrcaSynapse to view or change model routes. Serving credentials remain inside the encrypted credential store."
      actionLabel="Open platform settings"
      onAction={onConfigureConnections}
    />;
  }

  const activeCount = models.filter(({ status }) => status === "ACTIVE").length;
  const defaultCount = models.filter(({ isDefault }) => isDefault).length;
  const workloadCount = new Set(models.map(({ workload }) => workload)).size;

  return <div className="models-workspace">
    <header className="models-header">
      <div><p className="page-kicker">AI Inference control</p><h1>Models</h1><p>Approve Chat and Hermes aliases on healthy model-serving connections.</p></div>
      <div className="model-header-actions">
        <button type="button" onClick={onOpenOperations}>Evaluation evidence</button>
        {canManage && <button className="primary-button" type="button" onClick={startCreate}>New model route</button>}
      </div>
    </header>

    <section className="model-metrics" aria-label="Model catalogue summary">
      <article><span>Catalogue routes</span><strong>{models.length}</strong><small>Versioned records</small></article>
      <article><span>Active routes</span><strong>{activeCount}</strong><small>Evaluation gated</small></article>
      <article><span>Defaults</span><strong>{defaultCount}</strong><small>Per workload</small></article>
      <article><span>Workloads</span><strong>{workloadCount}</strong><small>Chat and agent</small></article>
    </section>

    <section className="model-boundary panel">
      <div><span>Control boundary</span><strong>OrcaSynapse approves routes; AI Inference remains the serving plane.</strong><p>Activation never modifies upstream configuration. The alias must already exist at the selected endpoint and the exact model version must have promoted evaluation evidence.</p></div>
      <button type="button" onClick={onConfigureConnections}>Manage serving connections</button>
    </section>

    {error && <div className="workspace-notice error" role="alert">{error}</div>}
    {message && <div className="workspace-notice success">{message}</div>}

    {showEditor && <form className="model-editor panel" onSubmit={(event) => void save(event)}>
      <div className="section-toolbar"><div><h2>{editing ? `Edit ${editing.displayName}` : "New model route"}</h2><p>{editing ? "Active routes must be suspended before editing." : "New routes remain draft until exact evaluation evidence is promoted."}</p></div><button type="button" onClick={() => setShowEditor(false)}>Cancel</button></div>
      <div className="model-editor-grid">
        <label><span>Display name</span><input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span>Slug</span><input value={draft.slug} required disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} /></label>
        <label><span>Workload</span><select value={draft.workload} disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, workload: event.target.value as ModelWorkload })}><option value="CHAT">Chat</option><option value="AGENT">Hermes agent</option></select></label>
        <label><span>Serving connection</span><select value={draft.connectionId} required onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}><option value="">Select a connection</option>{eligibleConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} - {connection.kind}</option>)}</select></label>
        <label><span>Model alias</span><input value={draft.modelAlias} required onChange={(event) => setDraft({ ...draft, modelAlias: event.target.value })} /></label>
        <label><span>Immutable version</span><input value={draft.version} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></label>
        <label><span>Context window</span><input type="number" min={1024} max={4194304} value={draft.contextWindowTokens} required onChange={(event) => setDraft({ ...draft, contextWindowTokens: Number(event.target.value) })} /></label>
        <label><span>Maximum output</span><input type="number" min={64} max={131072} value={draft.maxOutputTokens} required onChange={(event) => setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })} /></label>
        <label><span>Concurrency limit</span><input type="number" min={1} max={1024} value={draft.maxConcurrentRequests} required onChange={(event) => setDraft({ ...draft, maxConcurrentRequests: Number(event.target.value) })} /></label>
        <label><span>License / approval</span><input value={draft.license ?? ""} placeholder="Optional approved license reference" onChange={(event) => setDraft({ ...draft, license: event.target.value.trim() || null })} /></label>
      </div>
      <button className="primary-button model-save" type="submit" disabled={busy || editing?.status === "ACTIVE" || eligibleConnections.length === 0}>{busy ? "Saving..." : editing ? "Save new revision" : "Create draft route"}</button>
    </form>}

    <section className="model-catalogue" aria-label="Configured model routes">
      {models.length === 0 && <div className="model-empty panel"><strong>No model routes yet</strong><span>Legacy connection aliases remain active until the first catalogue route is created.</span>{canManage && <button type="button" onClick={startCreate}>Create the first route</button>}</div>}
      {models.map((model) => <article className="model-card panel" key={model.id}>
        <header><span className={`model-workload ${model.workload.toLowerCase()}`}>{model.workload}</span><span className={`connection-status ${modelTone(model)}`}><i />{model.status.toLowerCase()}</span>{model.isDefault && <span className="model-default">Default</span>}</header>
        <div className="model-title"><div className="model-symbol">{model.displayName.slice(0, 2).toUpperCase()}</div><div><h2>{model.displayName}</h2><p>{model.modelAlias}</p></div></div>
        <dl><div><dt>Version</dt><dd>{model.version}</dd></div><div><dt>Connection</dt><dd>{model.connection.displayName}</dd></div><div><dt>Context</dt><dd>{compactNumber(model.contextWindowTokens)}</dd></div><div><dt>Output</dt><dd>{compactNumber(model.maxOutputTokens)}</dd></div><div><dt>Concurrency</dt><dd>{model.maxConcurrentRequests}</dd></div><div><dt>Evidence</dt><dd>{model.activationEvaluationId ? "Promoted" : "Required"}</dd></div></dl>
        <footer><span>Revision {model.revision}</span>{canManage && <div>{model.status !== "ACTIVE" && <button type="button" onClick={() => startEdit(model)}>Edit</button>}<button type="button" onClick={() => setDecision({ id: model.id, action: model.status === "ACTIVE" ? "suspend" : "activate", reason: "", makeDefault: model.workload === "CHAT" })}>{model.status === "ACTIVE" ? "Suspend" : "Activate"}</button></div>}</footer>
        {decision?.id === model.id && <form className="model-decision" onSubmit={(event) => void applyDecision(event)}>
          <div><strong>{decision.action === "activate" ? "Activate evaluated route" : "Suspend route"}</strong><span>{decision.action === "activate" ? `Requires promoted target model:${model.slug} version ${model.version}.` : "Existing conversations or profiles may stop accepting new work."}</span></div>
          {decision.action === "activate" && <label className="model-default-toggle"><input type="checkbox" checked={decision.makeDefault} onChange={(event) => setDecision({ ...decision, makeDefault: event.target.checked })} /><span>Make default for {model.workload.toLowerCase()}</span></label>}
          <label><span>Operator reason</span><input minLength={3} maxLength={500} required value={decision.reason} onChange={(event) => setDecision({ ...decision, reason: event.target.value })} /></label>
          <div className="model-decision-actions"><button type="button" onClick={() => setDecision(null)}>Cancel</button><button className="primary-button" type="submit" disabled={busy || decision.reason.trim().length < 3}>{busy ? "Applying..." : "Confirm"}</button></div>
        </form>}
      </article>)}
    </section>
  </div>;
}

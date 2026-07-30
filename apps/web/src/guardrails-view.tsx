import type {
  AdministratorSession,
  CreateGuardrailPolicy,
  GuardrailPolicy,
} from "@aihub/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  changeGuardrailPolicyState,
  createGuardrailPolicy,
  getGuardrailPolicies,
  updateGuardrailPolicy,
} from "./api.js";

interface GuardrailsViewProps {
  session: AdministratorSession | null;
  onConfigureLiteLLM: () => void;
  onOpenOperations: () => void;
  onSessionExpired: () => void;
}

interface PolicyDraft extends Omit<CreateGuardrailPolicy, "liteLLMGuardrails"> {
  liteLLMGuardrails: string;
}

const initialDraft: PolicyDraft = {
  slug: "chat-safety",
  displayName: "Chat safety",
  description: "Approved input and output controls for internal AIHub chat.",
  version: "1.0.0",
  liteLLMGuardrails: "",
  maxInputCharacters: 12_000,
};

function names(value: string): string[] {
  return value.split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
}

function tone(policy: GuardrailPolicy): string {
  if (policy.status === "ACTIVE") return "healthy";
  if (policy.status === "SUSPENDED") return "degraded";
  return "not_tested";
}

function when(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function GuardrailsView({
  session,
  onConfigureLiteLLM,
  onOpenOperations,
  onSessionExpired,
}: GuardrailsViewProps) {
  const [policies, setPolicies] = useState<GuardrailPolicy[]>([]);
  const [draft, setDraft] = useState<PolicyDraft>(initialDraft);
  const [editing, setEditing] = useState<GuardrailPolicy | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [decision, setDecision] = useState<{ id: string; action: "activate" | "suspend"; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = session?.scopes.includes("guardrails:manage") === true;

  const load = async () => {
    if (!session) return;
    try {
      setPolicies((await getGuardrailPolicies()).items);
      setError(null);
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to load guardrail policies.");
    }
  };

  useEffect(() => { void load(); }, [session]);

  const startCreate = () => {
    setEditing(null);
    setDraft(initialDraft);
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const startEdit = (policy: GuardrailPolicy) => {
    setEditing(policy);
    setDraft({
      slug: policy.slug,
      displayName: policy.displayName,
      description: policy.description,
      version: policy.version,
      liteLLMGuardrails: policy.liteLLMGuardrails.join("\n"),
      maxInputCharacters: policy.maxInputCharacters,
    });
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const liteLLMGuardrails = names(draft.liteLLMGuardrails);
    if (liteLLMGuardrails.length === 0) {
      setError("Enter at least one guardrail name already configured in LiteLLM.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (editing) {
        await updateGuardrailPolicy(editing.id, {
          displayName: draft.displayName,
          description: draft.description,
          version: draft.version,
          liteLLMGuardrails,
          maxInputCharacters: draft.maxInputCharacters,
          expectedRevision: editing.revision,
        });
        setMessage("Policy updated. Material changes now require matching promoted safety evidence.");
      } else {
        await createGuardrailPolicy({ ...draft, liteLLMGuardrails });
        setMessage("Draft guardrail policy created.");
      }
      setEditing(null);
      setShowEditor(false);
      await load();
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to save the guardrail policy.");
    } finally {
      setBusy(false);
    }
  };

  const applyDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    const policy = policies.find(({ id }) => id === decision.id);
    if (!policy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await changeGuardrailPolicyState(policy.id, decision.action, {
        expectedRevision: policy.revision,
        reason: decision.reason.trim(),
      });
      setMessage(decision.action === "activate"
        ? "Evaluated guardrail policy activated for chat."
        : "Guardrail policy suspended; chat now fails closed until another evaluated policy is active.");
      setDecision(null);
      await load();
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to change the guardrail policy state.");
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return <div className="guardrails-workspace">
      <header className="guardrails-header"><div><p className="page-kicker">Policy control</p><h1>Guardrails</h1><p>Evaluated request boundaries and approved LiteLLM safety assignments.</p></div></header>
      <section className="guardrails-lock panel"><span className="guardrails-lock-mark">G</span><div><strong>Administrator session required</strong><p>Claim or sign in to AIHub to inspect policy versions and activation evidence. Guardrail credentials remain in the encrypted credential store.</p></div><button className="primary-button" type="button" onClick={onConfigureLiteLLM}>Open platform settings</button></section>
    </div>;
  }

  const active = policies.find(({ status }) => status === "ACTIVE");
  const activatedBefore = policies.some(({ firstActivatedAt }) => firstActivatedAt !== null);
  const uniqueAssignments = new Set(policies.flatMap(({ liteLLMGuardrails }) => liteLLMGuardrails)).size;

  return <div className="guardrails-workspace">
    <header className="guardrails-header">
      <div><p className="page-kicker">Policy control</p><h1>Guardrails</h1><p>Release evaluated chat boundaries and attach approved safety checks to every LiteLLM request.</p></div>
      <div className="guardrail-header-actions"><button type="button" onClick={onOpenOperations}>Evaluation evidence</button>{canManage && <button className="primary-button" type="button" onClick={startCreate}>New policy</button>}</div>
    </header>

    <section className="guardrail-metrics" aria-label="Guardrail policy summary">
      <article><span>Policy records</span><strong>{policies.length}</strong><small>Version controlled</small></article>
      <article><span>Active boundary</span><strong>{active ? "1" : "0"}</strong><small>{active ? active.displayName : activatedBefore ? "Fail closed" : "Legacy mode"}</small></article>
      <article><span>Assignments</span><strong>{uniqueAssignments}</strong><small>Named LiteLLM guardrails</small></article>
      <article><span>Input ceiling</span><strong>{active ? new Intl.NumberFormat("en", { notation: "compact" }).format(active.maxInputCharacters) : "—"}</strong><small>Characters per message</small></article>
    </section>

    <section className={`guardrail-boundary panel ${active ? "active" : activatedBefore ? "blocked" : "staged"}`}>
      <div><span>Runtime boundary</span><strong>{active ? `${active.displayName} v${active.version} is enforcing chat.` : activatedBefore ? "Chat policy enforcement is paused and fails closed." : "Drafts do not change current chat behavior."}</strong><p>AIHub enforces the input ceiling locally and sends approved names using LiteLLM's per-request <code>guardrails</code> field. The named guardrails and their pre/post-call modes must already exist in LiteLLM.</p></div>
      <button type="button" onClick={onConfigureLiteLLM}>Manage LiteLLM connection</button>
    </section>

    {error && <div className="workspace-notice error" role="alert">{error}</div>}
    {message && <div className="workspace-notice success">{message}</div>}

    {showEditor && <form className="guardrail-editor panel" onSubmit={(event) => void save(event)}>
      <div className="section-toolbar"><div><h2>{editing ? `Edit ${editing.displayName}` : "New chat policy"}</h2><p>Guardrail names are identifiers, never credentials. Put external classifier endpoints and keys in LiteLLM or AIHub Connections.</p></div><button type="button" onClick={() => setShowEditor(false)}>Cancel</button></div>
      <div className="guardrail-editor-grid">
        <label><span>Display name</span><input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span>Policy slug</span><input value={draft.slug} disabled={Boolean(editing)} required onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} /></label>
        <label><span>Immutable version</span><input value={draft.version} maxLength={120} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></label>
        <label><span>Maximum input characters</span><input type="number" min={256} max={32000} value={draft.maxInputCharacters} required onChange={(event) => setDraft({ ...draft, maxInputCharacters: Number(event.target.value) })} /></label>
        <label className="wide"><span>Purpose and coverage</span><textarea value={draft.description} minLength={3} maxLength={500} rows={3} required onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="wide"><span>LiteLLM guardrail names</span><textarea value={draft.liteLLMGuardrails} rows={4} required onChange={(event) => setDraft({ ...draft, liteLLMGuardrails: event.target.value })} /><small>One name per line or comma-separated, in execution order.</small></label>
      </div>
      <button className="primary-button guardrail-save" type="submit" disabled={busy || editing?.status === "ACTIVE"}>{busy ? "Saving…" : editing ? "Save policy revision" : "Create draft policy"}</button>
    </form>}

    <section className="guardrail-catalogue" aria-label="Configured guardrail policies">
      {policies.length === 0 && <div className="guardrail-empty panel"><strong>No policy records yet</strong><span>Chat continues using its existing schema, identity, and rate boundaries until the first evaluated policy is activated.</span>{canManage && <button type="button" onClick={startCreate}>Create the first policy</button>}</div>}
      {policies.map((policy) => <article className="guardrail-card panel" key={policy.id}>
        <header><span className="guardrail-version">v{policy.version}</span><span className={`connection-status ${tone(policy)}`}><i />{policy.status.toLowerCase()}</span></header>
        <div className="guardrail-card-title"><span>{policy.displayName.slice(0, 2).toUpperCase()}</span><div><h2>{policy.displayName}</h2><p>{policy.description}</p></div></div>
        <div className="guardrail-tags">{policy.liteLLMGuardrails.map((name) => <code key={name}>{name}</code>)}</div>
        <dl><div><dt>Input ceiling</dt><dd>{policy.maxInputCharacters.toLocaleString("en-US")} chars</dd></div><div><dt>Safety evidence</dt><dd>{policy.activationEvaluationId ? "Promoted" : "Required"}</dd></div><div><dt>Last updated</dt><dd>{when(policy.updatedAt)}</dd></div><div><dt>Enforcement history</dt><dd>{policy.firstActivatedAt ? "Started" : "Never active"}</dd></div></dl>
        <footer><span>Revision {policy.revision}</span>{canManage && <div>{policy.status !== "ACTIVE" && <button type="button" onClick={() => startEdit(policy)}>Edit</button>}<button type="button" onClick={() => setDecision({ id: policy.id, action: policy.status === "ACTIVE" ? "suspend" : "activate", reason: "" })}>{policy.status === "ACTIVE" ? "Suspend" : "Activate"}</button></div>}</footer>
        {decision?.id === policy.id && <form className="guardrail-decision" onSubmit={(event) => void applyDecision(event)}><div><strong>{decision.action === "activate" ? "Activate evaluated policy" : "Suspend active policy"}</strong><span>{decision.action === "activate" ? `Requires a promoted POLICY evaluation for policy:${policy.slug}, version ${policy.version}, including SAFETY.` : "Because this policy has previously enforced chat, suspension deliberately makes chat fail closed."}</span></div><label><span>Operator reason</span><input value={decision.reason} minLength={3} maxLength={500} required onChange={(event) => setDecision({ ...decision, reason: event.target.value })} /></label><div><button type="button" onClick={() => setDecision(null)}>Cancel</button><button className="primary-button" type="submit" disabled={busy || decision.reason.trim().length < 3}>{busy ? "Applying…" : "Confirm"}</button></div></form>}
      </article>)}
    </section>
  </div>;
}

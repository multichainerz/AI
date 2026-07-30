import type { AdministratorSession, CreatePromptTemplate, PromptTemplate } from "@aihub/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  changePromptTemplateState,
  createPromptTemplate,
  getPromptTemplates,
  updatePromptTemplate,
} from "./api.js";

interface PromptsViewProps {
  session: AdministratorSession | null;
  onOpenOperations: () => void;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

const initialDraft: CreatePromptTemplate = {
  slug: "mpm-chat-system",
  displayName: "MPM chat system",
  description: "Approved system behavior for internal employee chat.",
  purpose: "CHAT_SYSTEM",
  version: "1.0.0",
  content: "You are the MPM AIHub assistant. Be accurate, concise, and explicit about uncertainty. Do not claim to have used tools, enterprise data, or current external information unless that context is present in the conversation.",
};

function tone(prompt: PromptTemplate): string {
  if (prompt.status === "ACTIVE") return "healthy";
  if (prompt.status === "SUSPENDED") return "degraded";
  return "not_tested";
}

function when(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function PromptsView({ session, onOpenOperations, onOpenSettings, onSessionExpired }: PromptsViewProps) {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [draft, setDraft] = useState<CreatePromptTemplate>(initialDraft);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [decision, setDecision] = useState<{ id: string; action: "activate" | "suspend"; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = session?.scopes.includes("prompts:manage") === true;

  const load = async () => {
    if (!session) return;
    try {
      setPrompts((await getPromptTemplates()).items);
      setError(null);
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to load prompt templates.");
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

  const startEdit = (prompt: PromptTemplate) => {
    setEditing(prompt);
    setDraft({
      slug: prompt.slug,
      displayName: prompt.displayName,
      description: prompt.description,
      purpose: prompt.purpose,
      version: prompt.version,
      content: prompt.content,
    });
    setShowEditor(true);
    setError(null);
    setMessage(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (editing) {
        await updatePromptTemplate(editing.id, {
          displayName: draft.displayName,
          description: draft.description,
          version: draft.version,
          content: draft.content,
          expectedRevision: editing.revision,
        });
        setMessage("Prompt revision saved. Content or version changes require new promoted evidence.");
      } else {
        await createPromptTemplate(draft);
        setMessage("Draft chat-system prompt created.");
      }
      setEditing(null);
      setShowEditor(false);
      await load();
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to save the prompt template.");
    } finally {
      setBusy(false);
    }
  };

  const applyDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!decision) return;
    const prompt = prompts.find(({ id }) => id === decision.id);
    if (!prompt) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await changePromptTemplateState(prompt.id, decision.action, {
        expectedRevision: prompt.revision,
        reason: decision.reason.trim(),
      });
      setMessage(decision.action === "activate"
        ? "Evaluated chat-system prompt activated. New requests use this exact version."
        : "Prompt suspended. Because governance was previously adopted, chat now fails closed.");
      setDecision(null);
      await load();
    } catch (cause) {
      if (cause instanceof AIHubApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to change the prompt state.");
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return <div className="prompts-workspace">
      <header className="prompts-header"><div><p className="page-kicker">Release governance</p><h1>Prompts</h1><p>Versioned runtime instructions backed by promoted evaluation evidence.</p></div></header>
      <section className="prompts-lock panel"><span className="prompts-lock-mark">P</span><div><strong>Administrator session required</strong><p>Unlock AIHub to review prompt content, checksums, and release evidence.</p></div><button className="primary-button" type="button" onClick={onOpenSettings}>Open platform settings</button></section>
    </div>;
  }

  const active = prompts.find(({ status }) => status === "ACTIVE");
  const activatedBefore = prompts.some(({ firstActivatedAt }) => firstActivatedAt !== null);

  return <div className="prompts-workspace">
    <header className="prompts-header">
      <div><p className="page-kicker">Release governance</p><h1>Prompts</h1><p>Author, evaluate, and release the exact system instruction used by AIHub chat.</p></div>
      <div className="prompt-header-actions"><button type="button" onClick={onOpenOperations}>Evaluation evidence</button>{canManage && <button className="primary-button" type="button" onClick={startCreate}>New prompt</button>}</div>
    </header>

    <section className="prompt-metrics" aria-label="Prompt governance summary">
      <article><span>Prompt records</span><strong>{prompts.length}</strong><small>Chat-system purpose</small></article>
      <article><span>Active release</span><strong>{active ? "1" : "0"}</strong><small>{active ? `v${active.version}` : activatedBefore ? "Fail closed" : "Legacy mode"}</small></article>
      <article><span>Evidence gate</span><strong>{active?.activationEvaluationId ? "Passed" : "Required"}</strong><small>CHAT + SAFETY</small></article>
      <article><span>Instruction size</span><strong>{active ? active.content.length.toLocaleString("en-US") : "—"}</strong><small>Characters</small></article>
    </section>

    <section className={`prompt-runtime panel ${active ? "active" : activatedBefore ? "blocked" : "staged"}`}>
      <div><span>Runtime assignment</span><strong>{active ? `${active.displayName} v${active.version} is bound to chat.` : activatedBefore ? "Prompt enforcement is paused and chat fails closed." : "Drafts do not change the built-in chat instruction."}</strong><p>AIHub resolves one active <code>CHAT_SYSTEM</code> prompt before model or guardrail routing. Audit events retain the version and SHA-256 checksum, never a duplicate of the prompt body.</p></div>
      {active && <code>{active.contentChecksum.slice(0, 16)}…</code>}
    </section>

    {error && <div className="workspace-notice error" role="alert">{error}</div>}
    {message && <div className="workspace-notice success">{message}</div>}

    {showEditor && <form className="prompt-editor panel" onSubmit={(event) => void save(event)}>
      <div className="section-toolbar"><div><h2>{editing ? `Edit ${editing.displayName}` : "New chat-system prompt"}</h2><p>Changing instruction content requires a new version and matching promoted evaluation.</p></div><button type="button" onClick={() => setShowEditor(false)}>Cancel</button></div>
      <div className="prompt-editor-grid">
        <label><span>Display name</span><input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label><span>Prompt slug</span><input value={draft.slug} disabled={Boolean(editing)} required onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} /></label>
        <label><span>Version</span><input value={draft.version} maxLength={120} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></label>
        <label><span>Runtime purpose</span><input value="Chat system" disabled /></label>
        <label className="wide"><span>Purpose and ownership</span><textarea value={draft.description} minLength={3} maxLength={500} rows={3} required onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="wide"><span>System instruction</span><textarea className="prompt-content-input" value={draft.content} minLength={20} maxLength={20000} rows={12} required spellCheck onChange={(event) => setDraft({ ...draft, content: event.target.value })} /><small>{draft.content.length.toLocaleString("en-US")} / 20,000 characters. Do not place credentials or secret values in prompts.</small></label>
      </div>
      <button className="primary-button prompt-save" type="submit" disabled={busy || editing?.status === "ACTIVE"}>{busy ? "Saving…" : editing ? "Save prompt revision" : "Create draft prompt"}</button>
    </form>}

    <section className="prompt-catalogue" aria-label="Configured prompt templates">
      {prompts.length === 0 && <div className="prompt-empty panel"><strong>No governed prompts yet</strong><span>Chat keeps the built-in instruction until the first evaluated prompt is activated.</span>{canManage && <button type="button" onClick={startCreate}>Create the first prompt</button>}</div>}
      {prompts.map((prompt) => <article className="prompt-card panel" key={prompt.id}>
        <header><div><span className="prompt-purpose">Chat system</span><span className="prompt-version">v{prompt.version}</span></div><span className={`connection-status ${tone(prompt)}`}><i />{prompt.status.toLowerCase()}</span></header>
        <div className="prompt-card-title"><span>P</span><div><h2>{prompt.displayName}</h2><p>{prompt.description}</p></div></div>
        <pre>{prompt.content}</pre>
        <dl><div><dt>Checksum</dt><dd><code>{prompt.contentChecksum.slice(0, 16)}…</code></dd></div><div><dt>Evaluation</dt><dd>{prompt.activationEvaluationId ? "Promoted" : "Required"}</dd></div><div><dt>Updated</dt><dd>{when(prompt.updatedAt)}</dd></div><div><dt>Activation history</dt><dd>{prompt.firstActivatedAt ? "Started" : "Never active"}</dd></div></dl>
        <footer><span>Revision {prompt.revision}</span>{canManage && <div>{prompt.status !== "ACTIVE" && <button type="button" onClick={() => startEdit(prompt)}>Edit</button>}<button type="button" onClick={() => setDecision({ id: prompt.id, action: prompt.status === "ACTIVE" ? "suspend" : "activate", reason: "" })}>{prompt.status === "ACTIVE" ? "Suspend" : "Activate"}</button></div>}</footer>
        {decision?.id === prompt.id && <form className="prompt-decision" onSubmit={(event) => void applyDecision(event)}><div><strong>{decision.action === "activate" ? "Release evaluated prompt" : "Suspend runtime prompt"}</strong><span>{decision.action === "activate" ? `Requires a promoted PROMPT evaluation for prompt:${prompt.slug}, version ${prompt.version}, including CHAT and SAFETY.` : "Suspension makes chat fail closed after prompt governance has been adopted."}</span></div><label><span>Operator reason</span><input value={decision.reason} minLength={3} maxLength={500} required onChange={(event) => setDecision({ ...decision, reason: event.target.value })} /></label><div><button type="button" onClick={() => setDecision(null)}>Cancel</button><button className="primary-button" type="submit" disabled={busy || decision.reason.trim().length < 3}>{busy ? "Applying…" : "Confirm"}</button></div></form>}
      </article>)}
    </section>
  </div>;
}

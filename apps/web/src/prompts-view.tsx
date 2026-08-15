import type { AdministratorSession, CreatePromptTemplate, PromptTemplate } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  changePromptTemplateState,
  createPromptTemplate,
  getPromptTemplates,
  updatePromptTemplate,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, StatusText, Textarea, cn, toneFor,
} from "./ui/index.js";

interface PromptsViewProps {
  session: AdministratorSession | null;
  onOpenOperations: () => void;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

const initialDraft: CreatePromptTemplate = {
  slug: "orcasynapse-chat-system",
  displayName: "OrcaSynapse chat system",
  description: "Approved system behavior for internal employee chat.",
  purpose: "CHAT_SYSTEM",
  version: "1.0.0",
  content: "You are the OrcaSynapse assistant. Be accurate, concise, and explicit about uncertainty. Do not claim to have used tools, enterprise data, or current external information unless that context is present in the conversation.",
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
  const { unlocked, can } = adminAccess(session);
  const canManage = can("prompts:manage");

  const load = async (): Promise<PromptTemplate[]> => {
    if (!unlocked) return prompts;
    try {
      const { items } = await getPromptTemplates();
      setPrompts(items);
      setError(null);
      return items;
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to load prompt templates.");
      return prompts;
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
        // `DrizzlePromptManager` requires a new version for a content change
        // and resets the record to DRAFT; nothing anywhere asks for evidence.
        setMessage("Prompt revision saved. A content change resets it to Draft under its new version, so activate that version to release it.");
      } else {
        await createPromptTemplate({ ...draft, slug: slugify(draft.slug) });
        setMessage("Draft chat-system prompt created.");
      }
      setEditing(null);
      setShowEditor(false);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(cause);
        setError(cause instanceof Error ? cause.message : "Unable to save the prompt template.");
      }
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
      /*
       * Both of these described a runtime that does not exist. Nothing under
       * apps/api/src/chat or apps/worker/src reads PromptTemplate -- the only
       * non-CRUD consumer is one status tile in the Operations overview -- so
       * "new requests use this exact version" was untrue and "chat now fails
       * closed" would have sent an operator hunting a fault that is not there.
       * The fail-closed rule they were both borrowing from belongs to
       * guardrails. See docs/PROMPT_CONTROL_RUNBOOK.md.
       */
      setMessage(decision.action === "activate"
        ? "Chat-system prompt activated and recorded in the audit trail. Chat still takes its system text from the active agent profile."
        : "Prompt suspended and recorded. Chat is unaffected: no runtime component reads the active prompt.");
      setDecision(null);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(cause);
        setError(cause instanceof Error ? cause.message : "Unable to change the prompt state.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Prompt control"
      title="Prompts"
      mark="P"
      reason="Sign in as an administrator to review prompt content, checksums, and activation history; the workspace session you already have stays active."
      actionLabel="Open platform settings"
      onAction={onOpenSettings}
    />;
  }

  const active = prompts.find(({ status }) => status === "ACTIVE");

  return <div className="grid gap-5">
    <PageHeader
      kicker="Prompt control"
      title="Prompts"
      description="Author, version and release the reviewed chat system instruction. Activation records the decision; it does not yet change what a model receives."
      actions={<>
        <Button onClick={onOpenOperations}>Open Operations</Button>
        {canManage && <Button variant="primary" onClick={startCreate}>New prompt</Button>}
      </>}
    />

    <MetricRow className="lg:grid-cols-4" aria-label="Prompt governance summary">
      <Metric label="Prompt records" value={prompts.length} caption="Chat-system purpose" />
      {/* "Fail closed" and "Legacy mode" were the two states of a governed
          mode that was never wired: no active prompt breaks nothing, because
          nothing resolves one. */}
      <Metric
        label="Active release"
        value={active ? "1" : "0"}
        tone={active ? "good" : "neutral"}
        caption={active ? `v${active.version}` : "None released"}
      />
      <Metric
        label="Draft records"
        value={prompts.filter(({ status }) => status === "DRAFT").length}
        caption="Awaiting release"
      />
      <Metric
        label="Instruction size"
        value={active ? active.content.length.toLocaleString("en-US") : "—"}
        caption="Characters"
      />
    </MetricRow>

    {/* The left rule carries whether a release is on record. It used to carry
        a red "fails closed" state for a runtime consequence that does not
        exist -- suspending the active prompt changes nothing anywhere. */}
    <Panel className={cn(
      "flex items-center gap-4 border-l-2",
      active ? "border-l-good" : "border-l-border-strong",
    )}>
      <div className="min-w-0 flex-1">
        <MicroLabel className="block">Release record</MicroLabel>
        <strong className="mt-1.5 block text-label font-semibold text-text">
          {active
            ? `${active.displayName} v${active.version} is the released version.`
            : "No version is currently released."}
        </strong>
        <p className="mb-0 mt-1 text-body text-muted">
          OrcaSynapse keeps one <code className="rounded border border-border bg-raised px-1 font-mono text-accent">CHAT_SYSTEM</code> prompt
          active at a time and audits every lifecycle decision with its version and SHA-256 checksum, never a duplicate
          of the prompt body. No runtime component reads it yet: chat and agent runs take their system text from the
          active agent profile.
        </p>
      </div>
      {active && (
        <code className="shrink-0 rounded border border-border bg-raised px-2 py-1 font-mono text-micro text-muted">
          {active.contentChecksum.slice(0, 16)}…
        </code>
      )}
    </Panel>

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    {showEditor && <Panel>
      <form onSubmit={(event) => void save(event)}>
        <header className="mb-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
              {editing ? `Edit ${editing.displayName}` : "New chat-system prompt"}
            </h2>
            <p className="mb-0 mt-1.5 text-body text-muted">
              Changing instruction content requires a new version and returns the prompt to draft.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowEditor(false)}>Cancel</Button>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name"><Input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="Prompt slug"><Input value={draft.slug} disabled={Boolean(editing)} required onChange={(event) => setDraft({ ...draft, slug: slugAsTyped(event.target.value) })} onBlur={() => setDraft((current) => ({ ...current, slug: slugify(current.slug) }))} /></Field>
          <Field label="Version"><Input value={draft.version} maxLength={120} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></Field>
          <Field label="Runtime purpose"><Input value="Chat system" disabled /></Field>
          <Field label="Purpose and ownership" className="sm:col-span-2">
            <Textarea value={draft.description} minLength={3} maxLength={500} rows={3} required onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </Field>
          <Field
            label="System instruction"
            className="sm:col-span-2"
            hint={`${draft.content.length.toLocaleString("en-US")} / 20,000 characters. Do not place credentials or secret values in prompts.`}
          >
            <Textarea className="min-h-[240px] font-mono" value={draft.content} minLength={20} maxLength={20000} rows={12} required spellCheck onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
          </Field>
        </div>
        <Button variant="primary" type="submit" className="mt-4" disabled={busy || editing?.status === "ACTIVE"}>
          {busy ? "Saving…" : editing ? "Save prompt revision" : "Create draft prompt"}
        </Button>
      </form>
    </Panel>}

    <section className="grid items-start gap-3 lg:grid-cols-2" aria-label="Configured prompt templates">
      {prompts.length === 0 && (
        <EmptyState
          className="lg:col-span-2"
          title="No governed prompts yet"
          action={canManage ? <Button onClick={startCreate}>Create the first prompt</Button> : undefined}
        >
          Chat keeps the built-in instruction until the first prompt is activated.
        </EmptyState>
      )}
      {prompts.map((prompt) => <Panel className="grid min-w-0 gap-4" key={prompt.id}>
        <header className="flex items-center gap-3">
          <MicroLabel className="rounded border border-border bg-raised px-1.5 py-0.5">Chat system</MicroLabel>
          <MicroLabel className="font-mono">v{prompt.version}</MicroLabel>
          <StatusText dot tone={toneFor(tone(prompt))} className="ml-auto">{prompt.status.toLowerCase()}</StatusText>
        </header>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded border border-border-strong bg-raised font-mono text-[10px] font-bold text-accent"
          >
            P
          </span>
          <div className="min-w-0">
            <h2 className="m-0 truncate font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{prompt.displayName}</h2>
            <p className="mb-0 mt-0.5 truncate text-caption text-muted">{prompt.description}</p>
          </div>
        </div>
        {/* The instruction verbatim and scrollable: it is the artefact under
            governance, and a truncated one cannot be reviewed. */}
        <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg p-3 font-mono text-caption leading-relaxed text-muted">
          {prompt.content}
        </pre>
        <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border">
          {[
            { label: "Checksum", value: `${prompt.contentChecksum.slice(0, 16)}…` },
            { label: "Purpose", value: prompt.purpose.toLowerCase().replaceAll("_", " ") },
            { label: "Updated", value: when(prompt.updatedAt) },
            { label: "Activation history", value: prompt.firstActivatedAt ? "Started" : "Never active" },
          ].map((fact) => (
            <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
              <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
              <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <footer className="flex items-center justify-between gap-2.5">
          <StatusText>Revision {prompt.revision}</StatusText>
          {canManage && <div className="flex gap-1.5">
            {prompt.status !== "ACTIVE" && <Button size="sm" onClick={() => startEdit(prompt)}>Edit</Button>}
            <Button
              size="sm"
              variant={prompt.status === "ACTIVE" ? "danger" : "secondary"}
              onClick={() => setDecision({ id: prompt.id, action: prompt.status === "ACTIVE" ? "suspend" : "activate", reason: "" })}
            >
              {prompt.status === "ACTIVE" ? "Suspend" : "Activate"}
            </Button>
          </div>}
        </footer>
        {decision?.id === prompt.id && <form
          className={cn(
            "grid gap-3 rounded border p-3",
            decision.action === "suspend" ? "border-bad/40 bg-bad/10" : "border-border-strong bg-raised",
          )}
          onSubmit={(event) => void applyDecision(event)}
        >
          <div>
            <strong className="block text-label font-semibold text-text">
              {decision.action === "activate" ? "Release prompt" : "Suspend runtime prompt"}
            </strong>
            <span className="mt-1 block text-body text-muted">
              {decision.action === "activate"
                ? `Releases prompt:${prompt.slug}, version ${prompt.version}, as the single active ${prompt.purpose.toLowerCase().replaceAll("_", " ")} instruction.`
                : "Suspension makes chat fail closed after prompt governance has been adopted."}
            </span>
          </div>
          <Field label="Operator reason">
            <Input value={decision.reason} minLength={3} maxLength={500} required onChange={(event) => setDecision({ ...decision, reason: event.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDecision(null)}>Cancel</Button>
            <Button
              variant={decision.action === "suspend" ? "danger" : "primary"}
              type="submit"
              disabled={busy || decision.reason.trim().length < 3}
            >
              {busy ? "Applying…" : "Confirm"}
            </Button>
          </div>
        </form>}
      </Panel>)}
    </section>
  </div>;
}

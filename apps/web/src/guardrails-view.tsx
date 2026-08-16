import type {
  AdministratorSession,
  CreateGuardrailPolicy,
  GuardrailPolicy,
} from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { Switch } from "@/components/ui/switch";
import {
  OrcaSynapseApiError,
  changeGuardrailPolicyState,
  createGuardrailPolicy,
  getGuardrailPolicies,
  updateGuardrailPolicy,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, StatusText, Textarea, cn, toneFor,
} from "./ui/index.js";

interface GuardrailsViewProps {
  session: AdministratorSession | null;
  onConfigureInference: () => void;
  onOpenOperations: () => void;
  onSessionExpired: () => void;
}

type PolicyDraft = CreateGuardrailPolicy;

const initialDraft: PolicyDraft = {
  slug: "chat-safety",
  displayName: "Chat safety",
  description: "Approved input and output controls for internal OrcaSynapse chat.",
  version: "1.0.0",
  maxInputCharacters: 12_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
};

/**
 * How many policies `GET /admin/guardrails` will ever return.
 *
 * `DrizzleGuardrailManager.list` is a bare `limit: 100` and
 * `GuardrailPolicyList` carries no total, so a full array means "at least 100
 * exist". "Policy records" over "Version controlled" is a claim about the
 * table, and past the cap the figure under it is a claim about the response.
 */
const POLICY_WINDOW = 100;

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
  onConfigureInference,
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
  const { unlocked, can } = adminAccess(session);
  const canManage = can("guardrails:manage");

  const load = async (): Promise<GuardrailPolicy[]> => {
    if (!unlocked) return policies;
    try {
      const { items } = await getGuardrailPolicies();
      setPolicies(items);
      setError(null);
      return items;
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "Unable to load guardrail policies.");
      return policies;
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

  const startEdit = (policy: GuardrailPolicy) => {
    setEditing(policy);
    setDraft({
      slug: policy.slug,
      displayName: policy.displayName,
      description: policy.description,
      version: policy.version,
      maxInputCharacters: policy.maxInputCharacters,
      maxOutputCharacters: policy.maxOutputCharacters,
      blockControlCharacters: policy.blockControlCharacters,
      blockCredentialPatterns: policy.blockCredentialPatterns,
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
        await updateGuardrailPolicy(editing.id, {
          displayName: draft.displayName,
          description: draft.description,
          version: draft.version,
          maxInputCharacters: draft.maxInputCharacters,
          maxOutputCharacters: draft.maxOutputCharacters,
          blockControlCharacters: draft.blockControlCharacters,
          blockCredentialPatterns: draft.blockCredentialPatterns,
          expectedRevision: editing.revision,
        });
        // What the server actually does with a material change: it demands a
        // new version number and resets the policy to DRAFT. There is no
        // evidence check in `DrizzleGuardrailManager` and there has not been
        // one since the evaluation subsystem was removed, so the old wording
        // promised operators a gate that would never appear.
        setMessage("Policy updated. A material change resets it to Draft under its new version, so activate that version to enforce it.");
      } else {
        await createGuardrailPolicy({ ...draft, slug: slugify(draft.slug) });
        setMessage("Draft guardrail policy created.");
      }
      setEditing(null);
      setShowEditor(false);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(cause);
        setError(cause instanceof Error ? cause.message : "Unable to save the guardrail policy.");
      }
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
        ? "Guardrail policy activated for chat."
        : "Guardrail policy suspended; chat now fails closed until another policy is active.");
      setDecision(null);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(cause);
        setError(cause instanceof Error ? cause.message : "Unable to change the guardrail policy state.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Policy control"
      title="Guardrails"
      mark="G"
      reason="Sign in as an administrator to inspect policy versions and their activation history; the workspace session you already have stays active."
      actionLabel="Open platform settings"
      onAction={onConfigureInference}
    />;
  }

  const active = policies.find(({ status }) => status === "ACTIVE");
  const activatedBefore = policies.some(({ firstActivatedAt }) => firstActivatedAt !== null);
  const enabledControls = active
    ? Number(active.blockControlCharacters) + Number(active.blockCredentialPatterns)
    : 0;

  return <div className="grid gap-5">
    <PageHeader
      kicker="Policy control"
      title="Guardrails"
      description="Release the limits and deterministic safety checks enforced inside OrcaSynapse."
      actions={<>
        <Button onClick={onOpenOperations}>Open Operations</Button>
        {canManage && <Button variant="primary" onClick={startCreate}>New policy</Button>}
      </>}
    />

    <MetricRow className="lg:grid-cols-4" aria-label="Guardrail policy summary">
      <Metric
        label="Policy records"
        value={policies.length >= POLICY_WINDOW ? `${POLICY_WINDOW}+` : policies.length}
        caption={policies.length >= POLICY_WINDOW ? `Newest ${POLICY_WINDOW} loaded` : "Version controlled"}
      />
      <Metric
        label="Active boundary"
        value={active ? "1" : "0"}
        tone={active ? "good" : activatedBefore ? "bad" : "neutral"}
        caption={active ? active.displayName : activatedBefore ? "Fail closed" : "Legacy mode"}
      />
      <Metric label="Active checks" value={enabledControls} caption="OrcaSynapse-native detectors" />
      <Metric
        label="Input ceiling"
        value={active ? new Intl.NumberFormat("en", { notation: "compact" }).format(active.maxInputCharacters) : "—"}
        caption="Characters per message"
      />
    </MetricRow>

    <Panel className={cn(
      "flex items-center gap-4 border-l-2",
      active ? "border-l-good" : activatedBefore ? "border-l-bad" : "border-l-border-strong",
    )}>
      <div className="min-w-0 flex-1">
        <MicroLabel className="block">Runtime boundary</MicroLabel>
        <strong className="mt-1.5 block text-label font-semibold text-text">
          {active
            ? `${active.displayName} v${active.version} is enforcing chat.`
            : activatedBefore
              ? "Chat policy enforcement is paused and fails closed."
              : "Drafts do not change current chat behavior."}
        </strong>
        <p className="mb-0 mt-1 text-body text-muted">
          OrcaSynapse applies request size, response size, control-character, and credential-pattern checks before
          traffic reaches the approved inference route.
        </p>
      </div>
      <Button className="shrink-0" onClick={onConfigureInference}>Manage AI Inference</Button>
    </Panel>

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    {showEditor && <Panel>
      <form onSubmit={(event) => void save(event)}>
        <header className="mb-4 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
              {editing ? `Edit ${editing.displayName}` : "New chat policy"}
            </h2>
            <p className="mb-0 mt-1.5 text-body text-muted">
              These controls run locally in OrcaSynapse and are pinned to an immutable policy version.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowEditor(false)}>Cancel</Button>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name"><Input value={draft.displayName} minLength={2} maxLength={120} required onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="Policy slug"><Input value={draft.slug} disabled={Boolean(editing)} required onChange={(event) => setDraft({ ...draft, slug: slugAsTyped(event.target.value) })} onBlur={() => setDraft((current) => ({ ...current, slug: slugify(current.slug) }))} /></Field>
          <Field label="Immutable version"><Input value={draft.version} maxLength={120} required onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></Field>
          <Field label="Maximum input characters"><Input type="number" min={256} max={32000} value={draft.maxInputCharacters} required onChange={(event) => setDraft({ ...draft, maxInputCharacters: Number(event.target.value) })} /></Field>
          <Field label="Maximum output characters"><Input type="number" min={1024} max={1000000} value={draft.maxOutputCharacters} required onChange={(event) => setDraft({ ...draft, maxOutputCharacters: Number(event.target.value) })} /></Field>
          <Field label="Purpose and coverage" className="sm:col-span-2">
            <Textarea value={draft.description} minLength={3} maxLength={500} rows={3} required onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </Field>
          <label className="flex cursor-pointer items-center gap-2.5 rounded border border-border bg-raised p-2.5">
            <Switch checked={draft.blockControlCharacters} onCheckedChange={(checked) => setDraft({ ...draft, blockControlCharacters: checked })} />
            <span className="text-body text-text">Block unsafe control characters</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 rounded border border-border bg-raised p-2.5">
            <Switch checked={draft.blockCredentialPatterns} onCheckedChange={(checked) => setDraft({ ...draft, blockCredentialPatterns: checked })} />
            <span className="text-body text-text">Block recognizable credential patterns</span>
          </label>
        </div>
        <Button variant="primary" type="submit" className="mt-4" disabled={busy || editing?.status === "ACTIVE"}>
          {busy ? "Saving…" : editing ? "Save policy revision" : "Create draft policy"}
        </Button>
      </form>
    </Panel>}

    <section className="grid items-start gap-3 lg:grid-cols-2" aria-label="Configured guardrail policies">
      {policies.length === 0 && (
        <EmptyState
          className="lg:col-span-2"
          title="No policy records yet"
          action={canManage ? <Button onClick={startCreate}>Create the first policy</Button> : undefined}
        >
          Chat continues using its existing schema, identity, and rate boundaries until the first policy is
          activated.
        </EmptyState>
      )}
      {policies.map((policy) => <Panel className="grid min-w-0 gap-4" key={policy.id}>
        <header className="flex items-center gap-3">
          <MicroLabel className="font-mono">v{policy.version}</MicroLabel>
          <StatusText dot tone={toneFor(tone(policy))} className="ml-auto">{policy.status.toLowerCase()}</StatusText>
        </header>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded border border-border-strong bg-raised font-mono text-[10px] font-bold text-accent"
          >
            {policy.displayName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="m-0 truncate font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{policy.displayName}</h2>
            <p className="mb-0 mt-0.5 truncate text-caption text-muted">{policy.description}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["OrcaSynapse native",
            ...(policy.blockControlCharacters ? ["control chars"] : []),
            ...(policy.blockCredentialPatterns ? ["credentials"] : []),
          ].map((label) => (
            <code className="rounded border border-border bg-raised px-2 py-1 font-mono text-micro text-muted" key={label}>
              {label}
            </code>
          ))}
        </div>
        <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border">
          {[
            { label: "Input ceiling", value: `${policy.maxInputCharacters.toLocaleString("en-US")} chars` },
            { label: "Output ceiling", value: `${policy.maxOutputCharacters.toLocaleString("en-US")} chars` },
            { label: "Activation", value: policy.firstActivatedAt ? "Started" : "Never active" },
            { label: "Last updated", value: when(policy.updatedAt) },
          ].map((fact) => (
            <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
              <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
              <dd className="m-0 mt-1 truncate font-mono text-caption tabular-nums text-muted">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <footer className="flex items-center justify-between gap-2.5">
          <StatusText>Revision {policy.revision}</StatusText>
          {canManage && <div className="flex gap-1.5">
            {policy.status !== "ACTIVE" && <Button size="sm" onClick={() => startEdit(policy)}>Edit</Button>}
            <Button
              size="sm"
              variant={policy.status === "ACTIVE" ? "danger" : "secondary"}
              onClick={() => setDecision({ id: policy.id, action: policy.status === "ACTIVE" ? "suspend" : "activate", reason: "" })}
            >
              {policy.status === "ACTIVE" ? "Suspend" : "Activate"}
            </Button>
          </div>}
        </footer>
        {decision?.id === policy.id && <form
          className={cn(
            "grid gap-3 rounded border p-3",
            decision.action === "suspend" ? "border-bad/40 bg-bad/10" : "border-border-strong bg-raised",
          )}
          onSubmit={(event) => void applyDecision(event)}
        >
          <div>
            <strong className="block text-label font-semibold text-text">
              {decision.action === "activate" ? "Activate policy" : "Suspend active policy"}
            </strong>
            <span className="mt-1 block text-body text-muted">
              {decision.action === "activate"
                ? `Makes policy:${policy.slug}, version ${policy.version}, the single enforced chat boundary.`
                : "Because this policy has previously enforced chat, suspension deliberately makes chat fail closed."}
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

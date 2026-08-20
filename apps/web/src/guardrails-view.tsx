import type {
  AdministratorSession,
  CreateGuardrailPolicy,
  GuardrailPolicy,
  GuardrailRule,
  GuardrailRuleAction,
  GuardrailRuleType,
} from "@orcasynapse/contracts";
import { GUARDRAIL_RULE_ACTIONS, GUARDRAIL_RULE_TYPES } from "@orcasynapse/contracts";
import { Shield } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Switch } from "@/components/ui/switch";
import { createClientMessageId } from "./client-uuid.js";
import {
  OrcaSynapseApiError,
  changeGuardrailPolicyState,
  createGuardrailPolicy,
  getGuardrailPolicies,
  updateGuardrailPolicy,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, Dialog, EmptyState, Field, Input, LockedScreen,
  Select, StatusText, WorkspaceDock, WorkspaceIntro, cn, toneFor,
} from "./ui/index.js";

interface GuardrailsViewProps {
  session: AdministratorSession | null;
  onConfigureInference: () => void;
  onSessionExpired: () => void;
}

/** The enforceable half of a policy: what a control changes one part of. */
type BoundarySettings = Omit<CreateGuardrailPolicy, "slug" | "displayName" | "description" | "version">;

interface ControlEditor {
  /** Null while the operator is still choosing what to add. */
  kind: ControlKind | null;
  /** Set when editing an existing rule rather than adding one. */
  ruleId: string | null;
  amount: number;
  label: string;
  pattern: string;
  action: GuardrailRuleAction;
  caseSensitive: boolean;
}

/** What each rule type means, in the words an operator needs to choose between them. */
const RULE_TYPE_HELP: Readonly<Record<GuardrailRuleType, string>> = {
  WORD: "Whole word only — “cat” does not match “concatenate”.",
  PHRASE: "Exact text, tolerating a line break where you typed a space.",
  PREFIX: "The start of a word — “sk-” matches “sk-abc” but not “risk-averse”.",
  REGEX: "A regular expression. Checked for patterns that would stall the server.",
};

const RULE_ACTION_HELP: Readonly<Record<GuardrailRuleAction, string>> = {
  BLOCK: "Refuse the message.",
  REDACT: "Replace the match and send the rest.",
  FLAG: "Allow it through and record it — use this to measure a new rule before trusting it.",
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

/**
 * One control is one row, and one row is one thing an operator decided.
 *
 * The four singletons are columns on the policy record; the rule kinds are
 * entries in its `rules` array. Presenting them as one list is what makes the
 * boundary readable: the form this replaces asked for a slug, a version, two
 * ceilings, two detectors and a rule table before it would accept a single
 * blocked word, which put fifteen fields between an operator and one decision.
 *
 * The record underneath is unchanged. Every save is still one immutable
 * version of the whole boundary -- these rows are how it is composed, not a
 * claim that each control activates on its own.
 */
type ControlKind = "INPUT_CEILING" | "OUTPUT_CEILING" | "CONTROL_CHARACTERS" | "CREDENTIAL_PATTERNS" | GuardrailRuleType;

interface ControlDefinition {
  label: string;
  summary: string;
  /** The boundary has one of these, not a list of them. */
  singleton: boolean;
}

const CONTROL_KINDS: Readonly<Record<ControlKind, ControlDefinition>> = {
  INPUT_CEILING: { label: "Input ceiling", summary: "Longest message accepted before the model sees it.", singleton: true },
  OUTPUT_CEILING: { label: "Output ceiling", summary: "Longest response the gateway will return.", singleton: true },
  CONTROL_CHARACTERS: { label: "Control characters", summary: "Refuse unsafe control characters in inspected text.", singleton: true },
  CREDENTIAL_PATTERNS: { label: "Credential patterns", summary: "Refuse text shaped like a key, token or password.", singleton: true },
  WORD: { label: "Word filter", summary: RULE_TYPE_HELP.WORD, singleton: false },
  PHRASE: { label: "Phrase filter", summary: RULE_TYPE_HELP.PHRASE, singleton: false },
  PREFIX: { label: "Prefix filter", summary: RULE_TYPE_HELP.PREFIX, singleton: false },
  REGEX: { label: "Pattern filter", summary: RULE_TYPE_HELP.REGEX, singleton: false },
};

const CONTROL_ORDER: readonly ControlKind[] = [
  "INPUT_CEILING", "OUTPUT_CEILING", "CONTROL_CHARACTERS", "CREDENTIAL_PATTERNS", ...GUARDRAIL_RULE_TYPES,
];

function isRuleKind(kind: ControlKind): kind is GuardrailRuleType {
  return !CONTROL_KINDS[kind].singleton;
}

/**
 * The next version string, bumped on its trailing number.
 *
 * The server refuses a material change that reuses a version, and this screen
 * now saves one control at a time. Asking an operator to hand-author a version
 * for every word they block would turn a governance invariant into a tax, so
 * the screen keeps the invariant and does the typing.
 */
function nextVersion(version: string): string {
  const match = /^(.*?)(\d+)(\D*)$/.exec(version.trim());
  if (!match) return `${version.trim() || "1.0.0"}.1`;
  return `${match[1]}${Number(match[2]) + 1}${match[3]}`;
}

/** Slugs are unique per record, so each version gets one derived from itself. */
function versionSlug(version: string): string {
  const suffix = version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `chat-boundary-${suffix || "1"}`.slice(0, 64);
}

interface ControlRow {
  key: string;
  kind: ControlKind;
  detail: string;
  action: GuardrailRuleAction;
  enabled: boolean;
  /** Present when the row is an entry in `rules` rather than a column. */
  ruleId?: string;
  /** Ceilings always apply once a policy exists, so they cannot be removed. */
  removable: boolean;
}

function controlRows(policy: GuardrailPolicy | null): ControlRow[] {
  if (!policy) return [];
  const rows: ControlRow[] = [
    {
      key: "input-ceiling", kind: "INPUT_CEILING", removable: false, action: "BLOCK", enabled: true,
      detail: `${policy.maxInputCharacters.toLocaleString("en-US")} characters`,
    },
    {
      key: "output-ceiling", kind: "OUTPUT_CEILING", removable: false, action: "BLOCK", enabled: true,
      detail: `${policy.maxOutputCharacters.toLocaleString("en-US")} characters`,
    },
  ];
  if (policy.blockControlCharacters) {
    rows.push({ key: "control-characters", kind: "CONTROL_CHARACTERS", removable: true, action: "BLOCK", enabled: true, detail: "Built-in detector" });
  }
  if (policy.blockCredentialPatterns) {
    rows.push({ key: "credential-patterns", kind: "CREDENTIAL_PATTERNS", removable: true, action: "BLOCK", enabled: true, detail: "Built-in detector" });
  }
  for (const rule of policy.rules) {
    rows.push({
      key: rule.id, kind: rule.type, ruleId: rule.id, removable: true, action: rule.action, enabled: rule.enabled,
      detail: `${rule.label} — ${rule.pattern}${rule.caseSensitive ? "" : " (any case)"}`,
    });
  }
  return rows;
}

/* Audit-trail row grids: a header row and data rows sharing one template. */
const CONTROL_ROW = "grid min-w-[820px] grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_96px_80px_152px] items-center gap-3";
const POLICY_ROW = "grid min-w-[880px] grid-cols-[minmax(0,1.5fr)_64px_120px_minmax(0,1.3fr)_128px_168px] items-center gap-3";

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
  onSessionExpired,
}: GuardrailsViewProps) {
  const [policies, setPolicies] = useState<GuardrailPolicy[]>([]);
  const [control, setControl] = useState<ControlEditor | null>(null);
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
   * holding can never succeed again. Refetch: this screen has no Refresh
   * control and load() runs only on [session], so without this every retry
   * resends the revision that already lost and the only way out is to navigate
   * away and back. `commit` reads the revision from state at call time, so a
   * refetch is all a retry needs.
   */
  const resyncAfterConflict = async (cause: unknown) => {
    if (!(cause instanceof OrcaSynapseApiError) || cause.status !== 409) return;
    await load();
  };

  /*
   * The draft is the only editable record: the server refuses to change an
   * ACTIVE policy, and suspending one to edit it makes chat fail closed. So a
   * control lands on the open draft when there is one, and otherwise starts a
   * new draft seeded from whatever is enforcing -- the live boundary is never
   * touched, and no edit can open an outage window.
   */
  const draftPolicy = policies.find(({ status }) => status === "DRAFT") ?? null;
  const enforcedPolicy = policies.find(({ status }) => status === "ACTIVE") ?? null;
  const workingPolicy = draftPolicy ?? enforcedPolicy;

  const commit = async (settings: BoundarySettings, note: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      /*
       * Read from state at call time rather than from a snapshot taken when
       * the dialog opened. A 409 refetches, so the retry then carries the
       * revision that actually won instead of resending the one that lost.
       */
      const target = policies.find(({ status }) => status === "DRAFT") ?? null;
      if (target) {
        await updateGuardrailPolicy(target.id, {
          ...settings,
          version: nextVersion(target.version),
          expectedRevision: target.revision,
        });
      } else {
        const seed = policies.find(({ status }) => status === "ACTIVE") ?? null;
        const version = seed ? nextVersion(seed.version) : "1.0.0";
        await createGuardrailPolicy({
          ...settings,
          slug: versionSlug(version),
          displayName: "Chat boundary",
          description: seed?.description ?? "Controls enforced on everything sent to the model.",
          version,
        });
      }
      setMessage(note);
      setControl(null);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else {
        await resyncAfterConflict(cause);
        setError(cause instanceof Error ? cause.message : "Unable to save the control.");
      }
    } finally {
      setBusy(false);
    }
  };

  /** The boundary as it stands, which each control then changes one part of. */
  const currentSettings = (): BoundarySettings => ({
    maxInputCharacters: workingPolicy?.maxInputCharacters ?? 12_000,
    maxOutputCharacters: workingPolicy?.maxOutputCharacters ?? 200_000,
    blockControlCharacters: workingPolicy?.blockControlCharacters ?? false,
    blockCredentialPatterns: workingPolicy?.blockCredentialPatterns ?? false,
    rules: workingPolicy ? [...workingPolicy.rules] : [],
  });

  const saveControl = async (event: FormEvent) => {
    event.preventDefault();
    if (!control?.kind) return;
    const settings = currentSettings();
    if (control.kind === "INPUT_CEILING") settings.maxInputCharacters = control.amount;
    else if (control.kind === "OUTPUT_CEILING") settings.maxOutputCharacters = control.amount;
    else if (control.kind === "CONTROL_CHARACTERS") settings.blockControlCharacters = true;
    else if (control.kind === "CREDENTIAL_PATTERNS") settings.blockCredentialPatterns = true;
    else {
      const rule: GuardrailRule = {
        /*
         * Generated here because a rule is a member of a jsonb array, not a
         * row -- there is no insert to return an id from. `createClientMessageId`
         * rather than `crypto.randomUUID` because this product is routinely
         * served over plain HTTP, where `randomUUID` is absent.
         */
        id: control.ruleId ?? createClientMessageId(),
        label: control.label.trim(),
        type: control.kind,
        pattern: control.pattern.trim(),
        action: control.action,
        caseSensitive: control.caseSensitive,
        enabled: true,
      };
      const at = settings.rules.findIndex(({ id }) => id === rule.id);
      if (at >= 0) settings.rules[at] = rule;
      else settings.rules.push(rule);
    }
    await commit(settings, `${CONTROL_KINDS[control.kind].label} saved to the draft boundary. Activate the draft to enforce it.`);
  };

  const removeControl = async (row: ControlRow) => {
    const settings = currentSettings();
    if (row.kind === "CONTROL_CHARACTERS") settings.blockControlCharacters = false;
    else if (row.kind === "CREDENTIAL_PATTERNS") settings.blockCredentialPatterns = false;
    else if (row.ruleId) settings.rules = settings.rules.filter(({ id }) => id !== row.ruleId);
    else return;
    await commit(settings, `${CONTROL_KINDS[row.kind].label} removed from the draft boundary.`);
  };

  const startControl = (kind: ControlKind | null) => {
    setControl({
      kind,
      ruleId: null,
      amount: kind === "OUTPUT_CEILING" ? (workingPolicy?.maxOutputCharacters ?? 200_000) : (workingPolicy?.maxInputCharacters ?? 12_000),
      label: "",
      pattern: "",
      action: "BLOCK",
      caseSensitive: false,
    });
    setError(null);
    setMessage(null);
  };

  const editControl = (row: ControlRow) => {
    const rule = row.ruleId ? workingPolicy?.rules.find(({ id }) => id === row.ruleId) ?? null : null;
    setControl({
      kind: row.kind,
      ruleId: row.ruleId ?? null,
      amount: row.kind === "OUTPUT_CEILING"
        ? (workingPolicy?.maxOutputCharacters ?? 200_000)
        : (workingPolicy?.maxInputCharacters ?? 12_000),
      label: rule?.label ?? "",
      pattern: rule?.pattern ?? "",
      action: rule?.action ?? "BLOCK",
      caseSensitive: rule?.caseSensitive ?? false,
    });
    setError(null);
    setMessage(null);
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
  /*
   * The two built-in detectors plus the operator's enabled rules. Counting only
   * the booleans understated the boundary the moment rules existed: a policy
   * carrying forty rules reported "2".
   */
  const enabledRules = active ? active.rules.filter(({ enabled }) => enabled).length : 0;
  const enabledControls = active
    ? Number(active.blockControlCharacters) + Number(active.blockCredentialPatterns) + enabledRules
    : 0;


  return <div className="workspace-stack guardrails-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
    <WorkspaceIntro
      icon={<Shield className="size-4" aria-hidden="true" />}
      title="Guardrails"
      actions={canManage ? <Button variant="primary" onClick={() => startControl(null)}>Add control</Button> : undefined}
    />

    {/*
      * One strip, one line. This was two stacked cards -- a four-column metric
      * board and a status bar -- roughly 140px of chrome above a table that
      * restated most of it: "Active boundary 0 / Legacy mode" is what "nothing
      * enforcing" already says, and "Input ceiling" is a row in the table three
      * lines below. Figures sit beside their labels rather than under them, so
      * the whole summary costs one line instead of three.
      */}
    <WorkspaceDock className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2">
      <span className="flex shrink-0 items-center gap-2">
        <StatusText dot tone={active ? "good" : activatedBefore ? "bad" : "neutral"}>
          {active ? `Enforcing ${active.version}` : activatedBefore ? "Fail closed" : "Nothing enforcing"}
        </StatusText>
        {draftPolicy && <StatusText dot tone="warn">{`Draft ${draftPolicy.version}`}</StatusText>}
      </span>

      <dl aria-label="Guardrail policy summary" className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {[
          {
            label: "Records",
            value: policies.length >= POLICY_WINDOW ? `${POLICY_WINDOW}+` : String(policies.length),
            caption: policies.length >= POLICY_WINDOW ? `Newest ${POLICY_WINDOW} loaded` : "Version controlled",
          },
          {
            label: "Checks",
            value: String(enabledControls),
            caption: active ? `${enabledControls - enabledRules} built-in · ${enabledRules} rule${enabledRules === 1 ? "" : "s"}` : "No active policy",
          },
        ].map((fact) => (
          <div className="flex min-w-0 items-baseline gap-1.5" key={fact.label}>
            <dt className="text-micro font-semibold uppercase tracking-[0.08em] text-faint">{fact.label}</dt>
            <dd className="m-0 font-mono text-caption tabular-nums text-text">{fact.value}</dd>
            <dd className="m-0 truncate text-micro text-faint">{fact.caption}</dd>
          </div>
        ))}
      </dl>

      {/* No second "Add control" here: that is the page's action and lives in
          the title row. What belongs on the strip is what depends on the state
          the strip is reporting. */}
      {canManage && <span className="ml-auto flex shrink-0 gap-1.5 empty:hidden">
        {draftPolicy && !enforcedPolicy && (
          <Button size="sm" variant="primary" onClick={() => setDecision({ id: draftPolicy.id, action: "activate", reason: "" })}>
            Activate draft
          </Button>
        )}
        {enforcedPolicy && (
          <Button size="sm" variant="danger" onClick={() => setDecision({ id: enforcedPolicy.id, action: "suspend", reason: "" })}>
            Suspend
          </Button>
        )}
      </span>}
    </WorkspaceDock>

    {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}
    {message && <Alert className="shrink-0" tone="good" onDismiss={() => setMessage(null)}>{message}</Alert>}

    {/*
      * One control per visit. The dialog asks what kind first and then only
      * that kind's fields -- the form it replaces demanded slug, version,
      * description, both ceilings, both detectors and a rule table before it
      * would accept a single blocked word.
      */}
    <Dialog
      open={control !== null && canManage}
      onClose={() => setControl(null)}
      className="max-w-[560px]"
      icon={Shield}
      title={control?.kind ? (control.ruleId ? `Edit ${CONTROL_KINDS[control.kind].label.toLowerCase()}` : `Add ${CONTROL_KINDS[control.kind].label.toLowerCase()}`) : "Add a control"}
      description={control?.kind
        ? CONTROL_KINDS[control.kind].summary
        : "Each control is one decision, saved into the draft boundary; the enforced boundary is untouched until that draft is activated. Every control here checks what is sent to the model — responses are capped in length, but their content is not inspected."}
      footer={control?.kind ? <>
        <Button onClick={() => (control.ruleId ? setControl(null) : startControl(null))}>
          {control.ruleId ? "Cancel" : "Back"}
        </Button>
        <Button variant="primary" type="submit" form="guardrail-control-editor" disabled={busy}>
          {busy ? "Saving…" : "Save control"}
        </Button>
      </> : <Button onClick={() => setControl(null)}>Cancel</Button>}
    >
      {control && !control.kind && (
        <ul aria-label="Control types" className="m-0 grid list-none gap-1.5 p-0">
          {CONTROL_ORDER.map((kind) => {
            /* A singleton already on the boundary is edited from its row, not
               added twice -- offering "Add" for it would promise a second one. */
            const present = !CONTROL_KINDS[kind].singleton
              ? false
              : controlRows(workingPolicy).some((row) => row.kind === kind);
            return (
              <li key={kind}>
                <Button
                  size="auto"
                  className="grid w-full grid-cols-1 gap-0.5 px-3 py-2.5 text-left"
                  disabled={present}
                  onClick={() => setControl((open) => (open ? { ...open, kind } : open))}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-label font-medium text-text">{CONTROL_KINDS[kind].label}</span>
                    {present && <StatusText>already set</StatusText>}
                  </span>
                  <span className="text-caption font-normal text-muted">{CONTROL_KINDS[kind].summary}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {control?.kind && (
        <form className="grid content-start gap-3" id="guardrail-control-editor" onSubmit={(event) => void saveControl(event)}>
          {(control.kind === "INPUT_CEILING" || control.kind === "OUTPUT_CEILING") && (
            <Field label="Characters" hint={control.kind === "INPUT_CEILING" ? "Between 256 and 32,000." : "Between 1,024 and 1,000,000."}>
              <Input
                type="number"
                required
                min={control.kind === "INPUT_CEILING" ? 256 : 1_024}
                max={control.kind === "INPUT_CEILING" ? 128_000 : 256_000}
                value={control.amount}
                onChange={(event) => setControl({ ...control, amount: Number(event.target.value) })}
              />
            </Field>
          )}

          {(control.kind === "CONTROL_CHARACTERS" || control.kind === "CREDENTIAL_PATTERNS") && (
            <p className="m-0 rounded border border-border bg-raised px-3 py-2.5 text-caption leading-relaxed text-muted">
              This detector runs inside OrcaSynapse and takes no configuration. Saving adds it to the draft boundary;
              removing it from the table turns it off under a new version.
            </p>
          )}

          {isRuleKind(control.kind) && <>
            <Field label="Label" hint="What an operator sees in a refusal. The pattern itself is never shown to a user.">
              <Input value={control.label} minLength={1} maxLength={120} required onChange={(event) => setControl({ ...control, label: event.target.value })} />
            </Field>
            <Field label={control.kind === "REGEX" ? "Regular expression" : "Text to match"}>
              <Input value={control.pattern} minLength={1} maxLength={200} required onChange={(event) => setControl({ ...control, pattern: event.target.value })} />
            </Field>
            <Field label="When it matches">
              <Select value={control.action} onChange={(event) => setControl({ ...control, action: event.target.value as GuardrailRuleAction })}>
                {GUARDRAIL_RULE_ACTIONS.map((action) => <option key={action} value={action}>{action.toLowerCase()}</option>)}
              </Select>
              <span className="mt-1 block text-caption text-muted">{RULE_ACTION_HELP[control.action]}</span>
            </Field>
            <label className="flex items-center justify-between gap-3 rounded border border-border bg-raised px-3 py-2.5">
              <span className="text-caption text-muted">Case sensitive</span>
              <Switch checked={control.caseSensitive} onCheckedChange={(checked) => setControl({ ...control, caseSensitive: checked })} />
            </label>
          </>}
        </form>
      )}
    </Dialog>

    {/*
      * One table, in the Audit trail's shape: a sticky header over a body that
      * scrolls inside itself. This was three stacked panels -- an "enforced
      * boundary" card, a controls table and a records table -- which divided
      * one subject across three boxes and made the page a column of headings.
      *
      * The boundary card went entirely rather than being folded in: the
      * ceilings and detectors it printed are rows in this table already, so it
      * was the same four facts stated twice. Its remaining job -- which version
      * is enforcing and what to do about it -- is what the dock above carries.
      */}


    {decision && (() => {
      const policy = policies.find(({ id }) => id === decision.id);
      if (!policy) return null;
      return <form
        className={cn(
          "grid shrink-0 gap-3 rounded border p-3",
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
      </form>;
    })()}

    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border" aria-label="Boundary controls">
      <div className={cn(CONTROL_ROW, "shrink-0 border-b border-border bg-raised px-3 py-2")}>
        {["Control", "Configuration", "When it matches", "State", ""].map((head, index) => (
          <span className="text-micro font-semibold uppercase tabular-nums text-faint" key={head || index}>{head}</span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {controlRows(workingPolicy).length === 0 ? (
          <EmptyState
            className="m-3"
            title="No controls yet"
            action={canManage ? <Button onClick={() => startControl(null)}>Add the first control</Button> : undefined}
          >
            Add a ceiling, a detector or a filter. Each is one row here, and together they are the boundary this
            deployment enforces.
          </EmptyState>
        ) : (
          <ul aria-label="Boundary control rows" className="m-0 list-none p-0">
            {controlRows(workingPolicy).map((row) => (
              <li className={cn(CONTROL_ROW, "border-b border-border/60 px-3 py-2 last:border-b-0")} key={row.key}>
                <span className="min-w-0">
                  <span className="block truncate text-label font-medium text-text">{CONTROL_KINDS[row.kind].label}</span>
                  <span className="block truncate text-micro text-faint">{CONTROL_KINDS[row.kind].summary}</span>
                </span>
                <span className="min-w-0 truncate font-mono text-caption text-muted">{row.detail}</span>
                <StatusText tone={row.action === "BLOCK" ? "bad" : row.action === "REDACT" ? "warn" : "neutral"}>
                  {row.action.toLowerCase()}
                </StatusText>
                <StatusText tone={row.enabled ? "good" : "neutral"}>{row.enabled ? "on" : "off"}</StatusText>
                {canManage ? (
                  <span className="flex justify-end gap-1.5">
                    {/* A ceiling has no "off": the schema carries a number for
                        it on every record, so it is edited, never removed. */}
                    <Button size="sm" onClick={() => editControl(row)}>Edit</Button>
                    {row.removable && (
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void removeControl(row)}>Remove</Button>
                    )}
                  </span>
                ) : <span />}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Folded, because it is the one thing on this screen an operator reads
          rarely: every version ever drafted, under the table it produced. */}
      <details className="shrink-0 border-t border-border">
        <summary className="cursor-pointer list-none px-3 py-2 text-caption text-muted select-none hover:text-text [&::-webkit-details-marker]:hidden">
          Version history — {policies.length} record{policies.length === 1 ? "" : "s"}
          {policies.length >= POLICY_WINDOW ? " (newest 100)" : ""}
        </summary>
        <ul aria-label="Configured guardrail policies" className="m-0 max-h-[220px] list-none overflow-auto p-0">
          {policies.length === 0 && <li className="px-3 py-2 text-caption text-faint">No policy has been drafted yet.</li>}
          {policies.map((policy) => (
            <li className={cn(POLICY_ROW, "border-t border-border/60 px-3 py-2")} key={policy.id}>
              <h3 className="m-0 truncate text-label font-medium text-text">{policy.displayName}</h3>
              <span className="font-mono text-caption tabular-nums text-muted">v{policy.version}</span>
              <StatusText dot tone={toneFor(tone(policy))}>{policy.status.toLowerCase()}</StatusText>
              <span className="min-w-0 truncate font-mono text-micro tabular-nums text-muted">
                {policy.maxInputCharacters.toLocaleString("en-US")} in · {policy.rules.length} rule{policy.rules.length === 1 ? "" : "s"}
              </span>
              <span className="font-mono text-micro tabular-nums text-faint">{when(policy.updatedAt)}</span>
              {canManage && policy.status !== "ACTIVE" && policy.status !== "DRAFT" ? (
                <span className="flex justify-end">
                  <Button size="sm" onClick={() => setDecision({ id: policy.id, action: "activate", reason: "" })}>Activate</Button>
                </span>
              ) : <span />}
            </li>
          ))}
        </ul>
      </details>
    </div>
  </div>;
}

import type {
  AdministratorSession,
  AgentMemoryRecord,
  CreateMemoryPolicy,
  ForgetMatchingResult,
  MemoryPolicy,
} from "@orcasynapse/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  changeMemoryPolicyState,
  createMemoryPolicy,
  deleteAgentMemoryRecord,
  getAgentMemoryRecords,
  getMemoryPolicies,
  forgetMatchingAgentMemory,
  purgeAgentMemory,
  updateMemoryPolicy,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, PageHeader, Panel, PanelHeading,
  Select, StatusText, toneFor,
} from "./ui/index.js";

interface MemoryViewProps {
  session: AdministratorSession | null;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

const blankPolicy: CreateMemoryPolicy = {
  slug: "default-memory",
  displayName: "Default memory policy",
  description: "Bounds what every agent may remember about the people it serves.",
  maximumCaptureMode: "LEARN_USER",
  retentionDays: 365,
  maximumItemsPerOwner: 500,
  recallLimit: 6,
  recallMinimumScore: 0.4,
  knowledgeRecallLimit: 18,
  knowledgeMinimumScore: 0.35,
  distillCapture: true,
};

/**
 * Explains the ceiling in terms of the effect it has, not the enum value, so an
 * operator can tell at a glance whether anything is being stored about anyone.
 */
function ceilingSummary(mode: CreateMemoryPolicy["maximumCaptureMode"]): string {
  if (mode === "DOCUMENTS_ONLY") return "No agent stores anything about a person, whatever its profile asks for.";
  if (mode === "RECALL_ONLY") return "Agents may use memory that already exists, but none may add to it.";
  if (mode === "LEARN_USER") return "Agents may store what a person says. Model output is never retained.";
  return "Agents may store both sides of a turn, including model output, when their profile asks for it.";
}

function statusTone(status: MemoryPolicy["status"]): string {
  if (status === "ACTIVE") return "ready";
  if (status === "SUSPENDED") return "failed";
  return "neutral";
}

export function MemoryView({ session, onOpenSettings, onSessionExpired }: MemoryViewProps) {
  const [policies, setPolicies] = useState<MemoryPolicy[]>([]);
  const [records, setRecords] = useState<AgentMemoryRecord[]>([]);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [forgetTarget, setForgetTarget] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<ForgetMatchingResult | null>(null);
  const [draft, setDraft] = useState<CreateMemoryPolicy>(blankPolicy);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reason, setReason] = useState("Memory retention reviewed and approved.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { unlocked, can } = adminAccess(session);
  const canManage = can("memory:manage");
  const active = policies.find(({ status }) => status === "ACTIVE") ?? null;

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the memory operation.");
  }, [onSessionExpired]);

  const load = useCallback(async () => {
    const [policyList, recordList] = await Promise.all([
      getMemoryPolicies(),
      getAgentMemoryRecords({
        ...(ownerFilter.trim() ? { ownerSubject: ownerFilter.trim() } : {}),
        limit: 100,
        includeHistory: showHistory,
      }),
    ]);
    setPolicies(policyList.items);
    setRecords(recordList.items);
  }, [ownerFilter, showHistory]);

  useEffect(() => {
    if (!unlocked) { setPolicies([]); setRecords([]); return; }
    let live = true;
    void load().catch((cause) => live && fail(cause));
    return () => { live = false; };
  }, [unlocked, load, fail]);

  const savePolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canManage) return;
    setBusy(true); setError(null);
    try {
      if (editingId) {
        const current = policies.find(({ id }) => id === editingId);
        if (current) await updateMemoryPolicy(editingId, { ...draft, expectedRevision: current.revision });
      } else {
        await createMemoryPolicy(draft);
      }
      setEditingId(null);
      setDraft(blankPolicy);
      await load();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  const changeState = async (policy: MemoryPolicy, action: "activate" | "suspend") => {
    if (busy || !canManage || reason.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      await changeMemoryPolicyState(policy.id, action, { expectedRevision: policy.revision, reason: reason.trim() });
      await load();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  const forget = async (record: AgentMemoryRecord) => {
    if (busy || !canManage || reason.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      await deleteAgentMemoryRecord(record.id, reason.trim());
      await load();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  /**
   * Two steps on purpose: the operator sees which facts a model judged to be
   * about the topic, and only then commits. A semantic bulk delete without the
   * preview is not something worth offering.
   */
  const previewForget = async () => {
    if (busy || !canManage || !ownerFilter.trim() || !forgetTarget.trim() || reason.trim().length < 3) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      setPreview(await forgetMatchingAgentMemory({
        ownerSubject: ownerFilter.trim(), target: forgetTarget.trim(), reason: reason.trim(), dryRun: true,
      }));
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  const commitForget = async () => {
    if (busy || !canManage || !preview || preview.candidates.length === 0) return;
    setBusy(true); setError(null);
    try {
      await forgetMatchingAgentMemory({
        ownerSubject: ownerFilter.trim(), target: forgetTarget.trim(), reason: reason.trim(), dryRun: false,
      });
      setPreview(null); setForgetTarget("");
      await load();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  const purgeOwner = async () => {
    if (busy || !canManage || !ownerFilter.trim() || reason.trim().length < 3) return;
    setBusy(true); setError(null);
    try {
      await purgeAgentMemory(ownerFilter.trim(), reason.trim());
      await load();
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };

  const heading = <PageHeader
    className="mb-0"
    kicker="Retention governance"
    title="Memory"
    description="What agents may remember about the people they serve, and everything they currently hold."
  />;

  if (!unlocked) {
    return <LockedScreen
      kicker="Retention governance"
      title="Memory"
      mark="M"
      reason="Unlock OrcaSynapse to review the retention ceiling and everything agents currently remember."
      actionLabel="Open platform settings"
      onAction={onOpenSettings}
    />;
  }

  return <div className="grid gap-5">
    {heading}

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

    <Panel>
      <PanelHeading kicker="Installation ceiling" title="Memory policy" />
      <p className="mb-4 mt-0 text-body text-muted">
        {active
          ? ceilingSummary(active.maximumCaptureMode)
          : "No policy is active, so each agent's own profile governs what it stores."}
      </p>

      <div className="grid gap-2">
        {policies.map((policy) => <article
          className="flex items-start justify-between gap-4 rounded border border-border bg-raised p-3"
          key={policy.id}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <strong className="text-[12px] font-semibold text-text">{policy.displayName}</strong>
              <StatusText dot tone={toneFor(statusTone(policy.status))}>{policy.status.toLowerCase()}</StatusText>
            </div>
            <small className="mt-1.5 block text-body text-muted">{ceilingSummary(policy.maximumCaptureMode)}</small>
            <small className="mt-1 block text-caption text-faint">
              Retention {policy.retentionDays === null ? "indefinite" : `${policy.retentionDays} days`} ·
              up to {policy.maximumItemsPerOwner} items per person · recall {policy.recallLimit} above {policy.recallMinimumScore}
            </small>
            <small className="mt-0.5 block text-caption text-faint">
              Documents: up to {policy.knowledgeRecallLimit} excerpts above {policy.knowledgeMinimumScore}
            </small>
            <small className="mt-0.5 block text-caption text-faint">
              Capture: {policy.distillCapture ? "extracted facts only" : "whole turns, unfiltered"}
            </small>
          </div>
          {canManage && <div className="flex shrink-0 gap-1.5">
            {policy.status !== "ACTIVE" && (
              <Button size="sm" disabled={busy} onClick={() => { setEditingId(policy.id); setDraft({ ...policy }); }}>Edit</Button>
            )}
            {policy.status === "ACTIVE"
              ? <Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void changeState(policy, "suspend")}>Suspend</Button>
              : <Button variant="primary" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void changeState(policy, "activate")}>Activate</Button>}
          </div>}
        </article>)}
        {policies.length === 0 && (
          <EmptyState title="No memory policy yet">Create one to bound every agent at once.</EmptyState>
        )}
      </div>

      {canManage && <form className="mt-5 grid gap-3 border-t border-border pt-5 sm:grid-cols-2" onSubmit={savePolicy}>
        <Field label="Slug"><Input required value={draft.slug} disabled={editingId !== null} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} /></Field>
        <Field label="Name"><Input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
        <Field label="Most an agent may store" className="sm:col-span-2" hint={ceilingSummary(draft.maximumCaptureMode)}>
          <Select value={draft.maximumCaptureMode} onChange={(event) => setDraft({ ...draft, maximumCaptureMode: event.target.value as CreateMemoryPolicy["maximumCaptureMode"] })}>
            <option value="DOCUMENTS_ONLY">Nothing about people</option>
            <option value="RECALL_ONLY">Recall only, no new memory</option>
            <option value="LEARN_USER">What the person says</option>
            <option value="LEARN_EXCHANGE">Both sides of the turn</option>
          </Select>
        </Field>
        <Field label="Retention (days)"><Input type="number" min={1} max={3650} value={draft.retentionDays ?? ""} placeholder="Indefinite" onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value ? Number(event.target.value) : null })} /></Field>
        <Field label="Items per person"><Input type="number" min={10} max={10000} value={draft.maximumItemsPerOwner} onChange={(event) => setDraft({ ...draft, maximumItemsPerOwner: Number(event.target.value) })} /></Field>
        <Field label="Document excerpts per answer" hint="How many passages a run may retrieve from your documents.">
          <Input type="number" min={1} max={50} value={draft.knowledgeRecallLimit} onChange={(event) => setDraft({ ...draft, knowledgeRecallLimit: Number(event.target.value) })} />
        </Field>
        <Field label="Document relevance floor" hint="Below this similarity a passage is treated as noise. Lower it when questions are phrased unlike the source text; raise it if answers drift.">
          <Input type="number" min={0} max={1} step={0.05} value={draft.knowledgeMinimumScore} onChange={(event) => setDraft({ ...draft, knowledgeMinimumScore: Number(event.target.value) })} />
        </Field>
        <label className="grid cursor-pointer gap-1.5 rounded border border-border bg-raised p-3 sm:col-span-2">
          <span className="flex items-center gap-2.5 text-body text-text">
            <input type="checkbox" checked={draft.distillCapture} onChange={(event) => setDraft({ ...draft, distillCapture: event.target.checked })} />
            Store extracted facts instead of whole turns
          </span>
          <small className="text-caption leading-relaxed text-muted">
            A turn is mostly questions, greetings and the assistant talking about itself, and storing it verbatim makes
            recall match old questions rather than useful facts. With this on, a second model call after the answer
            extracts durable facts about the person and stores only those — usually none.
          </small>
        </label>
        <footer className="flex justify-end gap-2 sm:col-span-2">
          {editingId && <Button onClick={() => { setEditingId(null); setDraft(blankPolicy); }}>Cancel</Button>}
          <Button variant="primary" type="submit" disabled={busy}>{editingId ? "Save policy" : "Create policy"}</Button>
        </footer>
      </form>}

      {canManage && (
        <Field
          className="mt-4 max-w-[520px]"
          label="Decision reason"
          hint="Recorded in the audit trail with every activation, suspension, and deletion."
        >
          <Input minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      )}
    </Panel>

    <Panel>
      <PanelHeading
        kicker="Stored memory"
        title="What agents currently hold"
        actions={
          <>
            <Input
              className="w-[180px]"
              placeholder="Filter by person"
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
            />
            {/*
              * History is off by default so the list answers "what would this
              * agent recall right now". Turning it on brings in corrections and
              * forgotten facts, which is a different question and worth asking
              * for deliberately.
              */}
            <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-body text-muted">
              <input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} />
              Show corrected and forgotten
            </label>
            {canManage && ownerFilter.trim() && (
              <Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void purgeOwner()}>
                Forget everything for this person
              </Button>
            )}
          </>
        }
      />

      {canManage && ownerFilter.trim() && <div className="mb-4 grid gap-3 rounded border border-border bg-raised p-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Forget by topic" className="min-w-[220px] flex-1">
            <Input
              placeholder="e.g. Project Titan"
              value={forgetTarget}
              onChange={(event) => { setForgetTarget(event.target.value); setPreview(null); }}
            />
          </Field>
          <Button
            disabled={busy || !forgetTarget.trim() || reason.trim().length < 3}
            onClick={() => void previewForget()}
          >
            Preview what matches
          </Button>
        </div>
        <small className="text-caption text-muted">
          Between deleting one fact and forgetting a person entirely. Nothing changes until you confirm.
        </small>

        {preview && <div className="grid gap-2.5 rounded border border-border bg-surface p-3">
          {preview.candidates.length === 0
            ? <p className="m-0 text-body text-muted"><strong className="text-text">Nothing matched.</strong> No stored fact was judged to be about “{forgetTarget.trim()}”.</p>
            : <>
                <p className="m-0 text-body text-muted">
                  <strong className="text-text">{preview.matched} fact{preview.matched === 1 ? "" : "s"}</strong> judged to be about “{forgetTarget.trim()}”:
                </p>
                <ul className="m-0 grid list-none gap-1 p-0">
                  {preview.candidates.map((candidate) => (
                    <li className="rounded border border-border bg-raised px-2.5 py-2 text-body text-text" key={candidate.id}>
                      {candidate.content}
                    </li>
                  ))}
                </ul>
                {preview.capped && <StatusText tone="warn" className="normal-case">
                  More matched than the per-request limit allows; only the first {preview.candidates.length} would be forgotten.
                </StatusText>}
                {preview.truncated && <StatusText tone="warn" className="normal-case">
                  This person has more stored memory than one pass can read, so the scan was partial.
                </StatusText>}
                <Button variant="danger" className="justify-self-end" disabled={busy} onClick={() => void commitForget()}>
                  Forget these {preview.candidates.length}
                </Button>
              </>}
        </div>}
      </div>}

      {records.length === 0
        ? <EmptyState title="Nothing stored">No agent has recorded anything about anyone in this scope.</EmptyState>
        : <><p className="mb-3 mt-0 rounded border border-border bg-raised px-3 py-2.5 text-body leading-relaxed text-muted">
            Facts marked <strong className="text-good">always shown</strong> are placed in every prompt to that agent,
            whatever the question was — that is how a preference nobody would think to ask about
            still reaches an answer. <strong className="text-warn">Current context</strong> is included the same way but
            describes something expected to change. Everything else is reached only by search.
          </p>
          <div className="grid gap-2">{records.map((record) => <article
            className="flex items-start justify-between gap-4 rounded border border-border bg-raised p-3"
            key={record.id}
          >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong className="text-[12px] font-semibold text-text">{record.ownerSubject}</strong>
            <StatusText>{record.agentProfileSlug}</StatusText>
            {record.profileScope !== "EPISODIC" && (
              <StatusText tone={record.profileScope === "STATIC" ? "good" : "warn"}>
                {record.profileScope === "STATIC" ? "always shown" : "current context"}
              </StatusText>
            )}
            {/*
              * A fact past its first version was corrected. Saying so beside the
              * content is the difference between a store you can audit and a
              * list of sentences: the chain has existed since ai-v1.49.3 and was
              * never shown, so nothing distinguished a current belief from one
              * the person had already changed.
              */}
            {record.version > 1 && <StatusText tone="accent">v{record.version}</StatusText>}
            {!record.isLatest && <StatusText tone="neutral">superseded</StatusText>}
            {record.forgottenAt !== null && <StatusText tone="bad">forgotten</StatusText>}
            </div>
            <p className="mb-0 mt-2 text-body leading-relaxed text-text">{record.content}</p>
            {record.supersededReason && (
              <small className="mt-1.5 block text-caption text-faint">Retired: {record.supersededReason}</small>
            )}
            {record.forgetReason && (
              <small className="mt-1.5 block text-caption text-faint">
                Forgotten: {record.forgetReason}
                {record.forgetBatchId ? ` · batch ${record.forgetBatchId.slice(0, 8)}` : ""}
              </small>
            )}
            <small className="mt-1.5 block font-mono text-micro text-faint">
              Recorded {new Date(record.createdAt).toLocaleString()}
              {record.retentionUntil ? ` · expires ${new Date(record.retentionUntil).toLocaleDateString()}` : " · no expiry"}
            </small>
          </div>
          {canManage && record.isLatest && record.forgottenAt === null && (
            <Button variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void forget(record)}>
              Forget
            </Button>
          )}
        </article>)}</div></>}
    </Panel>
  </div>;
}

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
import { Button, StatusText } from "./ui/index.js";

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

  const heading = <header className="memory-header">
    <div>
      <p className="page-kicker">Retention governance</p>
      <h1>Memory</h1>
      <p>What agents may remember about the people they serve, and everything they currently hold.</p>
    </div>
  </header>;

  if (!unlocked) {
    return <div className="memory-workspace">
      {heading}
      <section className="memory-lock panel">
        <span className="memory-lock-mark">M</span>
        <div>
          <strong>Administrator session required</strong>
          <p>Unlock OrcaSynapse to review the retention ceiling and everything agents currently remember.</p>
        </div>
        <button className="primary-button" type="button" onClick={onOpenSettings}>Open platform settings</button>
      </section>
    </div>;
  }

  return <section className="memory-workspace">
    {heading}

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

    <section className="panel">
      <div className="document-section-heading">
        <div><p className="section-kicker">Installation ceiling</p><h2>Memory policy</h2></div>
      </div>
      <p className="memory-ceiling-note">
        {active
          ? ceilingSummary(active.maximumCaptureMode)
          : "No policy is active, so each agent's own profile governs what it stores."}
      </p>

      <div className="memory-policy-list">
        {policies.map((policy) => <article key={policy.id}>
          <div>
            <strong>{policy.displayName}</strong>
            <span className={`document-status ${statusTone(policy.status)}`}>{policy.status.toLowerCase()}</span>
            <small>{ceilingSummary(policy.maximumCaptureMode)}</small>
            <small>
              Retention {policy.retentionDays === null ? "indefinite" : `${policy.retentionDays} days`} ·
              up to {policy.maximumItemsPerOwner} items per person · recall {policy.recallLimit} above {policy.recallMinimumScore}
            </small>
            <small>Documents: up to {policy.knowledgeRecallLimit} excerpts above {policy.knowledgeMinimumScore}</small>
            <small>Capture: {policy.distillCapture ? "extracted facts only" : "whole turns, unfiltered"}</small>
          </div>
          {canManage && <div className="memory-policy-actions">
            {policy.status !== "ACTIVE" && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setEditingId(policy.id); setDraft({ ...policy }); }}>Edit</button>}
            {policy.status === "ACTIVE"
              ? <button type="button" className="danger-button" disabled={busy || reason.trim().length < 3} onClick={() => void changeState(policy, "suspend")}>Suspend</button>
              : <button type="button" className="primary-button" disabled={busy || reason.trim().length < 3} onClick={() => void changeState(policy, "activate")}>Activate</button>}
          </div>}
        </article>)}
        {policies.length === 0 && <p className="document-empty"><strong>No memory policy yet</strong><span>Create one to bound every agent at once.</span></p>}
      </div>

      {canManage && <form className="memory-policy-form" onSubmit={savePolicy}>
        <label>Slug<input required value={draft.slug} disabled={editingId !== null} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} /></label>
        <label>Name<input required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
        <label>Description<input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label>Most an agent may store<select value={draft.maximumCaptureMode} onChange={(event) => setDraft({ ...draft, maximumCaptureMode: event.target.value as CreateMemoryPolicy["maximumCaptureMode"] })}>
          <option value="DOCUMENTS_ONLY">Nothing about people</option>
          <option value="RECALL_ONLY">Recall only, no new memory</option>
          <option value="LEARN_USER">What the person says</option>
          <option value="LEARN_EXCHANGE">Both sides of the turn</option>
        </select><small>{ceilingSummary(draft.maximumCaptureMode)}</small></label>
        <label>Retention (days)<input type="number" min={1} max={3650} value={draft.retentionDays ?? ""} placeholder="Indefinite" onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Items per person<input type="number" min={10} max={10000} value={draft.maximumItemsPerOwner} onChange={(event) => setDraft({ ...draft, maximumItemsPerOwner: Number(event.target.value) })} /></label>
        <label>Document excerpts per answer<input type="number" min={1} max={50} value={draft.knowledgeRecallLimit} onChange={(event) => setDraft({ ...draft, knowledgeRecallLimit: Number(event.target.value) })} /><small>How many passages a run may retrieve from your documents.</small></label>
        <label>Document relevance floor<input type="number" min={0} max={1} step={0.05} value={draft.knowledgeMinimumScore} onChange={(event) => setDraft({ ...draft, knowledgeMinimumScore: Number(event.target.value) })} /><small>Below this similarity a passage is treated as noise. Lower it when questions are phrased unlike the source text; raise it if answers drift.</small></label>
        <label className="memory-toggle"><input type="checkbox" checked={draft.distillCapture} onChange={(event) => setDraft({ ...draft, distillCapture: event.target.checked })} />Store extracted facts instead of whole turns<small>A turn is mostly questions, greetings and the assistant talking about itself, and storing it verbatim makes recall match old questions rather than useful facts. With this on, a second model call after the answer extracts durable facts about the person and stores only those — usually none.</small></label>
        <footer>
          {editingId && <button type="button" className="secondary-button" onClick={() => { setEditingId(null); setDraft(blankPolicy); }}>Cancel</button>}
          <button type="submit" className="primary-button" disabled={busy}>{editingId ? "Save policy" : "Create policy"}</button>
        </footer>
      </form>}

      {canManage && <label className="memory-reason">Decision reason<input minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /><small>Recorded in the audit trail with every activation, suspension, and deletion.</small></label>}
    </section>

    <section className="panel">
      <div className="document-section-heading">
        <div><p className="section-kicker">Stored memory</p><h2>What agents currently hold</h2></div>
        <div className="memory-filter">
          <input placeholder="Filter by person" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)} />
          {/*
            * History is off by default so the list answers "what would this
            * agent recall right now". Turning it on brings in corrections and
            * forgotten facts, which is a different question and worth asking
            * for deliberately.
            */}
          <label className="memory-history-toggle">
            <input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} />
            Show corrected and forgotten
          </label>
          {canManage && ownerFilter.trim() && <button type="button" className="danger-button" disabled={busy || reason.trim().length < 3} onClick={() => void purgeOwner()}>Forget everything for this person</button>}
        </div>
      </div>

      {canManage && ownerFilter.trim() && <div className="memory-forget-topic">
        <label>Forget by topic
          <input
            placeholder="e.g. Project Titan"
            value={forgetTarget}
            onChange={(event) => { setForgetTarget(event.target.value); setPreview(null); }}
          />
        </label>
        <button
          type="button"
          disabled={busy || !forgetTarget.trim() || reason.trim().length < 3}
          onClick={() => void previewForget()}
        >Preview what matches</button>
        <small>Between deleting one fact and forgetting a person entirely. Nothing changes until you confirm.</small>

        {preview && <div className="memory-forget-preview">
          {preview.candidates.length === 0
            ? <p><strong>Nothing matched.</strong> No stored fact was judged to be about “{forgetTarget.trim()}”.</p>
            : <>
                <p><strong>{preview.matched} fact{preview.matched === 1 ? "" : "s"}</strong> judged to be about “{forgetTarget.trim()}”:</p>
                <ul>{preview.candidates.map((candidate) => <li key={candidate.id}>{candidate.content}</li>)}</ul>
                {preview.capped && <p className="memory-forget-warning">
                  More matched than the per-request limit allows; only the first {preview.candidates.length} would be forgotten.
                </p>}
                {preview.truncated && <p className="memory-forget-warning">
                  This person has more stored memory than one pass can read, so the scan was partial.
                </p>}
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={() => void commitForget()}
                >Forget these {preview.candidates.length}</button>
              </>}
        </div>}
      </div>}

      {records.length === 0
        ? <div className="document-empty"><strong>Nothing stored</strong><span>No agent has recorded anything about anyone in this scope.</span></div>
        : <><p className="chat-policy-note">
            Facts marked <strong>always shown</strong> are placed in every prompt to that agent,
            whatever the question was — that is how a preference nobody would think to ask about
            still reaches an answer. <strong>Current context</strong> is included the same way but
            describes something expected to change. Everything else is reached only by search.
          </p>
          <div className="memory-record-list">{records.map((record) => <article key={record.id}>
          <div>
            <strong>{record.ownerSubject}</strong>
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
            <p>{record.content}</p>
            {record.supersededReason && (
              <small className="memory-record-lineage">Retired: {record.supersededReason}</small>
            )}
            {record.forgetReason && (
              <small className="memory-record-lineage">
                Forgotten: {record.forgetReason}
                {record.forgetBatchId ? ` · batch ${record.forgetBatchId.slice(0, 8)}` : ""}
              </small>
            )}
            <small>
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
    </section>
  </section>;
}

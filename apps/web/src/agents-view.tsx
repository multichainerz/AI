import type { AgentMetrics, AgentProfile, AgentRun, AgentRunEvent, AgentRuntimeControl, AgentSkillReference, CreateAgentProfile } from "@aihub/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  cancelAgentRun,
  createAgentProfile,
  getAgentMetrics,
  getAgentProfiles,
  getAgentRunEvents,
  getAgentRuns,
  getAgentRuntime,
  setAgentProfileState,
  submitAgentRun,
  updateAgentProfile,
  updateAgentRuntime,
} from "./api.js";

interface AgentsViewProps {
  unlocked: boolean;
  administrator: boolean;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onUnauthorized: () => void;
}

const runningStatuses = new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);
const terminalGood = new Set(["COMPLETED"]);

const blankProfile: CreateAgentProfile = {
  slug: "hermes-analyst",
  displayName: "Hermes Analyst",
  purpose: "A bounded on-premise assistant for internal analysis and document-grounded answers.",
  instructions: "Provide concise, evidence-based answers. Clearly distinguish retrieved facts from analysis and state uncertainty.",
  soulMd: "You are a careful MPM analyst. Be calm, precise, evidence-led, and candid about uncertainty.",
  skills: [],
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  allowPrivateKnowledge: true,
  safeMode: true,
};

function skillManifestText(skills: AgentSkillReference[]): string {
  return skills.map((skill) => `${skill.name}@${skill.version} ${skill.digest}`).join("\n");
}

function parseSkillManifest(value: string): AgentSkillReference[] | null {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line) => /^([a-z0-9]+(?:-[a-z0-9]+)*)@([A-Za-z0-9][A-Za-z0-9._+-]*)\s+([a-f0-9]{64})$/.exec(line));
  if (parsed.some((match) => !match)) return null;
  return parsed.map((match) => ({ name: match![1]!, version: match![2]!, digest: match![3]! }));
}

function statusTone(status: AgentRun["status"] | AgentProfile["status"]): string {
  if (terminalGood.has(status) || status === "ACTIVE") return "ready";
  if (runningStatuses.has(status) || status === "STANDBY") return "processing";
  if (["FAILED", "TIMED_OUT", "DENIED"].includes(status)) return "failed";
  return "neutral";
}

function friendlyTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function eventTitle(event: AgentRunEvent): string {
  return event.type.replaceAll("_", " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

function eventDetail(event: AgentRunEvent): string {
  if (event.summary) return event.summary;
  if (event.toolName) return `Governed tool: ${event.toolName}`;
  if (event.childSessionId) return `Temporary child session ${event.childSessionId}`;
  if (event.status) return `Hermes status: ${event.status}`;
  return "Hermes emitted a bounded lifecycle event.";
}

function draftFromProfile(profile: AgentProfile): CreateAgentProfile {
  return {
    slug: profile.slug,
    displayName: profile.version.displayName,
    purpose: profile.version.purpose,
    instructions: profile.version.instructions,
    soulMd: profile.version.soulMd,
    skills: profile.version.skills,
    modelAlias: profile.version.modelAlias,
    maxTurns: 1,
    timeoutSeconds: profile.version.timeoutSeconds,
    maxConcurrentRuns: profile.version.maxConcurrentRuns,
    allowPrivateKnowledge: profile.version.allowPrivateKnowledge,
    safeMode: true,
  };
}

export function AgentsView({ unlocked, administrator, oidcConfigured, onSignIn, onConfigure, onUnauthorized }: AgentsViewProps) {
  const runsRef = useRef<AgentRun[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([]);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeControl | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [reason, setReason] = useState("Runtime and Profile Distribution boundaries verified by the platform administrator.");
  const [profileDraft, setProfileDraft] = useState<CreateAgentProfile>(blankProfile);
  const [skillsDraft, setSkillsDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRun = useMemo(() => runs.find(({ id }) => id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);

  const fail = (cause: unknown) => {
    if (cause instanceof AIHubApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : "AIHub could not complete the agent operation.");
  };

  const load = async () => {
    const [profileList, runList] = await Promise.all([getAgentProfiles(administrator), getAgentRuns(administrator)]);
    setProfiles(profileList.items);
    runsRef.current = runList.items;
    setRuns(runList.items);
    setSelectedProfileId((current) => current || profileList.items.find(({ status }) => status === "ACTIVE")?.id || "");
    if (administrator) {
      const [nextRuntime, nextMetrics] = await Promise.all([getAgentRuntime(), getAgentMetrics()]);
      setRuntime(nextRuntime);
      setMetrics(nextMetrics);
    }
  };

  useEffect(() => {
    if (!unlocked) {
      setProfiles([]); setRuns([]); setRuntime(null); setMetrics(null);
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => {
      if (active && runsRef.current.some(({ status }) => runningStatuses.has(status))) void load().catch(() => undefined);
    }, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked, administrator]);

  useEffect(() => {
    if (!unlocked || !selectedRun) {
      setRunEvents([]);
      return;
    }
    let active = true;
    void getAgentRunEvents(selectedRun.id, administrator)
      .then((result) => { if (active) setRunEvents(result.items); })
      .catch((cause) => { if (active) fail(cause); });
    return () => { active = false; };
  }, [unlocked, administrator, selectedRun?.id, selectedRun?.updatedAt]);

  const action = async (key: string, operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError(null);
    try { await operation(); await load(); }
    catch (cause) { fail(cause); }
    finally { setBusy(null); }
  };

  const editProfile = (profile: AgentProfile) => {
    setEditingId(profile.id);
    setProfileDraft(draftFromProfile(profile));
    setSkillsDraft(skillManifestText(profile.version.skills));
    setEditorOpen(true);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const skills = parseSkillManifest(skillsDraft);
    if (!skills) {
      setError("Each Skill must use 'name@version sha256' with a lowercase slug and a 64-character digest.");
      return;
    }
    await action("profile-save", async () => {
      const candidate = { ...profileDraft, skills };
      if (editingId) {
        const { slug: _slug, ...configuration } = candidate;
        await updateAgentProfile(editingId, configuration);
      } else {
        await createAgentProfile(candidate);
      }
      setEditorOpen(false); setEditingId(null); setProfileDraft(blankProfile); setSkillsDraft("");
    });
  };

  const runAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProfileId || !prompt.trim()) return;
    const input = prompt.trim();
    await action("run-submit", async () => {
      const created = await submitAgentRun(selectedProfileId, input);
      setPrompt(""); setSelectedRunId(created.id);
    });
  };

  if (!unlocked) {
    return (
      <section className="chat-locked agents-locked">
        <div className="chat-lock-mark">HA</div>
        <p className="page-kicker">Governed execution</p>
        <h1>Hermes agents require an authenticated workspace</h1>
        <p>Sign in to run active profiles. Administrators can also configure immutable versions, inspect every run, and control the global execution boundary.</p>
        <div className="chat-lock-actions">
          {oidcConfigured && <button className="primary-button" type="button" onClick={onSignIn}>Enterprise sign in</button>}
          <button className="secondary-button" type="button" onClick={onConfigure}>Administrator setup</button>
        </div>
      </section>
    );
  }

  return (
    <section className="agents-workspace">
      <header className="documents-header agents-header">
        <div><p className="page-kicker">Hardened orchestration</p><h1>Hermes Profiles</h1><p>Immutable Profile Distributions, scoped knowledge, optional AIHub-governed MCP actions, safe activity events, and an operator kill switch.</p></div>
        <div className="agent-header-actions"><button className="secondary-button" type="button" onClick={() => void load()}>Refresh</button>{administrator && <button className="primary-button" type="button" onClick={() => { setEditingId(null); setProfileDraft(blankProfile); setSkillsDraft(""); setEditorOpen(true); }}>New profile</button>}</div>
      </header>

      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

      {administrator && <section className={`agent-boundary ${runtime?.enabled ? "enabled" : "disabled"}`}>
        <div className="agent-boundary-mark">{runtime?.enabled ? "ON" : "OFF"}</div>
        <div><span>Global execution boundary</span><strong>{runtime?.enabled ? "Hermes runs are permitted" : "Hermes runs are denied fail-closed"}</strong><p>{runtime?.reason ?? "Runtime state is loading."}</p></div>
        <form onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 3) void action("runtime", () => updateAgentRuntime(!runtime?.enabled, reason.trim())); }}>
          <label htmlFor="runtime-reason">Operator reason</label><input id="runtime-reason" value={reason} minLength={3} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          <button className={runtime?.enabled ? "danger-button" : "primary-button"} disabled={busy !== null || reason.trim().length < 3} type="submit">{busy === "runtime" ? "Applying..." : runtime?.enabled ? "Disable execution" : "Enable after verification"}</button>
        </form>
      </section>}

      <div className="agent-metrics" aria-label="Agent operations summary">
        <article><span>Profiles</span><strong>{metrics?.profiles ?? profiles.length}</strong><small>{metrics?.activeProfiles ?? profiles.filter(({ status }) => status === "ACTIVE").length} active</small></article>
        <article><span>Queued</span><strong>{metrics?.queuedRuns ?? runs.filter(({ status }) => status === "QUEUED").length}</strong><small>awaiting worker</small></article>
        <article><span>Running</span><strong>{metrics?.runningRuns ?? runs.filter(({ status }) => runningStatuses.has(status)).length}</strong><small>live or stopping</small></article>
        <article><span>Completed</span><strong>{metrics?.completedRuns ?? runs.filter(({ status }) => status === "COMPLETED").length}</strong><small>retained outcomes</small></article>
      </div>

      <div className="agents-layout">
        <section className="agent-profiles panel">
          <div className="document-section-heading"><div><p className="section-kicker">Immutable configuration</p><h2>Profiles</h2></div><span>{profiles.length} profiles</span></div>
          <div className="agent-profile-list">
            {profiles.length === 0 && <div className="document-empty"><strong>No agent profiles</strong><span>An administrator must create and activate the first bounded profile.</span></div>}
            {profiles.map((profile) => <article key={profile.id} className={selectedProfileId === profile.id ? "selected" : undefined}>
              <button className="agent-profile-select" type="button" onClick={() => setSelectedProfileId(profile.id)}>
                <span className="agent-avatar">{profile.version.displayName.slice(0, 2).toUpperCase()}</span>
                <div><strong>{profile.version.displayName}</strong><p>{profile.version.purpose}</p><small>{profile.slug} · current v{profile.version.version} · {profile.version.modelAlias} · distro {profile.version.distributionDigest.slice(0, 10)}{profile.activeVersion !== null && profile.activeVersion !== profile.version.version ? ` · live v${profile.activeVersion}` : ""}</small></div>
                <span className={`document-status ${statusTone(profile.status)}`}>{profile.status.toLowerCase()}</span>
              </button>
              {administrator && <div className="agent-profile-actions"><button type="button" onClick={() => editProfile(profile)}>New version</button>{profile.status === "ACTIVE" ? <button type="button" disabled={busy !== null} onClick={() => void action(`suspend-${profile.id}`, () => setAgentProfileState(profile.id, "suspend"))}>Suspend</button> : profile.status === "STANDBY" ? <button type="button" disabled={busy !== null} onClick={() => void action(`activate-${profile.id}`, () => setAgentProfileState(profile.id, "activate"))}>Activate v{profile.currentVersion}</button> : <button type="button" disabled={busy !== null} onClick={() => void action(`standby-${profile.id}`, () => setAgentProfileState(profile.id, "standby"))}>Validate as standby</button>}</div>}
            </article>)}
          </div>
        </section>

        <section className="agent-run-panel panel">
          <div className="document-section-heading"><div><p className="section-kicker">Bounded request</p><h2>Run an active Profile</h2></div><span>1 turn · governed tools only</span></div>
          <form className="agent-composer" onSubmit={(event) => void runAgent(event)}>
            <label htmlFor="agent-profile">Agent profile</label>
            <select id="agent-profile" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
              <option value="">Select an active profile</option>{profiles.filter(({ status, activeVersionConfiguration }) => status === "ACTIVE" && activeVersionConfiguration !== null).map((profile) => <option key={profile.id} value={profile.id}>{profile.activeVersionConfiguration?.displayName} · v{profile.activeVersion}</option>)}
            </select>
            <label htmlFor="agent-prompt">Task</label>
            <textarea id="agent-prompt" value={prompt} maxLength={32_000} placeholder="Describe the bounded analysis you want Hermes to complete…" onChange={(event) => setPrompt(event.target.value)} />
            <div><span>Private memory is retrieved only when the selected profile permits it.</span><button className="primary-button" disabled={busy !== null || !selectedProfileId || !prompt.trim() || runtime?.enabled === false} type="submit">{busy === "run-submit" ? "Queuing..." : "Queue run"}</button></div>
          </form>
        </section>
      </div>

      <div className="agent-runs-layout">
        <section className="agent-run-list panel">
          <div className="document-section-heading"><div><p className="section-kicker">Execution ledger</p><h2>Recent runs</h2></div><span>{runs.length} records</span></div>
          <div className="agent-runs-scroll">{runs.length === 0 && <div className="document-empty"><strong>No runs yet</strong><span>Queued work will appear here with its complete lifecycle.</span></div>}{runs.map((run) => <button className={selectedRun?.id === run.id ? "selected" : undefined} key={run.id} type="button" onClick={() => setSelectedRunId(run.id)}><span className={`document-status ${statusTone(run.status)}`}>{run.status.replaceAll("_", " ").toLowerCase()}</span><strong>{run.profileName}</strong><p>{run.input}</p><small>v{run.profileVersion} · {friendlyTime(run.createdAt)}</small></button>)}</div>
        </section>
        <section className="agent-run-detail panel">
          {!selectedRun ? <div className="document-empty"><strong>Select a run</strong><span>Input, output, sources, and failure information remain in the AIHub execution ledger.</span></div> : <>
            <div className="agent-run-detail-head"><div><p className="section-kicker">Run detail</p><h2>{selectedRun.profileName}</h2><span>{selectedRun.profileSlug} · version {selectedRun.profileVersion}</span></div><span className={`document-status ${statusTone(selectedRun.status)}`}>{selectedRun.status.replaceAll("_", " ").toLowerCase()}</span></div>
            <dl className="agent-run-times"><div><dt>Queued</dt><dd>{friendlyTime(selectedRun.queuedAt)}</dd></div><div><dt>Started</dt><dd>{friendlyTime(selectedRun.startedAt)}</dd></div><div><dt>Completed</dt><dd>{friendlyTime(selectedRun.completedAt)}</dd></div></dl>
            <div className="agent-distribution-pin"><span>Profile Distribution</span><code>{selectedRun.profileDistributionDigest ?? "Legacy run — no distribution digest"}</code></div>
            <section className="agent-activity" aria-label="Safe Hermes activity timeline">
              <div><span>Activity timeline</span><small>{runEvents.length} safe event{runEvents.length === 1 ? "" : "s"}</small></div>
              {runEvents.length === 0 ? <p>No bounded Hermes activity events have been retained for this run.</p> : <ol>{runEvents.map((event) => <li key={event.id}>
                <i className={event.type.includes("FAILED") ? "failed" : event.type.includes("COMPLETED") ? "ready" : "processing"} />
                <div><strong>{eventTitle(event)}</strong><p>{eventDetail(event)}</p><small>{friendlyTime(event.occurredAt)}{event.durationMs !== null ? ` · ${Math.round(event.durationMs / 100) / 10}s` : ""}{event.inputTokens !== null || event.outputTokens !== null ? ` · ${(event.inputTokens ?? 0) + (event.outputTokens ?? 0)} tokens` : ""}</small></div>
              </li>)}</ol>}
              <footer>Token deltas, chain-of-thought, hidden prompts, credentials, tool arguments, and tool results are never retained here.</footer>
            </section>
            <div className="agent-run-content"><span>Input</span><p>{selectedRun.input}</p></div>
            {selectedRun.output && <div className="agent-run-content output"><span>Hermes output</span><p>{selectedRun.output}</p></div>}
            {selectedRun.failureMessage && <div className="agent-run-failure"><strong>{selectedRun.failureCode}</strong><p>{selectedRun.failureMessage}</p></div>}
            {selectedRun.sources.length > 0 && <div className="agent-run-sources"><span>Authorized private sources</span>{selectedRun.sources.map((source) => <details key={source.documentId}><summary>{source.fileName}<small>{Math.round(source.score * 100)}% match · {source.classification.toLowerCase()}</small></summary><p>{source.excerpt}</p></details>)}</div>}
            {runningStatuses.has(selectedRun.status) && <button className="danger-button" disabled={busy !== null || selectedRun.status === "CANCEL_REQUESTED"} type="button" onClick={() => void action(`cancel-${selectedRun.id}`, () => cancelAgentRun(selectedRun.id, administrator))}>{selectedRun.status === "CANCEL_REQUESTED" ? "Cancellation requested" : "Cancel run"}</button>}
          </>}
        </section>
      </div>

      {editorOpen && administrator && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}><form className="agent-editor" onSubmit={(event) => void saveProfile(event)}>
        <header><div><p className="section-kicker">{editingId ? "Immutable revision" : "New bounded profile"}</p><h2>{editingId ? "Create a new profile version" : "Create agent profile"}</h2></div><button type="button" aria-label="Close profile editor" onClick={() => setEditorOpen(false)}>×</button></header>
        <div className="agent-editor-grid"><label>Slug<input required disabled={editingId !== null} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={profileDraft.slug} onChange={(event) => setProfileDraft({ ...profileDraft, slug: event.target.value })} /></label><label>Display name<input required minLength={2} maxLength={120} value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} /></label></div>
        <label>Purpose<textarea required minLength={3} maxLength={500} value={profileDraft.purpose} onChange={(event) => setProfileDraft({ ...profileDraft, purpose: event.target.value })} /></label>
        <label>SOUL.md<textarea className="instructions" required minLength={10} maxLength={32_000} value={profileDraft.soulMd} onChange={(event) => setProfileDraft({ ...profileDraft, soulMd: event.target.value })} /></label>
        <label>System instructions<textarea className="instructions" required minLength={10} maxLength={32_000} value={profileDraft.instructions} onChange={(event) => setProfileDraft({ ...profileDraft, instructions: event.target.value })} /></label>
        <label>Approved Skills<textarea value={skillsDraft} placeholder={`One per line: name@version ${"a".repeat(64)}`} onChange={(event) => setSkillsDraft(event.target.value)} /><small>Only secret-free, reviewed Skill references are included in the distribution source. Runtime installation remains evidence-gated.</small></label>
        <div className="agent-editor-grid"><label>Hermes model alias<input required value={profileDraft.modelAlias} onChange={(event) => setProfileDraft({ ...profileDraft, modelAlias: event.target.value })} /></label><label>Timeout (seconds)<input required type="number" min={30} max={3600} value={profileDraft.timeoutSeconds} onChange={(event) => setProfileDraft({ ...profileDraft, timeoutSeconds: Number(event.target.value) })} /></label><label>Concurrent runs<input required type="number" min={1} max={20} value={profileDraft.maxConcurrentRuns} onChange={(event) => setProfileDraft({ ...profileDraft, maxConcurrentRuns: Number(event.target.value) })} /></label></div>
        <label className="agent-check"><input type="checkbox" checked={profileDraft.allowPrivateKnowledge} onChange={(event) => setProfileDraft({ ...profileDraft, allowPrivateKnowledge: event.target.checked })} /><span><strong>Allow private knowledge retrieval</strong><small>Searches only the requesting identity’s authorized Supermemory scope.</small></span></label>
        <div className="agent-editor-boundary"><strong>Distribution boundary</strong><span>SOUL.md and checksummed Skills describe behavior, never authority. Runtime installation must be verified before standby or activation; safe mode remains mandatory.</span></div>
        <footer><button className="secondary-button" type="button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy !== null} type="submit">{busy === "profile-save" ? "Saving..." : editingId ? "Create version" : "Create draft"}</button></footer>
      </form></div>}
    </section>
  );
}

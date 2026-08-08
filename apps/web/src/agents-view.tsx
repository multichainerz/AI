import type { AgentMetrics, AgentProfile, AgentRun, AgentRunEvent, AgentRuntimeControl, AgentSkillReference, CreateAgentProfile } from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  cancelAgentRun,
  createAgentProfile,
  getAgentMetrics,
  getAgentProfiles,
  getAgentRunEvents,
  getAgentRuns,
  getAgentRuntime,
  getConnections,
  runOnboardingValidation,
  setAgentProfileState,
  updateAgentProfile,
  updateAgentRuntime,
} from "./api.js";
import {
  Alert, Button, Dialog, EmptyState, Field, HeroBanner, Input, LockedScreen, MicroLabel,
  PageHeader, Panel, PanelHeading, Select, StatusText, Textarea, cn, toneFor,
} from "./ui/index.js";

interface AgentsViewProps {
  unlocked: boolean;
  administrator: boolean;
  activationReady: boolean | null;
  activationMessage: string | null;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onOpenChat: () => void;
  onOpenReadiness: () => void;
  onSessionExpired: () => void;
}

/**
 * Says plainly what each mode stores, because the difference between them is a
 * privacy decision an administrator is making on someone else's behalf.
 */
function memoryModeNote(mode: CreateAgentProfile["memoryMode"]): string {
  if (mode === "DOCUMENTS_ONLY") return "Nothing about the person is stored. Answers draw only on documents they own.";
  if (mode === "RECALL_ONLY") return "Reads memory this agent already holds, and writes none of its own.";
  if (mode === "LEARN_USER") return "Stores what the person says, so the agent accumulates their stable facts and preferences. The model's own replies are never stored.";
  return "Stores both sides of each turn. Richer recall, but the model's own output becomes durable memory an error can persist into.";
}

const runningStatuses = new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);
const terminalGood = new Set(["COMPLETED"]);

const blankProfile: CreateAgentProfile = {
  slug: "hermes-analyst",
  displayName: "Hermes Analyst",
  purpose: "A bounded on-premise assistant for internal analysis and document-grounded answers.",
  instructions: "Provide concise, evidence-based answers. Clearly distinguish retrieved facts from analysis and state uncertainty.",
  soulMd: "You are a careful OrcaSynapse analyst. Be calm, precise, evidence-led, and candid about uncertainty.",
  skills: [],
  modelAlias: "hermes-agent",
  maxTurns: 1,
  timeoutSeconds: 600,
  maxConcurrentRuns: 2,
  allowPrivateKnowledge: true,
  memoryMode: "DOCUMENTS_ONLY",
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
    memoryMode: profile.version.memoryMode,
    safeMode: true,
  };
}

export function AgentsView({ unlocked, administrator, activationReady, activationMessage, oidcConfigured, onSignIn, onConfigure, onOpenChat, onOpenReadiness, onSessionExpired }: AgentsViewProps) {
  const runsRef = useRef<AgentRun[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([]);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeControl | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [reason, setReason] = useState("Runtime and Profile Distribution boundaries verified by the platform administrator.");
  const [profileDraft, setProfileDraft] = useState<CreateAgentProfile>(blankProfile);
  const [skillsDraft, setSkillsDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readinessRequired, setReadinessRequired] = useState(false);

  const selectedRun = useMemo(() => runs.find(({ id }) => id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the agent operation.");
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

  const verifyProfileForChat = async (profile: AgentProfile) => {
    const snapshot = await runOnboardingValidation({ stageKey: "ai-services" });
    const hermesCompatibility = snapshot.components.find(({ key: componentKey }) => componentKey === "hermes-api");
    if (hermesCompatibility?.status !== "PASSED") {
      setReadinessRequired(true);
      const status = hermesCompatibility?.status.replaceAll("_", " ").toLowerCase() ?? "not tested";
      throw new Error(`Hermes compatibility is ${status}. ${hermesCompatibility?.note ?? "The Agentic System must pass its automated service check before this Profile can become active."}`);
    }
    await setAgentProfileState(profile.id, "activate");
    if (!runtime?.enabled) {
      await updateAgentRuntime(true, "Hermes boundary verified while activating the first usable Profile.");
    }
  };

  const activateForChat = async (profile: AgentProfile) => {
    if (busy) return;
    const key = `activate-${profile.id}`;
    setBusy(key);
    setError(null);
    setNotice(null);
    setReadinessRequired(false);
    try {
      await verifyProfileForChat(profile);
      setNotice(`${profile.version.displayName} is active and Chat is ready.`);
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.message.includes("Hermes compatibility")) setReadinessRequired(true);
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const openNewProfile = async () => {
    setError(null);
    setNotice(null);
    let modelAlias = blankProfile.modelAlias;
    try {
      const connections = await getConnections();
      const aliases = connections.items
        .filter(({ kind, enabled, status }) => kind === "INFERENCE" && enabled && status === "HEALTHY")
        .map(({ configuration }) => configuration.modelAlias)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (aliases.length === 1) modelAlias = aliases[0]!.trim();
    } catch (cause) {
      fail(cause);
    }
    setEditingId(null);
    setProfileDraft({ ...blankProfile, modelAlias });
    setSkillsDraft("");
    setEditorOpen(true);
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
    if (busy) return;
    setBusy("profile-save");
    setError(null);
    setNotice(null);
    setReadinessRequired(false);
    try {
      const candidate = { ...profileDraft, skills };
      if (editingId) {
        const { slug: _slug, ...configuration } = candidate;
        await updateAgentProfile(editingId, configuration);
        setNotice(`${candidate.displayName} version saved. Activate it when the new revision is ready for Chat.`);
      } else {
        const created = await createAgentProfile(candidate);
        // Creation is durable. Close the editor before live verification so a
        // failed readiness check cannot tempt the operator to submit a duplicate.
        setEditorOpen(false); setEditingId(null); setProfileDraft(blankProfile); setSkillsDraft("");
        if (activationReady === false) {
          setNotice(`${created.version.displayName} was saved as a draft. Finish the Agentic System, then use Verify & activate.`);
        } else {
          await verifyProfileForChat(created);
          setNotice(`${created.version.displayName} was created, verified, and activated. Chat is ready.`);
        }
      }
      setEditorOpen(false); setEditingId(null); setProfileDraft(blankProfile); setSkillsDraft("");
      await load();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.message.includes("Hermes compatibility")) setReadinessRequired(true);
      fail(cause);
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  if (!unlocked) {
    return (
      <LockedScreen
        kicker="Governed execution"
        title="Agents"
        mark="HA"
        headline="Authenticated workspace required"
        reason="Sign in to run active profiles. Administrators can also configure immutable versions, inspect every run, and control the global execution boundary."
        actionLabel={oidcConfigured ? "Enterprise sign in" : "Administrator setup"}
        onAction={oidcConfigured ? onSignIn : onConfigure}
        {...(oidcConfigured ? { secondaryLabel: "Administrator setup", onSecondary: onConfigure } : {})}
      />
    );
  }

  const chatAvailable = profiles.some(({ status }) => status === "ACTIVE")
    && (administrator ? runtime?.enabled === true : true);

  return (
    <div className="grid gap-5">
      <PageHeader
        kicker="Hardened orchestration"
        title="Hermes Profiles"
        description="Immutable Profile Distributions, scoped knowledge, optional OrcaSynapse-governed MCP actions, safe activity events, and an operator kill switch."
        actions={<>
          <Button disabled={!chatAvailable} onClick={onOpenChat}>{chatAvailable ? "Open Chat" : "Chat not ready"}</Button>
          <Button onClick={() => void load()}>Refresh</Button>
          {administrator && <Button variant="primary" onClick={() => void openNewProfile()}>{activationReady === false ? "Create draft" : "Create agent"}</Button>}
        </>}
      />

      {error && <Alert onDismiss={() => { setError(null); setReadinessRequired(false); }}>
        {error}
        {readinessRequired && (
          <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenReadiness}>Open Hermes readiness</Button>
        )}
      </Alert>}
      {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>
        {notice}
        {chatAvailable && <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenChat}>Open Chat</Button>}
      </Alert>}
      {administrator && activationReady === false && <Panel className="flex items-center gap-4 border-l-2 border-l-warn" role="status">
        <div className="min-w-0 flex-1">
          <strong className="block text-[12px] font-semibold text-text">Profiles can be drafted now</strong>
          <span className="mt-1 block text-body text-muted">
            {activationMessage ?? "Connect AI Inference and finish VM2 enrollment before activating a Profile for Chat."}
          </span>
        </div>
        <Button className="shrink-0" onClick={onOpenReadiness}>Review platform setup</Button>
      </Panel>}

      {administrator && <Panel className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4 border-l-2",
        runtime?.enabled ? "border-l-good" : "border-l-border-strong",
      )}>
        {/* The kill switch. ON/OFF is stated as a word rather than a colour
            alone, because this is the control an operator reaches for when
            something is already going wrong. */}
        <div className={cn(
          "grid h-11 w-11 place-items-center rounded border font-mono text-[11px] font-bold",
          runtime?.enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
        )}>
          {runtime?.enabled ? "ON" : "OFF"}
        </div>
        <div className="min-w-0">
          <MicroLabel className="block">Hermes execution</MicroLabel>
          <strong className="mt-1.5 block text-[12px] font-semibold text-text">
            {runtime?.enabled ? "Ready for Chat" : "Activates with the first verified Profile"}
          </strong>
          <p className="mb-0 mt-1 text-body text-muted">
            {runtime?.enabled ? runtime.reason : "Create or verify a Profile; OrcaSynapse will test Hermes and enable this boundary automatically."}
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer font-mono text-micro uppercase text-faint">Manual control</summary>
            <form
              className="mt-2.5 flex flex-wrap items-end gap-2.5"
              onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 3) void action("runtime", () => updateAgentRuntime(!runtime?.enabled, reason.trim())); }}
            >
              <Field label="Audit reason" htmlFor="runtime-reason" className="min-w-[220px] flex-1">
                <Input id="runtime-reason" value={reason} minLength={3} maxLength={500} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <Button
                variant={runtime?.enabled ? "danger" : "secondary"}
                disabled={busy !== null || reason.trim().length < 3}
                type="submit"
              >
                {busy === "runtime" ? "Applying..." : runtime?.enabled ? "Disable execution" : "Enable manually"}
              </Button>
            </form>
          </details>
        </div>
      </Panel>}

      <HeroBanner
        aria-label="Agent operations summary"
        highlight={{
          label: "Completed runs",
          value: metrics?.completedRuns ?? runs.filter(({ status }) => status === "COMPLETED").length,
          caption: "Retained outcomes with their complete lifecycle",
        }}
        metrics={[
          {
            label: "Profiles",
            value: metrics?.profiles ?? profiles.length,
            caption: `${metrics?.activeProfiles ?? profiles.filter(({ status }) => status === "ACTIVE").length} active`,
          },
          {
            label: "Queued",
            value: metrics?.queuedRuns ?? runs.filter(({ status }) => status === "QUEUED").length,
            caption: "awaiting worker",
          },
          {
            label: "Running",
            tone: "accent",
            value: metrics?.runningRuns ?? runs.filter(({ status }) => runningStatuses.has(status)).length,
            caption: "live or stopping",
          },
        ]}
      />

      <Panel>
        <PanelHeading
          kicker="Immutable configuration"
          title="Profiles"
          actions={<StatusText>{profiles.length} profiles</StatusText>}
        />
        <div className="grid gap-2">
          {profiles.length === 0 && (
            <EmptyState
              title="Create your first agent"
              action={administrator ? <Button variant="primary" onClick={() => void openNewProfile()}>Create starter agent</Button> : undefined}
            >
              OrcaSynapse will verify Hermes, activate the Profile, and enable Chat in one guided action.
            </EmptyState>
          )}
          {profiles.map((profile) => <article
            key={profile.id}
            className={cn(
              "grid gap-3 rounded border p-3",
              selectedProfileId === profile.id ? "border-border-strong bg-raised" : "border-border bg-raised/40",
            )}
          >
            <button
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-left"
              type="button"
              onClick={() => setSelectedProfileId(profile.id)}
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 place-items-center rounded border border-border-strong bg-surface font-mono text-[10px] font-bold text-accent"
              >
                {profile.version.displayName.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <strong className="block truncate text-[12px] font-semibold text-text">{profile.version.displayName}</strong>
                <p className="mb-0 mt-0.5 truncate text-caption text-muted">{profile.version.purpose}</p>
                {/* The distribution digest is what VM2 admits, so it is on the
                    row rather than behind a click. */}
                <small className="mt-1 block truncate font-mono text-micro text-faint">
                  {profile.slug} · current v{profile.version.version} · {profile.version.modelAlias} · distro {profile.version.distributionDigest.slice(0, 10)}
                  {profile.activeVersion !== null && profile.activeVersion !== profile.version.version ? ` · live v${profile.activeVersion}` : ""}
                </small>
              </div>
              <StatusText dot tone={toneFor(statusTone(profile.status))}>{profile.status.toLowerCase()}</StatusText>
            </button>
            {administrator && <div className="flex justify-end gap-1.5">
              <Button size="sm" onClick={() => editProfile(profile)}>New version</Button>
              {profile.status === "ACTIVE"
                ? <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void action(`suspend-${profile.id}`, () => setAgentProfileState(profile.id, "suspend"))}>Suspend</Button>
                : <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void activateForChat(profile)}>
                    {busy === `activate-${profile.id}` ? "Verifying Hermes..." : "Verify & activate"}
                  </Button>}
            </div>}
          </article>)}
        </div>
      </Panel>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <Panel>
          <PanelHeading kicker="Execution ledger" title="Recent runs" actions={<StatusText>{runs.length} records</StatusText>} />
          <div className="grid max-h-[520px] gap-1 overflow-y-auto">
            {runs.length === 0 && (
              <EmptyState title="No runs yet">Queued work will appear here with its complete lifecycle.</EmptyState>
            )}
            {runs.map((run) => <button
              className={cn(
                "grid w-full gap-1 rounded border p-2.5 text-left transition-colors",
                selectedRun?.id === run.id ? "border-border-strong bg-raised" : "border-transparent hover:bg-raised",
              )}
              key={run.id}
              type="button"
              onClick={() => setSelectedRunId(run.id)}
            >
              <StatusText dot tone={toneFor(statusTone(run.status))}>{run.status.replaceAll("_", " ").toLowerCase()}</StatusText>
              <strong className="truncate text-[12px] font-semibold text-text">{run.profileName}</strong>
              <p className="mb-0 line-clamp-2 text-caption text-muted">{run.input}</p>
              <small className="font-mono text-micro text-faint">v{run.profileVersion} · {friendlyTime(run.createdAt)}</small>
            </button>)}
          </div>
        </Panel>

        <Panel>
          {!selectedRun
            ? <EmptyState title="Select a run">Input, output, sources, and failure information remain in the OrcaSynapse execution ledger.</EmptyState>
            : <>
            <PanelHeading
              kicker="Run detail"
              title={selectedRun.profileName}
              description={`${selectedRun.profileSlug} · version ${selectedRun.profileVersion}`}
              actions={<StatusText dot tone={toneFor(statusTone(selectedRun.status))}>{selectedRun.status.replaceAll("_", " ").toLowerCase()}</StatusText>}
            />
            <dl className="m-0 grid grid-cols-3 gap-px rounded border border-border bg-border">
              {[
                { label: "Queued", value: friendlyTime(selectedRun.queuedAt) },
                { label: "Started", value: friendlyTime(selectedRun.startedAt) },
                { label: "Completed", value: friendlyTime(selectedRun.completedAt) },
              ].map((fact) => (
                <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                  <dt className="truncate font-mono text-micro uppercase text-faint">{fact.label}</dt>
                  <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 rounded border border-border bg-raised p-3">
              <MicroLabel className="block">Profile Distribution</MicroLabel>
              <code className="mt-1.5 block break-all font-mono text-micro text-muted">
                {selectedRun.profileDistributionDigest ?? "Legacy run — no distribution digest"}
              </code>
            </div>
            <section className="mt-3 overflow-hidden rounded border border-border" aria-label="Safe Hermes activity timeline">
              <header className="flex items-center justify-between border-b border-border bg-raised px-3 py-2">
                <MicroLabel>Activity timeline</MicroLabel>
                <StatusText>{runEvents.length} safe event{runEvents.length === 1 ? "" : "s"}</StatusText>
              </header>
              {runEvents.length === 0
                ? <p className="m-0 px-3 py-4 text-body text-faint">No bounded Hermes activity events have been retained for this run.</p>
                : <ol className="m-0 grid list-none p-0">{runEvents.map((event) => <li
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0"
                    key={event.id}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1 h-1.5 w-1.5 shrink-0",
                        event.type.includes("FAILED") ? "bg-bad" : event.type.includes("COMPLETED") ? "bg-good" : "bg-accent",
                      )}
                    />
                    <div className="min-w-0">
                      <strong className="block text-caption font-semibold text-text">{eventTitle(event)}</strong>
                      <p className="mb-0 mt-0.5 text-caption leading-relaxed text-muted">{eventDetail(event)}</p>
                      <small className="mt-1 block font-mono text-micro text-faint">
                        {friendlyTime(event.occurredAt)}
                        {event.durationMs !== null ? ` · ${Math.round(event.durationMs / 100) / 10}s` : ""}
                        {event.inputTokens !== null || event.outputTokens !== null ? ` · ${(event.inputTokens ?? 0) + (event.outputTokens ?? 0)} tokens` : ""}
                      </small>
                    </div>
                  </li>)}</ol>}
              {/* The list is bounded on purpose, and says so: an operator
                  reading it should not assume the omissions are absences. */}
              <footer className="border-t border-border bg-bg px-3 py-2 text-micro leading-relaxed text-faint">
                Token deltas, chain-of-thought, hidden prompts, credentials, tool arguments, and tool results are never
                retained here.
              </footer>
            </section>
            {[
              { label: "Input", body: selectedRun.input, tone: "" },
              ...(selectedRun.output ? [{ label: "Hermes output", body: selectedRun.output, tone: "border-l-2 border-l-accent" }] : []),
            ].map((block) => (
              <div className={cn("mt-3 rounded border border-border bg-raised p-3", block.tone)} key={block.label}>
                <MicroLabel className="block">{block.label}</MicroLabel>
                <p className="mb-0 mt-1.5 whitespace-pre-wrap break-words text-body leading-relaxed text-text">{block.body}</p>
              </div>
            ))}
            {selectedRun.failureMessage && <div className="mt-3 rounded border border-bad/40 bg-bad/10 p-3">
              <strong className="block font-mono text-micro uppercase text-bad">{selectedRun.failureCode}</strong>
              <p className="mb-0 mt-1.5 text-body leading-relaxed text-muted">{selectedRun.failureMessage}</p>
            </div>}
            {selectedRun.sources.length > 0 && <div className="mt-3 grid gap-1.5 rounded border border-border bg-raised p-3">
              <MicroLabel>Authorized private sources</MicroLabel>
              {selectedRun.sources.map((source) => <details className="rounded border border-border bg-surface p-2.5" key={source.documentId}>
                <summary className="flex cursor-pointer items-center justify-between gap-3 text-body text-text">
                  {source.fileName}
                  <small className="font-mono text-micro text-faint">
                    {Math.round(source.score * 100)}% match · {source.classification.toLowerCase()}
                  </small>
                </summary>
                <p className="mb-0 mt-2 text-caption leading-relaxed text-muted">{source.excerpt}</p>
              </details>)}
            </div>}
            {runningStatuses.has(selectedRun.status) && <Button
              variant="danger"
              className="mt-3"
              disabled={busy !== null || selectedRun.status === "CANCEL_REQUESTED"}
              onClick={() => void action(`cancel-${selectedRun.id}`, () => cancelAgentRun(selectedRun.id, administrator))}
            >
              {selectedRun.status === "CANCEL_REQUESTED" ? "Cancellation requested" : "Cancel run"}
            </Button>}
          </>}
        </Panel>
      </div>

      {/*
        * The profile editor was a hand-rolled backdrop with no focus trap, no
        * Escape and no scroll lock — the same gap the Chat overlays had before
        * v1.1.0. It is a long form that decides what an agent may do, so
        * tabbing out of it mid-edit is the worst place for that to happen.
        */}
      <Dialog
        open={editorOpen && administrator}
        onClose={() => setEditorOpen(false)}
        kicker={editingId ? "Immutable revision" : "New bounded profile"}
        title={editingId ? "Create a new profile version" : "Create agent profile"}
        className="max-w-[760px]"
        footer={<>
          <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy !== null} type="submit" form="agent-profile-editor">
            {busy === "profile-save" ? "Saving..." : editingId ? "Save new version" : activationReady === false ? "Save draft" : "Create & activate"}
          </Button>
        </>}
      >
        <form className="grid gap-3" id="agent-profile-editor" onSubmit={(event) => void saveProfile(event)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Slug"><Input required disabled={editingId !== null} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={profileDraft.slug} onChange={(event) => setProfileDraft({ ...profileDraft, slug: event.target.value })} /></Field>
            <Field label="Display name"><Input required minLength={2} maxLength={120} value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} /></Field>
          </div>
          <Field label="Purpose"><Textarea required minLength={3} maxLength={500} value={profileDraft.purpose} onChange={(event) => setProfileDraft({ ...profileDraft, purpose: event.target.value })} /></Field>
          <Field label="Personality and operating principles">
            <Textarea className="min-h-[160px]" required minLength={10} maxLength={32_000} value={profileDraft.soulMd} onChange={(event) => setProfileDraft({ ...profileDraft, soulMd: event.target.value })} />
          </Field>
          <Field label="System instructions">
            <Textarea className="min-h-[160px]" required minLength={10} maxLength={32_000} value={profileDraft.instructions} onChange={(event) => setProfileDraft({ ...profileDraft, instructions: event.target.value })} />
          </Field>
          <Field
            label="Approved Skills"
            hint="Only secret-free, reviewed Skill references are included in the distribution source. Runtime installation remains evidence-gated."
          >
            <Textarea className="font-mono" value={skillsDraft} placeholder={`One per line: name@version ${"a".repeat(64)}`} onChange={(event) => setSkillsDraft(event.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Inference model" hint="Filled from the healthy AI Inference connection.">
              <Input required value={profileDraft.modelAlias} onChange={(event) => setProfileDraft({ ...profileDraft, modelAlias: event.target.value })} />
            </Field>
            <Field label="Timeout (seconds)"><Input required type="number" min={30} max={3600} value={profileDraft.timeoutSeconds} onChange={(event) => setProfileDraft({ ...profileDraft, timeoutSeconds: Number(event.target.value) })} /></Field>
            <Field label="Concurrent runs"><Input required type="number" min={1} max={20} value={profileDraft.maxConcurrentRuns} onChange={(event) => setProfileDraft({ ...profileDraft, maxConcurrentRuns: Number(event.target.value) })} /></Field>
          </div>
          <label className="grid cursor-pointer gap-1.5 rounded border border-border bg-raised p-3">
            <span className="flex items-center gap-2.5">
              <input type="checkbox" checked={profileDraft.allowPrivateKnowledge} onChange={(event) => setProfileDraft({ ...profileDraft, allowPrivateKnowledge: event.target.checked })} />
              <strong className="text-body font-semibold text-text">Allow private knowledge retrieval</strong>
            </span>
            <small className="text-caption leading-relaxed text-muted">
              Searches only the requesting identity’s documents in the private knowledge index.
            </small>
          </label>
          <Field label="Memory" hint={memoryModeNote(profileDraft.memoryMode)}>
            <Select value={profileDraft.memoryMode} onChange={(event) => setProfileDraft({ ...profileDraft, memoryMode: event.target.value as CreateAgentProfile["memoryMode"] })}>
              <option value="DOCUMENTS_ONLY">Documents only — remembers nothing about the person</option>
              <option value="RECALL_ONLY">Recall only — uses existing memory, never adds to it</option>
              <option value="LEARN_USER">Learn the user — remembers what the person says</option>
              <option value="LEARN_EXCHANGE">Learn the exchange — remembers both sides of the turn</option>
            </Select>
          </Field>
          <div className={cn(
            "rounded border border-l-2 border-border p-3",
            activationReady === false ? "border-l-warn" : "border-l-accent",
          )}>
            <strong className="block text-[12px] font-semibold text-text">
              {activationReady === false ? "Draft until infrastructure is ready" : "Automatic activation"}
            </strong>
            <span className="mt-1 block text-body leading-relaxed text-muted">
              {activationReady === false
                ? "This Profile will be saved safely without attempting a runtime activation. Finish Platform setup, then verify and activate it from the Profile list."
                : "OrcaSynapse will verify Hermes, activate this immutable Profile, and enable Chat. Personality and Skills describe behavior, never authority."}
            </span>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

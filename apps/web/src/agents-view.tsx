import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import type {
  AdminScope, AdministratorSession, AgentMetrics, AgentProfile, AgentRun, AgentRunEvent,
  AgentRuntimeControl, AgentSkillReference, CreateAgentProfile,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { adminAccess } from "./admin-access.js";
import { ExecutionBoundary, RunDetail, RunLedger } from "./agent-run-ledger.js";
import { runningStatuses, statusTone } from "./agent-status.js";
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
  Alert, Button, Dialog, EmptyState, Field, Input, LockedScreen, PageHeader,
  Panel, PanelHeading, StatusText, Textarea, cn, toneFor,
} from "./ui/index.js";

interface AgentsViewProps {
  unlocked: boolean;
  /**
   * The administrator session, when there is one.
   *
   * Every sibling admin view takes this and derives its controls through
   * `adminAccess`. Profiles took only the boolean below, so every write on the
   * screen was gated on "has a session that is not pending a password change"
   * -- the one thing the API never asks. AUDITOR and OPERATIONS_ADMIN both
   * satisfy it, neither holds `agents:manage`, and navigation is unfiltered.
   *
   * Optional only because `app.tsx` does not pass it yet: adding it as required
   * would fail the build of a file this change does not own. Until
   * `session={adminSession}` is wired there, `granted` below falls back to the
   * boolean and the gating is exactly as permissive as it was.
   */
  session?: AdministratorSession | null;
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

/*
 * The create form opens on the same profile a fresh install is seeded with.
 *
 * What was here before was two sentences of "be concise and evidence-based" --
 * enough to satisfy the 10-character minimum and not enough to govern anything.
 * An operator who accepted it got an assistant with no meaningful accuracy,
 * uncertainty, or decision boundary.
 *
 * Written once in `@orcasynapse/contracts`, so the form and fresh-install seed
 * cannot drift.
 */
const blankProfile: CreateAgentProfile = DEFAULT_AGENT_PROFILE;

function skillManifestText(skills: AgentSkillReference[]): string {
  return skills.map((skill) => `${skill.name}@${skill.version} ${skill.digest}`).join("\n");
}

function parseSkillManifest(value: string): AgentSkillReference[] | null {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line) => /^([a-z0-9]+(?:-[a-z0-9]+)*)@([A-Za-z0-9][A-Za-z0-9._+-]*)\s+([a-f0-9]{64})$/.exec(line));
  if (parsed.some((match) => !match)) return null;
  return parsed.map((match) => ({ name: match![1]!, version: match![2]!, digest: match![3]! }));
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
    safeMode: true,
  };
}

export function AgentsView({ unlocked, session, administrator, activationReady, activationMessage, oidcConfigured, onSignIn, onConfigure, onOpenChat, onOpenReadiness, onSessionExpired }: AgentsViewProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  /*
   * The deployment-wide execution boundary, as the profile list reports it.
   *
   * `null` is "not read yet" and is not the same as `false`: the button below
   * distinguishes an unloaded screen from one that has been told execution is
   * off, and only the second may say so.
   *
   * Read from the profile list rather than from `runtime` because
   * `GET /admin/agents/runtime` is `adminOnly` -- see `runtime` below.
   */
  const [executionEnabled, setExecutionEnabled] = useState<boolean | null>(null);
  /*
   * The boundary's full administrative record: why, by whom, when.
   *
   * Fetched only for administrators, because its route is `adminOnly`, so it is
   * `null` for everyone else. Read in exactly two places, both of which an
   * enterprise identity can never reach: the `ExecutionBoundary` panel, and
   * `verifyProfileForChat`'s decision to switch the boundary on, which is
   * behind `agents:manage`.
   *
   * Nothing that decides whether a control is *offered* may read it. That was
   * the defect: `administrator ? runtime?.enabled === true : true` is
   * permissive for exactly the identity that cannot fetch it, so use
   * `executionEnabled` above for any such question.
   */
  const [runtime, setRuntime] = useState<AgentRuntimeControl | null>(null);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  /** False only after the operator asks to see runs the profile scope hides. */
  const [runsScoped, setRunsScoped] = useState(true);
  const [profileDraft, setProfileDraft] = useState<CreateAgentProfile>(blankProfile);
  const [skillsDraft, setSkillsDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readinessRequired, setReadinessRequired] = useState(false);

  const { can } = adminAccess(session ?? null);
  /*
   * One place for the fallback, so every call site below reads as the scope it
   * needs rather than as a ternary. `administrator` keeps its one honest job --
   * choosing the `/admin/` read surface, which all four roles may use because
   * all four hold `agents:read` -- and stops standing in for the rest.
   */
  const granted = (scope: AdminScope) => (session === undefined ? administrator : can(scope));
  /** Create, new version, activate, suspend: `POST`/`PATCH /admin/agents/profiles`. */
  const canManage = granted("agents:manage");
  /** The execution boundary's switch, and cancelling a run as an administrator. */
  const canControl = granted("agents:control");
  /*
   * Verify & activate calls `POST /admin/onboarding/validate` before it touches
   * a Profile, and that route wants `readiness:manage` -- so the button needs
   * both scopes or it fails on its first step with the Profile untouched.
   */
  const canActivate = canManage && granted("readiness:manage");
  /*
   * The enterprise cancel route authorises the caller against their own run
   * rather than by scope, so this is an administrator's question only.
   */
  const canCancelRuns = administrator ? canControl : true;

  /*
   * Held in a ref, and read through it, so the poll below survives a fresh
   * callback identity. `app.tsx` re-renders on its own interval and hands this
   * view a new `onSessionExpired` arrow every few seconds; depending on that
   * identity would tear down and rebuild the interval on each one, which is the
   * failure `operations-view.tsx` documents.
   */
  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => { latestOnSessionExpired.current = onSessionExpired; }, [onSessionExpired]);

  /** The window the poll reads, without making the interval depend on it. */
  const runsRef = useRef<AgentRun[]>([]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the agent operation.");
  };

  /*
   * Runs move without being asked; profiles change only when someone on this
   * screen changes them, and every one of those paths calls `load`. Keeping the
   * two loaders apart is what lets the interval refetch the ledger every few
   * seconds without also replacing the list an operator is reading.
   */
  const loadRuns = async () => {
    const runList = await getAgentRuns(administrator);
    runsRef.current = runList.items;
    setRuns(runList.items);
    if (administrator) setMetrics(await getAgentMetrics());
  };

  const loadProfiles = async () => {
    const profileList = await getAgentProfiles(administrator);
    setProfiles(profileList.items);
    // Both identity modes take the boundary from here, so the gate below has one
    // source rather than one per role -- the shape that let the two disagree.
    // `?? null` rather than `?? true`: an API too old to send the flag is an API
    // this dashboard cannot ask about the boundary, and the safe reading of "I
    // do not know" is to withhold the session rather than offer one the run
    // would refuse.
    setExecutionEnabled(profileList.executionEnabled ?? null);
    setSelectedProfileId((current) => current || profileList.items.find(({ status }) => status === "ACTIVE")?.id || "");
    if (administrator) setRuntime(await getAgentRuntime());
  };

  const load = async () => { await Promise.all([loadProfiles(), loadRuns()]); };

  useEffect(() => {
    if (!unlocked) {
      setProfiles([]); setExecutionEnabled(null); setRuntime(null); setMetrics(null); setRuns([]); runsRef.current = [];
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => {
      if (active && runsRef.current.some(({ status }) => runningStatuses.has(status))) void loadRuns().catch(() => undefined);
    }, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked, administrator]);

  const selectedProfile = useMemo(
    () => profiles.find(({ id }) => id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  /*
   * Runs belong to the Profile that produced them, so the list above scopes the
   * ledger below. `AgentRun` carries `profileId`, which is the whole reason this
   * can be a real relationship rather than two lists sharing a screen.
   */
  const ledgerScoped = runsScoped && selectedProfileId !== "";
  const runsFor = (profileId: string) => runs.filter((run) => run.profileId === profileId);
  const scopedRuns = useMemo(
    () => (ledgerScoped ? runs.filter(({ profileId }) => profileId === selectedProfileId) : runs),
    [runs, ledgerScoped, selectedProfileId],
  );

  const selectedRun = useMemo(
    () => scopedRuns.find(({ id }) => id === selectedRunId) ?? scopedRuns[0] ?? null,
    [scopedRuns, selectedRunId],
  );

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

  /*
   * Selecting a Profile re-scopes the ledger, which is the only thing this has
   * to do. The run selection is deliberately left alone: `selectedRun` falls
   * back to the newest run in scope whenever the held id is not in it, so
   * clearing the id here would change nothing except to forget a selection the
   * operator may come back to. A line whose removal no test can notice is worse
   * than none -- it implies a guarantee something else is already making.
   */
  const selectProfile = (profileId: string) => {
    setSelectedProfileId(profileId);
    setRunsScoped(true);
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
        kicker="Governed configuration"
        title="Agent Profiles"
        mark="HA"
        headline="Authenticated workspace required"
        reason="Sign in to see which profiles are active and what they have run. Administrators can also author immutable versions, verify them against Hermes, and control the global execution boundary."
        actionLabel={oidcConfigured ? "Enterprise sign in" : "Administrator setup"}
        onAction={oidcConfigured ? onSignIn : onConfigure}
        {...(oidcConfigured ? { secondaryLabel: "Administrator setup", onSecondary: onConfigure } : {})}
      />
    );
  }

  /*
   * Both halves of "can this reader start a session", gated identically for
   * both identity modes.
   *
   * It used to fall back to `true` for a non-administrator, because the only
   * source of the boundary was the admin-only route they cannot call. An
   * enterprise user was shown an enabled Open Session while execution was
   * switched off, and their run was refused at submission -- after they had
   * typed the message.
   */
  const chatAvailable = profiles.some(({ status }) => status === "ACTIVE") && executionEnabled === true;
  /*
   * Which half is missing, said out loud. "Session not ready" reads as a
   * complaint about the Profile, and when the boundary is off the Profile is the
   * one thing in order -- and the one thing an enterprise reader could not fix
   * anyway. The boundary wins when both are missing: it is the outer gate, and
   * no Profile change clears it.
   *
   * `null` is still "not read yet", so an unloaded screen makes neither claim.
   */
  const chatLabel = chatAvailable ? "Open Session" : executionEnabled === false ? "Execution is off" : "Session not ready";

  return (
    <div className="grid gap-5">
      <PageHeader
        kicker="Immutable configuration"
        title="Hermes Profiles"
        /* The boundary clause only where the boundary panel is: it is drawn for
           administrators, and describing a control the reader will not find is
           the same failure as pointing at one on another tab. */
        description={administrator
          ? "Immutable Profile Distributions and their verified activation, the runs each one has produced, and the global boundary deciding whether any of it may execute."
          : "Immutable Profile Distributions and their verified activation, and the runs you have produced against them."}
        actions={<>
          <Button disabled={!chatAvailable} onClick={onOpenChat}>{chatLabel}</Button>
          {/* `.catch(fail)` like every other call site here: without it an
              idled-out session rejects unhandled, so neither the Alert nor the
              re-auth path fires and the screen keeps its stale data. */}
          <Button onClick={() => void load().catch(fail)}>Refresh</Button>
          {canManage && <Button variant="primary" onClick={() => void openNewProfile()}>{activationReady === false ? "Create draft" : "Create agent"}</Button>}
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
        {chatAvailable && <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenChat}>Open Session</Button>}
      </Alert>}
      {/* "Profiles can be drafted now" is a claim about the reader, so it is
          addressed to the role that can actually draft one. */}
      {canManage && activationReady === false && <Panel className="flex items-center gap-4 border-l-2 border-l-warn" role="status">
        <div className="min-w-0 flex-1">
          <strong className="block text-label font-semibold text-text">Profiles can be drafted now</strong>
          <span className="mt-1 block text-body text-muted">
            {activationMessage ?? "Connect AI Inference and finish VM2 enrollment before activating a Profile for Chat."}
          </span>
        </div>
        <Button className="shrink-0" onClick={onOpenReadiness}>Review platform setup</Button>
      </Panel>}

      {/*
        * The screen reads in one direction: what may execute at all, what is
        * defined, and what each definition has actually done. The boundary
        * leads because it frames everything under it rather than following from
        * it -- and because an operator switching it off is not browsing.
        */}
      {administrator && <ExecutionBoundary
        runtime={runtime}
        metrics={metrics}
        runs={runs}
        busy={busy}
        onToggle={(enabled, reason) => void action("runtime", () => updateAgentRuntime(enabled, reason))}
        hasProfiles={profiles.length > 0}
        canControl={canControl}
        canManage={canManage}
      />}

      <Panel>
        <PanelHeading
          kicker="Immutable configuration"
          title="Profiles"
          description="Selecting one scopes the execution ledger below to the runs it produced."
          actions={<StatusText>{profiles.length} profile{profiles.length === 1 ? "" : "s"}</StatusText>}
        />
        <div className="grid gap-2">
          {profiles.length === 0 && (
            <EmptyState
              title="Create your first agent"
              action={canManage ? <Button variant="primary" onClick={() => void openNewProfile()}>Create starter agent</Button> : undefined}
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
            <Button
              variant="ghost"
              // Same reason as the run rows: three stacked lines do not fit the
              // default single-line height, and `p-0` keeps the article's own
              // padding as the row's only inset.
              size="auto"
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-0 text-left"
              onClick={() => selectProfile(profile.id)}
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 place-items-center rounded border border-border-strong bg-surface font-mono text-[10px] font-bold text-accent"
              >
                {profile.version.displayName.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <strong className="block truncate text-label font-semibold text-text">{profile.version.displayName}</strong>
                <p className="mb-0 mt-0.5 truncate text-caption text-muted">{profile.version.purpose}</p>
                {/* The distribution digest is what VM2 admits, so it is on the
                    row rather than behind a click. */}
                <small className="mt-1 block truncate font-mono text-micro text-faint">
                  {profile.slug} · current v{profile.version.version} · {profile.version.modelAlias} · distro {profile.version.distributionDigest.slice(0, 10)}
                  {profile.activeVersion !== null && profile.activeVersion !== profile.version.version ? ` · live v${profile.activeVersion}` : ""}
                </small>
              </div>
              {/*
                * Configuration status, then what that configuration is doing.
                * "recent" is not hedging: the ledger is the newest 200 runs, so
                * a figure derived from it is a window count and says so rather
                * than posing as a lifetime total -- the deployment-wide totals
                * are on the boundary above, where the API can back them.
                *
                * "by you" is the same honesty about the other axis.
                * `GET /agents/runs` returns a non-administrator only their own
                * runs, against a Profile that belongs to the whole deployment,
                * so an unqualified "no recent runs" beside a Profile colleagues
                * have run fifty times describes the reader, not the Profile.
                */}
              <div className="grid justify-items-end gap-1">
                <StatusText dot tone={toneFor(statusTone(profile.status))}>{profile.status.toLowerCase()}</StatusText>
                {runsFor(profile.id).some(({ status }) => runningStatuses.has(status))
                  ? <StatusText tone="accent">
                    {runsFor(profile.id).filter(({ status }) => runningStatuses.has(status)).length} running
                    {administrator ? "" : " for you"}
                  </StatusText>
                  : <StatusText>
                    {runsFor(profile.id).length === 0
                      ? "no recent runs"
                      : `${runsFor(profile.id).length} recent run${runsFor(profile.id).length === 1 ? "" : "s"}`}
                    {administrator ? "" : " by you"}
                  </StatusText>}
              </div>
            </Button>
            {canManage && <div className="flex justify-end gap-1.5">
              <Button size="sm" onClick={() => editProfile(profile)}>New version</Button>
              {profile.status === "ACTIVE"
                ? <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void action(`suspend-${profile.id}`, () => setAgentProfileState(profile.id, "suspend"))}>Suspend</Button>
                /* Verification runs before activation and needs `readiness:manage`
                   as well, so the button is withheld unless both are held. */
                : canActivate && <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void activateForChat(profile)}>
                    {busy === `activate-${profile.id}` ? "Verifying Hermes..." : "Verify & activate"}
                  </Button>}
            </div>}
          </article>)}
        </div>
      </Panel>

      {/*
        * The ledger, scoped to the Profile selected above, beside the one run
        * being read. This pairing was the whole of the Runtime tab; what it
        * lacked was the sentence joining it to a Profile, which it could not
        * state because the Profile list was on another screen.
        */}
      <div className={cn("grid items-start gap-4", runs.length > 0 && "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]")}>
        <RunLedger
          runs={scopedRuns}
          total={runs.length}
          profileName={selectedProfile?.version.displayName ?? null}
          scoped={ledgerScoped}
          administrator={administrator}
          selectedRunId={selectedRun?.id ?? null}
          onSelectRun={setSelectedRunId}
          onScopeChange={setRunsScoped}
        />
        {/*
          * Withheld only when the deployment has produced nothing at all. A
          * pane inviting the operator to select one of no runs is scaffolding
          * that makes a fresh install look half-built -- and a profile with no
          * runs of its own still gets one, because the escape hatch beside it
          * means there is something to select.
          */}
        {runs.length > 0 && <RunDetail
          run={selectedRun}
          events={runEvents}
          busy={busy}
          canCancel={canCancelRuns}
          onCancel={(run) => void action(`cancel-${run.id}`, () => cancelAgentRun(run.id, administrator))}
        />}
      </div>

      {/*
        * The profile editor was a hand-rolled backdrop with no focus trap, no
        * Escape and no scroll lock — the same gap the Chat overlays had before
        * v1.1.0. It is a long form that decides what an agent may do, so
        * tabbing out of it mid-edit is the worst place for that to happen.
        */}
      <Dialog
        open={editorOpen && canManage}
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
          {/*
            * The label and hint say what the field does, which is less than it
            * used to imply. The triples are recorded on the version and folded
            * into `distributionDigest`; the run payload carries no skills
            * field, and nothing in `apps/worker` or `packages/runtime-clients`
            * reads `version.skills`. Whether that stays true is a product
            * decision and not this file's to make -- reading the field as
            * "this Profile is bound to that Skill" is the part that has to
            * stop.
            */}
          <Field
            label="Approved Skills (recorded, not delivered)"
            hint="A reviewed, secret-free record of the Skills this version expects. It is folded into the distribution digest and never sent to Hermes: OrcaSynapse does not install, pin, or verify a Skill from here, and a run loads whatever the node already holds. Govern the node's own Skills under Agents → Skills."
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
          <Field label="Memory" hint="Hermes manages its native MEMORY.md and USER.md lifecycle inside the isolated runtime.">
            <div className="rounded border border-border bg-raised p-3 text-body text-muted">
              Hermes-native memory is active and remains canonical on VM2. Administrators can observe and govern its allowlisted file mirror from Agents → Memory; it is never used as model context.
            </div>
          </Field>
          <div className={cn(
            "rounded border border-l-2 border-border p-3",
            activationReady === false ? "border-l-warn" : "border-l-accent",
          )}>
            <strong className="block text-label font-semibold text-text">
              {activationReady === false ? "Draft until infrastructure is ready" : "Automatic activation"}
            </strong>
            <span className="mt-1 block text-body leading-relaxed text-muted">
              {activationReady === false
                ? "This Profile will be saved safely without attempting a runtime activation. Finish Settings setup, then verify and activate it from the Profile list."
                : "OrcaSynapse will verify Hermes, activate this immutable Profile, and enable Chat. Personality and Skills describe behavior, never authority."}
            </span>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

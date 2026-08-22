import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import type {
  AdminScope, AdministratorSession, AgentMetrics, AgentProfile, AgentRun, AgentRunEvent,
  AgentRuntimeControl, CreateAgentProfile, Division, SkillSet, ToolSet,
} from "@orcasynapse/contracts";
import { Bot, ChevronDown, RefreshCw as SyncIcon } from "lucide-react";
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
  assignProfileDivision,
  getDivisions,
  getSkillSets,
  getToolSets,
  runOnboardingValidation,
  setAgentProfileState,
  updateAgentProfile,
  updateAgentRuntime,
} from "./api.js";
import {
  Alert, Button, Dialog, EmptyState, Field, Input, LockedScreen, MicroLabel,
  Panel, PanelHeading, Select, StatusText, Textarea, WorkspaceIntro, cn, toneFor,
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

function draftFromProfile(profile: AgentProfile): CreateAgentProfile {
  return {
    slug: profile.slug,
    displayName: profile.version.displayName,
    purpose: profile.version.purpose,
    instructions: profile.version.instructions,
    soulMd: profile.version.soulMd,
    modelAlias: profile.version.modelAlias,
    maxTurns: 1,
    timeoutSeconds: profile.version.timeoutSeconds,
    maxConcurrentRuns: profile.version.maxConcurrentRuns,
    safeMode: true,
    ...(profile.version.toolSetId ? { toolSetId: profile.version.toolSetId } : {}),
    ...(profile.version.skillSetId ? { skillSetId: profile.version.skillSetId } : {}),
  };
}

export function AgentsView({ unlocked, session, administrator, activationReady, onConfigure, onOpenChat, onOpenReadiness, onSessionExpired }: AgentsViewProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  /*
   * The named sets and divisions a profile can be pointed at.
   *
   * Loaded here rather than inside the editor so the list can name a profile's
   * division without a second round trip, and so a failure to read them leaves
   * the editor usable: a profile created without naming a set gets the tracking
   * defaults on the server, which is the same answer an empty picker gives.
   */
  const [toolSets, setToolSets] = useState<ToolSet[]>([]);
  const [skillSets, setSkillSets] = useState<SkillSet[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
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
    /*
     * Best-effort and deliberately not part of `load`: these three only fill
     * pickers, and a profile saved without naming a set gets the tracking
     * defaults on the server. A failure here must not take the editor down with
     * it.
     */
    void Promise.all([getToolSets(), getSkillSets(), getDivisions(false)])
      .then(([tools, skills, divisionList]) => {
        if (!active) return;
        setToolSets(tools.items);
        setSkillSets(skills.items);
        setDivisions(divisionList.items);
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      if (active && runsRef.current.some(({ status }) => runningStatuses.has(status))) void loadRuns().catch(() => undefined);
    }, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked, administrator]);

  const assignDivision = async (profile: AgentProfile, divisionId: string | null) => {
    setBusy("profile-save");
    try {
      await assignProfileDivision(profile.id, divisionId, profile.currentVersion);
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

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

  const openNewProfile = () => {
    setError(null);
    setNotice(null);
    setEditingId(null);
    setProfileDraft(blankProfile);
    setEditorOpen(true);
  };

  const editProfile = (profile: AgentProfile) => {
    setEditingId(profile.id);
    setProfileDraft(draftFromProfile(profile));
    setEditorOpen(true);
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy("profile-save");
    setError(null);
    setNotice(null);
    setReadinessRequired(false);
    try {
      /*
       * The model is deliberately never sent: the server derives it from the
       * approved inference setup at mint time, so a profile follows a route
       * change instead of pinning whatever the screen once knew.
       */
      const { modelAlias: _model, ...candidate } = { ...profileDraft };
      if (editingId) {
        const { slug: _slug, ...configuration } = candidate;
        await updateAgentProfile(editingId, configuration);
        setNotice(`${candidate.displayName} version saved. Activate it when the new revision is ready for Chat.`);
      } else {
        const created = await createAgentProfile(candidate);
        // Creation is durable. Close the editor before live verification so a
        // failed readiness check cannot tempt the operator to submit a duplicate.
        setEditorOpen(false); setEditingId(null); setProfileDraft(blankProfile);
        if (activationReady === false) {
          setNotice(`${created.version.displayName} was saved as a draft. Finish the Agentic System, then use Verify & activate.`);
        } else {
          await verifyProfileForChat(created);
          setNotice(`${created.version.displayName} was created, verified, and activated. Chat is ready.`);
        }
      }
      setEditorOpen(false); setEditingId(null); setProfileDraft(blankProfile);
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
        actionLabel="Administrator setup"
        onAction={onConfigure}
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

  /*
   * What the save button is about to do, and what it costs right now. A save
   * onto an ACTIVE profile releases immediately, and the worker's boundary
   * check stops any run still executing on the superseded version -- so the
   * editor says both before the operator commits, instead of a colleague's
   * answer dying with "version no longer active" as the announcement.
   */
  const editingProfile = editingId === null ? undefined : profiles.find(({ id }) => id === editingId);
  const editingReleases = editingProfile?.status === "ACTIVE";
  const editingRunning = editingProfile
    ? runsFor(editingProfile.id).filter(({ status }) => runningStatuses.has(status)).length
    : 0;

  return (
    <div className="workspace-stack agents-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<Bot className="size-4" aria-hidden="true" />}
        title="Hermes Profiles"
        actions={<>
          <Button disabled={!chatAvailable} onClick={onOpenChat}>{chatLabel}</Button>
          {/* `.catch(fail)` like every other call site here: without it an
              idled-out session rejects unhandled, so neither the Alert nor the
              re-auth path fires and the screen keeps its stale data. */}
          <Button onClick={() => void load().catch(fail)}><SyncIcon size={16} />Refresh</Button>
          {canManage && <Button variant="primary" onClick={() => void openNewProfile()}>{activationReady === false ? "Create draft" : "Create agent"}</Button>}
        </>}
      >
        {/*
          * The screen reads in one direction: what may execute at all, what is
          * defined, and what each definition has actually done. The boundary
          * lives in this card because it frames the columns under it — and
          * because an operator switching it off is not browsing.
          */}
        {administrator ? (
          <ExecutionBoundary
            runtime={runtime}
            metrics={metrics}
            runs={runs}
            busy={busy}
            onToggle={(enabled, reason, extraction) => void action("runtime", () => updateAgentRuntime(enabled, reason, extraction))}
            canControl={canControl}
          />
        ) : null}
      </WorkspaceIntro>

      {error && <Alert className="shrink-0" onDismiss={() => { setError(null); setReadinessRequired(false); }}>
        {error}
        {readinessRequired && (
          <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenReadiness}>Open Hermes readiness</Button>
        )}
      </Alert>}
      {notice && <Alert className="shrink-0" tone="good" onDismiss={() => setNotice(null)}>
        {notice}
        {chatAvailable && <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenChat}>Open Session</Button>}
      </Alert>}

      {/*
        * 2x2, not three columns. Profiles and the ledger it scopes share the
        * top row -- selecting on the left filters the right, so they read as
        * one gesture. Run detail takes the whole second row: it is the densest
        * panel here (timeline, digest, input, output), and at a third of the
        * viewport each of those was a strip two words wide.
        */}
      <div className={cn(
        "grid min-h-0 flex-1 gap-3 lg:grid-cols-2",
        runs.length > 0 && "lg:grid-rows-[minmax(0,1fr)_minmax(0,1.1fr)]",
      )}>
      <Panel className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3">
        <PanelHeading
          className="mb-2 shrink-0"
          kicker="Immutable configuration"
          title="Profiles"
          actions={<StatusText>{profiles.length} profile{profiles.length === 1 ? "" : "s"}</StatusText>}
        />
        <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
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
              "grid gap-2.5 rounded-lg border p-3 transition-colors",
              selectedProfileId === profile.id
                ? "border-border-strong bg-raised"
                : "border-border bg-raised/40 hover:border-border-strong/70",
            )}
          >
            <Button
              variant="ghost"
              // Same reason as the run rows: stacked lines do not fit the
              // default single-line height, and `p-0` keeps the article's own
              // padding as the row's only inset.
              size="auto"
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-0 text-left"
              onClick={() => selectProfile(profile.id)}
            >
              <span
                aria-hidden="true"
                className="grid h-10 w-10 place-items-center rounded-md bg-accent/10 font-mono text-caption font-bold text-accent"
              >
                {profile.version.displayName.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <strong className="block truncate text-label font-semibold text-text">{profile.version.displayName}</strong>
                <p className="mb-0 mt-0.5 line-clamp-2 text-caption text-muted">{profile.version.purpose}</p>
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
            {/*
              * The facts the old dot-separated mono line crammed into one
              * truncating string, as chips that wrap instead of vanishing. The
              * distribution digest is what VM2 admits, so it stays on the card
              * rather than behind a click.
              *
              * "everyone" is the honest word for a null division: the profile
              * really is visible to every signed-in user. It is keyed off a
              * null `divisionId` and never off a failed lookup -- the division
              * list loads separately and lands after the profiles, and for that
              * frame a restricted profile must not announce itself as visible
              * to everybody.
              */}
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-micro text-faint">
              {[
                profile.slug,
                `current v${profile.version.version}`,
                ...(profile.activeVersion !== null && profile.activeVersion !== profile.version.version
                  ? [`live v${profile.activeVersion}`] : []),
                profile.version.modelAlias,
                `distro ${profile.version.distributionDigest.slice(0, 10)}`,
                profile.divisionId === null
                  ? "everyone"
                  : divisions.find(({ id }) => id === profile.divisionId)?.displayName ?? "a division",
              ].map((fact) => (
                <span key={fact} className="rounded border border-border bg-surface/60 px-1.5 py-0.5">{fact}</span>
              ))}
            </div>
            {canManage && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
              {divisions.length > 0
                ? (
                  /*
                    * Its own control, not a field in the version editor.
                    * Assigning a division does not change what the agent is or
                    * how it behaves, only who may reach it -- minting a new
                    * immutable version for it would make the version history
                    * lie about what changed. The write is guarded server-side
                    * by `currentVersion`, so a stale tab cannot silently
                    * re-home a profile somebody else just edited.
                    */
                  <label className="flex min-w-0 items-center gap-2 text-caption text-muted">
                    <span className="shrink-0">Visible to</span>
                    <Select
                      className="h-8 w-[190px] text-caption"
                      value={profile.divisionId ?? ""}
                      disabled={busy !== null}
                      onChange={(event) => void assignDivision(profile, event.target.value || null)}
                    >
                      <option value="">Everyone (deployment-wide)</option>
                      {divisions.map((item) => (
                        <option key={item.id} value={item.id}>{item.displayName}</option>
                      ))}
                    </Select>
                  </label>
                )
                : <span aria-hidden="true" />}
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => editProfile(profile)}>New version</Button>
                {profile.status === "ACTIVE"
                  ? <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void action(`suspend-${profile.id}`, () => setAgentProfileState(profile.id, "suspend"))}>Suspend</Button>
                  /* Verification runs before activation and needs `readiness:manage`
                     as well, so the button is withheld unless both are held. */
                  : canActivate && <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void activateForChat(profile)}>
                      {busy === `activate-${profile.id}` ? "Verifying Hermes..." : "Verify & activate"}
                    </Button>}
              </div>
            </div>}
          </article>)}
        </div>
      </Panel>

      {/*
        * The ledger, scoped to the Profile selected beside it, and the one run
        * being read. This pairing was the whole of the Runtime tab; what it
        * lacked was the sentence joining it to a Profile, which it could not
        * state because the Profile list was on another screen.
        */}
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
        {/* The span is on a wrapper because RunDetail is a Panel that sizes
            itself; the wrapper owns the grid placement, the panel the chrome. */}
        {runs.length > 0 && <div className="grid min-h-0 lg:col-span-2"><RunDetail
          run={selectedRun}
          events={runEvents}
          busy={busy}
          canCancel={canCancelRuns}
          onCancel={(run) => void action(`cancel-${run.id}`, () => cancelAgentRun(run.id, administrator))}
        /></div>}
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
        className="max-w-[840px]"
        icon={Bot}
        title={editingId ? "Create a new profile version" : "Create agent profile"}
        description={editingId
          ? (editingReleases
            ? "Saving writes a new immutable revision and releases it immediately — Sessions use it from their next message."
              + (editingRunning > 0
                ? ` ${editingRunning} run${editingRunning === 1 ? " is" : "s are"} executing on the current version and will stop when this releases.`
                : "")
            : "Saving writes a new immutable revision. The current version stays in the ledger until this profile is activated.")
          : "Name it, then write how it should think and act."}
        footer={<>
          <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy !== null} type="submit" form="agent-profile-editor">
            {busy === "profile-save"
              ? "Saving..."
              : editingId
                ? (editingReleases ? "Save & release" : "Save new version")
                : activationReady === false ? "Save draft" : "Create & activate"}
          </Button>
        </>}
      >
        <form className="grid gap-5" id="agent-profile-editor" onSubmit={(event) => void saveProfile(event)}>
          {error ? <Alert onDismiss={() => { setError(null); setReadinessRequired(false); }}>{error}</Alert> : null}

          {/*
            * Section labels as rules rather than headings with a paragraph.
            * "How this profile is named, and which model it uses." sat above
            * fields labelled Slug, Display name, Purpose and Inference model --
            * the same four facts in a sentence. A hairline with a word on it
            * groups them for a fraction of the height, and the form reads as
            * three passes instead of one long stack of inputs.
            */}
          <section className="grid gap-3">
            <MicroLabel className="block">Identity</MicroLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Slug">
                <Input required disabled={editingId !== null} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={profileDraft.slug} onChange={(event) => setProfileDraft({ ...profileDraft, slug: event.target.value })} />
              </Field>
              <Field label="Display name">
                <Input required minLength={2} maxLength={120} value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} />
              </Field>
            </div>
            <Field label="Purpose">
              <Textarea className="min-h-[64px]" rows={2} required minLength={3} maxLength={500} value={profileDraft.purpose} onChange={(event) => setProfileDraft({ ...profileDraft, purpose: event.target.value })} />
            </Field>
            {/*
              * Deliberately not a field. The gateway forwards every request
              * with the approved route's model regardless of what a profile
              * says, so asking for a model name here was asking the operator
              * to hand-copy platform state -- and the copy drifted. The server
              * resolves the alias from the ACTIVE default Agent route when
              * each version is minted; the card's chips show what a version
              * resolved to.
              */}
            <p className="mb-0 text-caption text-muted">
              The model follows the ACTIVE default Agent route on Gateway → Models. Profiles pick it up on their next save.
            </p>
          </section>

          <section className="grid gap-3 border-t border-border pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <MicroLabel className="block">Behaviour</MicroLabel>
              {/* Only the half the field labels cannot carry: what saving does. */}
              <span className="text-caption text-muted">Both become the immutable revision.</span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Personality and operating principles">
                <Textarea
                  className="min-h-[200px]"
                  rows={10}
                  required
                  minLength={10}
                  maxLength={32_000}
                  value={profileDraft.soulMd}
                  onChange={(event) => setProfileDraft({ ...profileDraft, soulMd: event.target.value })}
                />
              </Field>
              <Field label="System instructions">
                <Textarea
                  className="min-h-[200px]"
                  rows={10}
                  required
                  minLength={10}
                  maxLength={32_000}
                  value={profileDraft.instructions}
                  onChange={(event) => setProfileDraft({ ...profileDraft, instructions: event.target.value })}
                />
              </Field>
            </div>
          </section>

          <details className="group border-t border-border pt-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
              <span>
                <span className="block text-label font-semibold text-foreground">Limits and recorded references</span>
                <span className="block text-caption font-normal text-muted">Tool sets, skill sets, and run limits. Recorded on the version, not delivered to a run.</span>
              </span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {/*
                  * Recorded on the version, delivered to nothing -- the same
                  * correction the Approved Skills field carried before it was
                  * removed outright, except that this field is about authority
                  * rather than behaviour, so reading it wrongly is worse. `agent-processor.ts` selects every admitted toolset with
                  * no profile predicate and hands that array to `hermes.start`;
                  * `toolSetId` has no reader in the worker, in
                  * `packages/runtime-clients`, or in the tool-call gate, and
                  * `agent-processor.test.ts` pins the deployment-wide set being
                  * submitted even for a profile that names a narrower one.
                  *
                  * So a set narrows nothing today, and the label said "everything
                  * admitted" as though the alternative narrowed something. What an
                  * agent may actually use is decided by admission under Tools; that
                  * is where an operator has to be sent, rather than to a select
                  * that records a preference.
                  */}
                <Field
                  label="Tool set (recorded, not delivered)"
                  hint="Which Hermes toolsets this version declares. It is recorded on the version and folded into the distribution digest, and it does not narrow a run: every admitted toolset is submitted to Hermes whatever this says. Withhold a toolset under Agents → Tools to change what an agent may actually use."
                >
                  <Select
                    value={profileDraft.toolSetId ?? ""}
                    onChange={(event) => setProfileDraft({ ...profileDraft, toolSetId: event.target.value || undefined })}
                  >
                    <option value="">Default — no set declared</option>
                    {toolSets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.displayName}{set.tracksAdmission ? " (tracks admission)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Skill set"
                  hint="A named selection the system prompt can refer to. Like the Skills field above, it is recorded rather than delivered."
                >
                  <Select
                    value={profileDraft.skillSetId ?? ""}
                    onChange={(event) => setProfileDraft({ ...profileDraft, skillSetId: event.target.value || undefined })}
                  >
                    <option value="">Default — everything the runtime reports</option>
                    {skillSets.map((set) => (
                      <option key={set.id} value={set.id}>{set.displayName}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Timeout (seconds)">
                  <Input required type="number" min={30} max={3600} value={profileDraft.timeoutSeconds} onChange={(event) => setProfileDraft({ ...profileDraft, timeoutSeconds: Number(event.target.value) })} />
                </Field>
                <Field label="Concurrent runs">
                  <Input required type="number" min={1} max={20} value={profileDraft.maxConcurrentRuns} onChange={(event) => setProfileDraft({ ...profileDraft, maxConcurrentRuns: Number(event.target.value) })} />
                </Field>
              </div>
              <p className="m-0 text-caption leading-relaxed text-muted">
                Hermes-native memory is active and remains canonical on VM2. Administrators can observe and govern its allowlisted file mirror from Agents → Memory; it is never used as model context.
              </p>
            </div>
          </details>

          {activationReady === false ? (
            <Alert tone="warn">
              <span className="block font-semibold">Draft until infrastructure is ready</span>
              <span className="mt-1 block text-caption leading-relaxed">
                This Profile will be saved safely without attempting a runtime activation. Finish Settings setup, then verify and activate it from the Profile list.
              </span>
            </Alert>
          ) : (
            <p className="m-0 text-caption leading-relaxed text-muted">
              OrcaSynapse will verify Hermes, activate this immutable Profile, and enable Chat. Personality and Skills describe behavior, never authority.
            </p>
          )}
        </form>
      </Dialog>
    </div>
  );
}

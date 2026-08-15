import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import type { AgentProfile, AgentRuntimeControl, AgentSkillReference, CreateAgentProfile } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { statusTone } from "./agent-status.js";
import {
  OrcaSynapseApiError,
  createAgentProfile,
  getAgentProfiles,
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

export function AgentsView({ unlocked, administrator, activationReady, activationMessage, oidcConfigured, onSignIn, onConfigure, onOpenChat, onOpenReadiness, onSessionExpired }: AgentsViewProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  /*
   * Read, not drawn. The kill switch and its audit-reason form belong to
   * Runtime; what this screen still needs from the boundary is whether Chat is
   * reachable, and whether activating the first Profile has to switch it on --
   * which `verifyProfileForChat` does below.
   */
  const [runtime, setRuntime] = useState<AgentRuntimeControl | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDraft, setProfileDraft] = useState<CreateAgentProfile>(blankProfile);
  const [skillsDraft, setSkillsDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readinessRequired, setReadinessRequired] = useState(false);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the agent operation.");
  };

  const load = async () => {
    const profileList = await getAgentProfiles(administrator);
    setProfiles(profileList.items);
    setSelectedProfileId((current) => current || profileList.items.find(({ status }) => status === "ACTIVE")?.id || "");
    if (administrator) setRuntime(await getAgentRuntime());
  };

  /*
   * No polling interval. The run ledger needed one because Hermes moves work
   * without being asked; a Profile list changes only when someone on this
   * screen changes it, and every one of those paths already calls `load`.
   */
  useEffect(() => {
    if (!unlocked) {
      setProfiles([]); setRuntime(null);
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    return () => { active = false; };
  }, [unlocked, administrator]);

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
        kicker="Governed configuration"
        title="Agent Profiles"
        mark="HA"
        headline="Authenticated workspace required"
        reason="Sign in to see which profiles are active. Administrators can also author immutable versions, verify them against Hermes, and activate them for Chat."
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
        kicker="Immutable configuration"
        title="Hermes Profiles"
        description="Immutable Profile Distributions, their versions, and the verified activation that makes one usable in Chat."
        actions={<>
          <Button disabled={!chatAvailable} onClick={onOpenChat}>{chatAvailable ? "Open Session" : "Session not ready"}</Button>
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
        {chatAvailable && <Button variant="ghost" size="sm" className="ml-3" onClick={onOpenChat}>Open Session</Button>}
      </Alert>}
      {administrator && activationReady === false && <Panel className="flex items-center gap-4 border-l-2 border-l-warn" role="status">
        <div className="min-w-0 flex-1">
          <strong className="block text-label font-semibold text-text">Profiles can be drafted now</strong>
          <span className="mt-1 block text-body text-muted">
            {activationMessage ?? "Connect AI Inference and finish VM2 enrollment before activating a Profile for Chat."}
          </span>
        </div>
        <Button className="shrink-0" onClick={onOpenReadiness}>Review platform setup</Button>
      </Panel>}

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
            <Button
              variant="ghost"
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-left"
              onClick={() => setSelectedProfileId(profile.id)}
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
              <StatusText dot tone={toneFor(statusTone(profile.status))}>{profile.status.toLowerCase()}</StatusText>
            </Button>
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

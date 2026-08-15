import type {
  CreateHermesNodeInvitation,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  OnboardingTargetEnvironment,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createHermesNodeInvitation,
  getHermesRuntimeNodes,
  mutateHermesRuntimeNode,
  removeHermesRuntimeNode,
} from "./api.js";
import { Button, Dialog, Drawer, EmptyState, Input, MicroLabel, StatusText, Tile, cn } from "./ui/index.js";
import { Switch } from "@/components/ui/switch";

/**
 * How often the fleet is re-read while this panel is mounted.
 *
 * Enrolment hands off to another machine for 15-20 minutes and the node's
 * status is written by its own signed heartbeat, so the screen has no way to
 * learn that VM2 arrived except by asking. Ten seconds is well inside the
 * server's 180 s staleness window, which means a node that goes quiet is seen
 * as DEGRADED here within one window rather than at the next manual refresh.
 */
const NODE_POLL_MS = 10_000;

interface RuntimeNodesPanelProps {
  /**
   * `null` while the architecture decision has not loaded, or failed to.
   *
   * Not defaulted to DEVELOPMENT: that default is the one guess that *removes*
   * a guard, so a PRODUCTION install whose snapshot had not arrived was offered
   * an unpinned, plain-HTTP enrolment the API then refuses.
   */
  targetEnvironment: OnboardingTargetEnvironment | null;
  inferenceReady: boolean;
  onConfigureInference: () => void;
  onNodesChange?: (nodes: HermesRuntimeNode[]) => void;
  onSessionExpired: () => void;
}

/** `mm:ss`, because the first minute of a 20-minute wait is the anxious one. */
function elapsedSince(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The claim's remaining life, in the units the invitation form sets it in. */
function remainingMinutes(expiresAt: string, now: number): number {
  return Math.floor((Date.parse(expiresAt) - now) / 60_000);
}

function nodeTone(status: string): string {
  if (status === "ONLINE") return "ready";
  if (["PENDING", "DRAINING", "DEGRADED"].includes(status)) return "processing";
  if (["SUSPENDED", "REVOKED", "OFFLINE"].includes(status)) return "failed";
  return "neutral";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

/**
 * Whether this node is running something other than the commit recorded for it.
 *
 * Three states, not two. `hermesVersion` is what the node last reported and
 * `expectedHermesCommit` is what the control plane told it to run, and either
 * can be unknown: a node enrolled before the pin was recorded has no target,
 * and a node whose install could not resolve a commit reports "unknown". An
 * unknown is not a disagreement, and drawing it as one would put a fault on
 * the screen that no operator action can clear.
 */
function commitDrift(node: HermesRuntimeNode): boolean {
  const running = node.hermesVersion?.trim().toLowerCase() ?? "";
  if (!node.expectedHermesCommit || !/^[0-9a-f]{40}$/.test(running)) return false;
  return running !== node.expectedHermesCommit;
}

/**
 * The runtime revision line under a node: what it runs, and what it should.
 *
 * The expected commit is named only when it differs. A node that is where it
 * was put needs one commit on the screen, not two.
 */
function runtimeRevision(node: HermesRuntimeNode): string {
  if (!node.hermesVersion) return "Version pending";
  const running = /^[0-9a-f]{40}$/i.test(node.hermesVersion.trim())
    ? node.hermesVersion.trim().toLowerCase().slice(0, 12)
    : node.hermesVersion;
  return commitDrift(node) && node.expectedHermesCommit
    ? `${running} · expects ${node.expectedHermesCommit.slice(0, 12)}`
    : running;
}

function saveFile(fileName: string, content: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function agenticNodeInstallCommand(controlPlaneUrl: string): string {
  const origin = controlPlaneUrl.replace(/\/+$/, "");
  // -fsSL, not the long flag names: fail hard on an HTTP error so a proxy or
  // error page is never piped into a root shell, stay quiet, still print
  // transport errors, and follow redirects.
  return `curl -fsSL ${origin}/install/agentic-node.sh | sudo bash -s -- --connect ${origin}`;
}

export function agenticNodeRemovalCommand(controlPlaneUrl: string): string {
  const origin = controlPlaneUrl.replace(/\/+$/, "");
  return `curl -fsSL ${origin}/install/remove-agentic-node.sh | sudo bash`;
}

/**
 * The Hermes revision a fresh invitation offers, matching the contract's own
 * default. Exported because the wizard states the production artifact
 * requirements before this form is opened, and a second literal would let the
 * two disagree about what is actually about to be installed.
 */
export const DEFAULT_HERMES_COMMIT = "c015663b215c0e14de4295346b0727db602cbb1d";

/** The origin VM2 is told to call back on, which is this dashboard's own. */
export function defaultControlPlaneUrl(): string {
  return typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin;
}

function defaultForm(): CreateHermesNodeInvitation {
  return {
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    baseUrl: "http://10.0.0.12:8642",
    controlPlaneUrl: defaultControlPlaneUrl(),
    hermesCommit: DEFAULT_HERMES_COMMIT,
    expiresInMinutes: 30,
  };
}

export function RuntimeNodesPanel({
  targetEnvironment,
  inferenceReady,
  onConfigureInference,
  onNodesChange,
  onSessionExpired,
}: RuntimeNodesPanelProps) {
  const [nodes, setNodes] = useState<HermesRuntimeNode[]>([]);
  const [form, setForm] = useState<CreateHermesNodeInvitation>(defaultForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const [invitation, setInvitation] = useState<HermesNodeInvitation | null>(null);
  const [issuedAt, setIssuedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [removalNode, setRemovalNode] = useState<HermesRuntimeNode | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  const [hostDestructionConfirmed, setHostDestructionConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unpinned = !/^[0-9a-f]{40}$/.test(form.hermesCommit);
  const insecureControlPlane = !form.controlPlaneUrl.startsWith("https://");
  const productionArtifactBlocked = targetEnvironment === "PRODUCTION"
    && (unpinned || insecureControlPlane);
  // Not `!== "PRODUCTION"`: the target has to be *known* before an enrolment
  // can be offered at all, and an unloaded snapshot is not a development one.
  const targetKnown = targetEnvironment !== null;
  const activeRuntimeExists = nodes.some((node) => node.enrolledAt && node.status !== "REVOKED");
  const enrolledNodes = nodes.filter((node) => node.revokedAt === null);
  const anyOnline = enrolledNodes.some((node) => node.status === "ONLINE");
  /** The hand-off is live from the moment a claim exists until VM2 answers. */
  const awaitingNode = invitation !== null && !anyOnline;
  const pendingNode = invitation
    ? nodes.find((node) => node.id === invitation.bundle.nodeId)
    : undefined;

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not update the Hermes runtime fleet.");
  };

  const load = async () => {
    const result = await getHermesRuntimeNodes();
    setNodes(result.items);
    onNodesChange?.(result.items);
  };

  /*
   * Both callbacks are held in refs so the poll below depends on nothing.
   *
   * `onNodesChange` was this effect's only dependency, and every call site
   * hands down a fresh arrow on each parent render — which, with an interval
   * inside, would tear the timer down and start a new one several times a
   * minute while an operator watched a node enrol.
   */
  const latestOnNodesChange = useRef(onNodesChange);
  const latestOnSessionExpired = useRef(onSessionExpired);
  const busyRef = useRef<string | null>(null);
  useEffect(() => {
    latestOnNodesChange.current = onNodesChange;
    latestOnSessionExpired.current = onSessionExpired;
    busyRef.current = busy;
  });

  useEffect(() => {
    let active = true;
    const read = async (first: boolean) => {
      // A mutation in flight owns the list; a poll landing on top of it would
      // put the pre-mutation revision back.
      if (!first && busyRef.current !== null) return;
      try {
        const result = await getHermesRuntimeNodes();
        if (!active) return;
        /*
         * Written through on every poll, never diffed. `list()` bumps a node's
         * `revision` when it demotes one that has gone quiet past
         * NODE_STALE_AFTER_MS, so "the node looks the same, keep what we have"
         * silently caches a revision the server has already moved — and the
         * next Drain, Suspend or Revoke answers 409.
         */
        setNodes(result.items);
        latestOnNodesChange.current?.(result.items);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
          latestOnSessionExpired.current();
        } else if (first) {
          // Only the first read speaks up. A poll that fails once during a VM2
          // restart must not raise a banner every ten seconds over a list that
          // is still the best answer anyone has.
          setError(cause instanceof Error ? cause.message : "OrcaSynapse could not read the Hermes runtime fleet.");
        }
      }
    };
    void read(true);
    const timer = window.setInterval(() => void read(false), NODE_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  /*
   * The clock only runs while something is being waited on. The hand-off is
   * fifteen to twenty minutes with long silent stretches, and a counter that
   * moves is the difference between "it is working" and "it is hung".
   */
  useEffect(() => {
    if (!awaitingNode) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [awaitingNode]);

  const statusCounts = useMemo(() => ({
    online: nodes.filter((node) => node.status === "ONLINE").length,
    attention: nodes.filter((node) => ["DEGRADED", "OFFLINE", "SUSPENDED"].includes(node.status)).length,
  }), [nodes]);

  const issueInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !inferenceReady || !targetKnown) return;
    setBusy("invite");
    setError(null);
    try {
      const { expectedHostname, ...requiredFields } = form;
      const issued = await createHermesNodeInvitation(expectedHostname?.trim()
        ? { ...requiredFields, expectedHostname: expectedHostname.trim() }
        : requiredFields);
      setInvitation(issued);
      setIssuedAt(Date.now());
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const act = async (node: HermesRuntimeNode, action: MutateHermesRuntimeNode["action"]) => {
    if (busy) return;
    setBusy(`${action}-${node.id}`);
    setError(null);
    try {
      await mutateHermesRuntimeNode(node.id, {
        action,
        reason: `${action === "DRAIN" ? "New work drained" : action === "SUSPEND" ? "Execution suspended" : action === "RESUME" ? "Run admission resumed" : "Permanently revoked"} by the OrcaSynapse runtime-fleet administrator.`,
        expectedRevision: node.revision,
      });
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const downloadBundle = () => {
    if (!invitation) return;
    saveFile(`orcasynapse-${invitation.node.slug}-enrollment.json`, `${JSON.stringify(invitation.bundle, null, 2)}\n`, "application/json");
  };

  const openRemoval = (node: HermesRuntimeNode) => {
    setError(null);
    setRemovalConfirmation("");
    setHostDestructionConfirmed(false);
    setRemovalNode(node);
  };

  const remove = async () => {
    if (!removalNode || busy || removalConfirmation !== removalNode.slug) return;
    if (removalNode.enrolledAt && !hostDestructionConfirmed) return;
    setBusy(`REMOVE-${removalNode.id}`);
    setError(null);
    try {
      await removeHermesRuntimeNode(removalNode.id, {
        confirmation: removalConfirmation,
        reason: removalNode.enrolledAt
          ? "Operator confirmed the VM2 Agentic System purge completed before permanent record removal."
          : "Unused enrollment record permanently removed before VM2 enrollment.",
        expectedRevision: removalNode.revision,
      });
      setRemovalNode(null);
      setRemovalConfirmation("");
      setHostDestructionConfirmed(false);
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  return <div className="runtime-nodes-layout">
    <section className="panel runtime-nodes-overview">
      <div className="runtime-section-heading">
        <div><p className="text-micro font-semibold uppercase tabular-nums text-faint">Isolated VM2</p><h2>Agentic System</h2></div>
        <div className="runtime-node-heading-actions"><Button disabled={busy !== null} onClick={() => void load()}>Refresh</Button><Button variant="primary" disabled={activeRuntimeExists || !inferenceReady || !targetKnown} title={!inferenceReady ? "Configure and test AI Inference before enrolling the Agentic System." : !targetKnown ? "The architecture decision has not loaded, so the production artifact requirements cannot be applied." : activeRuntimeExists ? "Revoke the active execution boundary before enrolling its replacement." : undefined} onClick={() => { setInvitation(null); setEditorOpen(true); }}>Generate installer</Button></div>
      </div>
      <div className="runtime-node-principles">
        <article><strong>{nodes.length}</strong><span>Registered nodes</span></article>
        <article><strong>{statusCounts.online}</strong><span>Online now</span></article>
        <article><strong>{statusCounts.attention}</strong><span>Need attention</span></article>
        <div><strong>No standing SSH trust</strong><span>Enrollment is single-use. Agent Profiles remain versioned in OrcaSynapse and are injected per governed Run.</span></div>
        <div><strong>One runtime at a time</strong><span>{nodes.length === 0 ? "An installation holds exactly one Hermes execution boundary. Enrolling a second is refused." : "This installation already holds its Hermes execution boundary. Revoke and remove this node before enrolling a replacement."}</span></div>
      </div>
      {error && <div className="runtime-alert" role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button></div>}

      {/*
        * The hand-off, kept on the screen rather than inside the drawer that
        * issued it.
        *
        * This step gives work to another machine for fifteen to twenty minutes
        * with long silent stretches, and everything an operator needs during
        * that silence used to close with the drawer: the command, the claim,
        * and any sense of how long it had been. What is drawn here is exactly
        * what makes a silent wait legible — the command (which carries no
        * claim), a clock that moves, the claim's remaining life, the node's own
        * status as the poll reports it, and what the installer is doing while
        * it says nothing.
        */}
      {awaitingNode && invitation && <Tile as="article" pad="lg" strong className="grid gap-3" aria-label="VM2 enrollment in progress">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <MicroLabel className="block">Hand-off in progress</MicroLabel>
            <strong className="mt-1 block font-display text-[15px] font-semibold tracking-[-0.01em] text-text">Run the installer on VM2</strong>
          </div>
          <StatusText dot tone={pendingNode?.status === "PENDING" ? "warn" : "neutral"}>
            {pendingNode ? humanize(pendingNode.status) : "Awaiting VM2"}
          </StatusText>
        </div>

        <code className="block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
          {agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl)}
        </code>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl))}>Copy command</Button>
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(invitation.bundle.token)}>Copy claim</Button>
          <Button size="sm" variant="ghost" onClick={() => { setInvitation(null); setIssuedAt(null); }}>Stop watching</Button>
        </div>
        <p className="m-0 text-caption text-muted">
          The command contains no claim. The installer asks for it at a hidden prompt and sends it in a redacted body, so it never enters shell history or a URL.
        </p>

        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-3">
          <div>
            <dt className="text-micro font-semibold uppercase tabular-nums text-faint">Elapsed</dt>
            <dd className="m-0 mt-0.5 text-body tabular-nums text-text">{issuedAt === null ? "—" : elapsedSince(issuedAt, now)}</dd>
          </div>
          <div>
            <dt className="text-micro font-semibold uppercase tabular-nums text-faint">Claim expires</dt>
            <dd className={cn(
              "m-0 mt-0.5 text-body tabular-nums",
              remainingMinutes(invitation.bundle.expiresAt, now) > 0 ? "text-text" : "text-bad",
            )}>
              {remainingMinutes(invitation.bundle.expiresAt, now) > 0
                ? `in ${remainingMinutes(invitation.bundle.expiresAt, now)} min`
                : "expired — issue another"}
            </dd>
          </div>
          <div>
            <dt className="text-micro font-semibold uppercase tabular-nums text-faint">Last heartbeat</dt>
            <dd className="m-0 mt-0.5 text-body text-text">{pendingNode?.lastSeenAt ? new Date(pendingNode.lastSeenAt).toLocaleTimeString() : "None yet"}</dd>
          </div>
        </dl>

        <p className="m-0 text-caption leading-relaxed text-faint">
          Expect 15–20 minutes on a first install, with long silent stretches. VM2 clones the Hermes repository at the pinned commit (~180,000 objects), builds a Python virtual environment, and runs <code className="font-mono">npm install</code>. It is not hung. This panel re-reads the fleet every 10 seconds, so the node appears here on its own.
        </p>
      </Tile>}

      {nodes.length === 0 && !inferenceReady ? <EmptyState title="AI Inference must be ready first" action={<Button onClick={onConfigureInference}>Configure AI Inference</Button>}>Connect and activate one served model. OrcaSynapse will then prepare the VM2 installer with the approved route.</EmptyState> : nodes.length === 0 && !targetKnown ? <EmptyState title="The architecture decision has not loaded">Enrolment inputs depend on the target environment: Production requires a commit-pinned Hermes runtime and an HTTPS OrcaSynapse origin. OrcaSynapse will not offer an installer it cannot hold to the right standard.</EmptyState> : nodes.length === 0 ? <EmptyState title="Install the Agentic System on VM2" action={<Button variant="primary" onClick={() => setEditorOpen(true)}>Generate VM2 installer</Button>}>Generate one secure command, run it on the isolated VM, and paste the one-time claim when prompted. Hermes is installed, registered, and bound to the approved inference route.</EmptyState> : <div className="runtime-node-list">{nodes.map((node) => <article key={node.id}>
        <div className={`runtime-node-state ${nodeTone(node.status)}`}><span /></div>
        {/*
          * Drift is drawn beside the status, not instead of it. A node that
          * failed to take a new commit keeps heartbeating and stays Online, so
          * the status alone cannot show it — and this increment deliberately
          * stops at making that visible: the operator decision stays in
          * Settings → Application, and there is no apply button here.
          */}
        <div className="runtime-node-copy"><div><strong>{node.displayName}</strong><span className={`runtime-status ${nodeTone(node.status)}`}>{humanize(node.status)}</span>{commitDrift(node) && <span className="runtime-status quarantined" title="This node is not running the Hermes commit OrcaSynapse recorded for it.">Commit drift</span>}</div><p>{node.baseUrl}</p><small>{node.hostname ?? node.expectedHostname ?? "Awaiting hostname"} · {runtimeRevision(node)}</small></div>
        <dl><div><dt>Last heartbeat</dt><dd>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>OrcaSynapse → Hermes</dt><dd>{node.serviceConnectionStatus ? humanize(node.serviceConnectionStatus) : "Pending"}</dd></div><div><dt>Identity</dt><dd>{node.identityFingerprint ? `${node.identityFingerprint.slice(0, 12)}…` : "Not enrolled"}</dd></div></dl>
        <div className="runtime-node-actions">
          {node.status === "DRAINING" || node.status === "SUSPENDED" ? <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(node, "RESUME")}>Resume</Button> : <Button variant="ghost" size="sm" disabled={busy !== null || node.status === "PENDING" || node.status === "OFFLINE"} onClick={() => void act(node, "DRAIN")}>Drain</Button>}
          {!["PENDING", "SUSPENDED", "REVOKED"].includes(node.status) && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => { if (window.confirm(`Suspend ${node.displayName}? Active work will be stopped and new work will be denied until you resume it.`)) void act(node, "SUSPEND"); }}>Suspend</Button>}
          {node.status !== "REVOKED" && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => { if (window.confirm(`Permanently revoke ${node.displayName}? The node must be re-enrolled to reconnect.`)) void act(node, "REVOKE"); }}>Revoke</Button>}
          {node.status === "REVOKED" && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => openRemoval(node)}>Remove</Button>}
        </div>
      </article>)}</div>}
    </section>

    <aside className="panel runtime-network-contract">
      <p className="text-micro font-semibold uppercase tabular-nums text-faint">Network contract</p><h2>Required paths</h2>
      <ol><li><span>1</span><div><strong>OrcaSynapse → Hermes</strong><small>TCP 8642, health and governed agent API only.</small></div></li><li><span>2</span><div><strong>Runtime → OrcaSynapse</strong><small>HTTPS enrollment, heartbeat, and node-scoped inference gateway.</small></div></li></ol>
      <div className="runtime-network-note"><strong>The installer does not manage your firewall.</strong><p>Apply customer network policy before Production activation. Do not expose port 8642 to user or internet networks.</p></div>
    </aside>

    {editorOpen && inferenceReady && targetKnown && <Drawer
      open
      kicker="Agentic System"
      title={invitation ? "Run this on VM2" : "Generate the VM2 installer"}
      onClose={() => setEditorOpen(false)}
      footer={invitation
        ? <div className="flex justify-end gap-2">
            <Button onClick={() => setInvitation(null)}>Issue another</Button>
            <Button variant="primary" onClick={() => { setEditorOpen(false); void load(); }}>Done</Button>
          </div>
        : <div className="flex justify-end gap-2">
            <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button variant="primary" form="vm2-installer-form" type="submit" disabled={busy !== null || productionArtifactBlocked}>
              {busy === "invite" ? "Preparing installer…" : productionArtifactBlocked ? "Review production options" : "Generate install command"}
            </Button>
          </div>}
    >
      {!invitation ? <form id="vm2-installer-form" className="ops-form grid gap-4" onSubmit={(event) => void issueInvitation(event)}>
        <p className="runtime-form-intro">OrcaSynapse will pre-seed Hermes with the active AI Inference route. No inference key, SSH password, or private node key is exposed to the browser.</p>
        <div className="runtime-install-preview"><span>1</span><div><strong>Tell OrcaSynapse how to reach VM2</strong><small>Use the private address accessible from the dashboard host.</small></div><span>2</span><div><strong>Run one generated command</strong><small>The installer handles Hermes, credentials, and registration.</small></div></div>
        <label><span>VM2 private address</span><Input required type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /><small>Normally <code>http://VM2-IP:8642</code>. Port 8642 must be reachable only from OrcaSynapse.</small></label>
        <details className="runtime-deployment-details">
          <summary><span><strong>Advanced deployment options</strong><small>Identity, release pins, and network overrides</small></span><b>+</b></summary>
          <div>
            <label><span>Node name</span><Input required minLength={2} maxLength={120} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
            <label><span>Node slug</span><Input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={2} maxLength={64} value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} /></label>
            <label><span>Expected VM hostname (optional)</span><Input maxLength={253} value={form.expectedHostname ?? ""} placeholder="hermes-01.internal" onChange={(event) => setForm({ ...form, expectedHostname: event.target.value })} /><small>When set, enrollment fails if VM2 reports a different hostname.</small></label>
            <label><span>OrcaSynapse address visible to VM2</span><Input required type="url" value={form.controlPlaneUrl} onChange={(event) => setForm({ ...form, controlPlaneUrl: event.target.value })} /></label>
            <label><span>Hermes commit</span><Input required minLength={40} maxLength={40} pattern="[0-9a-fA-F]{40}" value={form.hermesCommit} onChange={(event) => setForm({ ...form, hermesCommit: event.target.value.trim().toLowerCase() })} /><small>The 40-character commit VM2 installs. A commit cannot be moved, so this is the runtime pin.</small></label>
          </div>
        </details>
        {targetEnvironment === "PRODUCTION" && (unpinned || insecureControlPlane) && <div className="runtime-invite-warning"><strong>Production hardening required</strong><ul>{unpinned && <li>The Hermes runtime is not pinned to a 40-character commit.</li>}{insecureControlPlane && <li>The OrcaSynapse enrollment route uses HTTP rather than HTTPS.</li>}</ul></div>}
        {targetKnown && targetEnvironment !== "PRODUCTION" && (unpinned || insecureControlPlane) && <div className="runtime-development-note">Development release defaults are selected. Exact production pins remain available under Advanced deployment options.</div>}
      </form> : <div className="runtime-install-steps">
        <div className="runtime-success-mark">✓</div><p>The enrollment claim expires <strong>{new Date(invitation.bundle.expiresAt).toLocaleString()}</strong> and can be used only once.</p>
        <ol><li><span>1</span><div><strong>Run one command on VM2</strong><small>OrcaSynapse serves the installer directly; it connects back only to this control-plane origin.</small><code>{agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl)}</code></div></li><li><span>2</span><div><strong>Paste the claim when prompted</strong><small>The installer reads it from the terminal with hidden input and sends it in a redacted POST body—not in the URL or shell history.</small><code>{invitation.bundle.token}</code><Button onClick={() => void navigator.clipboard.writeText(invitation.bundle.token)}>Copy claim</Button></div></li><li><span>3</span><div><strong>Watch the node come online</strong><small>OrcaSynapse installs Hermes, applies the approved route and policy, then starts signed health reporting.</small><Button onClick={downloadBundle}>Download JSON fallback</Button></div></li></ol>
        <div className="runtime-network-note"><strong>What happens next</strong><p>VM2 generates its own private identity, installs Hermes, exchanges the claim once, and appears Online here. OrcaSynapse never receives the private signing key or a reusable VM credential.</p></div>
      </div>}
    </Drawer>}

    {removalNode && <Dialog
      open
      kicker="Permanent decommission"
      title={`Remove ${removalNode.displayName}`}
      onClose={() => { if (busy === null) setRemovalNode(null); }}
      className="ops-form"
      footer={<div className="flex justify-end gap-2">
        <Button disabled={busy !== null} onClick={() => setRemovalNode(null)}>Cancel</Button>
        <Button
          variant="danger"
          disabled={busy !== null || removalConfirmation !== removalNode.slug || (Boolean(removalNode.enrolledAt) && !hostDestructionConfirmed)}
          onClick={() => void remove()}
        >
          {busy === `REMOVE-${removalNode.id}` ? "Removing…" : "Remove permanently"}
        </Button>
      </div>}
    >
      <div className="runtime-removal-warning"><strong>This cannot be undone</strong><p>Revocation stopped future trust. Decommissioning now destroys the VM2 runtime and then erases its control-plane identity, enrollment history, nonces, and generated Hermes connection. The audit record remains.</p></div>
      {removalNode.enrolledAt ? <ol className="runtime-removal-steps">
        <li><span>1</span><div><strong>Run the purge on the enrolled VM2</strong><small>The script shows its exact scope and requires typing <code>DESTROY</code>. It leaves Ubuntu packages, unrelated services, and external backups untouched.</small><code>{agenticNodeRemovalCommand(typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin)}</code><Button onClick={() => void navigator.clipboard.writeText(agenticNodeRemovalCommand(window.location.origin))}>Copy command</Button></div></li>
        <li><span>2</span><div><strong>Confirm the host-side result</strong><small>OrcaSynapse deliberately has no standing SSH access or remote execution channel on VM2, so this confirmation is your administrative attestation.</small><label className="runtime-removal-attestation"><Switch checked={hostDestructionConfirmed} onCheckedChange={setHostDestructionConfirmed} /><span>The remover reported “Agentic System removed from this VM,” or the VM was destroyed.</span></label></div></li>
      </ol> : <div className="runtime-development-note">This record never completed enrollment, so there is no managed VM2 installation to purge.</div>}
      <label><span>Type {removalNode.slug} to remove it permanently</span><Input autoComplete="off" spellCheck={false} value={removalConfirmation} onChange={(event) => setRemovalConfirmation(event.target.value)} /></label>
      {error && <div className="runtime-alert" role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button></div>}
    </Dialog>}
  </div>;
}

import type {
  AdministratorSession,
  CreateHermesNodeInvitation,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  OnboardingTargetEnvironment,
} from "@orcasynapse/contracts";
import { ChevronDown, RefreshCw as SyncIcon, Server, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createHermesNodeInvitation,
  getHermesRuntimeNodes,
  mutateHermesRuntimeNode,
  removeHermesRuntimeNode,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { Alert, Button, CopyButton, Dialog, Field, Input, Mark, MicroLabel, StatusText, Tile, cn } from "./ui/index.js";
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
  agentModelReady: boolean;
  onConfigureInference: () => void;
  onNodesChange?: (nodes: HermesRuntimeNode[]) => void;
  onSessionExpired: () => void;
  session?: AdministratorSession | null;
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
 * The node's units that are not doing their job, named.
 *
 * Null means the node has never reported units -- an older installer, not a
 * healthy node. That is why this returns null rather than an empty array for
 * the unknown case: "nothing wrong" and "nothing known" render differently, and
 * collapsing them is how a broken node reads as a fine one.
 *
 * A unit that is enabled but inactive failed or was stopped; one that is active
 * but not enabled will be gone at the next reboot. Both are reported, because
 * they need different fixes.
 */
export function unhealthyUnits(node: HermesRuntimeNode): string[] | null {
  if (!node.units) return null;
  return node.units
    .filter((unit) => !unit.active || !unit.enabled)
    .map((unit) => unit.active ? `${unit.name} (not enabled)` : `${unit.name} (inactive)`);
}

/**
 * Three distinct answers, never two. "Not reported" is what an older node gives
 * and must not read as "all running" — the whole point of showing this is that
 * an operator can tell a healthy node from one nobody can see into.
 */
function unitSummary(node: HermesRuntimeNode): string {
  const unhealthy = unhealthyUnits(node);
  if (unhealthy === null) return "Not reported";
  if (unhealthy.length === 0) return `All ${node.units?.length ?? 0} running`;
  return unhealthy.join(", ");
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
 * The maintenance command for a node that is already enrolled.
 *
 * `--repair`, not `--connect`: on a host whose enrollment completed, the
 * installer refuses `--connect` outright and tells the operator to
 * decommission. Repair is the arm built for this case -- it revalidates the
 * enrollment, rewrites the managed service boundary, and restarts Hermes in
 * place, from local state alone. The API keeps the installer downloadable
 * after enrollment for exactly this rerun; this is the command that uses it.
 */
export function agenticNodeRepairCommand(controlPlaneUrl: string): string {
  const origin = controlPlaneUrl.replace(/\/+$/, "");
  return `curl -fsSL ${origin}/install/agentic-node.sh | sudo bash -s -- --repair`;
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
  agentModelReady,
  onConfigureInference,
  onNodesChange,
  onSessionExpired,
  session,
}: RuntimeNodesPanelProps) {
  const { can } = adminAccess(session ?? null);
  const canManage = session === undefined ? true : can("readiness:manage");
  const [nodes, setNodes] = useState<HermesRuntimeNode[]>([]);
  const [form, setForm] = useState<CreateHermesNodeInvitation>(defaultForm);
  /*
   * A tunnel-fronted control plane (Cloudflare Zero Trust and kin) refuses
   * every machine at the edge: Access wants an identity Hermes and the node
   * clients cannot hold. This toggle makes the callback address a first-class
   * question instead of an Advanced field nobody finds — VM2 enrolls against
   * the private address and never touches the tunnel; the public origin stays
   * for people.
   */
  const [behindTunnel, setBehindTunnel] = useState(false);
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
  /*
   * The origin the node was enrolled against, not the browser's. A dashboard
   * opened through Access is on a hostname Hermes cannot pass; `--repair`
   * downloads from this origin, so printing `window.location.origin` is how
   * a tunnel-fronted install hands VM2 a 403.
   */
  const repairOrigin = nodes.find((node) => node.enrolledAt && node.status !== "REVOKED")?.controlPlaneUrl
    ?? defaultControlPlaneUrl();
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

  const issueInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || busy || !inferenceReady || !agentModelReady || !targetKnown) return;
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
    if (!canManage || busy) return;
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

  const canGenerate = inferenceReady && agentModelReady && targetKnown && !activeRuntimeExists;
  const generateTitle = !inferenceReady
    ? "Connect and test AI Inference before enrolling the agent runtime."
    : !agentModelReady
      ? "Activate a default Agent model on Gateway → Models."
      : !targetKnown
        ? "The architecture decision has not loaded, so the production artefact requirements cannot be applied."
        : activeRuntimeExists
          ? "Revoke the active execution boundary before enrolling its replacement."
          : undefined;

  return <div className="runtime-nodes-layout">
    <section className="grid gap-3" aria-label="Agent runtime">
      {error ? <Alert onDismiss={() => setError(null)}>{error}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-[62ch] text-caption leading-relaxed text-muted">
          {!inferenceReady
            ? "Finish connecting inference first. The installer is seeded with that route."
            : !agentModelReady
              ? "Activate a default Agent model on Gateway → Models."
              : !targetKnown
                ? "The architecture decision has not loaded, so production artefact requirements cannot be applied yet."
                : awaitingNode
                  ? "The claim is live. Run the command on VM2; this step updates when the node heartbeats."
                  : activeRuntimeExists
                    ? "This installation holds one Hermes execution boundary. Revoke it before enrolling a replacement."
                    : "Generate a one-time command, run it on the Ubuntu VM, and paste the claim when the installer asks."}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button disabled={busy !== null} onClick={() => void load()}><SyncIcon size={16} />Refresh</Button>
          {!inferenceReady ? (
            <Button variant="primary" onClick={onConfigureInference}>Configure AI Inference</Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy !== null || !canGenerate}
              title={generateTitle}
              onClick={() => { setInvitation(null); setEditorOpen(true); }}
            >
              Generate installer
            </Button>
          )}
        </div>
      </div>

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
          <CopyButton size="sm" value={() => agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl)}>Copy command</CopyButton>
          <CopyButton size="sm" value={() => invitation.bundle.token}>Copy claim</CopyButton>
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

      {nodes.length > 0 ? (
        <div className="runtime-node-list overflow-hidden rounded-lg border border-border">
          {nodes.map((node) => <article key={node.id}>
        <div className={`runtime-node-state ${nodeTone(node.status)}`}><span /></div>
        {/*
          * Drift is drawn beside the status, not instead of it. A node that
          * failed to take a new commit keeps heartbeating and stays Online, so
          * the status alone cannot show it — and this increment deliberately
          * stops at making that visible: the operator decision stays in
          * Settings → System, and there is no apply button here.
          */}
        <div className="runtime-node-copy"><div><strong>{node.displayName}</strong><span className={`runtime-status ${nodeTone(node.status)}`}>{humanize(node.status)}</span>{commitDrift(node) && <span className="runtime-status quarantined" title="This node is not running the Hermes commit OrcaSynapse recorded for it.">Commit drift</span>}</div><p>{node.baseUrl}</p><small>{node.hostname ?? node.expectedHostname ?? "Awaiting hostname"} · {runtimeRevision(node)}</small></div>
        <dl><div><dt>Last heartbeat</dt><dd>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>OrcaSynapse → Hermes</dt><dd>{node.serviceConnectionStatus ? humanize(node.serviceConnectionStatus) : "Pending"}</dd></div><div><dt>Identity</dt><dd>{node.identityFingerprint ? `${node.identityFingerprint.slice(0, 12)}…` : "Not enrolled"}</dd></div>
          {/*
            * Quiet when healthy, specific when not. The heartbeat's own timer is
            * absent from this list by construction -- a node whose heartbeat has
            * stopped never reports anything, and goes Offline above on a stale
            * `lastSeenAt` instead. Between the two, nothing on the node is
            * unaccounted for.
            */}
          <div><dt>Node services</dt><dd>{unitSummary(node)}</dd></div></dl>
        <div className="runtime-node-actions">
          {canManage ? (node.status === "DRAINING" || node.status === "SUSPENDED" ? <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(node, "RESUME")}>Resume</Button> : <Button variant="ghost" size="sm" disabled={busy !== null || node.status === "PENDING" || node.status === "OFFLINE"} onClick={() => void act(node, "DRAIN")}>Drain</Button>) : null}
          {!["PENDING", "SUSPENDED", "REVOKED"].includes(node.status) && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => { if (window.confirm(`Suspend ${node.displayName}? Active work will be stopped and new work will be denied until you resume it.`)) void act(node, "SUSPEND"); }}>Suspend</Button>}
          {node.status !== "REVOKED" && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => { if (window.confirm(`Permanently revoke ${node.displayName}? The node must be re-enrolled to reconnect.`)) void act(node, "REVOKE"); }}>Revoke</Button>}
          {node.status === "REVOKED" && <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => openRemoval(node)}>Remove</Button>}
        </div>
      </article>)}
        </div>
      ) : null}

      {/*
        * How to update the node once it exists. The install command lives in
        * the enrollment tile, which leaves the screen the moment the node
        * heartbeats -- and generating a new installer is then correctly
        * blocked, because the deployment holds one execution boundary. So an
        * enrolled node had no visible path to a runtime update at all: the
        * backend serves the installer after enrollment for exactly this rerun,
        * and no pixel said so. This is that pixel.
        */}
      {activeRuntimeExists && (
        <Tile as="article" pad="lg" className="grid gap-3" aria-label="Runtime maintenance">
          <div className="min-w-0">
            <MicroLabel className="block">Maintenance</MicroLabel>
            <strong className="mt-1 block font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
              Update or repair the enrolled runtime
            </strong>
          </div>
          <code className="block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
            {agenticNodeRepairCommand(repairOrigin)}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton size="sm" value={() => agenticNodeRepairCommand(repairOrigin)}>
              Copy command
            </CopyButton>
          </div>
          <p className="m-0 text-caption leading-relaxed text-muted">
            Safe to re-run on the enrolled node: it revalidates the enrollment, rewrites the managed
            service boundary from the current release, and restarts Hermes in place. Identity, keys and
            policy are untouched, and the command carries no credential. Update OrcaSynapse first — the
            node downloads this script from it.
          </p>
        </Tile>
      )}
    </section>

    {/*
      * A centred dialog, matching step 1's connection form and the removal
      * confirmation below it. As a right-hand drawer this slid in over the very
      * setup step it belongs to, so the instructions and the form could not be
      * read together — and the enrolment copy here is long enough that reading
      * it beside its own step is the point.
      *
      * Drawer is OverlayChrome with one flag, so the focus trap, escape
      * handling and scroll lock are unchanged.
      */}
    {editorOpen && inferenceReady && agentModelReady && targetKnown && <Dialog
      open
      icon={Server}
      title={invitation ? "Run this on VM2" : "Generate the VM2 installer"}
      description={invitation
        ? `The enrollment claim expires ${new Date(invitation.bundle.expiresAt).toLocaleString()} and can be used only once.`
        : "OrcaSynapse will pre-seed Hermes with the active AI Inference route. No inference key, SSH password, or private node key is exposed to the browser."}
      onClose={() => setEditorOpen(false)}
      footer={invitation
        ? <>
            <Button onClick={() => setInvitation(null)}>Issue another</Button>
            <Button variant="primary" onClick={() => { setEditorOpen(false); void load(); }}>Done</Button>
          </>
        : <>
            <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
            {canManage ? (
            <Button variant="primary" form="vm2-installer-form" type="submit" disabled={busy !== null || productionArtifactBlocked}>
              {busy === "invite" ? "Preparing installer…" : productionArtifactBlocked ? "Review production options" : "Generate install command"}
            </Button>
            ) : null}
          </>}
    >
      <div className="grid gap-5">
      {error ? <Alert>{error}</Alert> : null}
      {!invitation ? <form id="vm2-installer-form" className="grid gap-5" onSubmit={(event) => void issueInvitation(event)}>
        <Field
          label="VM2 private address"
          hint="Normally http://VM2-IP:8642. OrcaSynapse must reach TCP 8642 (Hermes) and TCP 8643 (Session inbox) from VM1 only."
        >
          <Input required type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 rounded border border-border bg-raised/50 px-3 py-2.5">
          <Switch
            checked={behindTunnel}
            onCheckedChange={(next) => {
              setBehindTunnel(next);
              // The public origin cannot be the callback under a tunnel, so
              // switching on empties the field rather than pre-filling an
              // address that is guaranteed wrong.
              setForm((current) => ({ ...current, controlPlaneUrl: next ? "" : defaultControlPlaneUrl() }));
            }}
          />
          <span className="grid gap-0.5">
            <span className="text-label font-semibold text-text">The control plane is behind a tunnel or Zero Trust</span>
            <span className="text-caption leading-relaxed text-muted">
              An identity check at the edge refuses machines, so VM2 will call OrcaSynapse directly on your private
              network — enrollment, heartbeats, files and the model gateway. The public address stays for people.
            </span>
          </span>
        </label>

        {behindTunnel && (
          <Field
            label="OrcaSynapse private address visible to VM2"
            hint="The control plane host's LAN address, e.g. http://10.0.0.160:8080 — a literal private IP, not a name. The one-time install command travels this network unencrypted; run it only on a network you trust."
          >
            <Input
              required
              type="url"
              placeholder="http://10.0.0.160:8080"
              value={form.controlPlaneUrl}
              onChange={(event) => setForm({ ...form, controlPlaneUrl: event.target.value })}
            />
          </Field>
        )}

        <details className="group border-t border-border pt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="block text-label font-semibold text-foreground">Advanced deployment options</span>
              <span className="block text-caption font-normal text-muted">Identity, release pins, and network overrides</span>
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Node name">
              <Input required minLength={2} maxLength={120} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
            </Field>
            <Field label="Node slug">
              <Input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={2} maxLength={64} value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} />
            </Field>
            <Field className="sm:col-span-2" label="Expected VM hostname" hint="Optional. When set, enrollment fails if VM2 reports a different hostname.">
              <Input maxLength={253} value={form.expectedHostname ?? ""} placeholder="hermes-01.internal" onChange={(event) => setForm({ ...form, expectedHostname: event.target.value })} />
            </Field>
            {!behindTunnel && (
              <Field className="sm:col-span-2" label="OrcaSynapse address visible to VM2">
                <Input required type="url" value={form.controlPlaneUrl} onChange={(event) => setForm({ ...form, controlPlaneUrl: event.target.value })} />
              </Field>
            )}
            <Field className="sm:col-span-2" label="Hermes commit" hint="The 40-character commit VM2 installs. A commit cannot be moved, so this is the runtime pin.">
              <Input required minLength={40} maxLength={40} pattern="[0-9a-fA-F]{40}" value={form.hermesCommit} onChange={(event) => setForm({ ...form, hermesCommit: event.target.value.trim().toLowerCase() })} />
            </Field>
          </div>
        </details>

        {targetEnvironment === "PRODUCTION" && (unpinned || insecureControlPlane) ? (
          <Alert tone="warn">
            <span className="block font-semibold">Production hardening required</span>
            <ul className="mt-1.5 list-disc pl-4 text-caption">
              {unpinned ? <li>The Hermes runtime is not pinned to a 40-character commit.</li> : null}
              {insecureControlPlane ? <li>The OrcaSynapse enrollment route uses HTTP rather than HTTPS.</li> : null}
            </ul>
          </Alert>
        ) : null}
        {targetKnown && targetEnvironment !== "PRODUCTION" && (unpinned || insecureControlPlane) ? (
          <p className="m-0 text-caption leading-relaxed text-muted">
            Development release defaults are selected. Exact production pins remain available under Advanced deployment options.
          </p>
        ) : null}
      </form> : <div className="grid gap-4">
        <div className="grid gap-1.5">
          <p className="text-micro font-semibold uppercase tabular-nums text-faint">Run on VM2</p>
          <code className="block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
            {agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl)}
          </code>
          <p className="m-0 text-caption leading-relaxed text-muted">
            OrcaSynapse serves the installer. It connects back only to this control-plane origin.
          </p>
        </div>
        <div className="grid gap-1.5">
          <p className="text-micro font-semibold uppercase tabular-nums text-faint">Paste the claim when prompted</p>
          <code className="block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
            {invitation.bundle.token}
          </code>
          <div className="flex flex-wrap gap-2">
            <CopyButton size="sm" value={() => invitation.bundle.token}>Copy claim</CopyButton>
            <Button size="sm" variant="ghost" onClick={downloadBundle}>Download JSON fallback</Button>
          </div>
          <p className="m-0 text-caption leading-relaxed text-muted">
            The installer reads the claim from a hidden prompt and sends it in a redacted body — not in the URL or shell history. VM2 then appears Online on this step.
          </p>
        </div>
      </div>}
      </div>
    </Dialog>}

    {/*
      * The decommission dialog, on the same primitives as every other form:
      * Dialog + Field + Mark-numbered steps. It carried its own stylesheet-era
      * classes (`.runtime-removal-*`, `.runtime-alert`) — 8px type and bespoke
      * circles from three design systems ago — deleted with this rebuild.
      */}
    {removalNode && <Dialog
      open
      icon={Trash2}
      kicker="Permanent decommission"
      title={`Remove ${removalNode.displayName}`}
      description="Revocation stopped future trust. Decommissioning destroys the VM2 runtime, then erases its control-plane identity, enrollment history, nonces, and generated Hermes connection. The audit record remains."
      onClose={() => { if (busy === null) setRemovalNode(null); }}
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
      <div className="grid gap-4">
      <Alert>This cannot be undone.</Alert>

      {removalNode.enrolledAt ? <ol className="m-0 grid list-none gap-4 p-0">
        <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
          <Mark size="sm" className="border border-bad/40 bg-bad/10 text-bad">1</Mark>
          <div className="grid gap-1.5">
            <strong className="text-label font-semibold text-text">Run the purge on the enrolled VM2</strong>
            <p className="m-0 text-caption leading-relaxed text-muted">
              The script shows its exact scope and requires typing <code className="font-mono">DESTROY</code>.
              It leaves Ubuntu packages, unrelated services, and external backups untouched.
            </p>
            <code className="block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
              {agenticNodeRemovalCommand(typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin)}
            </code>
            <div><CopyButton size="sm" value={() => agenticNodeRemovalCommand(window.location.origin)}>Copy command</CopyButton></div>
          </div>
        </li>
        <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
          <Mark size="sm" className="border border-bad/40 bg-bad/10 text-bad">2</Mark>
          <div className="grid gap-1.5">
            <strong className="text-label font-semibold text-text">Confirm the host-side result</strong>
            <p className="m-0 text-caption leading-relaxed text-muted">
              OrcaSynapse deliberately has no standing SSH access or remote execution channel on VM2, so this
              confirmation is your administrative attestation.
            </p>
            <label className="flex cursor-pointer items-start gap-2.5 rounded border border-border-strong bg-raised px-3 py-2.5">
              <Switch checked={hostDestructionConfirmed} onCheckedChange={setHostDestructionConfirmed} />
              <span className="text-caption leading-snug text-muted">
                The remover reported “Agentic System removed from this VM,” or the VM was destroyed.
              </span>
            </label>
          </div>
        </li>
      </ol> : (
        <p className="m-0 rounded border border-border bg-raised px-3 py-2.5 text-caption leading-relaxed text-muted">
          This record never completed enrollment, so there is no managed VM2 installation to purge.
        </p>
      )}

      <Field label={`Type ${removalNode.slug} to remove it permanently`}>
        <Input autoComplete="off" spellCheck={false} value={removalConfirmation} onChange={(event) => setRemovalConfirmation(event.target.value)} />
      </Field>
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      </div>
    </Dialog>}
  </div>;
}

import type {
  CreateHermesNodeInvitation,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  OnboardingTargetEnvironment,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createHermesNodeInvitation,
  getHermesRuntimeNodes,
  mutateHermesRuntimeNode,
  removeHermesRuntimeNode,
} from "./api.js";
import { Button, Dialog, Drawer, EmptyState } from "./ui/index.js";

interface RuntimeNodesPanelProps {
  targetEnvironment: OnboardingTargetEnvironment;
  inferenceReady: boolean;
  onConfigureInference: () => void;
  onNodesChange?: (nodes: HermesRuntimeNode[]) => void;
  onSessionExpired: () => void;
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

function defaultForm(): CreateHermesNodeInvitation {
  return {
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    baseUrl: "http://10.0.0.12:8642",
    controlPlaneUrl: typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin,
    hermesImage: "nousresearch/hermes-agent:latest",
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
  const [removalNode, setRemovalNode] = useState<HermesRuntimeNode | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  const [hostDestructionConfirmed, setHostDestructionConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unpinned = !form.hermesImage.includes("@sha256:");
  const insecureControlPlane = !form.controlPlaneUrl.startsWith("https://");
  const productionArtifactBlocked = targetEnvironment === "PRODUCTION"
    && (unpinned || insecureControlPlane);
  const activeRuntimeExists = nodes.some((node) => node.enrolledAt && node.status !== "REVOKED");

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not update the Hermes runtime fleet.");
  };

  const load = async () => {
    const result = await getHermesRuntimeNodes();
    setNodes(result.items);
    onNodesChange?.(result.items);
  };

  useEffect(() => {
    let active = true;
    void getHermesRuntimeNodes().then((result) => {
      if (!active) return;
      setNodes(result.items);
      onNodesChange?.(result.items);
    }).catch((cause) => active && fail(cause));
    return () => { active = false; };
  }, [onNodesChange]);

  const statusCounts = useMemo(() => ({
    online: nodes.filter((node) => node.status === "ONLINE").length,
    attention: nodes.filter((node) => ["DEGRADED", "OFFLINE", "SUSPENDED"].includes(node.status)).length,
  }), [nodes]);

  const issueInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !inferenceReady) return;
    setBusy("invite");
    setError(null);
    try {
      const { expectedHostname, ...requiredFields } = form;
      const issued = await createHermesNodeInvitation(expectedHostname?.trim()
        ? { ...requiredFields, expectedHostname: expectedHostname.trim() }
        : requiredFields);
      setInvitation(issued);
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
      <div className="document-section-heading">
        <div><p className="font-mono text-micro uppercase text-faint">Isolated VM2</p><h2>Agentic System</h2></div>
        <div className="runtime-node-heading-actions"><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={busy !== null} onClick={() => void load()}>Refresh</button><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-accent bg-accent px-3.5 text-body font-medium text-[#0a0a0b] transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={activeRuntimeExists || !inferenceReady} title={!inferenceReady ? "Configure and test AI Inference before enrolling the Agentic System." : activeRuntimeExists ? "Revoke the active execution boundary before enrolling its replacement." : undefined} onClick={() => { setInvitation(null); setEditorOpen(true); }}>Generate installer</button></div>
      </div>
      <div className="runtime-node-principles">
        <article><strong>{nodes.length}</strong><span>Registered nodes</span></article>
        <article><strong>{statusCounts.online}</strong><span>Online now</span></article>
        <article><strong>{statusCounts.attention}</strong><span>Need attention</span></article>
        <div><strong>No standing SSH trust</strong><span>Enrollment is single-use. Agent Profiles remain versioned in OrcaSynapse and are injected per governed Run.</span></div>
        <div><strong>One runtime at a time</strong><span>{nodes.length === 0 ? "An installation holds exactly one Hermes execution boundary. Enrolling a second is refused." : "This installation already holds its Hermes execution boundary. Revoke and remove this node before enrolling a replacement."}</span></div>
      </div>
      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      {nodes.length === 0 && !inferenceReady ? <EmptyState title="AI Inference must be ready first" action={<Button onClick={onConfigureInference}>Configure AI Inference</Button>}>Connect and activate one served model. OrcaSynapse will then prepare the VM2 installer with the approved route.</EmptyState> : nodes.length === 0 ? <EmptyState title="Install the Agentic System on VM2" action={<Button variant="primary" onClick={() => setEditorOpen(true)}>Generate VM2 installer</Button>}>Generate one secure command, run it on the isolated VM, and paste the one-time claim when prompted. Hermes is installed, registered, and bound to the approved inference route.</EmptyState> : <div className="runtime-node-list">{nodes.map((node) => <article key={node.id}>
        <div className={`runtime-node-state ${nodeTone(node.status)}`}><span /></div>
        <div className="runtime-node-copy"><div><strong>{node.displayName}</strong><span className={`document-status ${nodeTone(node.status)}`}>{humanize(node.status)}</span></div><p>{node.baseUrl}</p><small>{node.hostname ?? node.expectedHostname ?? "Awaiting hostname"} · {node.hermesVersion ?? "Version pending"}</small></div>
        <dl><div><dt>Last heartbeat</dt><dd>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>OrcaSynapse → Hermes</dt><dd>{node.serviceConnectionStatus ? humanize(node.serviceConnectionStatus) : "Pending"}</dd></div><div><dt>Identity</dt><dd>{node.identityFingerprint ? `${node.identityFingerprint.slice(0, 12)}…` : "Not enrolled"}</dd></div></dl>
        <div className="runtime-node-actions">
          {node.status === "DRAINING" || node.status === "SUSPENDED" ? <button className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded border border-transparent px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={busy !== null} onClick={() => void act(node, "RESUME")}>Resume</button> : <button className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded border border-transparent px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={busy !== null || node.status === "PENDING" || node.status === "OFFLINE"} onClick={() => void act(node, "DRAIN")}>Drain</button>}
          {!["PENDING", "SUSPENDED", "REVOKED"].includes(node.status) && <button className="text-button danger" type="button" disabled={busy !== null} onClick={() => { if (window.confirm(`Suspend ${node.displayName}? Active work will be stopped and new work will be denied until you resume it.`)) void act(node, "SUSPEND"); }}>Suspend</button>}
          {node.status !== "REVOKED" && <button className="text-button danger" type="button" disabled={busy !== null} onClick={() => { if (window.confirm(`Permanently revoke ${node.displayName}? The node must be re-enrolled to reconnect.`)) void act(node, "REVOKE"); }}>Revoke</button>}
          {node.status === "REVOKED" && <button className="text-button danger" type="button" disabled={busy !== null} onClick={() => openRemoval(node)}>Remove</button>}
        </div>
      </article>)}</div>}
    </section>

    <aside className="panel runtime-network-contract">
      <p className="font-mono text-micro uppercase text-faint">Network contract</p><h2>Required paths</h2>
      <ol><li><span>1</span><div><strong>OrcaSynapse → Hermes</strong><small>TCP 8642, health and governed agent API only.</small></div></li><li><span>2</span><div><strong>Runtime → OrcaSynapse</strong><small>HTTPS enrollment, heartbeat, and node-scoped inference gateway.</small></div></li></ol>
      <div className="runtime-network-note"><strong>The installer does not manage your firewall.</strong><p>Apply customer network policy before Production activation. Do not expose port 8642 to user or internet networks.</p></div>
    </aside>

    {editorOpen && inferenceReady && <Drawer
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
        <label><span>VM2 private address</span><input required type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /><small>Normally <code>http://VM2-IP:8642</code>. Port 8642 must be reachable only from OrcaSynapse.</small></label>
        <details className="runtime-deployment-details">
          <summary><span><strong>Advanced deployment options</strong><small>Identity, release pins, and network overrides</small></span><b>+</b></summary>
          <div>
            <label><span>Node name</span><input required minLength={2} maxLength={120} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
            <label><span>Node slug</span><input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={2} maxLength={64} value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} /></label>
            <label><span>Expected VM hostname (optional)</span><input maxLength={253} value={form.expectedHostname ?? ""} placeholder="hermes-01.internal" onChange={(event) => setForm({ ...form, expectedHostname: event.target.value })} /><small>When set, enrollment fails if VM2 reports a different hostname.</small></label>
            <label><span>OrcaSynapse address visible to VM2</span><input required type="url" value={form.controlPlaneUrl} onChange={(event) => setForm({ ...form, controlPlaneUrl: event.target.value })} /></label>
            <label><span>Hermes image</span><input required maxLength={500} value={form.hermesImage} onChange={(event) => setForm({ ...form, hermesImage: event.target.value })} /><small>Pin with <code>@sha256:…</code> after acceptance testing.</small></label>
          </div>
        </details>
        {targetEnvironment === "PRODUCTION" && (unpinned || insecureControlPlane) && <div className="runtime-invite-warning"><strong>Production hardening required</strong><ul>{unpinned && <li>The Hermes image is tagged, not digest-pinned.</li>}{insecureControlPlane && <li>The OrcaSynapse enrollment route uses HTTP rather than HTTPS.</li>}</ul></div>}
        {targetEnvironment !== "PRODUCTION" && (unpinned || insecureControlPlane) && <div className="runtime-development-note">Development release defaults are selected. Exact production pins remain available under Advanced deployment options.</div>}
      </form> : <div className="runtime-install-steps">
        <div className="runtime-success-mark">✓</div><p>The enrollment claim expires <strong>{new Date(invitation.bundle.expiresAt).toLocaleString()}</strong> and can be used only once.</p>
        <ol><li><span>1</span><div><strong>Run one command on VM2</strong><small>OrcaSynapse serves the installer directly; it connects back only to this control-plane origin.</small><code>{agenticNodeInstallCommand(invitation.bundle.controlPlaneUrl)}</code></div></li><li><span>2</span><div><strong>Paste the claim when prompted</strong><small>The installer reads it from the terminal with hidden input and sends it in a redacted POST body—not in the URL or shell history.</small><code>{invitation.bundle.token}</code><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => void navigator.clipboard.writeText(invitation.bundle.token)}>Copy claim</button></div></li><li><span>3</span><div><strong>Watch the node come online</strong><small>OrcaSynapse installs Hermes, applies the approved route and policy, then starts signed health reporting.</small><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={downloadBundle}>Download JSON fallback</button></div></li></ol>
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
        <li><span>1</span><div><strong>Run the purge on the enrolled VM2</strong><small>The script shows its exact scope and requires typing <code>DESTROY</code>. It does not uninstall Docker or touch unrelated containers.</small><code>{agenticNodeRemovalCommand(typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin)}</code><button className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded border border-border-strong bg-raised px-3.5 text-body font-medium text-text transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40" type="button" onClick={() => void navigator.clipboard.writeText(agenticNodeRemovalCommand(window.location.origin))}>Copy command</button></div></li>
        <li><span>2</span><div><strong>Confirm the host-side result</strong><small>OrcaSynapse deliberately has no standing SSH or Docker access, so this confirmation is your administrative attestation.</small><label className="runtime-removal-attestation"><input type="checkbox" checked={hostDestructionConfirmed} onChange={(event) => setHostDestructionConfirmed(event.target.checked)} /><span>The remover reported “Agentic System removed from this VM,” or the VM was destroyed.</span></label></div></li>
      </ol> : <div className="runtime-development-note">This record never completed enrollment, so there is no managed VM2 installation to purge.</div>}
      <label><span>Type {removalNode.slug} to remove it permanently</span><input autoComplete="off" spellCheck={false} value={removalConfirmation} onChange={(event) => setRemovalConfirmation(event.target.value)} /></label>
      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
    </Dialog>}
  </div>;
}

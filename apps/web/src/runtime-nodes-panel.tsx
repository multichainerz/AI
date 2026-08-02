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
} from "./api.js";

interface RuntimeNodesPanelProps {
  targetEnvironment: OnboardingTargetEnvironment;
  inferenceReady: boolean;
  onConfigureInference: () => void;
  onUnauthorized: () => void;
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

function defaultForm(): CreateHermesNodeInvitation {
  return {
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    baseUrl: "http://10.0.0.12:8642",
    controlPlaneUrl: typeof window === "undefined" ? "https://orcasynapse.internal" : window.location.origin,
    hermesImage: "nousresearch/hermes-agent:latest",
    supermemoryVersion: "latest",
    expiresInMinutes: 30,
  };
}

export function RuntimeNodesPanel({
  targetEnvironment,
  inferenceReady,
  onConfigureInference,
  onUnauthorized,
}: RuntimeNodesPanelProps) {
  const [nodes, setNodes] = useState<HermesRuntimeNode[]>([]);
  const [form, setForm] = useState<CreateHermesNodeInvitation>(defaultForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const [invitation, setInvitation] = useState<HermesNodeInvitation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unpinned = !form.hermesImage.includes("@sha256:");
  const unpinnedSupermemory = form.supermemoryVersion === "latest";
  const insecureControlPlane = !form.controlPlaneUrl.startsWith("https://");
  const productionArtifactBlocked = targetEnvironment === "PRODUCTION"
    && (unpinned || unpinnedSupermemory || insecureControlPlane);
  const activeRuntimeExists = nodes.some((node) => node.enrolledAt && node.status !== "REVOKED");

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not update the Hermes runtime fleet.");
  };

  const load = async () => {
    const result = await getHermesRuntimeNodes();
    setNodes(result.items);
  };

  useEffect(() => {
    let active = true;
    void getHermesRuntimeNodes().then((result) => active && setNodes(result.items)).catch((cause) => active && fail(cause));
    return () => { active = false; };
  }, []);

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

  return <div className="runtime-nodes-layout">
    <section className="panel runtime-nodes-overview">
      <div className="document-section-heading">
        <div><p className="section-kicker">Hermes trust zone</p><h2>Runtime nodes</h2></div>
        <div className="runtime-node-heading-actions"><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void load()}>Refresh</button><button className="primary-button" type="button" disabled={activeRuntimeExists || !inferenceReady} title={!inferenceReady ? "Configure and test AI Inference before enrolling the Agentic System." : activeRuntimeExists ? "Revoke the active execution boundary before enrolling its replacement." : undefined} onClick={() => { setInvitation(null); setEditorOpen(true); }}>Enroll node</button></div>
      </div>
      <div className="runtime-node-principles">
        <article><strong>{nodes.length}</strong><span>Registered nodes</span></article>
        <article><strong>{statusCounts.online}</strong><span>Online now</span></article>
        <article><strong>{statusCounts.attention}</strong><span>Need attention</span></article>
        <div><strong>No standing SSH trust</strong><span>Enrollment is single-use. Agent Profiles remain versioned in OrcaSynapse and are injected per governed Run.</span></div>
      </div>
      {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      {nodes.length === 0 && !inferenceReady ? <div className="setup-empty"><strong>AI Inference must be ready first</strong><p>Connect and successfully test one served model. OrcaSynapse will then unlock a customer-bound VM2 invitation and pre-seed Hermes with the governed inference route.</p><button className="primary-button" type="button" onClick={onConfigureInference}>Configure AI Inference</button></div> : nodes.length === 0 ? <div className="setup-empty"><strong>No Hermes runtime node enrolled</strong><p>Issue an invitation here and run the generated installer once on the isolated VM. The enrollment response supplies Hermes with the approved model alias, gateway route, and baseline policy.</p><button className="primary-button" type="button" onClick={() => setEditorOpen(true)}>Enroll the first node</button></div> : <div className="runtime-node-list">{nodes.map((node) => <article key={node.id}>
        <div className={`runtime-node-state ${nodeTone(node.status)}`}><span /></div>
        <div className="runtime-node-copy"><div><strong>{node.displayName}</strong><span className={`document-status ${nodeTone(node.status)}`}>{humanize(node.status)}</span></div><p>{node.baseUrl}</p><small>{node.hostname ?? node.expectedHostname ?? "Awaiting hostname"} · {node.hermesVersion ?? "Version pending"}</small></div>
        <dl><div><dt>Last heartbeat</dt><dd>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "Never"}</dd></div><div><dt>OrcaSynapse → Hermes</dt><dd>{node.serviceConnectionStatus ? humanize(node.serviceConnectionStatus) : "Pending"}</dd></div><div><dt>Identity</dt><dd>{node.identityFingerprint ? `${node.identityFingerprint.slice(0, 12)}…` : "Not enrolled"}</dd></div></dl>
        <div className="runtime-node-actions">
          {node.status === "DRAINING" || node.status === "SUSPENDED" ? <button className="text-button" type="button" disabled={busy !== null} onClick={() => void act(node, "RESUME")}>Resume</button> : <button className="text-button" type="button" disabled={busy !== null || node.status === "PENDING" || node.status === "OFFLINE"} onClick={() => void act(node, "DRAIN")}>Drain</button>}
          {!["PENDING", "SUSPENDED", "REVOKED"].includes(node.status) && <button className="text-button danger" type="button" disabled={busy !== null} onClick={() => { if (window.confirm(`Suspend ${node.displayName}? Active work will be stopped and new work will be denied until you resume it.`)) void act(node, "SUSPEND"); }}>Suspend</button>}
          {node.status !== "REVOKED" && <button className="text-button danger" type="button" disabled={busy !== null} onClick={() => { if (window.confirm(`Permanently revoke ${node.displayName}? The node must be re-enrolled to reconnect.`)) void act(node, "REVOKE"); }}>Revoke</button>}
        </div>
      </article>)}</div>}
    </section>

    <aside className="panel runtime-network-contract">
      <p className="section-kicker">Network contract</p><h2>Required paths</h2>
      <ol><li><span>1</span><div><strong>OrcaSynapse → Hermes</strong><small>TCP 8642, health and governed agent API only.</small></div></li><li><span>2</span><div><strong>Runtime → OrcaSynapse</strong><small>HTTPS enrollment, heartbeat, and node-scoped inference gateway.</small></div></li><li><span>3</span><div><strong>Hermes ↔ Supermemory</strong><small>Profile-scoped durable memory on the isolated runtime host.</small></div></li></ol>
      <div className="runtime-network-note"><strong>The installer does not manage your firewall.</strong><p>Apply customer network policy before Production activation. Do not expose port 8642 to user or internet networks.</p></div>
    </aside>

    {editorOpen && inferenceReady && <div className="agent-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditorOpen(false); }}><section className="setup-evidence-editor runtime-node-editor">
      <header><div><p className="section-kicker">Two-VM enrollment</p><h2>{invitation ? "Install the Hermes node" : "Create runtime invitation"}</h2></div><button type="button" aria-label="Close" onClick={() => setEditorOpen(false)}>×</button></header>
      {!invitation ? <form onSubmit={(event) => void issueInvitation(event)}>
        <p className="runtime-form-intro">Define the address OrcaSynapse will use to reach VM2. The healthy AI Inference route selected during dashboard onboarding is injected automatically; enrollment installs Hermes and Supermemory with its approved model alias and a scoped OrcaSynapse gateway key. No upstream inference key, SSH password, or private key enters the browser.</p>
        <label>Node name<input required minLength={2} maxLength={120} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
        <label>Node slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" minLength={2} maxLength={64} value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} /></label>
        <label>Hermes API address<input required type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /><small>Use the private VM2 address reachable from OrcaSynapse, normally port 8642.</small></label>
        <label>Expected VM hostname <em>Optional</em><input maxLength={253} value={form.expectedHostname ?? ""} placeholder="hermes-01.internal" onChange={(event) => setForm({ ...form, expectedHostname: event.target.value })} /><small>When set, enrollment fails if VM2 reports a different hostname.</small></label>
        <label>OrcaSynapse address visible to VM2<input required type="url" value={form.controlPlaneUrl} onChange={(event) => setForm({ ...form, controlPlaneUrl: event.target.value })} /></label>
        <label>Hermes image<input required maxLength={500} value={form.hermesImage} onChange={(event) => setForm({ ...form, hermesImage: event.target.value })} /><small>Pin with <code>@sha256:…</code> after acceptance testing.</small></label>
        <label>Supermemory release<input required maxLength={120} pattern="(?:latest|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)" value={form.supermemoryVersion} onChange={(event) => setForm({ ...form, supermemoryVersion: event.target.value })} /><small>Use <code>latest</code> only during development; Production requires an exact release.</small></label>
        {(unpinned || unpinnedSupermemory || insecureControlPlane) && <div className="runtime-invite-warning"><strong>{targetEnvironment === "PRODUCTION" ? "Production hardening required" : "Pre-production warning"}</strong><ul>{unpinned && <li>The Hermes image is tagged, not digest-pinned.</li>}{unpinnedSupermemory && <li>The Supermemory release is not pinned.</li>}{insecureControlPlane && <li>The OrcaSynapse enrollment route uses HTTP rather than HTTPS.</li>}</ul></div>}
        <footer><button className="secondary-button" type="button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy !== null || productionArtifactBlocked} type="submit">{busy === "invite" ? "Issuing…" : productionArtifactBlocked ? "Pin production artifacts" : "Issue one-time invitation"}</button></footer>
      </form> : <div className="runtime-install-steps">
        <div className="runtime-success-mark">✓</div><p>The enrollment claim expires <strong>{new Date(invitation.bundle.expiresAt).toLocaleString()}</strong> and can be used only once.</p>
        <ol><li><span>1</span><div><strong>Run one command on VM2</strong><small>OrcaSynapse serves the installer directly; it connects back only to this control-plane origin.</small><code>curl -fsSL {invitation.bundle.controlPlaneUrl}/install/hermes-node.sh | sudo bash -s -- --connect {invitation.bundle.controlPlaneUrl}</code></div></li><li><span>2</span><div><strong>Paste the claim when prompted</strong><small>The installer reads it from the terminal with hidden input and sends it in a redacted POST body—not in the URL or shell history.</small><code>{invitation.bundle.token}</code><button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(invitation.bundle.token)}>Copy claim</button></div></li><li><span>3</span><div><strong>Watch the node come online</strong><small>OrcaSynapse installs Hermes and Supermemory, applies the approved route and policy, then starts signed health reporting.</small><button className="secondary-button" type="button" onClick={downloadBundle}>Download JSON fallback</button></div></li></ol>
        <div className="runtime-network-note"><strong>What happens next</strong><p>VM2 generates its own private identity, installs Hermes and Supermemory, exchanges the claim once, and appears Online here. OrcaSynapse never receives the private signing key or a reusable VM credential.</p></div>
        <footer><button className="secondary-button" type="button" onClick={() => setInvitation(null)}>Issue another</button><button className="primary-button" type="button" onClick={() => { setEditorOpen(false); void load(); }}>Done</button></footer>
      </div>}
    </section></div>}
  </div>;
}

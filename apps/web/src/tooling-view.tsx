import type {
  AdminScope,
  AgentProfile,
  GatewayCredential,
  GovernedTool,
  IssuedGatewayCredential,
  ToolApproval,
  ToolCall,
  ToolGrant,
  ToolMetrics,
  ToolRuntimeControl,
} from "@aihub/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AIHubApiError,
  decideToolApproval,
  getAgentProfiles,
  getGatewayCredentials,
  getGovernedTools,
  getToolApprovals,
  getToolCalls,
  getToolGrants,
  getToolMetrics,
  getToolRuntime,
  issueGatewayCredential,
  revokeGatewayCredential,
  setGovernedToolStatus,
  updateToolRuntime,
  upsertToolGrant,
} from "./api.js";

interface ToolingViewProps {
  unlocked: boolean;
  scopes: AdminScope[];
  onConfigure: () => void;
  onUnauthorized: () => void;
}

function tone(value: string): string {
  if (["ACTIVE", "COMPLETED", "APPROVED"].includes(value)) return "ready";
  if (["PENDING", "APPROVAL_PENDING", "EXECUTING", "REQUESTED"].includes(value)) return "processing";
  if (["FAILED", "DENIED", "REJECTED", "EXPIRED", "CANCELLED"].includes(value)) return "failed";
  return "neutral";
}

function when(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function ToolingView({ unlocked, scopes, onConfigure, onUnauthorized }: ToolingViewProps) {
  const [tools, setTools] = useState<GovernedTool[]>([]);
  const [grants, setGrants] = useState<ToolGrant[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [credentials, setCredentials] = useState<GatewayCredential[]>([]);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [runtime, setRuntime] = useState<ToolRuntimeControl | null>(null);
  const [metrics, setMetrics] = useState<ToolMetrics | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [profileVersionId, setProfileVersionId] = useState("");
  const [toolId, setToolId] = useState("");
  const [groupClaims, setGroupClaims] = useState("");
  const [adminRole, setAdminRole] = useState("PLATFORM_ADMIN");
  const [credentialName, setCredentialName] = useState("Hermes on-prem gateway");
  const [issuedCredential, setIssuedCredential] = useState<IssuedGatewayCredential | null>(null);
  const [runtimeReason, setRuntimeReason] = useState("Phase 6 gateway controls reviewed for the isolated pilot.");
  const [approvalTtl, setApprovalTtl] = useState(15);
  const [decisionReason, setDecisionReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = scopes.includes("tools:manage");
  const canReview = scopes.includes("approvals:review");

  const selectedApproval = useMemo(() => approvals.find(({ id }) => id === selectedApprovalId) ?? approvals.find(({ status }) => status === "PENDING") ?? approvals[0] ?? null, [approvals, selectedApprovalId]);
  const profileVersions = useMemo(() => profiles.flatMap((profile) => {
    const versions = [{ profile, version: profile.version, live: profile.activeVersion === profile.version.version }];
    if (profile.activeVersionConfiguration && profile.activeVersionConfiguration.id !== profile.version.id) {
      versions.push({ profile, version: profile.activeVersionConfiguration, live: true });
    }
    return versions;
  }), [profiles]);

  const fail = (cause: unknown) => {
    if (cause instanceof AIHubApiError && cause.status === 401) onUnauthorized();
    setError(cause instanceof Error ? cause.message : "AIHub could not complete the governed-tool operation.");
  };

  const load = async () => {
    const [toolList, grantList, profileList, credentialList, approvalList, callList, control, nextMetrics] = await Promise.all([
      getGovernedTools(), getToolGrants(), getAgentProfiles(true), getGatewayCredentials(), getToolApprovals(), getToolCalls(), getToolRuntime(), getToolMetrics(),
    ]);
    setTools(toolList.items); setGrants(grantList.items); setProfiles(profileList.items); setCredentials(credentialList.items);
    setApprovals(approvalList.items); setCalls(callList.items); setRuntime(control); setMetrics(nextMetrics); setApprovalTtl(control.approvalTtlMinutes);
    setProfileVersionId((current) => current || profileList.items[0]?.activeVersionConfiguration?.id || profileList.items[0]?.version.id || "");
    setToolId((current) => current || toolList.items[0]?.id || "");
  };

  useEffect(() => {
    if (!unlocked) return;
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => { if (active) void load().catch(() => undefined); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked]);

  const action = async (key: string, operation: () => Promise<unknown>, message?: string) => {
    if (busy) return;
    setBusy(key); setError(null); setNotice(null);
    try { await operation(); await load(); if (message) setNotice(message); }
    catch (cause) { fail(cause); }
    finally { setBusy(null); }
  };

  const saveGrant = async (event: FormEvent) => {
    event.preventDefault();
    const groups = groupClaims.split(",").map((value) => value.trim()).filter(Boolean);
    const roles = adminRole ? [adminRole as "PLATFORM_ADMIN" | "SECURITY_ADMIN" | "OPERATIONS_ADMIN" | "AUDITOR"] : [];
    if (!profileVersionId || !toolId || (groups.length === 0 && roles.length === 0)) return;
    await action("grant", () => upsertToolGrant({ profileVersionId, toolId, enabled: true, allowedGroups: groups, allowedAdminRoles: roles, resourceScope: "OWNER_ONLY" }), "The exact version grant is active.");
  };

  if (!unlocked) {
    return <section className="chat-locked tooling-locked"><div className="chat-lock-mark">TG</div><p className="page-kicker">Governed access</p><h1>Tooling requires a scoped administrator</h1><p>Unlock the console to manage MCP gateway credentials, exact-version grants, tool health, and human approvals.</p><button className="primary-button" type="button" onClick={onConfigure}>Administrator setup</button></section>;
  }

  return <section className="tooling-workspace">
    <header className="documents-header tooling-header"><div><p className="page-kicker">Controlled integration plane</p><h1>Tools & approvals</h1><p>AIHub-owned MCP access with two-factor gateway authentication, exact-version grants, owner-only resources, and mandatory review for consequential actions.</p></div><button className="secondary-button" type="button" onClick={() => void load()}>Refresh</button></header>

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
    {notice && <div className="tooling-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

    <section className={`tooling-boundary ${runtime?.enabled ? "enabled" : "disabled"}`}>
      <div className="tooling-boundary-state"><span>{runtime?.enabled ? "ON" : "OFF"}</span><div><small>Global MCP gateway</small><strong>{runtime?.enabled ? "Governed calls are permitted" : "Every tool call is denied fail-closed"}</strong><p>{runtime?.reason ?? "Runtime state is loading."}</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void action("runtime", () => updateToolRuntime({ enabled: !runtime?.enabled, reason: runtimeReason, approvalTtlMinutes: approvalTtl })); }}>
        <label>Operator reason<input disabled={!canManage} minLength={3} maxLength={500} value={runtimeReason} onChange={(event) => setRuntimeReason(event.target.value)} /></label>
        <label>Approval expiry<select disabled={!canManage} value={approvalTtl} onChange={(event) => setApprovalTtl(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option></select></label>
        <button className={runtime?.enabled ? "danger-button" : "primary-button"} disabled={!canManage || busy !== null || runtimeReason.trim().length < 3} type="submit">{canManage ? busy === "runtime" ? "Applying…" : runtime?.enabled ? "Disable gateway" : "Enable gateway" : "Read-only access"}</button>
      </form>
    </section>

    <div className="tooling-metrics" aria-label="Governed tooling summary">
      <article><span>Active tools</span><strong>{metrics?.activeTools ?? tools.filter(({ status }) => status === "ACTIVE").length}</strong><small>AIHub handlers only</small></article>
      <article><span>Version grants</span><strong>{metrics?.activeGrants ?? grants.filter(({ enabled }) => enabled).length}</strong><small>exact profile revisions</small></article>
      <article><span>Pending review</span><strong>{metrics?.pendingApprovals ?? approvals.filter(({ status }) => status === "PENDING").length}</strong><small>expires automatically</small></article>
      <article><span>Action dispatch</span><strong>{metrics?.openActionDispatches ?? calls.filter(({ status }) => status === "EXECUTING").length}</strong><small>{metrics?.executingCalls ?? 0} executing / {metrics?.failedActionDispatches ?? 0} failed</small></article>
    </div>

    <div className="tooling-grid">
      <section className="panel tooling-tools"><div className="document-section-heading"><div><p className="section-kicker">Allowlisted surface</p><h2>Tool registry</h2></div><span>{tools.length} built-in tools</span></div>
        <div className="tooling-tool-list">{tools.map((tool) => <article key={tool.id}><div className={`tooling-tool-mark ${tool.risk === "READ_ONLY" ? "read" : "action"}`}>{tool.risk === "READ_ONLY" ? "R" : "A"}</div><div><div className="tooling-tool-title"><strong>{tool.displayName}</strong><span className={`document-status ${tone(tool.status)}`}>{tool.status.toLowerCase()}</span></div><p>{tool.description}</p><small>{tool.slug} · {tool.risk === "READ_ONLY" ? "read-only" : "human approval required"}</small></div><button type="button" disabled={!canManage || busy !== null} onClick={() => void action(`tool-${tool.id}`, () => setGovernedToolStatus(tool.id, tool.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"))}>{canManage ? tool.status === "ACTIVE" ? "Suspend" : "Activate" : "View only"}</button></article>)}</div>
      </section>

      <section className="panel tooling-grants"><div className="document-section-heading"><div><p className="section-kicker">Least privilege</p><h2>Exact-version grants</h2></div><span>owner-only</span></div>
        <form className="tooling-grant-form" onSubmit={(event) => void saveGrant(event)}>
          <label>Agent revision<select disabled={!canManage} value={profileVersionId} onChange={(event) => setProfileVersionId(event.target.value)}>{profileVersions.map(({ profile, version, live }) => <option key={version.id} value={version.id}>{profile.slug} · v{version.version}{live ? " · live" : " · current draft"}</option>)}</select></label>
          <label>Tool<select disabled={!canManage} value={toolId} onChange={(event) => setToolId(event.target.value)}>{tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.displayName} · {tool.risk.toLowerCase().replace("_", " ")}</option>)}</select></label>
          <label>Exact enterprise groups<input disabled={!canManage} placeholder="MPM-AI-Pilot, MPM-Ops" value={groupClaims} onChange={(event) => setGroupClaims(event.target.value)} /><small>Comma-separated, exact case-sensitive claims.</small></label>
          <label>Administrator recovery role<select disabled={!canManage} value={adminRole} onChange={(event) => setAdminRole(event.target.value)}><option value="">None</option><option value="PLATFORM_ADMIN">Platform administrator</option><option value="SECURITY_ADMIN">Security administrator</option><option value="OPERATIONS_ADMIN">Operations administrator</option><option value="AUDITOR">Auditor</option></select></label>
          <button className="primary-button" disabled={!canManage || busy !== null || !profileVersionId || !toolId} type="submit">{canManage ? busy === "grant" ? "Saving…" : "Save version grant" : "Read-only access"}</button>
        </form>
        <div className="tooling-grant-list">{grants.length === 0 ? <div className="document-empty"><strong>No grants configured</strong><span>The global gateway cannot be enabled until at least one exact-version grant exists.</span></div> : grants.map((grant) => <article key={grant.id}><div><strong>{grant.profileSlug} · v{grant.profileVersion}</strong><span>{grant.toolName}</span></div><small>{grant.allowedGroups.length > 0 ? grant.allowedGroups.join(", ") : grant.allowedAdminRoles.join(", ")} · {grant.resourceScope.toLowerCase().replace("_", " ")}</small><span className={`document-status ${grant.enabled ? "ready" : "neutral"}`}>{grant.enabled ? "active" : "disabled"}</span></article>)}</div>
      </section>
    </div>

    <div className="tooling-grid credentials-row">
      <section className="panel tooling-credentials"><div className="document-section-heading"><div><p className="section-kicker">Transport authentication</p><h2>Gateway credentials</h2></div><span>write-only</span></div>
        <form onSubmit={(event) => { event.preventDefault(); void action("credential", async () => { const issued = await issueGatewayCredential(credentialName.trim()); setIssuedCredential(issued); }, "Copy the new credential now; AIHub will not display it again."); }}><label>Client name<input disabled={!canManage} minLength={2} maxLength={120} value={credentialName} onChange={(event) => setCredentialName(event.target.value)} /></label><button className="primary-button" disabled={!canManage || busy !== null || credentialName.trim().length < 2} type="submit">{canManage ? busy === "credential" ? "Issuing…" : "Issue credential" : "Read-only access"}</button></form>
        {issuedCredential && <div className="tooling-secret"><div><strong>One-time credential</strong><span>Store this in the isolated Hermes MCP header configuration.</span></div><code>{issuedCredential.token}</code><button type="button" onClick={() => void navigator.clipboard.writeText(issuedCredential.token)}>Copy</button></div>}
        <div className="tooling-credential-list">{credentials.map((credential) => <article key={credential.id}><div><strong>{credential.name}</strong><code>{credential.tokenPrefix}…</code></div><span>Last used {when(credential.lastUsedAt)}</span><span className={`document-status ${credential.enabled ? "ready" : "neutral"}`}>{credential.enabled ? "active" : "revoked"}</span>{credential.enabled && <button type="button" disabled={!canManage || busy !== null} onClick={() => void action(`credential-${credential.id}`, () => revokeGatewayCredential(credential.id))}>{canManage ? "Revoke" : "View only"}</button>}</article>)}</div>
      </section>

      <section className="panel tooling-approvals"><div className="document-section-heading"><div><p className="section-kicker">Human control</p><h2>Approval inbox</h2></div><span>{approvals.filter(({ status }) => status === "PENDING").length} pending</span></div>
        <div className="tooling-approval-layout"><div className="tooling-approval-list">{approvals.length === 0 ? <div className="document-empty"><strong>Inbox is clear</strong><span>Consequential tool requests will appear here.</span></div> : approvals.map((approval) => <button className={selectedApproval?.id === approval.id ? "selected" : undefined} key={approval.id} type="button" onClick={() => { setSelectedApprovalId(approval.id); setDecisionReason(""); }}><span className={`document-status ${tone(approval.status)}`}>{approval.status.toLowerCase()}</span><strong>{approval.toolName}</strong><small>{approval.profileSlug} · expires {when(approval.expiresAt)}</small></button>)}</div>
          <div className="tooling-approval-detail">{!selectedApproval ? <div className="document-empty"><strong>No approval selected</strong><span>Review context and ownership before deciding.</span></div> : <><div><span className={`document-status ${tone(selectedApproval.status)}`}>{selectedApproval.status.toLowerCase()}</span><h3>{selectedApproval.toolName}</h3><p>{selectedApproval.requestedBySubject}</p></div><dl><div><dt>Agent</dt><dd>{selectedApproval.profileSlug}</dd></div><div><dt>Run</dt><dd>{selectedApproval.runId.slice(0, 12)}…</dd></div><div><dt>Expires</dt><dd>{when(selectedApproval.expiresAt)}</dd></div></dl><pre>{JSON.stringify(selectedApproval.arguments, null, 2)}</pre>{selectedApproval.status === "PENDING" && (canReview ? <form onSubmit={(event) => { event.preventDefault(); }}><label>Reviewer reason<textarea minLength={3} maxLength={1_000} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} /></label><div><button className="secondary-button" disabled={busy !== null || decisionReason.trim().length < 3} type="button" onClick={() => void action("decision", () => decideToolApproval(selectedApproval.id, "REJECT", decisionReason.trim()))}>Reject</button><button className="primary-button" disabled={busy !== null || decisionReason.trim().length < 3} type="button" onClick={() => void action("decision", () => decideToolApproval(selectedApproval.id, "APPROVE", decisionReason.trim()))}>Approve & execute</button></div></form> : <p className="tooling-readonly-note">Your role can inspect this request but cannot decide it.</p>)}</>}</div>
        </div>
      </section>
    </div>

    <section className="panel tooling-ledger"><div className="document-section-heading"><div><p className="section-kicker">Revalidated activity</p><h2>Tool-call ledger</h2></div><span>{calls.length} calls</span></div>
      <div className="tooling-call-table"><div className="tooling-call-head"><span>Status</span><span>Tool</span><span>Agent</span><span>Requested</span><span>Outcome</span></div>{calls.length === 0 ? <div className="document-empty"><strong>No calls recorded</strong><span>The gateway remains staged until a live Hermes configuration carries an approved per-run capability.</span></div> : calls.map((call) => <article key={call.id}><span className={`document-status ${tone(call.status)}`}>{call.status.toLowerCase().replace("_", " ")}</span><strong>{call.toolName}</strong><span>{call.profileSlug} · v{call.profileVersion}</span><span>{when(call.requestedAt)}</span><span>{call.errorMessage ?? (call.result ? "Result retained" : "Awaiting outcome")}</span></article>)}</div>
    </section>

    <div className="tooling-stage-note"><strong>Hermes remains zero-tool by default</strong><p>The gateway control plane is ready for acceptance, but Phase 5 runs will continue rejecting enabled Hermes toolsets until the isolated deployment proves exact tool discovery and per-run capability propagation end to end.</p></div>
  </section>;
}

import type {
  AdministratorSession,
  AgentProfile,
  GatewayCredential,
  GovernedTool,
  HermesRuntimeCatalogue,
  IssuedGatewayCredential,
  ToolApproval,
  ToolCall,
  ToolGrant,
  ToolMetrics,
  ToolRuntimeControl,
  ToolsetAdmission,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  getAgentProfiles,
  getGatewayCredentials,
  getGovernedTools,
  decideToolApproval,
  decideToolsetAdmission,
  getPendingToolApprovals,
  getRuntimeCatalogue,
  getToolsetAdmissions,
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
import { adminAccess } from "./admin-access.js";
import { LockedScreen } from "./ui/index.js";

interface ToolingViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
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

export function ToolingView({ session, onConfigure, onSessionExpired }: ToolingViewProps) {
  const [tools, setTools] = useState<GovernedTool[]>([]);
  const [grants, setGrants] = useState<ToolGrant[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [credentials, setCredentials] = useState<GatewayCredential[]>([]);
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [approvalReason, setApprovalReason] = useState("");
  const [admissions, setAdmissions] = useState<ToolsetAdmission[]>([]);
  const [catalogue, setCatalogue] = useState<HermesRuntimeCatalogue | null>(null);
  const [admissionReason, setAdmissionReason] = useState("");
  const [runtime, setRuntime] = useState<ToolRuntimeControl | null>(null);
  const [metrics, setMetrics] = useState<ToolMetrics | null>(null);
  const [profileVersionId, setProfileVersionId] = useState("");
  const [toolId, setToolId] = useState("");
  const [groupClaims, setGroupClaims] = useState("");
  const [adminRole, setAdminRole] = useState("PLATFORM_ADMIN");
  const [credentialName, setCredentialName] = useState("Hermes on-prem gateway");
  const [issuedCredential, setIssuedCredential] = useState<IssuedGatewayCredential | null>(null);
  const [runtimeReason, setRuntimeReason] = useState("Gateway controls reviewed for the isolated pilot.");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { unlocked, scopes } = adminAccess(session);
  const canManage = scopes.includes("tools:manage");
  const profileVersions = useMemo(() => profiles.flatMap((profile) => {
    const versions = [{ profile, version: profile.version, live: profile.activeVersion === profile.version.version }];
    if (profile.activeVersionConfiguration && profile.activeVersionConfiguration.id !== profile.version.id) {
      versions.push({ profile, version: profile.activeVersionConfiguration, live: true });
    }
    return versions;
  }), [profiles]);

  const admittedNames = useMemo(
    () => new Set(admissions.filter(({ admitted }) => admitted).map(({ toolsetName }) => toolsetName)),
    [admissions],
  );

  /**
   * Every toolset the runtime knows about, plus any admitted one it does not.
   *
   * An admission for a toolset the runtime has never reported still belongs on
   * screen — it is a decision this installation made, and hiding it would make
   * a revocation look like it had already happened.
   */
  const toolsetRows = useMemo(() => {
    const reasons = new Map(admissions.map((entry) => [entry.toolsetName, entry.reason]));
    const rows = (catalogue?.toolsets ?? []).map((toolset) => ({
      name: toolset.name,
      toolCount: toolset.toolCount,
      enabled: toolset.enabled,
      admitted: admittedNames.has(toolset.name),
      reason: reasons.get(toolset.name) ?? null,
    }));
    const known = new Set(rows.map(({ name }) => name));
    for (const entry of admissions) {
      if (known.has(entry.toolsetName)) continue;
      rows.push({
        name: entry.toolsetName,
        toolCount: 0,
        enabled: false,
        admitted: entry.admitted,
        reason: entry.reason,
      });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }, [catalogue, admissions, admittedNames]);

  // What the boundary is currently refusing runs over.
  const drifted = useMemo(
    () => toolsetRows.filter((row) => row.enabled && !row.admitted).map(({ name }) => name),
    [toolsetRows],
  );

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the governed-tool operation.");
  };

  const load = async () => {
    const [toolList, grantList, profileList, credentialList, callList, control, nextMetrics, approvalList, admissionList, runtimeCatalogue] = await Promise.all([
      getGovernedTools(), getToolGrants(), getAgentProfiles(true), getGatewayCredentials(), getToolCalls(), getToolRuntime(), getToolMetrics(),
      getPendingToolApprovals(), getToolsetAdmissions(),
      // The runtime may be unreachable; its catalogue is informative, not
      // load-bearing, so a failure must not blank the whole page.
      getRuntimeCatalogue().catch(() => null),
    ]);
    setTools(toolList.items); setGrants(grantList.items); setProfiles(profileList.items); setCredentials(credentialList.items);
    setCalls(callList.items); setRuntime(control); setMetrics(nextMetrics);
    setApprovals(approvalList.items);
    setAdmissions(admissionList.items); setCatalogue(runtimeCatalogue);
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
    return <LockedScreen
      kicker="Governed access"
      title="Tooling"
      mark="TG"
      headline="Scoped administrator required"
      reason="Unlock the console to manage the read-only MCP gateway, exact-version grants, credentials, and tool health."
      actionLabel="Administrator setup"
      onAction={onConfigure}
    />;
  }

  return <section className="tooling-workspace">
    <header className="documents-header tooling-header"><div><p className="page-kicker">Controlled integration plane</p><h1>Governed tools</h1><p>OrcaSynapse-owned, read-only MCP access with two-factor gateway authentication, exact-version grants, and owner-only resources.</p></div><button className="secondary-button" type="button" onClick={() => void load()}>Refresh</button></header>

    {error && <div className="documents-alert" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
    {notice && <div className="tooling-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

    <section className={`tooling-boundary ${runtime?.enabled ? "enabled" : "disabled"}`}>
      <div className="tooling-boundary-state"><span>{runtime?.enabled ? "ON" : "OFF"}</span><div><small>Global MCP gateway</small><strong>{runtime?.enabled ? "Governed calls are permitted" : "Every tool call is denied fail-closed"}</strong><p>{runtime?.reason ?? "Runtime state is loading."}</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void action("runtime", () => updateToolRuntime({ enabled: !runtime?.enabled, reason: runtimeReason, approvalTtlMinutes: runtime?.approvalTtlMinutes ?? 15 })); }}>
        <label>Operator reason<input disabled={!canManage} minLength={3} maxLength={500} value={runtimeReason} onChange={(event) => setRuntimeReason(event.target.value)} /></label>
        <button className={runtime?.enabled ? "danger-button" : "primary-button"} disabled={!canManage || busy !== null || runtimeReason.trim().length < 3} type="submit">{canManage ? busy === "runtime" ? "Applying…" : runtime?.enabled ? "Disable gateway" : "Enable gateway" : "Read-only access"}</button>
      </form>
    </section>

    <section className="panel tooling-toolsets" aria-label="Runtime toolset admission">
      <div className="document-section-heading">
        <div>
          <p className="section-kicker">Runtime boundary</p>
          <h2>Toolset admission</h2>
        </div>
        <span>{admittedNames.size} of {toolsetRows.length} admitted</span>
      </div>
      <p className="chat-policy-note">
        The runtime executes these itself, so OrcaSynapse cannot inspect an individual call the way
        it does its own governed tools. Admitting one permits the runtime to enable it at all. A run
        is refused outright if the runtime has anything enabled that is not admitted here.
      </p>
      {drifted.length > 0 && (
        <div className="documents-alert" role="alert">
          <span>
            The runtime is running {drifted.length === 1 ? "a toolset" : "toolsets"} nobody admitted
            ({drifted.join(", ")}). Every run is being refused until this agrees.
          </span>
        </div>
      )}
      <label className="tooling-approval-reason">
        Decision reason
        <input
          value={admissionReason}
          minLength={3}
          maxLength={500}
          placeholder="Why this toolset is or is not permitted here"
          onChange={(event) => setAdmissionReason(event.target.value)}
        />
      </label>
      {toolsetRows.length === 0
        ? <p className="tooling-empty">The runtime has not reported a catalogue. Admissions can still be recorded once it does.</p>
        : <div className="tooling-toolset-list">
          {toolsetRows.map((row) => (
            <article key={row.name} className={row.enabled && !row.admitted ? "drifted" : undefined}>
              <div>
                <div className="tooling-tool-title">
                  <strong>{row.name}</strong>
                  <span className={row.admitted ? "document-status ready" : "document-status"}>
                    {row.admitted ? "admitted" : "not admitted"}
                  </span>
                  {row.enabled && (
                    <span className={row.admitted ? "document-status ready" : "document-status quarantined"}>
                      enabled on runtime
                    </span>
                  )}
                </div>
                <small>{row.toolCount} {row.toolCount === 1 ? "tool" : "tools"}{row.reason ? ` · ${row.reason}` : ""}</small>
              </div>
              <button
                type="button"
                className={row.admitted ? "danger-button" : "primary-button"}
                disabled={!canManage || busy !== null || admissionReason.trim().length < 3}
                onClick={() => void action(`toolset-${row.name}`, async () => {
                  await decideToolsetAdmission(row.name, !row.admitted, admissionReason.trim());
                })}
              >{row.admitted ? "Revoke" : "Admit"}</button>
            </article>
          ))}
        </div>}
    </section>

    <div className="tooling-metrics" aria-label="Governed tooling summary">
      <article><span>Active tools</span><strong>{metrics?.activeTools ?? tools.filter(({ status }) => status === "ACTIVE").length}</strong><small>OrcaSynapse handlers only</small></article>
      <article><span>Version grants</span><strong>{metrics?.activeGrants ?? grants.filter(({ enabled }) => enabled).length}</strong><small>exact profile revisions</small></article>
      <article><span>Active calls</span><strong>{metrics?.executingCalls ?? calls.filter(({ status }) => status === "EXECUTING").length}</strong><small>read-only execution</small></article>
    </div>

    <div className="tooling-grid">
      <section className="panel tooling-tools"><div className="document-section-heading"><div><p className="section-kicker">Allowlisted surface</p><h2>Tool registry</h2></div><span>{tools.length} built-in tools</span></div>
        <div className="tooling-tool-list">{tools.map((tool) => <article key={tool.id}><div className={`tooling-tool-mark ${tool.risk === "READ_ONLY" ? "read" : "action"}`}>{tool.risk === "READ_ONLY" ? "R" : "A"}</div><div><div className="tooling-tool-title"><strong>{tool.displayName}</strong><span className={`document-status ${tone(tool.status)}`}>{tool.status.toLowerCase()}</span></div><p>{tool.description}</p><small>{tool.slug} · {tool.risk === "READ_ONLY" ? "read-only" : "human approval required"}</small></div><button type="button" disabled={!canManage || busy !== null} onClick={() => void action(`tool-${tool.id}`, () => setGovernedToolStatus(tool.id, tool.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"))}>{canManage ? tool.status === "ACTIVE" ? "Suspend" : "Activate" : "View only"}</button></article>)}</div>
      </section>

      <section className="panel tooling-grants"><div className="document-section-heading"><div><p className="section-kicker">Least privilege</p><h2>Exact-version grants</h2></div><span>owner-only</span></div>
        <form className="tooling-grant-form" onSubmit={(event) => void saveGrant(event)}>
          <label>Agent revision<select disabled={!canManage} value={profileVersionId} onChange={(event) => setProfileVersionId(event.target.value)}>{profileVersions.map(({ profile, version, live }) => <option key={version.id} value={version.id}>{profile.slug} · v{version.version}{live ? " · live" : " · current draft"}</option>)}</select></label>
          <label>Tool<select disabled={!canManage} value={toolId} onChange={(event) => setToolId(event.target.value)}>{tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.displayName} · {tool.risk.toLowerCase().replace("_", " ")}</option>)}</select></label>
          <label>Exact enterprise groups<input disabled={!canManage} placeholder="OrcaSynapse-AI-Pilot, OrcaSynapse-Ops" value={groupClaims} onChange={(event) => setGroupClaims(event.target.value)} /><small>Comma-separated, exact case-sensitive claims.</small></label>
          <label>Administrator recovery role<select disabled={!canManage} value={adminRole} onChange={(event) => setAdminRole(event.target.value)}><option value="">None</option><option value="PLATFORM_ADMIN">Platform administrator</option><option value="SECURITY_ADMIN">Security administrator</option><option value="OPERATIONS_ADMIN">Operations administrator</option><option value="AUDITOR">Auditor</option></select></label>
          <button className="primary-button" disabled={!canManage || busy !== null || !profileVersionId || !toolId} type="submit">{canManage ? busy === "grant" ? "Saving…" : "Save version grant" : "Read-only access"}</button>
        </form>
        <div className="tooling-grant-list">{grants.length === 0 ? <div className="document-empty"><strong>No grants configured</strong><span>The global gateway cannot be enabled until at least one exact-version grant exists.</span></div> : grants.map((grant) => <article key={grant.id}><div><strong>{grant.profileSlug} · v{grant.profileVersion}</strong><span>{grant.toolName}</span></div><small>{grant.allowedGroups.length > 0 ? grant.allowedGroups.join(", ") : grant.allowedAdminRoles.join(", ")} · {grant.resourceScope.toLowerCase().replace("_", " ")}</small><span className={`document-status ${grant.enabled ? "ready" : "neutral"}`}>{grant.enabled ? "active" : "disabled"}</span></article>)}</div>
      </section>
    </div>

    <div className="tooling-grid credentials-row tooling-credentials-only">
      <section className="panel tooling-credentials"><div className="document-section-heading"><div><p className="section-kicker">Transport authentication</p><h2>Gateway credentials</h2></div><span>write-only</span></div>
        <form onSubmit={(event) => { event.preventDefault(); void action("credential", async () => { const issued = await issueGatewayCredential(credentialName.trim()); setIssuedCredential(issued); }, "Copy the new credential now; OrcaSynapse will not display it again."); }}><label>Client name<input disabled={!canManage} minLength={2} maxLength={120} value={credentialName} onChange={(event) => setCredentialName(event.target.value)} /></label><button className="primary-button" disabled={!canManage || busy !== null || credentialName.trim().length < 2} type="submit">{canManage ? busy === "credential" ? "Issuing…" : "Issue credential" : "Read-only access"}</button></form>
        {issuedCredential && <div className="tooling-secret"><div><strong>One-time credential</strong><span>Store this in the isolated Hermes MCP header configuration.</span></div><code>{issuedCredential.token}</code><button type="button" onClick={() => void navigator.clipboard.writeText(issuedCredential.token)}>Copy</button></div>}
        <div className="tooling-credential-list">{credentials.map((credential) => <article key={credential.id}><div><strong>{credential.name}</strong><code>{credential.tokenPrefix}…</code></div><span>Last used {when(credential.lastUsedAt)}</span><span className={`document-status ${credential.enabled ? "ready" : "neutral"}`}>{credential.enabled ? "active" : "revoked"}</span>{credential.enabled && <button type="button" disabled={!canManage || busy !== null} onClick={() => void action(`credential-${credential.id}`, () => revokeGatewayCredential(credential.id))}>{canManage ? "Revoke" : "View only"}</button>}</article>)}</div>
      </section>

    </div>

    <section className="panel tooling-ledger"><div className="document-section-heading"><div><p className="section-kicker">Revalidated activity</p><h2>Tool-call ledger</h2></div><span>{calls.length} calls</span></div>
      {approvals.length > 0 && (
        <section className="panel tooling-approvals" aria-label="Tool calls awaiting approval">
          <div className="document-section-heading">
            <div>
              <p className="section-kicker">Waiting on you</p>
              <h2>{approvals.length} consequential {approvals.length === 1 ? "call" : "calls"} awaiting a decision</h2>
            </div>
          </div>
          <p className="chat-policy-note">
            An agent is blocked until you decide. Approving authorises this call only — it cannot
            reach data the requester could not already reach, and it does not grant the tool again.
          </p>
          <label className="tooling-approval-reason">
            Decision reason
            <input
              value={approvalReason}
              minLength={3}
              maxLength={1000}
              placeholder="Why this call is or is not authorized"
              onChange={(event) => setApprovalReason(event.target.value)}
            />
          </label>
          {approvals.map((approval) => (
            <article className="tooling-approval" key={approval.id}>
              <div>
                <strong>{approval.toolName}</strong>
                <small>{approval.profileSlug} · requested by {approval.requestedBySubject}</small>
                <small>Expires {when(approval.expiresAt)}</small>
                <code>{JSON.stringify(approval.arguments)}</code>
              </div>
              <div className="tooling-approval-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canManage || busy !== null || approvalReason.trim().length < 3}
                  onClick={() => void action(`approve-${approval.id}`, async () => {
                    await decideToolApproval(approval.id, "APPROVE", approvalReason.trim());
                  })}
                >Approve</button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={!canManage || busy !== null || approvalReason.trim().length < 3}
                  onClick={() => void action(`reject-${approval.id}`, async () => {
                    await decideToolApproval(approval.id, "REJECT", approvalReason.trim());
                  })}
                >Reject</button>
              </div>
            </article>
          ))}
        </section>
      )}

      <div className="tooling-call-table"><div className="tooling-call-head"><span>Status</span><span>Tool</span><span>Agent</span><span>Requested</span><span>Outcome</span></div>{calls.length === 0 ? <div className="document-empty"><strong>No calls recorded</strong><span>The gateway remains staged until a live Hermes configuration carries an approved per-run capability.</span></div> : calls.map((call) => <article key={call.id}><span className={`document-status ${tone(call.status)}`}>{call.status.toLowerCase().replace("_", " ")}</span><strong>{call.toolName}</strong><span>{call.profileSlug} · v{call.profileVersion}</span><span>{when(call.requestedAt)}</span><span>{call.errorMessage ?? (call.result ? "Result retained" : "Awaiting outcome")}</span></article>)}</div>
    </section>

    <div className="tooling-stage-note"><strong>Hermes remains zero-tool by default</strong><p>Only installed read-only OrcaSynapse handlers can be granted. Consequential actions remain denied until an independently reviewed execution and approval subsystem is delivered.</p></div>
  </section>;
}

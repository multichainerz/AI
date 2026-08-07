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
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, PanelHeading, Select, StatusText, cn, toneFor,
} from "./ui/index.js";

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

  return <div className="grid gap-5">
    <PageHeader
      kicker="Controlled integration plane"
      title="Governed tools"
      description="OrcaSynapse-owned, read-only MCP access with two-factor gateway authentication, exact-version grants, and owner-only resources."
      actions={<Button onClick={() => void load()}>Refresh</Button>}
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}

    <Panel className={cn(
      "grid gap-4 border-l-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end",
      runtime?.enabled ? "border-l-good" : "border-l-border-strong",
    )}>
      <div className="flex items-start gap-4">
        {/* Fail-closed is the default and the word says so. OFF here means
            every call is denied, not that the feature is idle. */}
        <span className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded border font-mono text-[11px] font-bold",
          runtime?.enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
        )}>
          {runtime?.enabled ? "ON" : "OFF"}
        </span>
        <div className="min-w-0">
          <MicroLabel className="block">Global MCP gateway</MicroLabel>
          <strong className="mt-1.5 block text-[12px] font-semibold text-text">
            {runtime?.enabled ? "Governed calls are permitted" : "Every tool call is denied fail-closed"}
          </strong>
          <p className="mb-0 mt-1 text-body text-muted">{runtime?.reason ?? "Runtime state is loading."}</p>
        </div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2.5"
        onSubmit={(event) => { event.preventDefault(); void action("runtime", () => updateToolRuntime({ enabled: !runtime?.enabled, reason: runtimeReason, approvalTtlMinutes: runtime?.approvalTtlMinutes ?? 15 })); }}
      >
        <Field label="Operator reason" className="min-w-[220px] flex-1">
          <Input disabled={!canManage} minLength={3} maxLength={500} value={runtimeReason} onChange={(event) => setRuntimeReason(event.target.value)} />
        </Field>
        <Button
          variant={runtime?.enabled ? "danger" : "primary"}
          disabled={!canManage || busy !== null || runtimeReason.trim().length < 3}
          type="submit"
        >
          {canManage ? busy === "runtime" ? "Applying…" : runtime?.enabled ? "Disable gateway" : "Enable gateway" : "Read-only access"}
        </Button>
      </form>
    </Panel>

    <Panel aria-label="Runtime toolset admission">
      <PanelHeading
        kicker="Runtime boundary"
        title="Toolset admission"
        actions={<StatusText tone={admittedNames.size > 0 ? "good" : "neutral"}>{admittedNames.size} of {toolsetRows.length} admitted</StatusText>}
      />
      <p className="mb-3 mt-0 rounded border border-border bg-raised px-3 py-2.5 text-body leading-relaxed text-muted">
        The runtime executes these itself, so OrcaSynapse cannot inspect an individual call the way
        it does its own governed tools. Admitting one permits the runtime to enable it at all. A run
        is refused outright if the runtime has anything enabled that is not admitted here.
      </p>
      {drifted.length > 0 && (
        <Alert className="mb-3">
          The runtime is running {drifted.length === 1 ? "a toolset" : "toolsets"} nobody admitted
          ({drifted.join(", ")}). Every run is being refused until this agrees.
        </Alert>
      )}
      <Field className="mb-3 max-w-[520px]" label="Decision reason">
        <Input
          value={admissionReason}
          minLength={3}
          maxLength={500}
          placeholder="Why this toolset is or is not permitted here"
          onChange={(event) => setAdmissionReason(event.target.value)}
        />
      </Field>
      {toolsetRows.length === 0
        ? <EmptyState title="No catalogue reported">The runtime has not reported a catalogue. Admissions can still be recorded once it does.</EmptyState>
        : <div className="grid gap-2">
          {toolsetRows.map((row) => (
            /* Drift is the alarm state: the runtime is running something
               nobody admitted, so every run is refused until it agrees. */
            <article
              key={row.name}
              className={cn(
                "flex items-center justify-between gap-4 rounded border p-3",
                row.enabled && !row.admitted ? "border-bad/50 bg-bad/10" : "border-border bg-raised",
              )}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="font-mono text-[12px] font-semibold text-text">{row.name}</strong>
                  <StatusText dot tone={row.admitted ? "good" : "neutral"}>
                    {row.admitted ? "admitted" : "not admitted"}
                  </StatusText>
                  {row.enabled && (
                    <StatusText dot tone={row.admitted ? "good" : "bad"}>enabled on runtime</StatusText>
                  )}
                </div>
                <small className="mt-1 block text-caption text-muted">
                  {row.toolCount} {row.toolCount === 1 ? "tool" : "tools"}{row.reason ? ` · ${row.reason}` : ""}
                </small>
              </div>
              <Button
                size="sm"
                variant={row.admitted ? "danger" : "primary"}
                disabled={!canManage || busy !== null || admissionReason.trim().length < 3}
                onClick={() => void action(`toolset-${row.name}`, async () => {
                  await decideToolsetAdmission(row.name, !row.admitted, admissionReason.trim());
                })}
              >{row.admitted ? "Revoke" : "Admit"}</Button>
            </article>
          ))}
        </div>}
    </Panel>

    <MetricRow className="lg:grid-cols-3" aria-label="Governed tooling summary">
      <Metric label="Active tools" value={metrics?.activeTools ?? tools.filter(({ status }) => status === "ACTIVE").length} caption="OrcaSynapse handlers only" />
      <Metric label="Version grants" value={metrics?.activeGrants ?? grants.filter(({ enabled }) => enabled).length} caption="exact profile revisions" />
      <Metric label="Active calls" tone="accent" value={metrics?.executingCalls ?? calls.filter(({ status }) => status === "EXECUTING").length} caption="read-only execution" />
    </MetricRow>

    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeading kicker="Allowlisted surface" title="Tool registry" actions={<StatusText>{tools.length} built-in tools</StatusText>} />
        <div className="grid gap-2">{tools.map((tool) => <article
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded border border-border bg-raised p-3"
          key={tool.id}
        >
          {/* R or A: whether a call can only read, or needs a human. That is
              the whole risk model, so it leads the row. */}
          <span className={cn(
            "grid h-8 w-8 place-items-center rounded border font-mono text-micro font-bold",
            tool.risk === "READ_ONLY" ? "border-good/50 bg-good/10 text-good" : "border-warn/50 bg-warn/10 text-warn",
          )}>
            {tool.risk === "READ_ONLY" ? "R" : "A"}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <strong className="truncate text-[12px] font-semibold text-text">{tool.displayName}</strong>
              <StatusText dot tone={toneFor(tone(tool.status))}>{tool.status.toLowerCase()}</StatusText>
            </div>
            <p className="mb-0 mt-0.5 text-caption leading-relaxed text-muted">{tool.description}</p>
            <small className="mt-1 block font-mono text-micro text-faint">
              {tool.slug} · {tool.risk === "READ_ONLY" ? "read-only" : "human approval required"}
            </small>
          </div>
          <Button
            size="sm"
            variant={tool.status === "ACTIVE" ? "danger" : "secondary"}
            disabled={!canManage || busy !== null}
            onClick={() => void action(`tool-${tool.id}`, () => setGovernedToolStatus(tool.id, tool.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"))}
          >
            {canManage ? tool.status === "ACTIVE" ? "Suspend" : "Activate" : "View only"}
          </Button>
        </article>)}</div>
      </Panel>

      <Panel>
        <PanelHeading kicker="Least privilege" title="Exact-version grants" actions={<StatusText>owner-only</StatusText>} />
        <form className="mb-4 grid gap-3 sm:grid-cols-2" onSubmit={(event) => void saveGrant(event)}>
          <Field label="Agent revision">
            <Select disabled={!canManage} value={profileVersionId} onChange={(event) => setProfileVersionId(event.target.value)}>
              {profileVersions.map(({ profile, version, live }) => (
                <option key={version.id} value={version.id}>{profile.slug} · v{version.version}{live ? " · live" : " · current draft"}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tool">
            <Select disabled={!canManage} value={toolId} onChange={(event) => setToolId(event.target.value)}>
              {tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.displayName} · {tool.risk.toLowerCase().replace("_", " ")}</option>)}
            </Select>
          </Field>
          <Field label="Exact enterprise groups" className="sm:col-span-2" hint="Comma-separated, exact case-sensitive claims.">
            <Input disabled={!canManage} placeholder="OrcaSynapse-AI-Pilot, OrcaSynapse-Ops" value={groupClaims} onChange={(event) => setGroupClaims(event.target.value)} />
          </Field>
          <Field label="Administrator recovery role" className="sm:col-span-2">
            <Select disabled={!canManage} value={adminRole} onChange={(event) => setAdminRole(event.target.value)}>
              <option value="">None</option>
              <option value="PLATFORM_ADMIN">Platform administrator</option>
              <option value="SECURITY_ADMIN">Security administrator</option>
              <option value="OPERATIONS_ADMIN">Operations administrator</option>
              <option value="AUDITOR">Auditor</option>
            </Select>
          </Field>
          <Button variant="primary" className="justify-self-end sm:col-span-2" disabled={!canManage || busy !== null || !profileVersionId || !toolId} type="submit">
            {canManage ? busy === "grant" ? "Saving…" : "Save version grant" : "Read-only access"}
          </Button>
        </form>
        <div className="grid gap-2">{grants.length === 0
          ? <EmptyState title="No grants configured">The global gateway cannot be enabled until at least one exact-version grant exists.</EmptyState>
          : grants.map((grant) => <article
              className="flex items-center justify-between gap-3 rounded border border-border bg-raised p-2.5"
              key={grant.id}
            >
              <div className="min-w-0">
                <strong className="block truncate font-mono text-caption font-semibold text-text">
                  {grant.profileSlug} · v{grant.profileVersion} → {grant.toolName}
                </strong>
                <small className="mt-1 block truncate text-micro text-faint">
                  {grant.allowedGroups.length > 0 ? grant.allowedGroups.join(", ") : grant.allowedAdminRoles.join(", ")} · {grant.resourceScope.toLowerCase().replace("_", " ")}
                </small>
              </div>
              <StatusText dot tone={grant.enabled ? "good" : "neutral"}>{grant.enabled ? "active" : "disabled"}</StatusText>
            </article>)}</div>
      </Panel>
    </div>

    <Panel>
      <PanelHeading kicker="Transport authentication" title="Gateway credentials" actions={<StatusText>write-only</StatusText>} />
      <form
        className="mb-3 flex flex-wrap items-end gap-2.5"
        onSubmit={(event) => { event.preventDefault(); void action("credential", async () => { const issued = await issueGatewayCredential(credentialName.trim()); setIssuedCredential(issued); }, "Copy the new credential now; OrcaSynapse will not display it again."); }}
      >
        <Field label="Client name" className="min-w-[220px] flex-1">
          <Input disabled={!canManage} minLength={2} maxLength={120} value={credentialName} onChange={(event) => setCredentialName(event.target.value)} />
        </Field>
        <Button variant="primary" disabled={!canManage || busy !== null || credentialName.trim().length < 2} type="submit">
          {canManage ? busy === "credential" ? "Issuing…" : "Issue credential" : "Read-only access"}
        </Button>
      </form>
      {/* Shown exactly once and never again, so it is warn-toned rather than
          celebratory: navigating away loses it. */}
      {issuedCredential && <div className="mb-3 grid gap-2 rounded border border-warn/50 bg-warn/10 p-3">
        <div>
          <strong className="block text-[12px] font-semibold text-warn">One-time credential</strong>
          <span className="mt-1 block text-body text-muted">Store this in the isolated Hermes MCP header configuration.</span>
        </div>
        <code className="break-all rounded border border-border bg-bg px-2.5 py-2 font-mono text-caption text-text">
          {issuedCredential.token}
        </code>
        <Button className="justify-self-end" onClick={() => void navigator.clipboard.writeText(issuedCredential.token)}>Copy</Button>
      </div>}
      <div className="grid gap-2">{credentials.map((credential) => <article
        className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-raised p-2.5"
        key={credential.id}
      >
        <div className="min-w-0">
          <strong className="block truncate text-[12px] font-semibold text-text">{credential.name}</strong>
          <code className="mt-0.5 block font-mono text-micro text-faint">{credential.tokenPrefix}…</code>
        </div>
        <StatusText>Last used {when(credential.lastUsedAt)}</StatusText>
        <StatusText dot tone={credential.enabled ? "good" : "neutral"}>{credential.enabled ? "active" : "revoked"}</StatusText>
        {credential.enabled && <Button
          size="sm"
          variant="danger"
          disabled={!canManage || busy !== null}
          onClick={() => void action(`credential-${credential.id}`, () => revokeGatewayCredential(credential.id))}
        >
          {canManage ? "Revoke" : "View only"}
        </Button>}
      </article>)}</div>
    </Panel>

    {approvals.length > 0 && (
      /* Someone is waiting. This is warn-toned and sits above the ledger
         because an agent is blocked until a person decides. */
      <Panel className="border-l-2 border-l-warn" aria-label="Tool calls awaiting approval">
        <PanelHeading
          kicker="Waiting on you"
          title={`${approvals.length} consequential ${approvals.length === 1 ? "call" : "calls"} awaiting a decision`}
          description="An agent is blocked until you decide. Approving authorises this call only — it cannot reach data the requester could not already reach, and it does not grant the tool again."
        />
        <Field className="mb-3 max-w-[520px]" label="Decision reason">
          <Input
            value={approvalReason}
            minLength={3}
            maxLength={1000}
            placeholder="Why this call is or is not authorized"
            onChange={(event) => setApprovalReason(event.target.value)}
          />
        </Field>
        <div className="grid gap-2">{approvals.map((approval) => (
          <article className="flex flex-wrap items-center justify-between gap-4 rounded border border-warn/40 bg-warn/10 p-3" key={approval.id}>
            <div className="min-w-0">
              <strong className="block text-[12px] font-semibold text-text">{approval.toolName}</strong>
              <small className="mt-1 block text-caption text-muted">
                {approval.profileSlug} · requested by {approval.requestedBySubject}
              </small>
              <small className="mt-0.5 block text-micro text-faint">Expires {when(approval.expiresAt)}</small>
              {/* The arguments verbatim: this is the decision, and a summary
                  of it would be the operator approving something else. */}
              <code className="mt-1.5 block break-all rounded border border-border bg-bg px-2 py-1.5 font-mono text-micro text-muted">
                {JSON.stringify(approval.arguments)}
              </code>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="primary"
                disabled={!canManage || busy !== null || approvalReason.trim().length < 3}
                onClick={() => void action(`approve-${approval.id}`, async () => {
                  await decideToolApproval(approval.id, "APPROVE", approvalReason.trim());
                })}
              >Approve</Button>
              <Button
                variant="danger"
                disabled={!canManage || busy !== null || approvalReason.trim().length < 3}
                onClick={() => void action(`reject-${approval.id}`, async () => {
                  await decideToolApproval(approval.id, "REJECT", approvalReason.trim());
                })}
              >Reject</Button>
            </div>
          </article>
        ))}</div>
      </Panel>
    )}

    <Panel>
      <PanelHeading kicker="Revalidated activity" title="Tool-call ledger" actions={<StatusText>{calls.length} calls</StatusText>} />
      <div className="overflow-x-auto rounded border border-border">
        <div className="grid min-w-[720px] grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_120px_minmax(0,1.2fr)] gap-3 border-b border-border bg-raised px-3 py-2">
          {["Status", "Tool", "Agent", "Requested", "Outcome"].map((head) => (
            <span className="font-mono text-micro uppercase text-faint" key={head}>{head}</span>
          ))}
        </div>
        {calls.length === 0
          ? <EmptyState className="m-3 border-0" title="No calls recorded">
              The gateway remains staged until a live Hermes configuration carries an approved per-run capability.
            </EmptyState>
          : calls.map((call) => <article
              className="grid min-w-[720px] grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_120px_minmax(0,1.2fr)] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              key={call.id}
            >
              <StatusText dot tone={toneFor(tone(call.status))}>{call.status.toLowerCase().replace("_", " ")}</StatusText>
              <strong className="truncate font-mono text-caption font-medium text-text">{call.toolName}</strong>
              <span className="truncate font-mono text-caption text-muted">{call.profileSlug} · v{call.profileVersion}</span>
              <span className="truncate font-mono text-micro text-faint">{when(call.requestedAt)}</span>
              <span className="truncate text-caption text-muted">
                {call.errorMessage ?? (call.result ? "Result retained" : "Awaiting outcome")}
              </span>
            </article>)}
      </div>
    </Panel>

    {/* The honest boundary, kept where an operator configuring grants will
        read it: the plane is deliberately narrower than it looks. */}
    <Panel className="border-l-2 border-l-accent">
      <strong className="block text-[12px] font-semibold text-text">Hermes remains zero-tool by default</strong>
      <p className="mb-0 mt-1 text-body leading-relaxed text-muted">
        Only installed read-only OrcaSynapse handlers can be granted. Consequential actions remain denied until an
        independently reviewed execution and approval subsystem is delivered.
      </p>
    </Panel>
  </div>;
}

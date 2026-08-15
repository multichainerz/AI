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
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  PageHeader, Panel, PanelHeading, Select, StatusText, Tile, cn, toneFor,
} from "./ui/index.js";

interface ToolingViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

/**
 * The one native toolset that is permitted whether or not anybody admits it.
 *
 * `HermesClient.assertAdmittedToolBoundaryFor` adds this to the permitted set
 * unconditionally, which is invariant 7's "except built-in memory". Two things
 * follow, and the screen got both wrong before: an enabled `memory` toolset is
 * never drift, and an Admit/Revoke button on it would be a control that cannot
 * change the outcome.
 */
const BASELINE_TOOLSET = "memory";

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

function plural(count: number, singular: string, plural_ = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural_}`;
}

/**
 * One prerequisite of enabling the MCP gateway, drawn where the button is.
 *
 * The API refuses `PATCH /runtime {enabled:true}` for four separate reasons and
 * the screen used to name one of them, in an empty state at the foot of a
 * different card. An operator pressing a live-looking button and receiving a
 * 409 is being told the same thing far too late.
 */
function Prerequisite({ met, label, detail }: { met: boolean; label: string; detail: ReactNode }) {
  const Icon = met ? Check : X;
  return (
    <Tile as="article" pad="sm" className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border",
          met ? "border-good/50 bg-good/10 text-good" : "border-bad/50 bg-bad/10 text-bad",
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
      <div className="min-w-0">
        <strong className="block text-label font-semibold text-text">{label}</strong>
        <small className="mt-0.5 block text-caption leading-relaxed text-muted">{detail}</small>
      </div>
    </Tile>
  );
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
  const [catalogueRead, setCatalogueRead] = useState(true);
  const [admissionReason, setAdmissionReason] = useState("");
  const [pendingToolset, setPendingToolset] = useState("");
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
   *
   * The memory baseline is deliberately not in here. It is drawn as its own
   * fixed row with no decision attached, because a decision on it is one the
   * boundary would ignore.
   */
  const toolsetRows = useMemo(() => {
    const reasons = new Map(admissions.map((entry) => [entry.toolsetName, entry.reason]));
    const rows = (catalogue?.toolsets ?? []).map((toolset) => ({
      name: toolset.name,
      label: toolset.label,
      toolCount: toolset.toolCount,
      enabled: toolset.enabled,
      reported: true,
      admitted: admittedNames.has(toolset.name),
      reason: reasons.get(toolset.name) ?? null,
    }));
    const known = new Set(rows.map(({ name }) => name));
    for (const entry of admissions) {
      if (known.has(entry.toolsetName)) continue;
      rows.push({
        name: entry.toolsetName,
        label: null,
        toolCount: 0,
        enabled: false,
        reported: false,
        admitted: entry.admitted,
        reason: entry.reason,
      });
    }
    return rows
      .filter(({ name }) => name !== BASELINE_TOOLSET)
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [catalogue, admissions, admittedNames]);

  const baseline = useMemo(
    () => catalogue?.toolsets.find(({ name }) => name === BASELINE_TOOLSET) ?? null,
    [catalogue],
  );

  // What the boundary is currently refusing runs over. `memory` cannot appear
  // here: it is filtered out of the rows above for exactly this reason.
  const drifted = useMemo(
    () => toolsetRows.filter((row) => row.enabled && !row.admitted).map(({ name }) => name),
    [toolsetRows],
  );

  const admittedCount = useMemo(
    () => toolsetRows.filter(({ admitted }) => admitted).length,
    [toolsetRows],
  );

  const activeTools = useMemo(() => tools.filter(({ status }) => status === "ACTIVE"), [tools]);

  /*
   * The API counts a grant only when its tool is also ACTIVE, so counting
   * enabled grants alone would promise a prerequisite that is not met.
   */
  const activeGrants = useMemo(
    () => grants.filter((grant) => grant.enabled && tools.some(({ id, status }) => id === grant.toolId && status === "ACTIVE")),
    [grants, tools],
  );
  const activeCredentials = useMemo(
    () => credentials.filter(({ enabled, revokedAt }) => enabled && !revokedAt),
    [credentials],
  );

  /** The four things `updateRuntimeControl` checks before it will open the gateway. */
  const prerequisites = useMemo(() => [
    {
      met: activeTools.length > 0,
      label: "A governed tool is installed",
      detail: activeTools.length > 0
        ? `${plural(activeTools.length, "active tool")} in the registry.`
        : "No governed tool is installed. Tools arrive with an OrcaSynapse release; this console cannot add one.",
    },
    {
      met: activeGrants.length > 0,
      label: "An exact agent revision is granted a tool",
      detail: activeGrants.length > 0
        ? `${plural(activeGrants.length, "active grant")} across agent revisions.`
        : "No agent revision is granted a tool, so no run could reach one.",
    },
    {
      met: activeCredentials.length > 0,
      label: "A gateway credential is active",
      detail: activeCredentials.length > 0
        ? `${plural(activeCredentials.length, "active credential")}.`
        : "No gateway credential has been issued, so Hermes cannot authenticate to the gateway.",
    },
    {
      met: catalogueRead && drifted.length === 0,
      label: "The runtime agrees with the admitted toolsets",
      detail: !catalogueRead
        ? "OrcaSynapse could not read the runtime's toolsets, so it cannot verify the boundary this check depends on."
        : drifted.length > 0
          ? `Hermes has ${plural(drifted.length, "enabled toolset")} nobody admitted: ${drifted.join(", ")}.`
          : "Hermes reports nothing enabled that this installation has not admitted.",
    },
  ], [activeTools, activeGrants, activeCredentials, catalogueRead, drifted]);

  const unmet = prerequisites.filter(({ met }) => !met).length;

  /**
   * The answer to "what can my agents do right now?", stated rather than left
   * to be inferred from five counters.
   */
  const capability = useMemo((): { tone: "good" | "warn" | "bad"; headline: string; detail: string } => {
    if (drifted.length > 0) {
      return {
        tone: "bad",
        headline: "Every chat turn and agent run is refused.",
        detail: `The runtime has ${plural(drifted.length, "toolset")} enabled that this installation never admitted (${drifted.join(", ")}). Admit them below, or have the runtime disable them. Nothing runs until the two agree.`,
      };
    }
    const mcp = activeTools.length === 0
      ? "No OrcaSynapse-executed MCP tool is installed, so nothing routes through the gateway."
      : runtime?.enabled
        ? `The MCP gateway is open over ${plural(activeTools.length, "governed tool")}.`
        : "The MCP gateway is closed, so every governed tool call is denied.";
    if (!catalogueRead) {
      return {
        tone: "warn",
        headline: "OrcaSynapse cannot read what the runtime can do.",
        detail: `Hermes did not answer the toolset query, so this screen cannot confirm which native toolsets are enabled and neither plane can be enabled. ${mcp}`,
      };
    }
    return {
      tone: admittedCount > 0 ? "warn" : "good",
      headline: admittedCount > 0
        ? `Agents run with built-in memory and ${plural(admittedCount, "admitted toolset")}.`
        : "Agents run with built-in memory only.",
      detail: `Admitted toolsets are executed by the runtime, so OrcaSynapse records that a tool ran but never inspects the call. ${mcp}`,
    };
  }, [drifted, catalogueRead, admittedCount, activeTools, runtime]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the governed-tool operation.");
  };

  const load = async () => {
    const [toolList, grantList, profileList, credentialList, callList, control, nextMetrics, approvalList, admissionList, runtimeCatalogue] = await Promise.all([
      getGovernedTools(), getToolGrants(), getAgentProfiles(true), getGatewayCredentials(), getToolCalls(), getToolRuntime(), getToolMetrics(),
      getPendingToolApprovals(), getToolsetAdmissions(),
      // The runtime may be unreachable; its catalogue is informative, not
      // load-bearing, so a failure must not blank the whole page. It is still
      // reported: "unread" and "read, and empty" are different governance
      // states, and conflating them hid an unreachable runtime behind a
      // reassuring empty list.
      getRuntimeCatalogue().catch(() => null),
    ]);
    setTools(toolList.items); setGrants(grantList.items); setProfiles(profileList.items); setCredentials(credentialList.items);
    setCalls(callList.items); setRuntime(control); setMetrics(nextMetrics);
    setApprovals(approvalList.items);
    setAdmissions(admissionList.items);
    setCatalogue(runtimeCatalogue); setCatalogueRead(runtimeCatalogue !== null);
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

  const recordAdmission = async (event: FormEvent) => {
    event.preventDefault();
    const name = pendingToolset.trim();
    const reason = admissionReason.trim();
    if (name.length < 1 || reason.length < 3) return;
    await action(`toolset-${name}`, async () => {
      await decideToolsetAdmission(name, true, reason);
      setPendingToolset("");
    }, `${name} is admitted. The runtime still decides whether to enable it.`);
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Agent tooling governance"
      title="Agent Tools"
      mark="TG"
      headline="Scoped administrator required"
      reason="Unlock the console to admit or refuse the toolsets the Hermes runtime executes, and to govern the MCP tools OrcaSynapse executes itself."
      actionLabel="Administrator setup"
      onAction={onConfigure}
    />;
  }

  return <div className="grid gap-5">
    <PageHeader
      kicker="Agent tooling governance"
      title="Agent Tools"
      description="Two planes decide what an agent can do. The Hermes runtime executes its own toolsets, so OrcaSynapse can only admit or refuse a whole toolset. OrcaSynapse executes its own MCP tools, so it inspects, scopes and records every one of those calls."
      actions={<Button onClick={() => void load()}>Refresh</Button>}
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}

    {/* What can my agents do right now — stated, then counted. The five figures
        used to float in the page with no container and no relationship to the
        panels above and below them. */}
    <Panel
      aria-label="Agent tooling summary"
      className={cn(
        "grid gap-4 border-l-2",
        capability.tone === "bad" ? "border-l-bad" : capability.tone === "warn" ? "border-l-warn" : "border-l-good",
      )}
    >
      <div className="min-w-0">
        <MicroLabel className="block">Current capability</MicroLabel>
        <strong className={cn(
          "mt-1.5 block text-label font-semibold",
          capability.tone === "bad" ? "text-bad" : capability.tone === "warn" ? "text-warn" : "text-text",
        )}>
          {capability.headline}
        </strong>
        <p className="mb-0 mt-1 max-w-[86ch] text-body leading-relaxed text-muted">{capability.detail}</p>
      </div>
      <MetricRow className="border-b-0 pb-0 lg:grid-cols-5">
        <Metric
          label="Admitted toolsets"
          value={admittedCount}
          tone={admittedCount > 0 ? "warn" : undefined}
          caption="runtime-executed"
        />
        <Metric
          label="Runtime drift"
          value={drifted.length}
          tone={drifted.length > 0 ? "bad" : "good"}
          caption="enabled, never admitted"
        />
        <Metric label="Governed MCP tools" value={metrics?.activeTools ?? activeTools.length} caption="OrcaSynapse-executed" />
        <Metric label="Version grants" value={metrics?.activeGrants ?? activeGrants.length} caption="exact agent revisions" />
        <Metric
          label="Awaiting approval"
          value={metrics?.pendingApprovals ?? approvals.length}
          tone={(metrics?.pendingApprovals ?? approvals.length) > 0 ? "warn" : undefined}
          caption="consequential calls"
        />
      </MetricRow>
    </Panel>

    {approvals.length > 0 && (
      /* Belongs to the MCP plane below, and is drawn here anyway: an agent is
         blocked and the decision expires. An interrupt outranks the taxonomy. */
      <Panel className="border-l-2 border-l-warn" aria-label="Tool calls awaiting approval">
        <PanelHeading
          kicker="Waiting on you · MCP plane"
          title={`${approvals.length} consequential ${approvals.length === 1 ? "call" : "calls"} awaiting a decision`}
          description="An agent is blocked until you decide. Approving authorises this call only — it cannot reach data the requester could not already reach, and it does not grant the tool again."
          actions={runtime ? <StatusText>expires after {plural(runtime.approvalTtlMinutes, "minute")}</StatusText> : undefined}
        />
        <Field className="mb-3 max-w-[520px]" label="Why this call is authorised or refused">
          <Input
            value={approvalReason}
            minLength={3}
            maxLength={1000}
            placeholder="Reviewed with the data owner"
            onChange={(event) => setApprovalReason(event.target.value)}
          />
        </Field>
        <div className="grid gap-2">{approvals.map((approval) => (
          <article className="flex flex-wrap items-center justify-between gap-4 rounded border border-warn/40 bg-warn/10 p-3" key={approval.id}>
            <div className="min-w-0">
              <strong className="block text-label font-semibold text-text">{approval.toolName}</strong>
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

    {/*
      * Plane one: the runtime's own toolsets.
      *
      * This is the plane that is actually live, which is why it now leads the
      * page. The gateway used to, and it governs a plane with nothing in it.
      */}
    <Panel aria-label="Hermes-native toolsets">
      <PanelHeading
        kicker="Plane 1 · executed by the runtime"
        title="Hermes-native toolsets"
        description="The runtime executes these itself, so OrcaSynapse never sees an individual call and cannot scope one. Admission is the whole lever: a toolset nobody admitted must never be enabled on the runtime, and a run submitted while one is refuses outright. Admitting does not switch anything on — the runtime's managed policy still decides that."
        actions={<StatusText tone={admittedCount > 0 ? "good" : "neutral"}>
          {admittedCount} of {toolsetRows.length} admitted
        </StatusText>}
      />

      {drifted.length > 0 && (
        <Alert className="mb-3">
          Every chat turn and agent run is refused: the runtime has {plural(drifted.length, "toolset")} enabled
          that nobody admitted ({drifted.join(", ")}). This is not confined to this screen — Chat and Agent
          Runtime are refused by the same check.
        </Alert>
      )}
      {!catalogueRead && (
        <Alert tone="warn" className="mb-3">
          OrcaSynapse could not read the runtime's toolsets. Anything below is this installation's own record of
          past decisions, not what Hermes is running now. Check the Hermes connection under Settings.
        </Alert>
      )}

      {/* The baseline, stated. "0 of 0 admitted" alone reads as "my agents can
          do nothing", which is the opposite of what invariant 7 says. */}
      <Tile as="article" className="mb-3 flex flex-wrap items-center justify-between gap-3 border-border-strong">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong className="font-mono text-label font-semibold text-text">{BASELINE_TOOLSET}</strong>
            <StatusText tone="accent">baseline</StatusText>
            {baseline?.enabled && <StatusText dot tone="good">enabled on runtime</StatusText>}
          </div>
          <small className="mt-1 block text-caption leading-relaxed text-muted">
            Built-in memory is permitted on every run and cannot be admitted or revoked here. It writes only
            Hermes-owned MEMORY.md and USER.md; OrcaSynapse neither receives nor mirrors that content.
          </small>
        </div>
      </Tile>

      <Field className="mb-3 max-w-[520px]" label="Why this toolset is admitted or refused">
        <Input
          value={admissionReason}
          minLength={3}
          maxLength={500}
          placeholder="Reviewed with the data owner"
          onChange={(event) => setAdmissionReason(event.target.value)}
        />
      </Field>

      {toolsetRows.length === 0
        ? <EmptyState title={catalogueRead ? "The runtime reports no other toolsets" : "No toolsets read from the runtime"}>
            {catalogueRead
              ? "Beyond built-in memory, Hermes has nothing to admit. Record a decision by name below if you want it in place before the runtime offers one."
              : "Hermes did not answer, so nothing can be listed. Record a decision by name below to have it in place for when it does."}
          </EmptyState>
        : <div className="grid gap-2">
          {toolsetRows.map((row) => (
            /* Drift is the alarm state: the runtime is running something
               nobody admitted, so every run is refused until it agrees. */
            <article
              key={row.name}
              className={cn(
                "flex flex-wrap items-center justify-between gap-4 rounded border p-3",
                row.enabled && !row.admitted ? "border-bad/50 bg-bad/10" : "border-border bg-raised",
              )}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="font-mono text-label font-semibold text-text">{row.name}</strong>
                  <StatusText dot tone={row.admitted ? "good" : "neutral"}>
                    {row.admitted ? "admitted" : "not admitted"}
                  </StatusText>
                  {row.enabled && (
                    <StatusText dot tone={row.admitted ? "good" : "bad"}>enabled on runtime</StatusText>
                  )}
                  {!row.reported && <StatusText tone="neutral">not reported by the runtime</StatusText>}
                </div>
                <small className="mt-1 block text-caption text-muted">
                  {row.reported ? `${plural(row.toolCount, "tool")}` : "decision on record only"}
                  {row.reason ? ` · ${row.reason}` : ""}
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

      {/* The API accepts a decision on any name; without this the screen could
          only ever decide about toolsets an already-reachable runtime had
          already reported, which is precisely the case that needs no staging. */}
      {canManage && (
        <form className="mt-3 flex flex-wrap items-end gap-2.5 border-t border-border pt-3" onSubmit={(event) => void recordAdmission(event)}>
          <Field label="Toolset name" className="min-w-[220px] flex-1">
            <Input
              value={pendingToolset}
              maxLength={120}
              placeholder="clarify"
              onChange={(event) => setPendingToolset(event.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            type="submit"
            disabled={busy !== null || pendingToolset.trim().length < 1 || admissionReason.trim().length < 3}
          >
            {busy === `toolset-${pendingToolset.trim()}` ? "Recording…" : "Record admission"}
          </Button>
          {/* Below the row rather than as the field's hint: a hint inside the
              Field grows it, and `items-end` then drops the button a line. */}
          <p className="mb-0 basis-full text-caption leading-relaxed text-muted">
            Records a decision for a toolset the runtime has not reported yet. Exact name, as Hermes spells it.
            Admitting does not enable it — the runtime still has to.
          </p>
        </form>
      )}
    </Panel>

    {/*
      * Plane two: the tools OrcaSynapse executes.
      *
      * The gateway switch, its four prerequisites and the plane's own
      * explanation are one block, because the question "why can I not press
      * this" was answerable only by scrolling to the foot of another card.
      */}
    <Panel
      aria-label="OrcaSynapse MCP gateway"
      className={cn("border-l-2", runtime?.enabled ? "border-l-good" : "border-l-border-strong")}
    >
      <PanelHeading
        kicker="Plane 2 · executed by OrcaSynapse"
        title="MCP gateway"
        description="OrcaSynapse executes these itself over its own MCP server, so every call is authenticated, matched against an exact-version grant, scoped to the requester's own resources, recorded, and — when the tool is consequential — held for a human decision."
        actions={<StatusText dot tone={runtime?.enabled ? "good" : "neutral"}>
          {runtime?.enabled ? "open" : "closed"}
        </StatusText>}
      />

      <div className="mb-4 flex items-start gap-4">
        {/* Fail-closed is the default and the word says so. OFF here means
            every call is denied, not that the feature is idle. */}
        <span className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded border font-mono text-caption font-bold",
          runtime?.enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
        )}>
          {runtime?.enabled ? "ON" : "OFF"}
        </span>
        <div className="min-w-0">
          <strong className="block text-label font-semibold text-text">
            {runtime?.enabled ? "Governed calls are permitted" : "Every tool call is denied fail-closed"}
          </strong>
          <p className="mb-0 mt-1 text-body text-muted">{runtime?.reason ?? "Runtime state is loading."}</p>
        </div>
      </div>

      <MicroLabel className="mb-2 block">Before this gateway can be opened</MicroLabel>
      <div className="grid gap-2 sm:grid-cols-2">
        {prerequisites.map((item) => <Prerequisite key={item.label} {...item} />)}
      </div>

      <form
        className="mt-4 flex flex-wrap items-end gap-2.5 border-t border-border pt-4"
        onSubmit={(event) => { event.preventDefault(); void action("runtime", () => updateToolRuntime({ enabled: !runtime?.enabled, reason: runtimeReason, approvalTtlMinutes: runtime?.approvalTtlMinutes ?? 15 })); }}
      >
        <Field label="Why you are changing the gateway" className="min-w-[240px] flex-1">
          <Input disabled={!canManage} minLength={3} maxLength={500} value={runtimeReason} onChange={(event) => setRuntimeReason(event.target.value)} />
        </Field>
        <Button
          variant={runtime?.enabled ? "danger" : "primary"}
          /* Closing is always allowed — it is the fail-closed direction. Only
             opening is gated, and it is gated here rather than by a 409 from
             the API after the operator has already pressed it. */
          disabled={!canManage || busy !== null || runtimeReason.trim().length < 3 || (!runtime?.enabled && unmet > 0)}
          type="submit"
        >
          {canManage ? busy === "runtime" ? "Applying…" : runtime?.enabled ? "Disable gateway" : "Enable gateway" : "Read-only access"}
        </Button>
        {!runtime?.enabled && unmet > 0 && (
          <p className="mb-0 basis-full text-caption text-muted">
            {`Enable is blocked by ${unmet === 1 ? "1 unmet check" : `${unmet} unmet checks`} above.`}
          </p>
        )}
      </form>
    </Panel>

    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel aria-label="Tool registry">
        <PanelHeading
          kicker="Prerequisite 1"
          title="Tool registry"
          actions={<StatusText>{plural(tools.length, "tool")}</StatusText>}
        />
        {tools.length === 0
          ? <EmptyState title="No governed tool is installed">
              Governed tools are OrcaSynapse's own MCP handlers: the units a grant points at and the gateway
              exposes. They arrive with an OrcaSynapse release — the console has no route to add, upload or
              write one — so until a release ships them, this plane can record decisions but cannot execute
              anything.
            </EmptyState>
          : <div className="grid gap-2">{tools.map((tool) => <Tile as="article" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3" key={tool.id}>
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
                <strong className="truncate text-label font-semibold text-text">{tool.displayName}</strong>
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
          </Tile>)}</div>}
      </Panel>

      <Panel aria-label="Gateway credentials">
        <PanelHeading
          kicker="Prerequisite 3"
          title="Gateway credentials"
          description="The bearer token Hermes presents to OrcaSynapse's MCP server. Shown once, never again."
          actions={<StatusText tone={activeCredentials.length > 0 ? "good" : "neutral"}>
            {plural(activeCredentials.length, "active")}
          </StatusText>}
        />
        <form
          className="mb-3 flex flex-wrap items-end gap-2.5"
          onSubmit={(event) => { event.preventDefault(); void action("credential", async () => { const issued = await issueGatewayCredential(credentialName.trim()); setIssuedCredential(issued); }, "Copy the new credential now; OrcaSynapse will not display it again."); }}
        >
          <Field label="Client name" className="min-w-[200px] flex-1">
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
            <strong className="block text-label font-semibold text-warn">One-time credential</strong>
            <span className="mt-1 block text-body text-muted">Store this in the isolated Hermes MCP header configuration.</span>
          </div>
          <code className="break-all rounded border border-border bg-bg px-2.5 py-2 font-mono text-caption text-text">
            {issuedCredential.token}
          </code>
          <Button className="justify-self-end" onClick={() => void navigator.clipboard.writeText(issuedCredential.token)}>Copy</Button>
        </div>}
        {credentials.length === 0
          ? <EmptyState title="No credential issued">
              Hermes cannot authenticate to the gateway until one exists, so the gateway cannot be opened.
            </EmptyState>
          : <div className="grid gap-2">{credentials.map((credential) => <Tile as="article" pad="sm" className="flex flex-wrap items-center justify-between gap-3" key={credential.id}>
            <div className="min-w-0">
              <strong className="block truncate text-label font-semibold text-text">{credential.name}</strong>
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
          </Tile>)}</div>}
      </Panel>
    </div>

    {/* Full width, with the form beside its own output. As a column next to the
        empty registry it was the tallest thing on the page facing the
        shortest. */}
    <Panel aria-label="Exact-version grants">
      <PanelHeading
        kicker="Prerequisite 2 · least privilege"
        title="Exact-version grants"
        description="A grant binds one tool to one exact agent revision and one set of identity claims. Editing an agent creates a new revision, which carries no grants — that is the point."
        actions={<StatusText tone={activeGrants.length > 0 ? "good" : "neutral"}>owner-only · {plural(activeGrants.length, "active")}</StatusText>}
      />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void saveGrant(event)}>
          {(tools.length === 0 || profileVersions.length === 0) && (
            <p className="mb-0 rounded border border-border bg-raised px-3 py-2.5 text-caption leading-relaxed text-muted sm:col-span-2">
              {tools.length === 0
                ? "A grant points at a governed tool, and none is installed, so nothing can be granted yet."
                : "A grant points at an exact agent revision, and no agent profile exists yet. Create one under Agents."}
            </p>
          )}
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
        <div className="grid content-start gap-2">{grants.length === 0
          ? <EmptyState title="No grants configured">
              Without one the gateway cannot be opened, and a run that reached a tool would be refused for
              lack of a grant.
            </EmptyState>
          : grants.map((grant) => <Tile as="article" pad="sm" className="flex items-center justify-between gap-3" key={grant.id}>
              <div className="min-w-0">
                <strong className="block truncate font-mono text-caption font-semibold text-text">
                  {grant.profileSlug} · v{grant.profileVersion} → {grant.toolName}
                </strong>
                <small className="mt-1 block truncate text-micro text-faint">
                  {grant.allowedGroups.length > 0 ? grant.allowedGroups.join(", ") : grant.allowedAdminRoles.join(", ")} · {grant.resourceScope.toLowerCase().replace("_", " ")}
                </small>
              </div>
              <StatusText dot tone={grant.enabled ? "good" : "neutral"}>{grant.enabled ? "active" : "disabled"}</StatusText>
            </Tile>)}</div>
      </div>
    </Panel>

    {/* `min-w-0` is load-bearing: without it this Panel takes an automatic
        minimum size from the 720px table below and overflows its grid track,
        which scrolls the entire screen sideways rather than just the table. */}
    <Panel aria-label="Tool-call ledger" className="min-w-0">
      <PanelHeading
        kicker="Plane 2 evidence"
        title="Tool-call ledger"
        description="Only the MCP plane appears here. A native toolset call happens inside the runtime, so OrcaSynapse has no row to write for it."
        actions={<StatusText>
          {plural(metrics?.completedCalls ?? 0, "completed")} · {metrics?.deniedCalls ?? 0} denied · {metrics?.failedCalls ?? 0} failed
        </StatusText>}
      />
      <div className="overflow-x-auto rounded border border-border">
        <div className="grid min-w-[720px] grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_120px_minmax(0,1.2fr)] gap-3 border-b border-border bg-raised px-3 py-2">
          {["Status", "Tool", "Agent", "Requested", "Outcome"].map((head) => (
            <span className="text-micro font-semibold uppercase tabular-nums text-faint" key={head}>{head}</span>
          ))}
        </div>
        {calls.length === 0
          ? <EmptyState className="m-3 border-0" title="No calls recorded">
              Nothing has been executed through the gateway. With no tool installed and the gateway closed,
              that is the expected state rather than a sign of a quiet week.
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
  </div>;
}

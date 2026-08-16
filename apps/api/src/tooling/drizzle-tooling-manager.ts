import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  CreateScopedMemory,
  DecideToolsetAdmission,
  GatewayCredential,
  ScopedMemoryEntry,
  GovernedTool,
  ToolApproval,
  ToolCall,
  ToolGrant,
  ToolMetrics,
  ToolRuntimeControl,
  ScopedMemoryList,
  ToolsetAdmission,
  ToolStatus,
  UpdateToolRuntimeControl,
  UpsertToolGrant,
} from "@orcasynapse/contracts";
import {
  administratorSession,
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentToolGrant,
  auditEvent,
  enterpriseUser,
  enterpriseUserSession,
  governedTool,
  governedToolCall,
  mcpGatewayCredential,
  division,
  runtimeToolsetAdmission,
  scopedMemoryEntry,
  toolApproval,
  toolRuntimeControl,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  ToolingConflictError,
  ToolingDeniedError,
  ToolingNotFoundError,
  type GovernedToolInvocation,
  type GovernedToolResult,
  type ToolingManager,
  type ToolingPrincipal,
  type ToolBoundaryVerifier,
} from "./tooling-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GATEWAY_TOKEN = /^orcasynapse_mcp_([A-Za-z0-9_-]{43})$/;
const RUN_AUTHORIZATION = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;
/** How often a waiting consequential call re-checks for a human decision. */
const APPROVAL_POLL_MS = 1_000;

/**
 * The longest a tool call will hold its caller open waiting for a human.
 *
 * approvalTtlMinutes may be set as high as 1440, which is a sensible lifetime
 * for the decision but an absurd one for an HTTP request. Hitting this cap ends
 * the wait and nothing else: the approval keeps the deadline the administrator
 * configured and stays in the queue, because it is the request that ran out of
 * patience and not the decision that ran out of time. Expiring the row here
 * instead is what left `approvalTtlMinutes` with no observable effect anywhere
 * in its 5-1440 range.
 */
const MAXIMUM_INLINE_WAIT_MS = 5 * 60_000;

/** The database handle or a transaction opened from it. */
type Executor = OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0];

function digest(value: string): Uint8Array<ArrayBuffer> {
  const source = createHash("sha256").update(value, "utf8").digest();
  const result = new Uint8Array(source.length);
  result.set(source);
  return result;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolDto(tool: {
  id: string; slug: string; displayName: string; description: string; risk: GovernedTool["risk"];
  status: GovernedTool["status"]; handlerKey: string; inputSchema: unknown; createdAt: Date; updatedAt: Date;
}): GovernedTool {
  return {
    ...tool,
    inputSchema: jsonObject(tool.inputSchema),
    createdAt: tool.createdAt.toISOString(),
    updatedAt: tool.updatedAt.toISOString(),
  };
}

/**
 * The joined grant row. Prisma nested the profile and tool inside the grant;
 * a join flattens them, so the DTO reads the columns directly.
 */
interface GrantRow {
  id: string; profileVersionId: string; toolId: string; enabled: boolean; allowedGroups: string[];
  allowedAdminRoles: ToolGrant["allowedAdminRoles"]; resourceScope: ToolGrant["resourceScope"];
  createdAt: Date; updatedAt: Date;
  profileId: string; profileSlug: string; profileVersion: number;
  toolSlug: string; toolName: string;
}

function grantDto(grant: GrantRow): ToolGrant {
  return {
    id: grant.id,
    profileId: grant.profileId,
    profileSlug: grant.profileSlug,
    profileVersionId: grant.profileVersionId,
    profileVersion: grant.profileVersion,
    toolId: grant.toolId,
    toolSlug: grant.toolSlug,
    toolName: grant.toolName,
    enabled: grant.enabled,
    allowedGroups: grant.allowedGroups,
    allowedAdminRoles: grant.allowedAdminRoles,
    resourceScope: grant.resourceScope,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

function credentialDto(credential: {
  id: string; name: string; tokenPrefix: string; enabled: boolean; lastUsedAt: Date | null;
  revokedAt: Date | null; createdAt: Date;
}): GatewayCredential {
  return {
    ...credential,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    createdAt: credential.createdAt.toISOString(),
  };
}

/** The joined call row, flattened from Prisma's run/profile/tool includes. */
interface CallRow {
  id: string; runId: string; requestId: string; status: ToolCall["status"]; arguments: unknown; result: unknown;
  errorCode: string | null; errorMessage: string | null; requestedAt: Date; startedAt: Date | null;
  completedAt: Date | null; createdAt: Date; updatedAt: Date;
  profileVersion: number; profileSlug: string;
  toolSlug: string; toolName: string; risk: ToolCall["risk"];
}

function callDto(call: CallRow): ToolCall {
  return {
    id: call.id,
    runId: call.runId,
    profileSlug: call.profileSlug,
    profileVersion: call.profileVersion,
    toolSlug: call.toolSlug,
    toolName: call.toolName,
    risk: call.risk,
    status: call.status,
    requestId: call.requestId,
    arguments: jsonObject(call.arguments),
    result: call.result === null ? null : jsonObject(call.result),
    errorCode: call.errorCode,
    errorMessage: call.errorMessage,
    requestedAt: call.requestedAt.toISOString(),
    startedAt: call.startedAt?.toISOString() ?? null,
    completedAt: call.completedAt?.toISOString() ?? null,
    createdAt: call.createdAt.toISOString(),
    updatedAt: call.updatedAt.toISOString(),
  };
}

const grantColumns = {
  id: agentToolGrant.id,
  profileVersionId: agentToolGrant.profileVersionId,
  toolId: agentToolGrant.toolId,
  enabled: agentToolGrant.enabled,
  allowedGroups: agentToolGrant.allowedGroups,
  allowedAdminRoles: agentToolGrant.allowedAdminRoles,
  resourceScope: agentToolGrant.resourceScope,
  createdAt: agentToolGrant.createdAt,
  updatedAt: agentToolGrant.updatedAt,
  profileId: agentProfile.id,
  profileSlug: agentProfile.slug,
  profileVersion: agentProfileVersion.version,
  toolSlug: governedTool.slug,
  toolName: governedTool.displayName,
};

const callColumns = {
  id: governedToolCall.id,
  runId: governedToolCall.runId,
  requestId: governedToolCall.requestId,
  status: governedToolCall.status,
  arguments: governedToolCall.arguments,
  result: governedToolCall.result,
  errorCode: governedToolCall.errorCode,
  errorMessage: governedToolCall.errorMessage,
  requestedAt: governedToolCall.requestedAt,
  startedAt: governedToolCall.startedAt,
  completedAt: governedToolCall.completedAt,
  createdAt: governedToolCall.createdAt,
  updatedAt: governedToolCall.updatedAt,
  profileVersion: agentRun.profileVersion,
  profileSlug: agentProfile.slug,
  toolSlug: governedTool.slug,
  toolName: governedTool.displayName,
  risk: governedTool.risk,
};

/**
 * How the wait for a human ended, and what the approval may still become.
 *
 * UNDECIDED is the outcome the code used to lack, and lacking it is what made
 * `approvalTtlMinutes` inert: the request giving up and the approval running out
 * were reported as one thing and written to the row as EXPIRED.
 */
type ApprovalWait =
  | { outcome: "APPROVED" | "REJECTED" | "EXPIRED" }
  | { outcome: "UNDECIDED"; decidableUntil: Date };

/**
 * Timings a deployment may need to differ on, and tests certainly do.
 *
 * The wait cap is a property of how long the deployment's proxies will hold a
 * request open rather than of governance, so it is a setting rather than a
 * constant -- and a suite that had to spend five real minutes to reach the
 * give-up path would simply never test it.
 */
export interface ToolingManagerOptions {
  maximumInlineWaitMs?: number;
  approvalPollMs?: number;
}

export class DrizzleToolingManager implements ToolingManager {
  private readonly maximumInlineWaitMs: number;
  private readonly approvalPollMs: number;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly boundaryVerifier?: ToolBoundaryVerifier,
    options: ToolingManagerOptions = {},
  ) {
    this.maximumInlineWaitMs = options.maximumInlineWaitMs ?? MAXIMUM_INLINE_WAIT_MS;
    this.approvalPollMs = options.approvalPollMs ?? APPROVAL_POLL_MS;
  }

  async listTools() {
    const items = await this.database
      .select()
      .from(governedTool)
      .orderBy(asc(governedTool.risk), asc(governedTool.displayName));
    return { items: items.map(toolDto) };
  }

  async listToolsForRun(authorization: string | undefined) {
    const { run } = await this.authorizedRun(authorization, "discovery");

    const items: GovernedTool[] = [];
    for (const grant of await this.enabledGrantsForVersion(run.profileVersionId)) {
      if (
        grant.tool.status === "ACTIVE" &&
        await this.requesterMatchesGrant(run.requestedBy, grant.allowedGroups, grant.allowedAdminRoles)
      ) {
        items.push(toolDto(grant.tool));
      }
    }
    return { items };
  }

  async setToolStatus(principal: ToolingPrincipal, toolId: string, status: ToolStatus): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const changed = await transaction
        .update(governedTool)
        .set({ status })
        .where(eq(governedTool.id, toolId))
        .returning({ id: governedTool.id });
      if (changed.length !== 1) throw new ToolingNotFoundError();
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: status === "ACTIVE" ? "tool.activated" : "tool.suspended",
        resourceType: "GovernedTool", resourceId: toolId, outcome: "SUCCESS",
      });
    });
  }

  async listGrants() {
    const items = await this.grantQuery(this.database).orderBy(desc(agentToolGrant.updatedAt)).limit(300);
    return { items: items.map(grantDto) };
  }

  async upsertGrant(principal: ToolingPrincipal, input: UpsertToolGrant): Promise<ToolGrant> {
    const [version, tool] = await Promise.all([
      this.database
        .select({ id: agentProfileVersion.id })
        .from(agentProfileVersion)
        .where(eq(agentProfileVersion.id, input.profileVersionId))
        .limit(1),
      this.database
        .select({ id: governedTool.id })
        .from(governedTool)
        .where(eq(governedTool.id, input.toolId))
        .limit(1),
    ]);
    if (version.length === 0 || tool.length === 0) {
      throw new ToolingNotFoundError("The selected profile version or tool does not exist.");
    }
    const grantId = await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(agentToolGrant)
        .values({ ...input, createdBy: principal.id })
        .onConflictDoUpdate({
          target: [agentToolGrant.profileVersionId, agentToolGrant.toolId],
          set: {
            enabled: input.enabled,
            allowedGroups: input.allowedGroups,
            allowedAdminRoles: input.allowedAdminRoles,
            resourceScope: input.resourceScope,
            updatedAt: new Date(),
          },
        })
        .returning({ id: agentToolGrant.id });
      if (!saved) throw new ToolingConflictError("The tool grant could not be saved.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "tool.grant_upserted",
        resourceType: "AgentToolGrant", resourceId: saved.id, outcome: "SUCCESS",
        metadata: { profileVersionId: input.profileVersionId, toolId: input.toolId, enabled: input.enabled, resourceScope: input.resourceScope },
      });
      return saved.id;
    });
    const [grant] = await this.grantQuery(this.database).where(eq(agentToolGrant.id, grantId)).limit(1);
    if (!grant) throw new ToolingNotFoundError("The saved tool grant could not be read back.");
    return grantDto(grant);
  }

  async listCredentials() {
    const items = await this.database
      .select()
      .from(mcpGatewayCredential)
      .orderBy(desc(mcpGatewayCredential.createdAt))
      .limit(100);
    return { items: items.map(credentialDto) };
  }

  async issueCredential(principal: ToolingPrincipal, name: string) {
    const secret = randomBytes(32).toString("base64url");
    const token = `orcasynapse_mcp_${secret}`;
    const tokenPrefix = token.slice(0, 20);
    const credential = await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(mcpGatewayCredential)
        .values({ name, tokenPrefix, tokenHash: digest(token), createdBy: principal.id })
        .returning();
      if (!saved) throw new ToolingConflictError("The gateway credential could not be issued.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "mcp.gateway_credential_issued",
        resourceType: "McpGatewayCredential", resourceId: saved.id, outcome: "SUCCESS",
        metadata: { name, tokenPrefix },
      });
      return saved;
    });
    return { ...credentialDto(credential), token };
  }

  async revokeCredential(principal: ToolingPrincipal, credentialId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const changed = await transaction
        .update(mcpGatewayCredential)
        .set({ enabled: false, revokedAt: new Date() })
        .where(and(eq(mcpGatewayCredential.id, credentialId), isNull(mcpGatewayCredential.revokedAt)))
        .returning({ id: mcpGatewayCredential.id });
      if (changed.length !== 1) {
        throw new ToolingNotFoundError("The gateway credential is missing or already revoked.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "mcp.gateway_credential_revoked",
        resourceType: "McpGatewayCredential", resourceId: credentialId, outcome: "SUCCESS",
      });
    });
  }

  async authenticateGateway(token: string | undefined): Promise<boolean> {
    if (!token || !GATEWAY_TOKEN.test(token)) return false;
    const prefix = token.slice(0, 20);
    const [credential] = await this.database
      .select()
      .from(mcpGatewayCredential)
      .where(eq(mcpGatewayCredential.tokenPrefix, prefix))
      .limit(1);
    if (!credential?.enabled || credential.revokedAt) return false;
    const expected = Buffer.from(credential.tokenHash);
    const actual = Buffer.from(digest(token));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    await this.database
      .update(mcpGatewayCredential)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpGatewayCredential.id, credential.id));
    return true;
  }

  /**
   * What agents have remembered, for Agents → Memory.
   *
   * Reads the same table the `recall` tool reads. That is the whole reason the
   * store lives in VM1's database: the screen shows what the agent has, rather
   * than a mirror that could fall behind it, and there is no reconciliation
   * that could be wrong.
   *
   * Deliberately unscoped by division, because every caller is an administrator
   * and administrators are deployment-wide. The division is *labelled* on each
   * row rather than used to filter it -- an administrator asking "what has been
   * remembered" is asking about the whole deployment.
   */
  async listScopedMemory(limit = 200): Promise<ScopedMemoryList> {
    const [rows, [counted]] = await Promise.all([
      this.database
        .select({
          id: scopedMemoryEntry.id,
          content: scopedMemoryEntry.content,
          divisionId: scopedMemoryEntry.divisionId,
          divisionName: division.displayName,
          runId: scopedMemoryEntry.runId,
          createdAt: scopedMemoryEntry.createdAt,
        })
        .from(scopedMemoryEntry)
        .leftJoin(division, eq(division.id, scopedMemoryEntry.divisionId))
        .orderBy(desc(scopedMemoryEntry.createdAt))
        .limit(limit),
      this.database.select({ total: count() }).from(scopedMemoryEntry),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        content: row.content,
        divisionId: row.divisionId,
        divisionName: row.divisionName,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
      })),
      total: counted?.total ?? 0,
    };
  }

  /**
   * An entry an administrator writes for a division, or for the deployment.
   *
   * Written to the same table a run reads, deliberately: a curated note and a
   * remembered one are the same kind of thing to the run that reads them, and
   * two stores would be two places for the division scope to be got wrong.
   * `runId` stays null, which is the only thing distinguishing the two and what
   * the Memory screen reads to label them.
   *
   * No division check beyond the foreign key. An administrator is
   * deployment-wide by construction -- see the scope model in the divisions
   * plan -- so there is no narrower principal whose division this could exceed.
   */
  async createScopedMemory(
    principal: ToolingPrincipal,
    input: CreateScopedMemory,
  ): Promise<ScopedMemoryEntry> {
    return this.database.transaction(async (transaction) => {
      const [written] = await transaction
        .insert(scopedMemoryEntry)
        .values({ divisionId: input.divisionId, content: input.content, runId: null })
        .returning();
      if (!written) throw new ToolingConflictError("The memory entry could not be written.");
      const [named] = input.divisionId === null ? [] : await transaction
        .select({ displayName: division.displayName })
        .from(division).where(eq(division.id, input.divisionId)).limit(1);
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "memory.entry_curated",
        resourceType: "ScopedMemoryEntry", resourceId: written.id, outcome: "SUCCESS",
      });
      return {
        id: written.id,
        content: written.content,
        divisionId: written.divisionId,
        divisionName: named?.displayName ?? null,
        runId: null,
        createdAt: written.createdAt.toISOString(),
      };
    });
  }

  /**
   * Removes one entry.
   *
   * The gap this closes was total: `/scoped-memory` had `GET` and `POST` and
   * nothing else, so a note extraction got wrong -- a misread fact, something
   * that should never have been written down -- had no remedy short of SQL on
   * the control plane's database. Adding memory an agent reads without a way to
   * remove it is the wrong half of the feature to ship first.
   *
   * Hard delete rather than a tombstone. What makes a note dangerous is that a
   * run reads it, and a soft-deleted row invites exactly one future bug: a
   * filter forgotten in one of the two places that select from this table.
   */
  async deleteScopedMemory(principal: ToolingPrincipal, entryId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const removed = await transaction
        .delete(scopedMemoryEntry)
        .where(eq(scopedMemoryEntry.id, entryId))
        .returning({ id: scopedMemoryEntry.id, divisionId: scopedMemoryEntry.divisionId });
      if (removed.length !== 1) throw new ToolingNotFoundError("The memory entry is missing or already removed.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "memory.entry_removed",
        resourceType: "ScopedMemoryEntry", resourceId: entryId, outcome: "SUCCESS",
        metadata: { divisionId: removed[0]!.divisionId },
      });
    });
  }

  async invoke(toolSlug: string, invocation: GovernedToolInvocation): Promise<GovernedToolResult> {
    if (!UUID.test(invocation.requestId)) throw new ToolingDeniedError("Run authorization or request ID is invalid.");
    const [authorized, tool] = await Promise.all([
      this.authorizedRun(invocation.authorization, "execution"),
      this.database.select().from(governedTool).where(eq(governedTool.slug, toolSlug)).limit(1)
        .then(([found]) => found),
    ]);
    const { runId, run, control } = authorized;
    if (!tool || tool.status !== "ACTIVE") throw new ToolingDeniedError("The requested tool is not active.");
    // CONSEQUENTIAL tools are no longer refused outright; they request a human
    // decision. Everything below this point still applies to them — the grant,
    // the requester check, and idempotency — because an approval must never be
    // able to widen what the grant already allows.
    const grants = await this.enabledGrantsForVersion(run.profileVersionId);
    const grant = grants.find((item) => item.toolId === tool.id);
    if (!grant) throw new ToolingDeniedError("The active agent version does not grant this tool.");
    if (!(await this.requesterMatchesGrant(run.requestedBy, grant.allowedGroups, grant.allowedAdminRoles))) {
      throw new ToolingDeniedError("The requesting identity no longer satisfies the tool grant.");
    }
    const sanitizedArguments = jsonObject(invocation.arguments);
    const existing = await this.findExistingResult(runId, invocation.requestId, toolSlug, sanitizedArguments);
    /*
     * A call still waiting for its human is resumed, not replayed.
     *
     * This is the other half of letting a request give up while its approval
     * lives on: the approval is only decidable in a useful sense if presenting
     * the same request id again picks the decision up. Replaying the stored
     * APPROVAL_PENDING row instead would hand the agent a resultless answer
     * forever, and the human's decision would never reach the tool.
     */
    const waiting = existing?.status === "APPROVAL_PENDING" && tool.risk === "CONSEQUENTIAL";
    if (existing && !waiting) return existing;

    let callId: string;
    if (existing) {
      callId = existing.callId;
    } else {
      try {
        const [created] = await this.database
          .insert(governedToolCall)
          .values({
            runId, toolId: tool.id, grantId: grant.id, requestId: invocation.requestId,
            status: tool.risk === "CONSEQUENTIAL" ? "APPROVAL_PENDING" : "EXECUTING",
            arguments: sanitizedArguments,
            ...(tool.risk === "CONSEQUENTIAL" ? {} : { startedAt: new Date() }),
          })
          .returning({ id: governedToolCall.id });
        if (!created) throw new ToolingConflictError("The tool call could not be recorded.");
        callId = created.id;
      } catch (cause) {
        const raced = await this.findExistingResult(runId, invocation.requestId, toolSlug, sanitizedArguments);
        if (raced) return raced;
        throw cause;
      }
    }
    if (tool.risk === "CONSEQUENTIAL") {
      const wait = await this.awaitApproval(callId, control.approvalTtlMinutes ?? 15);
      /*
       * The request ran out of patience; the approval did not.
       *
       * Nothing is written to either row here. The call stays APPROVAL_PENDING
       * because that is what it is, the approval keeps the deadline the
       * administrator configured, and the message says which of the two clocks
       * expired -- because "expired" was previously said of an approval that
       * had fifty-five minutes left, which sent the administrator looking for a
       * decision the queue no longer offered them.
       */
      if (wait.outcome === "UNDECIDED") {
        const message = "No human decision was recorded while this request could wait. "
          + `The approval is still pending and can be decided until ${wait.decidableUntil.toISOString()}; `
          + "presenting the same request id again resumes the wait.";
        return {
          callId,
          status: "APPROVAL_PENDING",
          data: { message, decidableUntil: wait.decidableUntil.toISOString() },
          isError: true,
        };
      }
      if (wait.outcome !== "APPROVED") {
        const reason = wait.outcome === "REJECTED"
          ? "A human rejected this tool call."
          : "No human decision was recorded before the approval expired.";
        await this.failCall(callId, `TOOL_APPROVAL_${wait.outcome}`, reason);
        return { callId, status: "FAILED", data: { message: reason }, isError: true };
      }
      await this.database
        .update(governedToolCall)
        .set({ status: "EXECUTING", startedAt: new Date() })
        .where(eq(governedToolCall.id, callId));
    }

    try {
      /*
       * The scope is handed to the handler, never taken from the arguments.
       *
       * `run` came from the authorization, which `assertRunIsExecutable` has
       * already verified above. `sanitizedArguments` is whatever the agent
       * sent. Passing the first and not the second is the entire boundary.
       */
      const data = await this.executeHandler(tool.handlerKey, sanitizedArguments, {
        runId, divisionId: run.divisionId,
      });
      await this.completeCall(callId, data);
      return { callId, status: "COMPLETED", data, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Tool execution failed.";
      await this.failCall(callId, "TOOL_EXECUTION_FAILED", message);
      return { callId, status: "FAILED", data: { message }, isError: true };
    }
  }

  /**
   * The approval's own deadline, opening one if this call has none yet.
   *
   * `ToolApproval.callId` is unique, so a resumed call re-uses the row it
   * already has -- and, crucially, the deadline that row was opened with. A
   * second insert would otherwise hand the caller a fresh hour every time it
   * asked, which would make `approvalTtlMinutes` a per-request grace rather
   * than the lifetime of one decision.
   */
  private async openApproval(callId: string, ttlMinutes: number): Promise<Date> {
    const [opened] = await this.database
      .insert(toolApproval)
      .values({ callId, status: "PENDING", expiresAt: new Date(Date.now() + ttlMinutes * 60_000) })
      .onConflictDoNothing({ target: toolApproval.callId })
      .returning({ expiresAt: toolApproval.expiresAt });
    if (opened) return opened.expiresAt;
    const [existing] = await this.database
      .select({ expiresAt: toolApproval.expiresAt })
      .from(toolApproval)
      .where(eq(toolApproval.callId, callId))
      .limit(1);
    if (!existing) throw new ToolingConflictError("The approval for this tool call could not be opened.");
    return existing.expiresAt;
  }

  /** The recorded decision, or null while nobody has made one. */
  private async recordedDecision(callId: string): Promise<"APPROVED" | "REJECTED" | "EXPIRED" | null> {
    const [row] = await this.database
      .select({ status: toolApproval.status })
      .from(toolApproval)
      .where(eq(toolApproval.callId, callId))
      .limit(1);
    if (!row || row.status === "PENDING") return null;
    return row.status === "APPROVED" ? "APPROVED" : row.status === "REJECTED" ? "REJECTED" : "EXPIRED";
  }

  /**
   * Waits for a human, for as long as the request can afford to.
   *
   * MCP is request/response, so the decision has to happen while the caller
   * waits: there is no channel to hand an answer back to a call that already
   * returned. But the two clocks that bound this are not the same clock, and
   * conflating them is what made `approvalTtlMinutes` inert across its whole
   * 5-1440 range. The approval's lifetime is the administrator's setting; the
   * wait is capped at five minutes because no HTTP request survives an hour.
   * Hitting the cap used to write EXPIRED, so the approval left the queue and
   * `decideApproval` answered "already decided, or it expired" for every value
   * the setting could take -- including, at its 5-minute minimum, the value
   * where the two deadlines coincide and the bug was invisible.
   *
   * So the row is only expired when the row's own deadline has passed.
   * Otherwise the wait reports UNDECIDED and leaves the approval exactly as the
   * administrator will find it in the queue.
   *
   * This deliberately does not rest on `maxTurns = 1`. That value is a boundary
   * OrcaSynapse declares about its own profiles and never transmits: the run
   * submission carries no turn field, and Hermes exposes no turn control. What
   * actually keeps a run single-step is that no toolset is admitted, so
   * blocking here must hold on its own once one is.
   */
  private async awaitApproval(callId: string, ttlMinutes: number): Promise<ApprovalWait> {
    const expiresAt = await this.openApproval(callId, ttlMinutes);
    const giveUpAt = Math.min(expiresAt.getTime(), Date.now() + this.maximumInlineWaitMs);

    while (Date.now() < giveUpAt) {
      const decision = await this.recordedDecision(callId);
      if (decision) return { outcome: decision };
      await new Promise((resolve) => setTimeout(resolve, this.approvalPollMs));
    }

    /*
     * One last read before either answer, because a decision can land between
     * the final poll and here. Reporting the wrong thing regardless failed a
     * call a named human had already approved, leaving the trail holding
     * tool.call_approved SUCCESS beside a record asserting nobody decided.
     */
    const decision = await this.recordedDecision(callId);
    if (decision) return { outcome: decision };
    if (Date.now() < expiresAt.getTime()) return { outcome: "UNDECIDED", decidableUntil: expiresAt };

    // Expire it durably, so the record reflects why nothing ran. The row count
    // is the answer, not the clock: a decision landing inside this same window
    // matches the guard away, and then it is that decision that stands.
    const expired = await this.database
      .update(toolApproval)
      .set({ status: "EXPIRED", decidedAt: new Date() })
      .where(and(eq(toolApproval.callId, callId), eq(toolApproval.status, "PENDING")))
      .returning({ id: toolApproval.id });
    if (expired.length === 1) return { outcome: "EXPIRED" };
    return { outcome: await this.recordedDecision(callId) ?? "EXPIRED" };
  }

  /** Approvals still awaiting a human, newest first. */
  async listPendingApprovals(): Promise<{ items: ToolApproval[] }> {
    const rows = await this.database
      .select({
        approval: toolApproval,
        call: governedToolCall,
        toolSlug: governedTool.slug,
        toolName: governedTool.displayName,
        profileSlug: agentProfile.slug,
        requestedBy: agentRun.requestedBy,
        ownerSubject: agentRun.ownerSubject,
      })
      .from(toolApproval)
      .innerJoin(governedToolCall, eq(toolApproval.callId, governedToolCall.id))
      .innerJoin(governedTool, eq(governedToolCall.toolId, governedTool.id))
      .innerJoin(agentRun, eq(governedToolCall.runId, agentRun.id))
      .innerJoin(agentProfile, eq(agentRun.profileId, agentProfile.id))
      .where(and(eq(toolApproval.status, "PENDING"), gt(toolApproval.expiresAt, new Date())))
      .orderBy(desc(toolApproval.createdAt))
      .limit(100);

    return {
      items: rows.map(({ approval, call, toolSlug, toolName, profileSlug, ownerSubject }) => ({
        id: approval.id,
        callId: approval.callId,
        runId: call.runId,
        profileSlug,
        toolSlug,
        toolName,
        requestedBySubject: ownerSubject,
        arguments: call.arguments as Record<string, unknown>,
        status: approval.status,
        expiresAt: approval.expiresAt.toISOString(),
        decisionReason: approval.decisionReason,
        decisionBy: approval.decisionBy,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        createdAt: approval.createdAt.toISOString(),
        updatedAt: approval.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Records a human decision on a pending tool call.
   *
   * The update is conditional on the row still being PENDING and unexpired, so
   * two administrators racing cannot both decide, and a decision cannot be
   * applied to a call whose approval already lapsed.
   */
  async decideApproval(
    principal: ToolingPrincipal,
    approvalId: string,
    approve: boolean,
    reason: string,
  ): Promise<void> {
    const decided = await this.database
      .update(toolApproval)
      .set({
        status: approve ? "APPROVED" : "REJECTED",
        decisionReason: reason.slice(0, 1_000),
        decisionBy: principal.id,
        decidedAt: new Date(),
      })
      .where(and(
        eq(toolApproval.id, approvalId),
        eq(toolApproval.status, "PENDING"),
        gt(toolApproval.expiresAt, new Date()),
      ))
      .returning({ callId: toolApproval.callId });

    if (decided.length !== 1) {
      throw new ToolingConflictError("That approval was already decided, or it expired.");
    }

    await this.database.insert(auditEvent).values({
      actorType: "USER",
      actorId: principal.id,
      action: approve ? "tool.call_approved" : "tool.call_rejected",
      resourceType: "GovernedToolCall",
      resourceId: decided[0]!.callId,
      outcome: approve ? "SUCCESS" : "FAILURE",
      // The reason, never the arguments: those can carry the very data the
      // approval exists to protect.
      metadata: { reason: reason.slice(0, 500) },
    });
  }

  async recordDeniedInvocation(toolSlug: string, invocation: GovernedToolInvocation, reason: string): Promise<void> {
    const runId = RUN_AUTHORIZATION.exec(invocation.authorization)?.[1];
    await this.database.insert(auditEvent).values({
      actorType: "SERVICE", action: "tool.call_denied", resourceType: runId ? "AgentRun" : "McpGateway",
      ...(runId ? { resourceId: runId } : {}), outcome: "FAILURE",
      metadata: { toolSlug: toolSlug.slice(0, 80), requestId: invocation.requestId.slice(0, 36), reason: reason.slice(0, 500) },
    });
  }

  async listCalls() {
    const items = await this.callQuery(this.database).orderBy(desc(governedToolCall.createdAt)).limit(300);
    return { items: items.map(callDto) };
  }

  /**
   * Toolsets an operator has admitted, by name.
   *
   * Read on the run path, so it stays a single indexed lookup returning only
   * the names the boundary needs — never the whole admission history.
   */
  async admittedToolsetNames(): Promise<string[]> {
    const rows = await this.database
      .select({ toolsetName: runtimeToolsetAdmission.toolsetName })
      .from(runtimeToolsetAdmission)
      .where(eq(runtimeToolsetAdmission.admitted, true));
    return rows.map((row) => row.toolsetName);
  }

  async listToolsetAdmissions(): Promise<{ items: ToolsetAdmission[] }> {
    const rows = await this.database
      .select()
      .from(runtimeToolsetAdmission)
      .orderBy(asc(runtimeToolsetAdmission.toolsetName));
    return {
      items: rows.map((row) => ({
        toolsetName: row.toolsetName,
        admitted: row.admitted,
        reason: row.reason,
        admittedBy: row.admittedBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async decideToolsetAdmission(
    principal: ToolingPrincipal,
    toolsetName: string,
    input: DecideToolsetAdmission,
  ): Promise<ToolsetAdmission> {
    const row = await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(runtimeToolsetAdmission)
        .values({
          toolsetName,
          admitted: input.admitted,
          reason: input.reason,
          admittedBy: principal.id,
        })
        .onConflictDoUpdate({
          target: runtimeToolsetAdmission.toolsetName,
          set: {
            admitted: input.admitted,
            reason: input.reason,
            admittedBy: principal.id,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!saved) throw new ToolingConflictError("The toolset admission could not be recorded.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: input.admitted ? "tool.toolset_admitted" : "tool.toolset_revoked",
        resourceType: "RuntimeToolsetAdmission", resourceId: saved.id, outcome: "SUCCESS",
      });
      return saved;
    });
    return {
      toolsetName: row.toolsetName,
      admitted: row.admitted,
      reason: row.reason,
      admittedBy: row.admittedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getRuntimeControl(): Promise<ToolRuntimeControl> {
    const control = await this.runtimeControlRow();
    return {
      enabled: control?.enabled ?? false,
      reason: control?.reason ?? "Tool runtime control is missing; execution is denied fail-closed.",
      approvalTtlMinutes: control?.approvalTtlMinutes ?? 15,
      updatedAt: (control?.updatedAt ?? new Date(0)).toISOString(),
      updatedBy: control?.updatedBy ?? null,
    };
  }

  async updateRuntimeControl(principal: ToolingPrincipal, input: UpdateToolRuntimeControl): Promise<ToolRuntimeControl> {
    if (input.enabled) {
      const [credentialRows, grantRows] = await Promise.all([
        this.database
          .select({ total: count() })
          .from(mcpGatewayCredential)
          .where(and(eq(mcpGatewayCredential.enabled, true), isNull(mcpGatewayCredential.revokedAt))),
        this.database
          .select({ total: count() })
          .from(agentToolGrant)
          .innerJoin(governedTool, eq(agentToolGrant.toolId, governedTool.id))
          .where(and(eq(agentToolGrant.enabled, true), eq(governedTool.status, "ACTIVE"))),
      ]);
      const credentials = credentialRows[0]?.total ?? 0;
      const grants = grantRows[0]?.total ?? 0;
      if (credentials === 0 || grants === 0) {
        await this.database.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "tool.runtime_enable_denied",
          resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { activeGatewayCredentials: credentials, activeToolGrants: grants },
        });
        throw new ToolingConflictError("Issue an active gateway credential and configure at least one active tool grant before enabling the gateway.");
      }
      if (!this.boundaryVerifier) {
        throw new ToolingConflictError("Hermes governed-tool boundary verification is unavailable; the gateway remains disabled.");
      }
      try {
        await this.boundaryVerifier.assertAdmittedToolBoundary(await this.admittedToolsetNames());
      } catch {
        await this.database.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "tool.runtime_enable_denied",
          resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { activeGatewayCredentials: credentials, activeToolGrants: grants, failureCode: "HERMES_GOVERNED_BOUNDARY_FAILED" },
        });
        throw new ToolingConflictError("Hermes failed the private governed-tool handoff check; the gateway remains disabled.");
      }
    }
    const control = await this.database.transaction(async (transaction) => {
      const [saved] = await transaction
        .insert(toolRuntimeControl)
        .values({ id: "global", ...input, updatedBy: principal.id })
        .onConflictDoUpdate({
          target: toolRuntimeControl.id,
          set: { ...input, updatedBy: principal.id, updatedAt: new Date() },
        })
        .returning();
      if (!saved) throw new ToolingConflictError("The tool runtime control could not be written.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: input.enabled ? "tool.runtime_enabled" : "tool.runtime_disabled",
        resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "SUCCESS",
        metadata: { reason: input.reason, approvalTtlMinutes: input.approvalTtlMinutes },
      });
      return saved;
    });
    return { enabled: control.enabled, reason: control.reason, approvalTtlMinutes: control.approvalTtlMinutes, updatedAt: control.updatedAt.toISOString(), updatedBy: control.updatedBy };
  }

  async metrics(): Promise<ToolMetrics> {
    const callsByStatus = async (status: "EXECUTING" | "COMPLETED" | "DENIED" | "FAILED") =>
      this.database.select({ total: count() }).from(governedToolCall)
        .where(eq(governedToolCall.status, status))
        .then(([row]) => row?.total ?? 0);
    const [
      activeTools, activeGrants, pendingApprovals, executingCalls,
      completedCalls, deniedCalls, failedCalls,
    ] = await Promise.all([
      this.database.select({ total: count() }).from(governedTool)
        .where(eq(governedTool.status, "ACTIVE")).then(([row]) => row?.total ?? 0),
      this.database.select({ total: count() }).from(agentToolGrant)
        .where(eq(agentToolGrant.enabled, true)).then(([row]) => row?.total ?? 0),
      this.database.select({ total: count() }).from(toolApproval)
        .where(and(eq(toolApproval.status, "PENDING"), gt(toolApproval.expiresAt, new Date())))
        .then(([row]) => row?.total ?? 0),
      callsByStatus("EXECUTING"),
      callsByStatus("COMPLETED"),
      callsByStatus("DENIED"),
      callsByStatus("FAILED"),
    ]);
    return {
      generatedAt: new Date().toISOString(), activeTools, activeGrants, pendingApprovals,
      executingCalls,
      completedCalls, deniedCalls, failedCalls,
    };
  }

  private grantQuery(executor: Executor) {
    return executor
      .select(grantColumns)
      .from(agentToolGrant)
      .innerJoin(agentProfileVersion, eq(agentToolGrant.profileVersionId, agentProfileVersion.id))
      .innerJoin(agentProfile, eq(agentProfileVersion.profileId, agentProfile.id))
      .innerJoin(governedTool, eq(agentToolGrant.toolId, governedTool.id))
      .$dynamic();
  }

  private callQuery(executor: Executor) {
    return executor
      .select(callColumns)
      .from(governedToolCall)
      .innerJoin(agentRun, eq(governedToolCall.runId, agentRun.id))
      .innerJoin(agentProfile, eq(agentRun.profileId, agentProfile.id))
      .innerJoin(governedTool, eq(governedToolCall.toolId, governedTool.id))
      .$dynamic();
  }

  private async runtimeControlRow() {
    const [control] = await this.database
      .select()
      .from(toolRuntimeControl)
      .where(eq(toolRuntimeControl.id, "global"))
      .limit(1);
    return control;
  }

  /** The run joined to the profile fields every tooling gate re-checks. */
  private async runForTooling(runId: string) {
    const [run] = await this.database
      .select({
        id: agentRun.id,
        status: agentRun.status,
        profileVersion: agentRun.profileVersion,
        profileVersionId: agentRun.profileVersionId,
        ownerSubject: agentRun.ownerSubject,
        requestedBy: agentRun.requestedBy,
        toolCapabilityTokenHash: agentRun.toolCapabilityTokenHash,
        toolCapabilityExpiresAt: agentRun.toolCapabilityExpiresAt,
        profileStatus: agentProfile.status,
        profileActiveVersion: agentProfile.activeVersion,
        // The division the run belongs to. Read from the profile the run is
        // pinned to, never from anything the caller sent -- see `runScope`.
        divisionId: agentProfile.divisionId,
      })
      .from(agentRun)
      .innerJoin(agentProfile, eq(agentRun.profileId, agentProfile.id))
      .where(eq(agentRun.id, runId))
      .limit(1);
    return run;
  }

  /**
   * The division a tool call is acting for, derived from its authorization.
   *
   * This is the scope injection increment F is built on, and the reason its
   * rule -- *the tool filters, the prompt never does* -- is enforceable rather
   * than aspirational.
   *
   * Nothing about the division comes from the caller. The MCP authorization
   * carries a run id and a capability derived from the bootstrap key and that
   * run id, whose digest alone is stored; an agent can neither forge one nor
   * obtain another run's. The run resolves to the profile it is pinned to, and
   * the profile carries the division. So a tool that scopes its reads by this
   * value cannot be argued, prompted or injected into scoping them by another:
   * there is no parameter to override and no token in the prompt to leak.
   *
   * A null division means the run belongs to a deployment-wide profile. That is
   * a real scope, not an absent one, and a caller reading this must treat it as
   * its own bucket rather than as "no filter" -- the difference between the two
   * is every division's rows.
   */
  async runScope(authorization: string | undefined): Promise<{ runId: string; divisionId: string | null }> {
    const { runId, run } = await this.authorizedRun(authorization, "execution");
    return { runId, divisionId: run.divisionId };
  }

  /**
   * The run an authorization names, once every gate that governs it has passed.
   *
   * One implementation, three callers: discovery, execution, and `runScope`.
   * They had three copies of the same six lines, and the copies had already
   * begun to differ -- `invoke` read the control row and the run in parallel
   * while `runScope` read them one after the other -- which meant the seven
   * tests covering `runScope`'s guarantee were covering a chain the shipping
   * invocation path re-implemented separately. A guarantee this load-bearing
   * gets written once and tested once.
   *
   * The gate is the same for all three intents on purpose: a run that may not
   * call a tool may not discover one, and may not have a scope resolved for it
   * either. Only the wording of the refusal differs, which is what `intent`
   * carries.
   */
  private async authorizedRun(authorization: string | undefined, intent: "discovery" | "execution") {
    const parsed = authorization ? RUN_AUTHORIZATION.exec(authorization) : null;
    const runId = parsed?.[1];
    const capability = parsed?.[2];
    if (!runId || !capability) {
      throw new ToolingDeniedError(
        intent === "discovery"
          ? "Private run authorization is required for tool discovery."
          : "Private run authorization is required.",
      );
    }
    const [control, run] = await Promise.all([this.runtimeControlRow(), this.runForTooling(runId)]);
    if (!control?.enabled) throw new ToolingDeniedError(control?.reason ?? "The tool gateway is disabled fail-closed.");
    this.assertRunIsExecutable(run, capability, intent);
    return { runId, run: run!, control };
  }

  private assertRunIsExecutable(
    run: Awaited<ReturnType<DrizzleToolingManager["runForTooling"]>>,
    capability: string,
    intent: "discovery" | "execution",
  ): void {
    if (!run || run.status !== "RUNNING" || !run.toolCapabilityTokenHash || !run.toolCapabilityExpiresAt || run.toolCapabilityExpiresAt <= new Date()) {
      throw new ToolingDeniedError(`The agent run is not eligible for tool ${intent} or its capability has expired.`);
    }
    const expected = Buffer.from(run.toolCapabilityTokenHash);
    const actual = Buffer.from(digest(capability));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ToolingDeniedError("The run capability is invalid.");
    }
    if (run.profileStatus !== "ACTIVE" || run.profileActiveVersion !== run.profileVersion) {
      throw new ToolingDeniedError("The agent profile or version is no longer active.");
    }
  }

  private async enabledGrantsForVersion(profileVersionId: string) {
    const rows = await this.database
      .select({
        id: agentToolGrant.id,
        toolId: agentToolGrant.toolId,
        allowedGroups: agentToolGrant.allowedGroups,
        allowedAdminRoles: agentToolGrant.allowedAdminRoles,
        tool: governedTool,
      })
      .from(agentToolGrant)
      .innerJoin(governedTool, eq(agentToolGrant.toolId, governedTool.id))
      .where(and(eq(agentToolGrant.profileVersionId, profileVersionId), eq(agentToolGrant.enabled, true)));
    return rows;
  }

  private async requesterMatchesGrant(
    requestedBy: string,
    groups: string[],
    roles: string[],
    executor: Executor = this.database,
  ): Promise<boolean> {
    const now = new Date();
    const [administrator] = await executor
      .select({ role: administratorSession.role })
      .from(administratorSession)
      .where(and(
        eq(administratorSession.id, requestedBy),
        isNull(administratorSession.revokedAt),
        gt(administratorSession.idleExpiresAt, now),
        gt(administratorSession.absoluteExpiresAt, now),
      ))
      .limit(1);
    if (administrator) return roles.includes(administrator.role);
    const [enterprise] = await executor
      .select({ groups: enterpriseUser.groups })
      .from(enterpriseUserSession)
      .innerJoin(enterpriseUser, eq(enterpriseUserSession.userId, enterpriseUser.id))
      .where(and(
        eq(enterpriseUserSession.id, requestedBy),
        isNull(enterpriseUserSession.revokedAt),
        gt(enterpriseUserSession.idleExpiresAt, now),
        gt(enterpriseUserSession.absoluteExpiresAt, now),
        eq(enterpriseUser.enabled, true),
      ))
      .limit(1);
    return (enterprise?.groups ?? []).some((group) => groups.includes(group));
  }

  private async executeHandler(
    handlerKey: string,
    _arguments: Record<string, unknown>,
    scope: { runId: string; divisionId: string | null },
  ): Promise<Record<string, unknown>> {
    /*
     * Increment F's two handlers, and the first executors this build registers.
     *
     * Neither takes a division. The scope is a parameter of the *handler*, not
     * of the tool's input schema, so there is nothing in the JSON an agent sends
     * that could name another division -- and no wording in a prompt that could
     * either, since the division never travels through one.
     */
    if (handlerKey === "orcasynapse.memory.remember") {
      const text = typeof _arguments.text === "string" ? _arguments.text.trim() : "";
      if (!text) throw new ToolingConflictError("Nothing to remember: 'text' is required.");
      const [written] = await this.database
        .insert(scopedMemoryEntry)
        .values({ divisionId: scope.divisionId, content: text.slice(0, 4_000), runId: scope.runId })
        .returning({ id: scopedMemoryEntry.id });
      return { remembered: true, id: written?.id ?? null };
    }

    if (handlerKey === "orcasynapse.memory.recall") {
      const query = typeof _arguments.query === "string" ? _arguments.query.trim() : "";
      /*
       * `is null` rather than an omitted predicate. A deployment-wide run reads
       * deployment-wide rows and no others; treating null as "match anything"
       * is the one mistake that would quietly undo the whole increment.
       */
      const scopePredicate = scope.divisionId === null
        ? isNull(scopedMemoryEntry.divisionId)
        : eq(scopedMemoryEntry.divisionId, scope.divisionId);
      const rows = await this.database
        .select({ content: scopedMemoryEntry.content, createdAt: scopedMemoryEntry.createdAt })
        .from(scopedMemoryEntry)
        .where(query
          ? and(scopePredicate, sql`to_tsvector('simple', ${scopedMemoryEntry.content}) @@ plainto_tsquery('simple', ${query})`)
          : scopePredicate)
        .orderBy(desc(scopedMemoryEntry.createdAt))
        .limit(20);
      return {
        entries: rows.map(({ content, createdAt }) => ({ content, at: createdAt.toISOString() })),
      };
    }

    throw new ToolingConflictError(`No local executor is registered for handler '${handlerKey}'.`);
  }

  private async completeCall(callId: string, data: Record<string, unknown>): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(governedToolCall)
        .set({ status: "COMPLETED", result: data, completedAt: new Date() })
        .where(eq(governedToolCall.id, callId));
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE", action: "tool.call_completed", resourceType: "GovernedToolCall",
        resourceId: callId, outcome: "SUCCESS",
      });
    });
  }

  private async failCall(callId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(governedToolCall)
        .set({ status: "FAILED", errorCode, errorMessage, completedAt: new Date() })
        .where(eq(governedToolCall.id, callId));
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE", action: "tool.call_failed", resourceType: "GovernedToolCall",
        resourceId: callId, outcome: "FAILURE", metadata: { errorCode },
      });
    });
  }

  private existingResult(call: CallRow): GovernedToolResult {
    const mapped = callDto(call);
    return {
      callId: mapped.id,
      status: mapped.status === "COMPLETED" ? "COMPLETED" : mapped.status === "APPROVAL_PENDING" ? "APPROVAL_PENDING" : mapped.status === "EXECUTING" || mapped.status === "REQUESTED" ? "EXECUTING" : mapped.status === "DENIED" ? "DENIED" : "FAILED",
      data: mapped.result ?? { status: mapped.status, message: mapped.errorMessage },
      isError: ["FAILED", "DENIED", "CANCELLED"].includes(mapped.status),
    };
  }

  private async findExistingResult(
    runId: string,
    requestId: string,
    toolSlug: string,
    arguments_: Record<string, unknown>,
  ): Promise<GovernedToolResult | null> {
    const [existing] = await this.callQuery(this.database)
      .where(and(eq(governedToolCall.runId, runId), eq(governedToolCall.requestId, requestId)))
      .limit(1);
    if (!existing) return null;
    const storedArguments = jsonObject(existing.arguments);
    if (existing.toolSlug !== toolSlug || JSON.stringify(storedArguments) !== JSON.stringify(arguments_)) {
      throw new ToolingDeniedError("The request ID was already used for a different tool invocation.");
    }
    return this.existingResult(existing);
  }
}

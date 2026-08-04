import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  GatewayCredential,
  GovernedTool,
  ToolApproval,
  ToolCall,
  ToolGrant,
  ToolMetrics,
  ToolRuntimeControl,
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
  document,
  documentMemoryPublication,
  enterpriseUser,
  enterpriseUserSession,
  governedTool,
  governedToolCall,
  mcpGatewayCredential,
  toolActionDispatch,
  toolApproval,
  toolRuntimeControl,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { advisoryLock } from "../database-support.js";
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
const SUPPORTED_TOOL_HANDLERS = ["builtin.document_metadata_read"] as const;

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

/** The joined approval row, flattened from Prisma's call/run/tool includes. */
interface ApprovalRow {
  id: string; callId: string; status: ToolApproval["status"]; expiresAt: Date; decisionReason: string | null;
  decisionBy: string | null; decidedAt: Date | null; createdAt: Date; updatedAt: Date;
  runId: string; arguments: unknown; ownerSubject: string; profileSlug: string;
  toolSlug: string; toolName: string;
}

function approvalDto(approval: ApprovalRow): ToolApproval {
  return {
    id: approval.id,
    callId: approval.callId,
    runId: approval.runId,
    profileSlug: approval.profileSlug,
    toolSlug: approval.toolSlug,
    toolName: approval.toolName,
    requestedBySubject: approval.ownerSubject,
    arguments: jsonObject(approval.arguments),
    status: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
    decisionReason: approval.decisionReason,
    decisionBy: approval.decisionBy,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

/** Everything the approval authorization re-check reads, in one shape. */
interface ApprovalAuthorizationContext {
  callId: string;
  toolId: string;
  arguments: unknown;
  runStatus: string;
  runProfileVersion: number;
  runProfileVersionId: string;
  runOwnerSubject: string;
  runRequestedBy: string;
  toolCapabilityTokenHash: Uint8Array | null;
  toolCapabilityExpiresAt: Date | null;
  profileStatus: string;
  profileActiveVersion: number | null;
  toolStatus: string;
  toolRisk: string;
  grantEnabled: boolean;
  grantToolId: string;
  grantProfileVersionId: string;
  grantResourceScope: string;
  grantAllowedGroups: string[];
  grantAllowedAdminRoles: string[];
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

export class DrizzleToolingManager implements ToolingManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly boundaryVerifier?: ToolBoundaryVerifier,
  ) {}

  async listTools() {
    const items = await this.database
      .select()
      .from(governedTool)
      .where(inArray(governedTool.handlerKey, [...SUPPORTED_TOOL_HANDLERS]))
      .orderBy(asc(governedTool.risk), asc(governedTool.displayName));
    return { items: items.map(toolDto) };
  }

  async listToolsForRun(authorization: string | undefined) {
    const parsedAuthorization = authorization ? RUN_AUTHORIZATION.exec(authorization) : null;
    const runId = parsedAuthorization?.[1];
    const capability = parsedAuthorization?.[2];
    if (!runId || !capability) throw new ToolingDeniedError("Private run authorization is required for tool discovery.");
    const [control, run] = await Promise.all([this.runtimeControlRow(), this.runForTooling(runId)]);
    if (!control?.enabled) throw new ToolingDeniedError(control?.reason ?? "The tool gateway is disabled fail-closed.");
    this.assertRunIsExecutable(run, capability, "discovery");

    const items: GovernedTool[] = [];
    for (const grant of await this.enabledGrantsForVersion(run!.profileVersionId)) {
      if (
        grant.tool.status === "ACTIVE" &&
        await this.requesterMatchesGrant(run!.requestedBy, grant.allowedGroups, grant.allowedAdminRoles)
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
        .where(and(
          eq(governedTool.id, toolId),
          inArray(governedTool.handlerKey, [...SUPPORTED_TOOL_HANDLERS]),
        ))
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
        .where(and(
          eq(governedTool.id, input.toolId),
          inArray(governedTool.handlerKey, [...SUPPORTED_TOOL_HANDLERS]),
        ))
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

  async invoke(toolSlug: string, invocation: GovernedToolInvocation): Promise<GovernedToolResult> {
    const parsedAuthorization = RUN_AUTHORIZATION.exec(invocation.authorization);
    if (!parsedAuthorization || !UUID.test(invocation.requestId)) throw new ToolingDeniedError("Run authorization or request ID is invalid.");
    const [, runId, capability] = parsedAuthorization;
    if (!runId || !capability) throw new ToolingDeniedError();

    const [control, run, tool] = await Promise.all([
      this.runtimeControlRow(),
      this.runForTooling(runId),
      this.database.select().from(governedTool).where(eq(governedTool.slug, toolSlug)).limit(1)
        .then(([found]) => found),
    ]);
    if (!control?.enabled) throw new ToolingDeniedError(control?.reason ?? "The tool gateway is disabled fail-closed.");
    this.assertRunIsExecutable(run, capability, "execution");
    if (!tool || tool.status !== "ACTIVE") throw new ToolingDeniedError("The requested tool is not active.");
    if (tool.risk === "CONSEQUENTIAL") {
      throw new ToolingDeniedError("No consequential tool handler is installed in this release.");
    }
    const grants = await this.enabledGrantsForVersion(run!.profileVersionId);
    const grant = grants.find((item) => item.toolId === tool.id);
    if (!grant) throw new ToolingDeniedError("The active agent version does not grant this tool.");
    if (!(await this.requesterMatchesGrant(run!.requestedBy, grant.allowedGroups, grant.allowedAdminRoles))) {
      throw new ToolingDeniedError("The requesting identity no longer satisfies the tool grant.");
    }
    const documentId = this.documentId(invocation.arguments);
    const sanitizedArguments = { documentId };
    const existing = await this.findExistingResult(runId, invocation.requestId, toolSlug, documentId);
    if (existing) return existing;

    let callId: string;
    try {
      const [created] = await this.database
        .insert(governedToolCall)
        .values({
          runId, toolId: tool.id, grantId: grant.id, requestId: invocation.requestId,
          status: "EXECUTING", arguments: sanitizedArguments, startedAt: new Date(),
        })
        .returning({ id: governedToolCall.id });
      if (!created) throw new ToolingConflictError("The tool call could not be recorded.");
      callId = created.id;
    } catch (cause) {
      const raced = await this.findExistingResult(runId, invocation.requestId, toolSlug, documentId);
      if (raced) return raced;
      throw cause;
    }
    try {
      const data = await this.executeRead(tool.handlerKey, run!.ownerSubject, documentId);
      await this.completeCall(callId, data);
      return { callId, status: "COMPLETED", data, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Tool execution failed.";
      await this.failCall(callId, "TOOL_EXECUTION_FAILED", message);
      return { callId, status: "FAILED", data: { message }, isError: true };
    }
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

  /*
   * INCOMPLETE SUBSYSTEM - human approval for CONSEQUENTIAL governed tools.
   *
   * This is the consequential half of the governed MCP surface whose read-only
   * half is live. It is deliberately parked and currently unreachable:
   *
   *   - nothing anywhere creates a ToolApproval, so the two methods below have
   *     no data source;
   *   - neither is declared on the ToolingManager interface or exposed by a
   *     route, so nothing can call them;
   *   - invoke() denies CONSEQUENTIAL tools outright, so no call can reach the
   *     state that would request an approval.
   *
   * Before wiring this up, note that decideToolApproval is NOT inert. On
   * approval it moves the GovernedToolCall to EXECUTING and writes a
   * ToolActionDispatch row - and nothing reads ToolActionDispatch. Without an
   * executor draining that table, approved calls stay EXECUTING forever. The
   * dispatch consumer is the missing piece, not the approval flow.
   */
  async listToolApprovals() {
    await this.expireApprovals();
    const items = await this.approvalQuery(this.database).orderBy(desc(toolApproval.createdAt)).limit(300);
    return { items: items.map(approvalDto) };
  }

  /** Named for its model so it cannot be confused with the live chat approval
   * decision on ChatManager, which acts on AgentRunApproval instead. */
  async decideToolApproval(principal: ToolingPrincipal, approvalId: string, input: { decision: "APPROVE" | "REJECT"; reason: string }): Promise<ToolApproval> {
    let expired = false;
    let revokedReason: string | null = null;
    await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-tool-approval:${approvalId}`));
      const [found] = await transaction
        .select({
          id: toolApproval.id,
          callId: toolApproval.callId,
          status: toolApproval.status,
          expiresAt: toolApproval.expiresAt,
        })
        .from(toolApproval)
        .where(eq(toolApproval.id, approvalId))
        .limit(1);
      if (!found) throw new ToolingNotFoundError("The approval request does not exist.");
      if (found.status !== "PENDING") throw new ToolingConflictError("Only a pending approval can be decided.");
      const now = new Date();
      if (found.expiresAt <= now) {
        await transaction
          .update(toolApproval)
          .set({ status: "EXPIRED", decidedAt: now, decisionReason: "Approval expired before review." })
          .where(eq(toolApproval.id, approvalId));
        await transaction
          .update(governedToolCall)
          .set({ status: "DENIED", errorCode: "APPROVAL_EXPIRED", errorMessage: "Approval expired before review.", completedAt: now })
          .where(eq(governedToolCall.id, found.callId));
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "tool.approval_expired",
          resourceType: "ToolApproval", resourceId: approvalId, outcome: "FAILURE",
          metadata: { callId: found.callId },
        });
        expired = true;
        return;
      }
      const approved = input.decision === "APPROVE";
      if (approved) {
        try {
          await this.assertApprovalStillAuthorized(await this.approvalAuthorization(transaction, found.callId), transaction);
        } catch (cause) {
          if (!(cause instanceof ToolingDeniedError)) throw cause;
          revokedReason = cause.message;
          await transaction
            .update(toolApproval)
            .set({ status: "CANCELLED", decisionReason: cause.message, decidedAt: now })
            .where(eq(toolApproval.id, approvalId));
          await transaction
            .update(governedToolCall)
            .set({ status: "DENIED", errorCode: "AUTHORIZATION_REVOKED", errorMessage: cause.message, completedAt: now })
            .where(eq(governedToolCall.id, found.callId));
          await transaction.insert(auditEvent).values({
            actorType: "USER", actorId: principal.id, action: "tool.approval_cancelled_by_policy",
            resourceType: "ToolApproval", resourceId: approvalId, outcome: "FAILURE",
            metadata: { callId: found.callId, reason: cause.message },
          });
          return;
        }
      }
      await transaction
        .update(toolApproval)
        .set({ status: approved ? "APPROVED" : "REJECTED", decisionReason: input.reason, decisionBy: principal.id, decidedAt: now })
        .where(eq(toolApproval.id, approvalId));
      await transaction
        .update(governedToolCall)
        .set(approved
          ? { status: "EXECUTING", startedAt: now }
          : { status: "DENIED", errorCode: "APPROVAL_REJECTED", errorMessage: input.reason, completedAt: now })
        .where(eq(governedToolCall.id, found.callId));
      if (approved) {
        // No executor drains ToolActionDispatch today, so this row is durable
        // intent with no consumer. See the note above decideToolApproval.
        await transaction.insert(toolActionDispatch).values({ callId: found.callId });
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: approved ? "tool.approval_approved" : "tool.approval_rejected",
        resourceType: "ToolApproval", resourceId: approvalId, outcome: "SUCCESS",
        metadata: { callId: found.callId, reason: input.reason, durableDispatchCreated: approved },
      });
    });

    if (expired) throw new ToolingConflictError("The approval request has expired.");
    if (revokedReason) throw new ToolingDeniedError(revokedReason);

    const [refreshed] = await this.approvalQuery(this.database).where(eq(toolApproval.id, approvalId)).limit(1);
    if (!refreshed) throw new ToolingNotFoundError("The approval request does not exist.");
    return approvalDto(refreshed);
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
        await this.boundaryVerifier.assertGovernedToolBoundary();
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

  private approvalQuery(executor: Executor) {
    return executor
      .select({
        id: toolApproval.id,
        callId: toolApproval.callId,
        status: toolApproval.status,
        expiresAt: toolApproval.expiresAt,
        decisionReason: toolApproval.decisionReason,
        decisionBy: toolApproval.decisionBy,
        decidedAt: toolApproval.decidedAt,
        createdAt: toolApproval.createdAt,
        updatedAt: toolApproval.updatedAt,
        runId: governedToolCall.runId,
        arguments: governedToolCall.arguments,
        ownerSubject: agentRun.ownerSubject,
        profileSlug: agentProfile.slug,
        toolSlug: governedTool.slug,
        toolName: governedTool.displayName,
      })
      .from(toolApproval)
      .innerJoin(governedToolCall, eq(toolApproval.callId, governedToolCall.id))
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
      })
      .from(agentRun)
      .innerJoin(agentProfile, eq(agentRun.profileId, agentProfile.id))
      .where(eq(agentRun.id, runId))
      .limit(1);
    return run;
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

  private documentId(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length !== 1 || keys[0] !== "documentId" || typeof args.documentId !== "string" || !UUID.test(args.documentId)) {
      throw new ToolingDeniedError("Tool arguments must contain exactly one valid documentId.");
    }
    return args.documentId;
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

  private async executeRead(handlerKey: string, ownerSubject: string, documentId: string): Promise<Record<string, unknown>> {
    if (handlerKey !== "builtin.document_metadata_read") throw new ToolingConflictError("The read-only tool handler is not implemented.");
    const [found] = await this.database
      .select({
        id: document.id,
        fileName: document.fileName,
        mediaType: document.mediaType,
        sizeBytes: document.sizeBytes,
        classification: document.classification,
        status: document.status,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        memoryStatus: documentMemoryPublication.status,
        memorySyncedAt: documentMemoryPublication.syncedAt,
        memoryFailureCode: documentMemoryPublication.failureCode,
        memoryExternalDocumentId: documentMemoryPublication.externalDocumentId,
      })
      .from(document)
      .leftJoin(documentMemoryPublication, eq(documentMemoryPublication.documentId, document.id))
      .where(and(
        eq(document.id, documentId),
        eq(document.ownerSubject, ownerSubject),
        isNull(document.deletedAt),
      ))
      .limit(1);
    if (!found) throw new ToolingDeniedError("The document is unavailable within the requesting user's owner-only scope.");
    return {
      documentId: found.id,
      fileName: found.fileName,
      mediaType: found.mediaType,
      sizeBytes: found.sizeBytes.toString(),
      classification: found.classification,
      status: found.status,
      memory: found.memoryStatus ? {
        status: found.memoryStatus,
        externalDocumentId: found.memoryExternalDocumentId,
        syncedAt: found.memorySyncedAt?.toISOString() ?? null,
        failureCode: found.memoryFailureCode,
      } : null,
      createdAt: found.createdAt.toISOString(),
      updatedAt: found.updatedAt.toISOString(),
    };
  }

  /** Loads the full authorization graph the approval re-check reads. */
  private async approvalAuthorization(executor: Executor, callId: string): Promise<ApprovalAuthorizationContext> {
    const [row] = await executor
      .select({
        callId: governedToolCall.id,
        toolId: governedToolCall.toolId,
        arguments: governedToolCall.arguments,
        runStatus: agentRun.status,
        runProfileVersion: agentRun.profileVersion,
        runProfileVersionId: agentRun.profileVersionId,
        runOwnerSubject: agentRun.ownerSubject,
        runRequestedBy: agentRun.requestedBy,
        toolCapabilityTokenHash: agentRun.toolCapabilityTokenHash,
        toolCapabilityExpiresAt: agentRun.toolCapabilityExpiresAt,
        profileStatus: agentProfile.status,
        profileActiveVersion: agentProfile.activeVersion,
        toolStatus: governedTool.status,
        toolRisk: governedTool.risk,
        grantEnabled: agentToolGrant.enabled,
        grantToolId: agentToolGrant.toolId,
        grantProfileVersionId: agentToolGrant.profileVersionId,
        grantResourceScope: agentToolGrant.resourceScope,
        grantAllowedGroups: agentToolGrant.allowedGroups,
        grantAllowedAdminRoles: agentToolGrant.allowedAdminRoles,
      })
      .from(governedToolCall)
      .innerJoin(agentRun, eq(governedToolCall.runId, agentRun.id))
      .innerJoin(agentProfile, eq(agentRun.profileId, agentProfile.id))
      .innerJoin(governedTool, eq(governedToolCall.toolId, governedTool.id))
      .innerJoin(agentToolGrant, eq(governedToolCall.grantId, agentToolGrant.id))
      .where(eq(governedToolCall.id, callId))
      .limit(1);
    if (!row) throw new ToolingNotFoundError("The approved call no longer exists.");
    return row;
  }

  private async assertApprovalStillAuthorized(
    call: ApprovalAuthorizationContext,
    executor: Executor,
  ): Promise<void> {
    const [control] = await executor
      .select({ enabled: toolRuntimeControl.enabled })
      .from(toolRuntimeControl)
      .where(eq(toolRuntimeControl.id, "global"))
      .limit(1);
    if (
      call.runStatus !== "RUNNING" ||
      !call.toolCapabilityTokenHash ||
      !call.toolCapabilityExpiresAt ||
      call.toolCapabilityExpiresAt <= new Date()
    ) {
      throw new ToolingDeniedError("The originating agent run is no longer authorized for tool execution.");
    }
    if (!control?.enabled || call.toolStatus !== "ACTIVE" || !call.grantEnabled) throw new ToolingDeniedError("Tool execution was revoked before approval.");
    if (call.grantToolId !== call.toolId || call.grantProfileVersionId !== call.runProfileVersionId || call.grantResourceScope !== "OWNER_ONLY") {
      throw new ToolingDeniedError("The stored tool grant no longer matches the exact run and tool scope.");
    }
    if (call.toolRisk === "CONSEQUENTIAL") throw new ToolingDeniedError("No consequential tool handler is installed in this release.");
    if (call.profileStatus !== "ACTIVE" || call.profileActiveVersion !== call.runProfileVersion) throw new ToolingDeniedError("The agent profile or version was revoked before approval.");
    if (!(await this.requesterMatchesGrant(call.runRequestedBy, call.grantAllowedGroups, call.grantAllowedAdminRoles, executor))) {
      throw new ToolingDeniedError("The requesting identity no longer satisfies the tool grant.");
    }
    const documentId = this.documentId(jsonObject(call.arguments));
    const [eligible] = await executor
      .select({ id: document.id })
      .from(document)
      .innerJoin(documentMemoryPublication, eq(documentMemoryPublication.documentId, document.id))
      .where(and(
        eq(document.id, documentId),
        eq(document.ownerSubject, call.runOwnerSubject),
        eq(document.status, "READY"),
        isNull(document.deletedAt),
        eq(documentMemoryPublication.status, "READY"),
        isNotNull(documentMemoryPublication.externalDocumentId),
      ))
      .limit(1);
    if (!eligible) throw new ToolingDeniedError("The target document is no longer eligible within owner-only scope.");
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
    documentId: string,
  ): Promise<GovernedToolResult | null> {
    const [existing] = await this.callQuery(this.database)
      .where(and(eq(governedToolCall.runId, runId), eq(governedToolCall.requestId, requestId)))
      .limit(1);
    if (!existing) return null;
    const arguments_ = jsonObject(existing.arguments);
    if (existing.toolSlug !== toolSlug || arguments_.documentId !== documentId) {
      throw new ToolingDeniedError("The request ID was already used for a different tool invocation.");
    }
    return this.existingResult(existing);
  }

  private async expireApprovals(): Promise<void> {
    const expired = await this.database
      .select({ id: toolApproval.id, callId: toolApproval.callId })
      .from(toolApproval)
      .where(and(eq(toolApproval.status, "PENDING"), lte(toolApproval.expiresAt, new Date())));
    if (expired.length === 0) return;
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(toolApproval)
        .set({ status: "EXPIRED", decidedAt: now, decisionReason: "Approval expired before review." })
        .where(and(
          inArray(toolApproval.id, expired.map(({ id }) => id)),
          eq(toolApproval.status, "PENDING"),
        ));
      await transaction
        .update(governedToolCall)
        .set({ status: "DENIED", errorCode: "APPROVAL_EXPIRED", errorMessage: "Approval expired before review.", completedAt: now })
        .where(and(
          inArray(governedToolCall.id, expired.map(({ callId }) => callId)),
          eq(governedToolCall.status, "APPROVAL_PENDING"),
        ));
      await transaction.insert(auditEvent).values(expired.map(({ id, callId }) => ({
        actorType: "SERVICE" as const,
        action: "tool.approval_expired",
        resourceType: "ToolApproval",
        resourceId: id,
        outcome: "FAILURE" as const,
        metadata: { callId },
      })));
    });
  }
}

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
  documentChunk,
  enterpriseUser,
  enterpriseUserSession,
  governedTool,
  governedToolCall,
  mcpGatewayCredential,
  toolApproval,
  toolRuntimeControl,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
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
   * Human approval for CONSEQUENTIAL governed tools is not implemented. The
   * read-only half of the governed MCP surface is live; invoke() denies
   * CONSEQUENTIAL tools outright, so no approval can be requested. The approval
   * flow and its durable ToolActionDispatch queue were removed rather than left
   * parked, because nothing drained that queue: an approved call would have sat
   * in EXECUTING forever. Rebuild both together, executor first.
   */

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
        chunkCount: count(documentChunk.id),
        embeddingModel: sql<string | null>`max(${documentChunk.embeddingModel})`,
      })
      .from(document)
      .leftJoin(documentChunk, eq(documentChunk.documentId, document.id))
      .where(and(
        eq(document.id, documentId),
        eq(document.ownerSubject, ownerSubject),
        isNull(document.deletedAt),
      ))
      .groupBy(document.id)
      .limit(1);
    if (!found) throw new ToolingDeniedError("The document is unavailable within the requesting user's owner-only scope.");
    return {
      documentId: found.id,
      fileName: found.fileName,
      mediaType: found.mediaType,
      sizeBytes: found.sizeBytes.toString(),
      classification: found.classification,
      status: found.status,
      // Retrieval state comes from the pgvector index the document was embedded
      // into, which replaced the external memory projection.
      retrieval: found.chunkCount > 0 ? {
        status: "INDEXED",
        chunks: found.chunkCount,
        embeddingModel: found.embeddingModel,
      } : { status: "NOT_INDEXED", chunks: 0, embeddingModel: null },
      createdAt: found.createdAt.toISOString(),
      updatedAt: found.updatedAt.toISOString(),
    };
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
}

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
import { Prisma, type OrcaSynapsePrismaClient } from "@orcasynapse/database";
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

const callInclude = {
  run: { include: { profile: { select: { slug: true } } } },
  tool: true,
} as const;
const approvalInclude = {
  call: {
    include: {
      run: { include: { profile: { select: { slug: true, status: true, activeVersion: true } } } },
      tool: true,
      grant: true,
    },
  },
} as const;

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

function grantDto(grant: {
  id: string; profileVersionId: string; toolId: string; enabled: boolean; allowedGroups: string[];
  allowedAdminRoles: ToolGrant["allowedAdminRoles"]; resourceScope: ToolGrant["resourceScope"];
  createdAt: Date; updatedAt: Date;
  profileVersion: { version: number; profile: { id: string; slug: string } };
  tool: { slug: string; displayName: string };
}): ToolGrant {
  return {
    id: grant.id,
    profileId: grant.profileVersion.profile.id,
    profileSlug: grant.profileVersion.profile.slug,
    profileVersionId: grant.profileVersionId,
    profileVersion: grant.profileVersion.version,
    toolId: grant.toolId,
    toolSlug: grant.tool.slug,
    toolName: grant.tool.displayName,
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

function callDto(call: {
  id: string; runId: string; requestId: string; status: ToolCall["status"]; arguments: unknown; result: unknown;
  errorCode: string | null; errorMessage: string | null; requestedAt: Date; startedAt: Date | null;
  completedAt: Date | null; createdAt: Date; updatedAt: Date;
  run: { profileVersion: number; profile: { slug: string } };
  tool: { slug: string; displayName: string; risk: ToolCall["risk"] };
}): ToolCall {
  return {
    id: call.id,
    runId: call.runId,
    profileSlug: call.run.profile.slug,
    profileVersion: call.run.profileVersion,
    toolSlug: call.tool.slug,
    toolName: call.tool.displayName,
    risk: call.tool.risk,
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

function approvalDto(approval: {
  id: string; callId: string; status: ToolApproval["status"]; expiresAt: Date; decisionReason: string | null;
  decisionBy: string | null; decidedAt: Date | null; createdAt: Date; updatedAt: Date;
  call: {
    runId: string; arguments: unknown; run: { ownerSubject: string; profile: { slug: string } };
    tool: { slug: string; displayName: string };
  };
}): ToolApproval {
  return {
    id: approval.id,
    callId: approval.callId,
    runId: approval.call.runId,
    profileSlug: approval.call.run.profile.slug,
    toolSlug: approval.call.tool.slug,
    toolName: approval.call.tool.displayName,
    requestedBySubject: approval.call.run.ownerSubject,
    arguments: jsonObject(approval.call.arguments),
    status: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
    decisionReason: approval.decisionReason,
    decisionBy: approval.decisionBy,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  };
}

export class PrismaToolingManager implements ToolingManager {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly boundaryVerifier?: ToolBoundaryVerifier,
  ) {}

  async listTools() {
    const items = await this.prisma.governedTool.findMany({
      where: { handlerKey: { in: [...SUPPORTED_TOOL_HANDLERS] } },
      orderBy: [{ risk: "asc" }, { displayName: "asc" }],
    });
    return { items: items.map(toolDto) };
  }

  async listToolsForRun(authorization: string | undefined) {
    const parsedAuthorization = authorization ? RUN_AUTHORIZATION.exec(authorization) : null;
    const runId = parsedAuthorization?.[1];
    const capability = parsedAuthorization?.[2];
    if (!runId || !capability) throw new ToolingDeniedError("Private run authorization is required for tool discovery.");
    const [control, run] = await Promise.all([
      this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } }),
      this.prisma.agentRun.findUnique({
        where: { id: runId },
        include: {
          profile: { select: { status: true, activeVersion: true } },
          version: { include: { toolGrants: { where: { enabled: true }, include: { tool: true } } } },
        },
      }),
    ]);
    if (!control?.enabled) throw new ToolingDeniedError(control?.reason ?? "The tool gateway is disabled fail-closed.");
    if (!run || run.status !== "RUNNING" || !run.toolCapabilityTokenHash || !run.toolCapabilityExpiresAt || run.toolCapabilityExpiresAt <= new Date()) {
      throw new ToolingDeniedError("The agent run is not eligible for tool discovery or its capability has expired.");
    }
    const expected = Buffer.from(run.toolCapabilityTokenHash);
    const actual = Buffer.from(digest(capability));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ToolingDeniedError("The run capability is invalid.");
    if (run.profile.status !== "ACTIVE" || run.profile.activeVersion !== run.profileVersion) {
      throw new ToolingDeniedError("The agent profile or version is no longer active.");
    }
    const items: GovernedTool[] = [];
    for (const grant of run.version.toolGrants) {
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
    await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.governedTool.updateMany({
        where: { id: toolId, handlerKey: { in: [...SUPPORTED_TOOL_HANDLERS] } },
        data: { status },
      });
      if (changed.count !== 1) throw new ToolingNotFoundError();
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: status === "ACTIVE" ? "tool.activated" : "tool.suspended",
        resourceType: "GovernedTool", resourceId: toolId, outcome: "SUCCESS",
      } });
    });
  }

  async listGrants() {
    const items = await this.prisma.agentToolGrant.findMany({
      include: { profileVersion: { select: { version: true, profile: { select: { id: true, slug: true } } } }, tool: { select: { slug: true, displayName: true } } },
      orderBy: { updatedAt: "desc" }, take: 300,
    });
    return { items: items.map((item) => grantDto(item as Parameters<typeof grantDto>[0])) };
  }

  async upsertGrant(principal: ToolingPrincipal, input: UpsertToolGrant): Promise<ToolGrant> {
    const [version, tool] = await Promise.all([
      this.prisma.agentProfileVersion.findUnique({ where: { id: input.profileVersionId }, select: { id: true } }),
      this.prisma.governedTool.findFirst({ where: { id: input.toolId, handlerKey: { in: [...SUPPORTED_TOOL_HANDLERS] } }, select: { id: true } }),
    ]);
    if (!version || !tool) throw new ToolingNotFoundError("The selected profile version or tool does not exist.");
    const grant = await this.prisma.$transaction(async (transaction) => {
      const saved = await transaction.agentToolGrant.upsert({
        where: { profileVersionId_toolId: { profileVersionId: input.profileVersionId, toolId: input.toolId } },
        create: { ...input, createdBy: principal.id },
        update: { enabled: input.enabled, allowedGroups: input.allowedGroups, allowedAdminRoles: input.allowedAdminRoles, resourceScope: input.resourceScope },
        include: { profileVersion: { select: { version: true, profile: { select: { id: true, slug: true } } } }, tool: { select: { slug: true, displayName: true } } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "tool.grant_upserted",
        resourceType: "AgentToolGrant", resourceId: saved.id, outcome: "SUCCESS",
        metadata: { profileVersionId: input.profileVersionId, toolId: input.toolId, enabled: input.enabled, resourceScope: input.resourceScope },
      } });
      return saved;
    });
    return grantDto(grant as Parameters<typeof grantDto>[0]);
  }

  async listCredentials() {
    const items = await this.prisma.mcpGatewayCredential.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return { items: items.map(credentialDto) };
  }

  async issueCredential(principal: ToolingPrincipal, name: string) {
    const secret = randomBytes(32).toString("base64url");
    const token = `orcasynapse_mcp_${secret}`;
    const tokenPrefix = token.slice(0, 20);
    const credential = await this.prisma.$transaction(async (transaction) => {
      const saved = await transaction.mcpGatewayCredential.create({ data: {
        name, tokenPrefix, tokenHash: digest(token), createdBy: principal.id,
      } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "mcp.gateway_credential_issued",
        resourceType: "McpGatewayCredential", resourceId: saved.id, outcome: "SUCCESS",
        metadata: { name, tokenPrefix },
      } });
      return saved;
    });
    return { ...credentialDto(credential), token };
  }

  async revokeCredential(principal: ToolingPrincipal, credentialId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.mcpGatewayCredential.updateMany({
        where: { id: credentialId, revokedAt: null }, data: { enabled: false, revokedAt: new Date() },
      });
      if (changed.count !== 1) throw new ToolingNotFoundError("The gateway credential is missing or already revoked.");
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "mcp.gateway_credential_revoked",
        resourceType: "McpGatewayCredential", resourceId: credentialId, outcome: "SUCCESS",
      } });
    });
  }

  async authenticateGateway(token: string | undefined): Promise<boolean> {
    if (!token || !GATEWAY_TOKEN.test(token)) return false;
    const prefix = token.slice(0, 20);
    const credential = await this.prisma.mcpGatewayCredential.findUnique({ where: { tokenPrefix: prefix } });
    if (!credential?.enabled || credential.revokedAt) return false;
    const expected = Buffer.from(credential.tokenHash);
    const actual = Buffer.from(digest(token));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    await this.prisma.mcpGatewayCredential.update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } });
    return true;
  }

  async invoke(toolSlug: string, invocation: GovernedToolInvocation): Promise<GovernedToolResult> {
    const parsedAuthorization = RUN_AUTHORIZATION.exec(invocation.authorization);
    if (!parsedAuthorization || !UUID.test(invocation.requestId)) throw new ToolingDeniedError("Run authorization or request ID is invalid.");
    const [, runId, capability] = parsedAuthorization;
    if (!runId || !capability) throw new ToolingDeniedError();

    const [control, run, tool] = await Promise.all([
      this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } }),
      this.prisma.agentRun.findUnique({
        where: { id: runId },
        include: {
          profile: { select: { slug: true, status: true, activeVersion: true } },
          version: { include: { toolGrants: { where: { enabled: true }, include: { tool: true } } } },
        },
      }),
      this.prisma.governedTool.findUnique({ where: { slug: toolSlug } }),
    ]);
    if (!control?.enabled) throw new ToolingDeniedError(control?.reason ?? "The tool gateway is disabled fail-closed.");
    if (!run || run.status !== "RUNNING" || !run.toolCapabilityTokenHash || !run.toolCapabilityExpiresAt || run.toolCapabilityExpiresAt <= new Date()) {
      throw new ToolingDeniedError("The agent run is not eligible for tool execution or its capability has expired.");
    }
    const expected = Buffer.from(run.toolCapabilityTokenHash);
    const actual = Buffer.from(digest(capability));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ToolingDeniedError("The run capability is invalid.");
    if (run.profile.status !== "ACTIVE" || run.profile.activeVersion !== run.profileVersion) throw new ToolingDeniedError("The agent profile or version is no longer active.");
    if (!tool || tool.status !== "ACTIVE") throw new ToolingDeniedError("The requested tool is not active.");
    if (tool.risk === "CONSEQUENTIAL") {
      throw new ToolingDeniedError("No consequential tool handler is installed in this release.");
    }
    const grant = run.version.toolGrants.find((item) => item.toolId === tool.id);
    if (!grant) throw new ToolingDeniedError("The active agent version does not grant this tool.");
    if (!(await this.requesterMatchesGrant(run.requestedBy, grant.allowedGroups, grant.allowedAdminRoles))) {
      throw new ToolingDeniedError("The requesting identity no longer satisfies the tool grant.");
    }
    const documentId = this.documentId(invocation.arguments);
    const sanitizedArguments = { documentId };
    const existing = await this.findExistingResult(runId, invocation.requestId, toolSlug, documentId);
    if (existing) return existing;

    let call;
    try {
      call = await this.prisma.governedToolCall.create({ data: {
        runId, toolId: tool.id, grantId: grant.id, requestId: invocation.requestId,
        status: "EXECUTING", arguments: sanitizedArguments, startedAt: new Date(),
      }, include: callInclude });
    } catch (cause) {
      const raced = await this.findExistingResult(runId, invocation.requestId, toolSlug, documentId);
      if (raced) return raced;
      throw cause;
    }
    try {
      const data = await this.executeRead(tool.handlerKey, run.ownerSubject, documentId);
      await this.completeCall(call.id, data);
      return { callId: call.id, status: "COMPLETED", data, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Tool execution failed.";
      await this.failCall(call.id, "TOOL_EXECUTION_FAILED", message);
      return { callId: call.id, status: "FAILED", data: { message }, isError: true };
    }
  }

  async recordDeniedInvocation(toolSlug: string, invocation: GovernedToolInvocation, reason: string): Promise<void> {
    const runId = RUN_AUTHORIZATION.exec(invocation.authorization)?.[1];
    await this.prisma.auditEvent.create({ data: {
      actorType: "SERVICE", action: "tool.call_denied", resourceType: runId ? "AgentRun" : "McpGateway",
      ...(runId ? { resourceId: runId } : {}), outcome: "FAILURE",
      metadata: { toolSlug: toolSlug.slice(0, 80), requestId: invocation.requestId.slice(0, 36), reason: reason.slice(0, 500) },
    } });
  }

  async listCalls() {
    const items = await this.prisma.governedToolCall.findMany({ include: callInclude, orderBy: { createdAt: "desc" }, take: 300 });
    return { items: items.map((item) => callDto(item as Parameters<typeof callDto>[0])) };
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
    const items = await this.prisma.toolApproval.findMany({ include: approvalInclude, orderBy: { createdAt: "desc" }, take: 300 });
    return { items: items.map((item) => approvalDto(item as Parameters<typeof approvalDto>[0])) };
  }

  /** Named for its model so it cannot be confused with the live chat approval
   * decision on ChatManager, which acts on AgentRunApproval instead. */
  async decideToolApproval(principal: ToolingPrincipal, approvalId: string, input: { decision: "APPROVE" | "REJECT"; reason: string }): Promise<ToolApproval> {
    let expired = false;
    let revokedReason: string | null = null;
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`orcasynapse-tool-approval:${approvalId}`}, 0))`;
      const found = await transaction.toolApproval.findUnique({ where: { id: approvalId }, include: approvalInclude });
      if (!found) throw new ToolingNotFoundError("The approval request does not exist.");
      if (found.status !== "PENDING") throw new ToolingConflictError("Only a pending approval can be decided.");
      const now = new Date();
      if (found.expiresAt <= now) {
        await transaction.toolApproval.update({ where: { id: approvalId }, data: { status: "EXPIRED", decidedAt: now, decisionReason: "Approval expired before review." } });
        await transaction.governedToolCall.update({ where: { id: found.callId }, data: { status: "DENIED", errorCode: "APPROVAL_EXPIRED", errorMessage: "Approval expired before review.", completedAt: now } });
        await transaction.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: "tool.approval_expired",
          resourceType: "ToolApproval", resourceId: approvalId, outcome: "FAILURE",
          metadata: { callId: found.callId },
        } });
        expired = true;
        return found;
      }
      const approved = input.decision === "APPROVE";
      if (approved) {
        try {
          await this.assertApprovalStillAuthorized(found, transaction);
        } catch (cause) {
          if (!(cause instanceof ToolingDeniedError)) throw cause;
          revokedReason = cause.message;
          await transaction.toolApproval.update({ where: { id: approvalId }, data: { status: "CANCELLED", decisionReason: cause.message, decidedAt: now } });
          await transaction.governedToolCall.update({ where: { id: found.callId }, data: { status: "DENIED", errorCode: "AUTHORIZATION_REVOKED", errorMessage: cause.message, completedAt: now } });
          await transaction.auditEvent.create({ data: {
            actorType: "USER", actorId: principal.id, action: "tool.approval_cancelled_by_policy",
            resourceType: "ToolApproval", resourceId: approvalId, outcome: "FAILURE",
            metadata: { callId: found.callId, reason: cause.message },
          } });
          return found;
        }
      }
      const updated = await transaction.toolApproval.update({
        where: { id: approvalId },
        data: { status: approved ? "APPROVED" : "REJECTED", decisionReason: input.reason, decisionBy: principal.id, decidedAt: now },
        include: approvalInclude,
      });
      await transaction.governedToolCall.update({
        where: { id: found.callId },
        data: approved
          ? { status: "EXECUTING", startedAt: now }
          : { status: "DENIED", errorCode: "APPROVAL_REJECTED", errorMessage: input.reason, completedAt: now },
      });
      if (approved) {
        // No executor drains ToolActionDispatch today, so this row is durable
        // intent with no consumer. See the note above decideToolApproval.
        await transaction.toolActionDispatch.create({
          data: { callId: found.callId },
        });
      }
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: approved ? "tool.approval_approved" : "tool.approval_rejected",
        resourceType: "ToolApproval", resourceId: approvalId, outcome: "SUCCESS",
        metadata: { callId: found.callId, reason: input.reason, durableDispatchCreated: approved },
      } });
      return updated;
    });

    if (expired) throw new ToolingConflictError("The approval request has expired.");
    if (revokedReason) throw new ToolingDeniedError(revokedReason);

    const refreshed = await this.prisma.toolApproval.findUniqueOrThrow({ where: { id: approvalId }, include: approvalInclude });
    return approvalDto(refreshed as Parameters<typeof approvalDto>[0]);
  }

  async getRuntimeControl(): Promise<ToolRuntimeControl> {
    const control = await this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } });
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
      const [credentials, grants] = await Promise.all([
        this.prisma.mcpGatewayCredential.count({ where: { enabled: true, revokedAt: null } }),
        this.prisma.agentToolGrant.count({ where: { enabled: true, tool: { status: "ACTIVE" } } }),
      ]);
      if (credentials === 0 || grants === 0) {
        await this.prisma.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: "tool.runtime_enable_denied",
          resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { activeGatewayCredentials: credentials, activeToolGrants: grants },
        } });
        throw new ToolingConflictError("Issue an active gateway credential and configure at least one active tool grant before enabling the gateway.");
      }
      if (!this.boundaryVerifier) {
        throw new ToolingConflictError("Hermes governed-tool boundary verification is unavailable; the gateway remains disabled.");
      }
      try {
        await this.boundaryVerifier.assertGovernedToolBoundary();
      } catch {
        await this.prisma.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: "tool.runtime_enable_denied",
          resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { activeGatewayCredentials: credentials, activeToolGrants: grants, failureCode: "HERMES_GOVERNED_BOUNDARY_FAILED" },
        } });
        throw new ToolingConflictError("Hermes failed the private governed-tool handoff check; the gateway remains disabled.");
      }
    }
    const control = await this.prisma.$transaction(async (transaction) => {
      const saved = await transaction.toolRuntimeControl.upsert({
        where: { id: "global" },
        create: { id: "global", ...input, updatedBy: principal.id },
        update: { ...input, updatedBy: principal.id },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: input.enabled ? "tool.runtime_enabled" : "tool.runtime_disabled",
        resourceType: "ToolRuntimeControl", resourceId: "global", outcome: "SUCCESS",
        metadata: { reason: input.reason, approvalTtlMinutes: input.approvalTtlMinutes },
      } });
      return saved;
    });
    return { enabled: control.enabled, reason: control.reason, approvalTtlMinutes: control.approvalTtlMinutes, updatedAt: control.updatedAt.toISOString(), updatedBy: control.updatedBy };
  }

  async metrics(): Promise<ToolMetrics> {
    const [
      activeTools, activeGrants, pendingApprovals, executingCalls,
      completedCalls, deniedCalls, failedCalls,
    ] = await Promise.all([
      this.prisma.governedTool.count({ where: { status: "ACTIVE" } }),
      this.prisma.agentToolGrant.count({ where: { enabled: true } }),
      this.prisma.toolApproval.count({ where: { status: "PENDING", expiresAt: { gt: new Date() } } }),
      this.prisma.governedToolCall.count({ where: { status: "EXECUTING" } }),
      this.prisma.governedToolCall.count({ where: { status: "COMPLETED" } }),
      this.prisma.governedToolCall.count({ where: { status: "DENIED" } }),
      this.prisma.governedToolCall.count({ where: { status: "FAILED" } }),
    ]);
    return {
      generatedAt: new Date().toISOString(), activeTools, activeGrants, pendingApprovals,
      executingCalls,
      completedCalls, deniedCalls, failedCalls,
    };
  }

  private documentId(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length !== 1 || keys[0] !== "documentId" || typeof args.documentId !== "string" || !UUID.test(args.documentId)) {
      throw new ToolingDeniedError("Tool arguments must contain exactly one valid documentId.");
    }
    return args.documentId;
  }

  private async requesterMatchesGrant(requestedBy: string, groups: string[], roles: string[], client: any = this.prisma): Promise<boolean> {
    const now = new Date();
    const administrator = await client.administratorSession.findFirst({
      where: { id: requestedBy, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      select: { role: true },
    });
    if (administrator) return roles.includes(administrator.role);
    const enterprise = await client.enterpriseUserSession.findFirst({
      where: { id: requestedBy, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { enabled: true } },
      select: { user: { select: { groups: true } } },
    });
    return enterprise ? enterprise.user.groups.some((group: string) => groups.includes(group)) : false;
  }

  private async executeRead(handlerKey: string, ownerSubject: string, documentId: string): Promise<Record<string, unknown>> {
    if (handlerKey !== "builtin.document_metadata_read") throw new ToolingConflictError("The read-only tool handler is not implemented.");
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ownerSubject, deletedAt: null },
      select: {
        id: true, fileName: true, mediaType: true, sizeBytes: true, classification: true, status: true,
        createdAt: true, updatedAt: true,
        supermemoryProjection: { select: { status: true, syncedAt: true, failureCode: true, externalDocumentId: true } },
      },
    });
    if (!document) throw new ToolingDeniedError("The document is unavailable within the requesting user's owner-only scope.");
    return {
      documentId: document.id,
      fileName: document.fileName,
      mediaType: document.mediaType,
      sizeBytes: document.sizeBytes.toString(),
      classification: document.classification,
      status: document.status,
      memory: document.supermemoryProjection ? {
        status: document.supermemoryProjection.status,
        externalDocumentId: document.supermemoryProjection.externalDocumentId,
        syncedAt: document.supermemoryProjection.syncedAt?.toISOString() ?? null,
        failureCode: document.supermemoryProjection.failureCode,
      } : null,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  }

  private async assertApprovalStillAuthorized(approval: any, client: any = this.prisma): Promise<void> {
    const control = await client.toolRuntimeControl.findUnique({ where: { id: "global" } });
    const { call } = approval;
    if (
      call.run.status !== "RUNNING" ||
      !call.run.toolCapabilityTokenHash ||
      !call.run.toolCapabilityExpiresAt ||
      call.run.toolCapabilityExpiresAt <= new Date()
    ) {
      throw new ToolingDeniedError("The originating agent run is no longer authorized for tool execution.");
    }
    if (!control?.enabled || call.tool.status !== "ACTIVE" || !call.grant.enabled) throw new ToolingDeniedError("Tool execution was revoked before approval.");
    if (call.grant.toolId !== call.toolId || call.grant.profileVersionId !== call.run.profileVersionId || call.grant.resourceScope !== "OWNER_ONLY") {
      throw new ToolingDeniedError("The stored tool grant no longer matches the exact run and tool scope.");
    }
    if (call.tool.risk === "CONSEQUENTIAL") throw new ToolingDeniedError("No consequential tool handler is installed in this release.");
    if (call.run.profile.status !== "ACTIVE" || call.run.profile.activeVersion !== call.run.profileVersion) throw new ToolingDeniedError("The agent profile or version was revoked before approval.");
    if (!(await this.requesterMatchesGrant(call.run.requestedBy, call.grant.allowedGroups, call.grant.allowedAdminRoles, client))) {
      throw new ToolingDeniedError("The requesting identity no longer satisfies the tool grant.");
    }
    const documentId = this.documentId(jsonObject(call.arguments));
    const document = await client.document.findFirst({
      where: {
        id: documentId,
        ownerSubject: call.run.ownerSubject,
        status: "READY",
        deletedAt: null,
        supermemoryProjection: { is: { status: "READY", externalDocumentId: { not: null } } },
      },
      select: { id: true },
    });
    if (!document) throw new ToolingDeniedError("The target document is no longer eligible within owner-only scope.");
  }

  private async completeCall(callId: string, data: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.governedToolCall.update({ where: { id: callId }, data: { status: "COMPLETED", result: data as Prisma.InputJsonValue, completedAt: new Date() } }),
      this.prisma.auditEvent.create({ data: { actorType: "SERVICE", action: "tool.call_completed", resourceType: "GovernedToolCall", resourceId: callId, outcome: "SUCCESS" } }),
    ]);
  }

  private async failCall(callId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.governedToolCall.update({ where: { id: callId }, data: { status: "FAILED", errorCode, errorMessage, completedAt: new Date() } }),
      this.prisma.auditEvent.create({ data: { actorType: "SERVICE", action: "tool.call_failed", resourceType: "GovernedToolCall", resourceId: callId, outcome: "FAILURE", metadata: { errorCode } } }),
    ]);
  }

  private existingResult(call: Parameters<typeof callDto>[0]): GovernedToolResult {
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
    const existing = await this.prisma.governedToolCall.findUnique({
      where: { runId_requestId: { runId, requestId } },
      include: callInclude,
    });
    if (!existing) return null;
    const arguments_ = jsonObject(existing.arguments);
    if (existing.tool.slug !== toolSlug || arguments_.documentId !== documentId) {
      throw new ToolingDeniedError("The request ID was already used for a different tool invocation.");
    }
    return this.existingResult(existing as Parameters<typeof callDto>[0]);
  }

  private async expireApprovals(): Promise<void> {
    const expired = await this.prisma.toolApproval.findMany({ where: { status: "PENDING", expiresAt: { lte: new Date() } }, select: { id: true, callId: true } });
    if (expired.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.toolApproval.updateMany({ where: { id: { in: expired.map(({ id }) => id) }, status: "PENDING" }, data: { status: "EXPIRED", decidedAt: new Date(), decisionReason: "Approval expired before review." } }),
      this.prisma.governedToolCall.updateMany({ where: { id: { in: expired.map(({ callId }) => callId) }, status: "APPROVAL_PENDING" }, data: { status: "DENIED", errorCode: "APPROVAL_EXPIRED", errorMessage: "Approval expired before review.", completedAt: new Date() } }),
      this.prisma.auditEvent.createMany({ data: expired.map(({ id, callId }) => ({
        actorType: "SERVICE" as const,
        action: "tool.approval_expired",
        resourceType: "ToolApproval",
        resourceId: id,
        outcome: "FAILURE" as const,
        metadata: { callId },
      })) }),
    ]);
  }
}

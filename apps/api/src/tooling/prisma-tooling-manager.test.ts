import { createHash } from "node:crypto";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import { ToolingConflictError, ToolingDeniedError } from "./tooling-manager.js";
import { PrismaToolingManager } from "./prisma-tooling-manager.js";

const RUN_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const REQUEST_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const DOCUMENT_ID = "b41d3534-658b-4cf0-a046-2b20b15f44e5";
const SESSION_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const TOOL_ID = "d160a1a0-7218-48a4-8a9f-7e1681280fe4";
const GRANT_ID = "9a36cfb0-37ee-4772-9aee-4df72a809ddb";
const APPROVAL_ID = "b36b4ce0-6aac-4dd6-9b59-0e361f942e8d";
const capability = "b".repeat(43);
const now = new Date("2026-07-30T00:00:00.000Z");

function hash(value: string) { return createHash("sha256").update(value).digest(); }
describe("PrismaToolingManager", () => {
  it("authenticates a revocable gateway credential by prefix and constant-time digest", async () => {
    const token = `orcasynapse_mcp_${"a".repeat(43)}`;
    const update = vi.fn(async () => ({}));
    const prisma = { mcpGatewayCredential: {
      findUnique: vi.fn(async () => ({ id: TOOL_ID, enabled: true, revokedAt: null, tokenHash: hash(token) })), update,
    } } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaToolingManager(prisma);
    await expect(manager.authenticateGateway(token)).resolves.toBe(true);
    await expect(manager.authenticateGateway("bad-token")).resolves.toBe(false);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastUsedAt: expect.any(Date) }) }));
  });

  it("denies every invocation while the global gateway boundary is disabled", async () => {
    const prisma = {
      governedToolCall: { findUnique: vi.fn(async () => null) },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: false, reason: "Acceptance pending" })) },
      agentRun: { findUnique: vi.fn() }, governedTool: { findUnique: vi.fn() },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaToolingManager(prisma);
    await expect(manager.invoke("document_metadata_read", {
      authorization: `${RUN_ID}.${capability}`, requestId: REQUEST_ID, arguments: { documentId: DOCUMENT_ID },
    })).rejects.toBeInstanceOf(ToolingDeniedError);
  });

  it("validates the run capability before consulting an idempotent call result", async () => {
    const callLookup = vi.fn(async () => ({ id: REQUEST_ID }));
    const prisma = {
      governedToolCall: { findUnique: callLookup },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true, approvalTtlMinutes: 15 })) },
      agentRun: { findUnique: vi.fn(async () => ({
        id: RUN_ID,
        status: "RUNNING",
        toolCapabilityTokenHash: hash("a".repeat(43)),
        toolCapabilityExpiresAt: new Date(Date.now() + 60_000),
        profile: { slug: "hermes-analyst", status: "ACTIVE", activeVersion: 1 },
        version: { toolGrants: [] },
      })) },
      governedTool: { findUnique: vi.fn(async () => null) },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaToolingManager(prisma);

    await expect(manager.invoke("document_metadata_read", {
      authorization: `${RUN_ID}.${capability}`,
      requestId: REQUEST_ID,
      arguments: { documentId: DOCUMENT_ID },
    })).rejects.toThrow("run capability is invalid");
    expect(callLookup).not.toHaveBeenCalled();
  });

  it("revalidates the run, active version, role grant, capability, and owner scope before a read", async () => {
    const tool = {
      id: TOOL_ID, slug: "document_metadata_read", displayName: "Read document metadata", description: "Read metadata",
      risk: "READ_ONLY", status: "ACTIVE", handlerKey: "builtin.document_metadata_read", inputSchema: {}, createdAt: now, updatedAt: now,
    };
    const grant = { id: GRANT_ID, toolId: TOOL_ID, enabled: true, allowedGroups: [], allowedAdminRoles: ["PLATFORM_ADMIN"], resourceScope: "OWNER_ONLY", tool };
    const run = {
      id: RUN_ID, status: "RUNNING", requestedBy: SESSION_ID, ownerSubject: "platform-admin", profileVersion: 1,
      toolCapabilityTokenHash: hash(capability), toolCapabilityExpiresAt: new Date(Date.now() + 60_000),
      profile: { slug: "hermes-analyst", status: "ACTIVE", activeVersion: 1 },
      version: { toolGrants: [grant] },
    };
    const callCreate = vi.fn(async () => ({ id: REQUEST_ID }));
    const callUpdate = vi.fn(async () => ({}));
    const auditCreate = vi.fn(async () => ({}));
    const prismaBase: any = {
      governedToolCall: { findUnique: vi.fn(async () => null), create: callCreate, update: callUpdate },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true, approvalTtlMinutes: 15 })) },
      agentRun: { findUnique: vi.fn(async () => run) }, governedTool: { findUnique: vi.fn(async () => tool) },
      administratorSession: { findFirst: vi.fn(async () => ({ role: "PLATFORM_ADMIN" })) },
      enterpriseUserSession: { findFirst: vi.fn() },
      document: { findFirst: vi.fn(async () => ({
        id: DOCUMENT_ID, fileName: "policy.pdf", mediaType: "application/pdf", sizeBytes: 1000n,
        classification: "CONFIDENTIAL", status: "READY", processingGeneration: 1, memoryPublication: null,
        createdAt: now, updatedAt: now,
      })) },
      auditEvent: { create: auditCreate },
    };
    prismaBase.$transaction = vi.fn(async (value: unknown) => Array.isArray(value) ? Promise.all(value) : (value as (tx: unknown) => Promise<unknown>)(prismaBase));
    const manager = new PrismaToolingManager(prismaBase as OrcaSynapsePrismaClient);

    await expect(manager.listToolsForRun(`${RUN_ID}.${capability}`)).resolves.toMatchObject({
      items: [{ slug: "document_metadata_read" }],
    });
    await expect(manager.invoke("document_metadata_read", {
      authorization: `${RUN_ID}.${capability}`, requestId: REQUEST_ID, arguments: { documentId: DOCUMENT_ID },
    })).resolves.toMatchObject({ status: "COMPLETED", data: { fileName: "policy.pdf", documentId: DOCUMENT_ID } });
    expect(callCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ arguments: { documentId: DOCUMENT_ID } }) }));
    expect(JSON.stringify(callCreate.mock.calls)).not.toContain(capability);
  });

  it("will not enable the tool runtime without both a credential and a grant", async () => {
    const prisma = {
      mcpGatewayCredential: { count: vi.fn(async () => 1) }, agentToolGrant: { count: vi.fn(async () => 0) },
      auditEvent: { create: vi.fn(async () => ({})) },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaToolingManager(prisma);
    await expect(manager.updateRuntimeControl({ id: SESSION_ID, subject: "admin" }, {
      enabled: true, reason: "Pilot approved", approvalTtlMinutes: 15,
    })).rejects.toBeInstanceOf(ToolingConflictError);
  });

  it("will not enable governed tools unless Hermes confirms private handoff support", async () => {
    const auditCreate = vi.fn(async () => ({}));
    const prisma = {
      mcpGatewayCredential: { count: vi.fn(async () => 1) },
      agentToolGrant: { count: vi.fn(async () => 1) },
      auditEvent: { create: auditCreate },
    } as unknown as OrcaSynapsePrismaClient;
    const boundary = { assertGovernedToolBoundary: vi.fn(async () => { throw new Error("unsupported"); }) };
    const manager = new PrismaToolingManager(prisma, boundary);
    await expect(manager.updateRuntimeControl({ id: SESSION_ID, subject: "admin" }, {
      enabled: true, reason: "Pilot approved", approvalTtlMinutes: 15,
    })).rejects.toThrow("private governed-tool handoff");
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "tool.runtime_enable_denied", outcome: "FAILURE" }),
    }));
  });

  it("commits an approved decision and its durable dispatch in one transaction", async () => {
    const toolActionDispatchCreate = vi.fn(async () => ({ id: REQUEST_ID }));
    const approval = {
      id: APPROVAL_ID,
      callId: REQUEST_ID,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
      decisionReason: null,
      decisionBy: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
      call: {
        id: REQUEST_ID,
        runId: RUN_ID,
        toolId: TOOL_ID,
        grantId: GRANT_ID,
        status: "APPROVAL_PENDING",
        arguments: { documentId: DOCUMENT_ID },
        run: {
          id: RUN_ID,
          status: "RUNNING",
          ownerSubject: "platform-admin",
          requestedBy: SESSION_ID,
          profileVersionId: "6f0b696b-9447-4932-848c-7f4c5295f935",
          profileVersion: 1,
          toolCapabilityTokenHash: hash(capability),
          toolCapabilityExpiresAt: new Date(Date.now() + 60_000),
          profile: { slug: "hermes-analyst", status: "ACTIVE", activeVersion: 1 },
        },
        tool: {
          id: TOOL_ID,
          slug: "document_memory_resync",
          displayName: "Resynchronize document memory",
          risk: "CONSEQUENTIAL",
          status: "ACTIVE",
          handlerKey: "builtin.document_memory_resync",
        },
        grant: {
          id: GRANT_ID,
          toolId: TOOL_ID,
          profileVersionId: "6f0b696b-9447-4932-848c-7f4c5295f935",
          enabled: true,
          allowedGroups: [],
          allowedAdminRoles: ["PLATFORM_ADMIN"],
          resourceScope: "OWNER_ONLY",
        },
      },
    };
    const approved = {
      ...approval,
      status: "APPROVED",
      decisionReason: "Approved for the pilot.",
      decisionBy: SESSION_ID,
      decidedAt: now,
    };
    const prismaBase: any = {
      $executeRaw: vi.fn(async () => 1),
      toolApproval: {
        findUnique: vi.fn(async () => approval),
        update: vi.fn(async () => approved),
        findUniqueOrThrow: vi.fn(async () => approved),
      },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true })) },
      administratorSession: { findFirst: vi.fn(async () => ({ role: "PLATFORM_ADMIN" })) },
      enterpriseUserSession: { findFirst: vi.fn() },
      document: { findFirst: vi.fn(async () => ({ id: DOCUMENT_ID })) },
      governedToolCall: { update: vi.fn(async () => ({})) },
      toolActionDispatch: { create: toolActionDispatchCreate },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    prismaBase.$transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(prismaBase));
    const manager = new PrismaToolingManager(prismaBase as OrcaSynapsePrismaClient);

    await expect(manager.decideApproval(
      { id: SESSION_ID, subject: "platform-admin" },
      APPROVAL_ID,
      { decision: "APPROVE", reason: "Approved for the pilot." },
    )).resolves.toMatchObject({ id: APPROVAL_ID, status: "APPROVED" });

    expect(toolActionDispatchCreate).toHaveBeenCalledWith({ data: { callId: REQUEST_ID } });
    expect(prismaBase.governedToolCall.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "EXECUTING" }),
    }));
  });

  it("cancels approval when the originating run capability was revoked", async () => {
    const approval = {
      id: APPROVAL_ID, callId: REQUEST_ID, status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000), decisionReason: null, decisionBy: null, decidedAt: null,
      createdAt: now, updatedAt: now,
      call: {
        id: REQUEST_ID, runId: RUN_ID, toolId: TOOL_ID, grantId: GRANT_ID,
        status: "APPROVAL_PENDING", arguments: { documentId: DOCUMENT_ID },
        run: {
          id: RUN_ID, status: "DENIED", ownerSubject: "platform-admin", requestedBy: SESSION_ID,
          profileVersionId: "6f0b696b-9447-4932-848c-7f4c5295f935", profileVersion: 1,
          toolCapabilityTokenHash: null, toolCapabilityExpiresAt: null,
          profile: { slug: "hermes-analyst", status: "ACTIVE", activeVersion: 1 },
        },
        tool: { id: TOOL_ID, slug: "document_memory_resync", displayName: "Resynchronize document memory", risk: "CONSEQUENTIAL", status: "ACTIVE", handlerKey: "builtin.document_memory_resync" },
        grant: { id: GRANT_ID, toolId: TOOL_ID, profileVersionId: "6f0b696b-9447-4932-848c-7f4c5295f935", enabled: true, allowedGroups: [], allowedAdminRoles: ["PLATFORM_ADMIN"], resourceScope: "OWNER_ONLY" },
      },
    };
    const approvalUpdate = vi.fn(async () => approval);
    const callUpdate = vi.fn(async () => ({}));
    const prismaBase: any = {
      $executeRaw: vi.fn(async () => 1),
      toolApproval: { findUnique: vi.fn(async () => approval), update: approvalUpdate },
      governedToolCall: { update: callUpdate },
      auditEvent: { create: vi.fn(async () => ({})) },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true })) },
    };
    prismaBase.$transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(prismaBase));

    await expect(new PrismaToolingManager(prismaBase as OrcaSynapsePrismaClient).decideApproval(
      { id: SESSION_ID, subject: "platform-admin" }, APPROVAL_ID,
      { decision: "APPROVE", reason: "Approved for the pilot." },
    )).rejects.toThrow("originating agent run is no longer authorized");
    expect(approvalUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
    expect(callUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DENIED", errorCode: "AUTHORIZATION_REVOKED" }) }));
  });
});

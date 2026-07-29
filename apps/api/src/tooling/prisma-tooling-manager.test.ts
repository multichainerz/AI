import { createHash } from "node:crypto";
import type { AIHubPrismaClient } from "@aihub/database";
import type { MemoryManager } from "../memory/memory-manager.js";
import { describe, expect, it, vi } from "vitest";
import { ToolingConflictError, ToolingDeniedError } from "./tooling-manager.js";
import { PrismaToolingManager } from "./prisma-tooling-manager.js";

const RUN_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const REQUEST_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const DOCUMENT_ID = "b41d3534-658b-4cf0-a046-2b20b15f44e5";
const SESSION_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const TOOL_ID = "d160a1a0-7218-48a4-8a9f-7e1681280fe4";
const GRANT_ID = "9a36cfb0-37ee-4772-9aee-4df72a809ddb";
const capability = "b".repeat(43);
const now = new Date("2026-07-30T00:00:00.000Z");

function hash(value: string) { return createHash("sha256").update(value).digest(); }
function memory(): MemoryManager { return { list: vi.fn(), metrics: vi.fn(), reindex: vi.fn() } as unknown as MemoryManager; }

describe("PrismaToolingManager", () => {
  it("authenticates a revocable gateway credential by prefix and constant-time digest", async () => {
    const token = `aihub_mcp_${"a".repeat(43)}`;
    const update = vi.fn(async () => ({}));
    const prisma = { mcpGatewayCredential: {
      findUnique: vi.fn(async () => ({ id: TOOL_ID, enabled: true, revokedAt: null, tokenHash: hash(token) })), update,
    } } as unknown as AIHubPrismaClient;
    const manager = new PrismaToolingManager(prisma, memory());
    await expect(manager.authenticateGateway(token)).resolves.toBe(true);
    await expect(manager.authenticateGateway("bad-token")).resolves.toBe(false);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastUsedAt: expect.any(Date) }) }));
  });

  it("denies every invocation while the global gateway boundary is disabled", async () => {
    const prisma = {
      governedToolCall: { findUnique: vi.fn(async () => null) },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: false, reason: "Acceptance pending" })) },
      agentRun: { findUnique: vi.fn() }, governedTool: { findUnique: vi.fn() },
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaToolingManager(prisma, memory());
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
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaToolingManager(prisma, memory());

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
    const manager = new PrismaToolingManager(prismaBase as AIHubPrismaClient, memory());

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
    } as unknown as AIHubPrismaClient;
    const manager = new PrismaToolingManager(prisma, memory());
    await expect(manager.updateRuntimeControl({ id: SESSION_ID, subject: "admin" }, {
      enabled: true, reason: "Pilot approved", approvalTtlMinutes: 15,
    })).rejects.toBeInstanceOf(ToolingConflictError);
  });
});

import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import { AgentConflictError, AgentRuntimeDisabledError, type AgentPrincipal } from "./agent-manager.js";
import { PrismaAgentManager } from "./prisma-agent-manager.js";

const PROFILE_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const RUN_ID = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
const VERSION_ID = "b41d3534-658b-4cf0-a046-2b20b15f44e5";
const EVALUATION_ID = "de44bc5d-0355-4c3f-872e-1af99f356d19";
const MODEL_ROUTE_ID = "5277951c-7d22-4cec-8d46-fad3afba37dd";
const USER_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const now = new Date("2026-07-30T00:00:00.000Z");
const principal: AgentPrincipal = { id: USER_ID, subject: "user:pilot", identityMode: "ENTERPRISE", scopes: ["agents:use"] };

function version(versionNumber: number) {
  return {
    id: versionNumber === 1 ? VERSION_ID : "9a36cfb0-37ee-4772-9aee-4df72a809ddb",
    version: versionNumber,
    displayName: `Hermes Analyst v${versionNumber}`,
    purpose: "Internal analysis",
    instructions: "Answer from authorized evidence only.",
    soulMd: "You are a careful internal analyst who follows the approved evidence.",
    skills: [],
    distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 600,
    maxConcurrentRuns: 2,
    allowPrivateKnowledge: true,
    safeMode: true,
    createdBy: USER_ID,
    createdAt: now,
  };
}

function storedRun() {
  return {
    id: RUN_ID, profileId: PROFILE_ID, profileVersionId: VERSION_ID, profileVersion: 1, profileDistributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerSubject: principal.subject, requestedBy: principal.id, status: "QUEUED", input: "Analyze policy",
    output: null, effectiveCapabilities: ["knowledge:private:read"], sources: [], externalRunId: null,
    jobId: null, failureCode: null, failureMessage: null, queuedAt: now, startedAt: null, completedAt: null,
    createdAt: now, updatedAt: now, profile: { slug: "hermes-analyst" }, version: { displayName: "Hermes Analyst v1", distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  };
}

describe("PrismaAgentManager", () => {
  it("shows the current draft version to administrators and only the active version to users", async () => {
    const profile = {
      id: PROFILE_ID, slug: "hermes-analyst", status: "ACTIVE", currentVersion: 2, activeVersion: 1,
      createdAt: now, updatedAt: now, versions: [version(2), version(1)],
    };
    const prisma = { agentProfile: { findMany: vi.fn(async () => [profile]) } } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaAgentManager(prisma);

    await expect(manager.listProfiles(principal, true)).resolves.toMatchObject({ items: [{ version: { version: 2 }, activeVersionConfiguration: { version: 1 } }] });
    await expect(manager.listProfiles(principal, false)).resolves.toMatchObject({ items: [{ version: { version: 1 }, activeVersionConfiguration: { version: 1 } }] });
  });

  it("atomically checks runtime, active version, concurrency, and records durable work", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      agentRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true, reason: "Verified" })) },
      agentProfile: { findUnique: vi.fn(async () => ({ id: PROFILE_ID, status: "ACTIVE", activeVersion: 1 })) },
      hermesRuntimeNode: { findMany: vi.fn(async () => [{
        status: "ONLINE", lastSeenAt: new Date(), serviceConnection: { enabled: true, status: "HEALTHY" },
      }]) },
      agentProfileVersion: { findUnique: vi.fn(async () => version(1)) },
      agentRun: { count: vi.fn(async () => 0), create: vi.fn(async () => storedRun()) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
      agentRun: { update: vi.fn(async () => ({ ...storedRun(), jobId: "f9558542-48f4-4b96-a536-65036114af6c" })) },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaAgentManager(prisma);

    await expect(manager.submitRun(principal, { profileId: PROFILE_ID, input: "Analyze policy" })).resolves.toMatchObject({
      id: RUN_ID, status: "QUEUED", effectiveCapabilities: ["knowledge:private:read"],
    });
    expect(transaction.agentRun.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ profileId: PROFILE_ID }) }));
    expect(transaction.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ jobId: expect.any(String) }),
    }));
  });

  it("denies submission fail-closed when the global runtime row is absent", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      agentRuntimeControl: { findUnique: vi.fn(async () => null) },
      agentProfile: { findUnique: vi.fn(async () => ({ id: PROFILE_ID, status: "ACTIVE", activeVersion: 1 })) },
      hermesRuntimeNode: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaAgentManager(prisma);

    await expect(manager.submitRun(principal, { profileId: PROFILE_ID, input: "Analyze policy" })).rejects.toBeInstanceOf(AgentRuntimeDisabledError);
  });

  it("rejects new work while the Hermes runtime is draining", async () => {
    const transaction = {
      $executeRaw: vi.fn(async () => 1),
      agentRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: true, reason: "Verified" })) },
      agentProfile: { findUnique: vi.fn(async () => ({ id: PROFILE_ID, status: "ACTIVE", activeVersion: 1 })) },
      hermesRuntimeNode: { findMany: vi.fn(async () => [{
        status: "DRAINING", lastSeenAt: new Date(), serviceConnection: { enabled: true, status: "HEALTHY" },
      }]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAgentManager(prisma).submitRun(principal, { profileId: PROFILE_ID, input: "Analyze policy" }))
      .rejects.toThrow("draining");
  });

  it("requires the authenticated zero-tool boundary before enabling execution", async () => {
    const boundaryVerifier = {
      assertZeroToolBoundary: vi.fn(async () => { throw new Error("toolset enabled"); }),
      assertGovernedToolBoundary: vi.fn(async () => undefined),
    };
    const auditCreate = vi.fn(async () => ({}));
    const transaction = vi.fn();
    const prisma = {
      $transaction: transaction,
      auditEvent: { create: auditCreate },
      toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: false })) },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaAgentManager(prisma, boundaryVerifier);

    await expect(manager.updateRuntimeControl(principal, { enabled: true, reason: "Acceptance verification" })).rejects.toBeInstanceOf(AgentRuntimeDisabledError);
    expect(boundaryVerifier.assertZeroToolBoundary).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "agent.runtime_enable_denied", outcome: "FAILURE" }) }));
  });

  it("requires promoted evaluation evidence before activating an agent version", async () => {
    const transaction = {
      agentProfile: {
        findUnique: vi.fn(async () => ({ id: PROFILE_ID, slug: "hermes-analyst", currentVersion: 1, activeVersion: null })),
        update: vi.fn(),
      },
      agentProfileVersion: { findUnique: vi.fn(async () => ({ modelAlias: "hermes-agent", distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) },
      componentCompatibility: { findUnique: vi.fn(async () => ({ status: "PASSED" })) },
      modelDeployment: { count: vi.fn(async () => 0), findFirst: vi.fn() },
      evaluationRun: { findFirst: vi.fn(async () => null) },
      auditEvent: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAgentManager(prisma).activateProfile(principal, PROFILE_ID))
      .rejects.toBeInstanceOf(AgentConflictError);
    expect(transaction.agentProfile.update).not.toHaveBeenCalled();
  });

  it("fails closed when Hermes compatibility has not passed", async () => {
    const transaction = {
      agentProfile: {
        findUnique: vi.fn(async () => ({ id: PROFILE_ID, slug: "hermes-analyst", currentVersion: 1, activeVersion: null })),
        update: vi.fn(),
      },
      agentProfileVersion: { findUnique: vi.fn(async () => ({ modelAlias: "hermes-agent", distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) },
      componentCompatibility: {
        findUnique: vi.fn(async () => null),
      },
      modelDeployment: { count: vi.fn(), findFirst: vi.fn() },
      evaluationRun: { findFirst: vi.fn() },
      auditEvent: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAgentManager(prisma).standbyProfile(principal, PROFILE_ID))
      .rejects.toThrow("Run Setup and pass Hermes compatibility");
    expect(transaction.modelDeployment.count).not.toHaveBeenCalled();
    expect(transaction.agentProfile.update).not.toHaveBeenCalled();
  });

  it("links promoted evidence to the agent activation audit", async () => {
    const updatedProfile = {
      id: PROFILE_ID, slug: "hermes-analyst", status: "ACTIVE", currentVersion: 1, activeVersion: 1,
      createdAt: now, updatedAt: now, versions: [version(1)],
    };
    const transaction = {
      agentProfile: {
        findUnique: vi.fn(async () => ({ id: PROFILE_ID, slug: "hermes-analyst", currentVersion: 1, activeVersion: null })),
        update: vi.fn(async () => updatedProfile),
      },
      agentProfileVersion: { findUnique: vi.fn(async () => ({ modelAlias: "hermes-agent", distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) },
      componentCompatibility: { findUnique: vi.fn(async () => ({ status: "PASSED" })) },
      modelDeployment: { count: vi.fn(async () => 1), findFirst: vi.fn(async () => ({ id: MODEL_ROUTE_ID })) },
      evaluationRun: { findFirst: vi.fn(async () => ({ id: EVALUATION_ID })) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAgentManager(prisma).activateProfile(principal, PROFILE_ID))
      .resolves.toMatchObject({ status: "ACTIVE", activeVersion: 1 });
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: expect.objectContaining({ evaluationRunId: EVALUATION_ID, modelRouteId: MODEL_ROUTE_ID }) }),
    }));
  });

  it("fails closed when the profile alias has no active agent model route", async () => {
    const transaction = {
      agentProfile: {
        findUnique: vi.fn(async () => ({ id: PROFILE_ID, slug: "hermes-analyst", currentVersion: 1, activeVersion: null })),
        update: vi.fn(),
      },
      agentProfileVersion: { findUnique: vi.fn(async () => ({ modelAlias: "hermes-agent", distributionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) },
      componentCompatibility: { findUnique: vi.fn(async () => ({ status: "PASSED" })) },
      modelDeployment: { count: vi.fn(async () => 1), findFirst: vi.fn(async () => null) },
      evaluationRun: { findFirst: vi.fn(async () => ({ id: EVALUATION_ID })) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)) } as unknown as OrcaSynapsePrismaClient;

    await expect(new PrismaAgentManager(prisma).activateProfile(principal, PROFILE_ID))
      .rejects.toThrow("Activate the 'hermes-agent' agent model route");
    expect(transaction.modelDeployment.count).toHaveBeenCalledWith({
      where: { workload: "AGENT", firstActivatedAt: { not: null } },
    });
    expect(transaction.evaluationRun.findFirst).not.toHaveBeenCalled();
    expect(transaction.agentProfile.update).not.toHaveBeenCalled();
  });
});

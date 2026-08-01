import type { ArchitectureDecision, ComponentCompatibility, OnboardingStep } from "@aihub/contracts";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { AIHubPrismaClient } from "@aihub/database";
import { calculateOnboardingGate, PrismaOnboardingManager } from "./prisma-onboarding-manager.js";

const architecture: ArchitectureDecision = {
  topologyMode: "CONTROL_PLANE",
  targetEnvironment: "DEVELOPMENT",
  reason: null,
  revision: 0,
  updatedBy: null,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function component(key: string, required: boolean, status: ComponentCompatibility["status"]): ComponentCompatibility {
  return {
    key, displayName: key, category: "Test", required, requirementReason: required ? "Test baseline" : "Not selected", expectedContract: "A tested component contract.",
    evidenceSource: status === "PASSED" ? "AUTOMATED" : null,
    status, observedVersion: status === "PASSED" ? "1.0.0" : null,
    evidenceRef: status === "PASSED" ? `report:${key}` : null, note: null, testedAt: null,
    updatedBy: null, revision: 0, updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

const step: OnboardingStep = {
  key: "system-topology", ordinal: 2, title: "System and topology",
  description: "Verify deployment evidence.", required: true, automated: true, action: "Validate host", status: "COMPLETED",
  evidenceRefs: ["report:preflight"], note: null, revision: 1, updatedBy: null,
  completedAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
};

describe("production onboarding gate", () => {
  it("passes only required contracts and steps in the baseline architecture", () => {
    const gate = calculateOnboardingGate(architecture, [
      component("hermes-api", true, "PASSED"),
      component("hermes-native-memory", false, "NOT_TESTED"),
    ], [step]);
    expect(gate).toMatchObject({ ready: true, requiredComponents: 1, passedComponents: 1, requiredSteps: 1, completedSteps: 1 });
  });

  it("blocks a required component until its compatibility passes", () => {
    const gate = calculateOnboardingGate(architecture, [
      component("hermes-api", true, "PASSED"),
      component("hermes-native-memory", true, "NOT_TESTED"),
    ], [step]);
    expect(gate.ready).toBe(false);
    expect(gate.blockers).toContain("hermes-native-memory: not tested");
  });

  it("requires verified encryption-key recovery for Production", () => {
    const gate = calculateOnboardingGate({ ...architecture, targetEnvironment: "PRODUCTION" }, [
      component("hermes-api", true, "PASSED"),
    ], [step], {
      status: "EXPORTED", keyFingerprint: "a".repeat(64), kitChecksum: "b".repeat(64),
      recoveryOwner: "Infrastructure", exportedAt: "2026-07-30T00:00:00.000Z", verifiedAt: null, revision: 1,
    }, "READY");
    expect(gate.ready).toBe(false);
    expect(gate.blockers[0]).toContain("Credential recovery");
  });

  it("requires the current readiness authority before Production activation", () => {
    const gate = calculateOnboardingGate({ ...architecture, targetEnvironment: "PRODUCTION" }, [
      component("hermes-api", true, "PASSED"),
    ], [step], {
      status: "VERIFIED", keyFingerprint: "a".repeat(64), kitChecksum: "b".repeat(64),
      recoveryOwner: "Infrastructure", exportedAt: "2026-07-30T00:00:00.000Z", verifiedAt: "2026-07-30T00:05:00.000Z", revision: 1,
    }, "NOT_READY");

    expect(gate.ready).toBe(false);
    expect(gate.blockers).toContain("Production readiness: status is not ready");
  });

  it("invalidates component and stage evidence when architecture changes", async () => {
    const componentUpdateMany = vi.fn(async () => ({ count: 21 }));
    const stepUpdateMany = vi.fn(async () => ({ count: 7 }));
    const current = {
      id: "global",
      ...architecture,
      updatedAt: new Date(architecture.updatedAt),
    };
    const transaction: any = {
      $executeRaw: vi.fn(async () => 1),
      componentCompatibility: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })), updateMany: componentUpdateMany },
      onboardingStep: { upsert: vi.fn(async () => ({})), updateMany: stepUpdateMany },
      platformArchitectureDecision: {
        upsert: vi.fn(async () => current),
        findUniqueOrThrow: vi.fn(async () => current),
        update: vi.fn(async ({ data }: any) => ({ ...current, targetEnvironment: data.targetEnvironment, revision: 1, reason: data.reason })),
      },
      onboardingJourney: {
        upsert: vi.fn(async () => ({})),
        findUniqueOrThrow: vi.fn(async () => ({ id: "global", startedAt: null })),
        update: vi.fn(async () => ({})),
      },
      credentialRecoveryControl: { upsert: vi.fn(async () => ({})) },
      auditEvent: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction)),
    } as unknown as AIHubPrismaClient;

    await new PrismaOnboardingManager(prisma).updateArchitecture({ id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb" } as any, {
      expectedRevision: 0,
      targetEnvironment: "PRODUCTION",
      reason: "Promote the validated architecture to Production.",
    });

    expect(componentUpdateMany).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "NOT_TESTED", evidenceRef: null, revision: { increment: 1 } }) });
    expect(stepUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { key: { in: expect.not.arrayContaining(["activate-installation"]) } },
      data: expect.objectContaining({ status: "NOT_STARTED", evidenceRefs: [] }),
    }));
  });
});

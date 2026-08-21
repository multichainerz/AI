import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  componentCompatibility,
  createTestDatabase,
  guardrailPolicy,
  localAdministrator,
  onboardingEvidence,
  onboardingStep,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { calculateOnboardingGate, DrizzleOnboardingManager } from "./drizzle-onboarding-manager.js";
import { OnboardingConflictError, OnboardingNotFoundError } from "./onboarding-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal = { id: randomUUID() } as AdminPrincipal;
const masterKey = new Uint8Array(32).fill(9);

function manager(readiness?: { productionReadiness(): Promise<never> }) {
  return new DrizzleOnboardingManager(context.database, masterKey, readiness as never);
}

async function provisionAdministrator() {
  await context.database.insert(localAdministrator).values({
    username: "admin",
    displayName: "Local Administrator",
    passwordHash: "argon2id$placeholder",
    role: "PLATFORM_ADMIN",
  });
}


describe("DrizzleOnboardingManager state seeding", () => {
  it("seeds the component and stage catalogue idempotently", async () => {
    const first = await manager().snapshot();
    const second = await manager().snapshot();

    expect(first.components.length).toBeGreaterThan(10);
    expect(second.components.length).toBe(first.components.length);
    expect(second.steps.map(({ key }) => key)).toEqual([
      "activate-installation", "system-topology", "identity-recovery", "ai-services",
      "hermes-profiles", "guardrails-tools", "validate-activate",
    ]);
    expect(second.journey.currentStepKey).toBe("activate-installation");
  });

  it("prunes contracts that were withdrawn or renamed", async () => {
    await manager().snapshot();
    await context.database.insert(componentCompatibility).values([
      { key: "legacy-installer", displayName: "Renamed", category: "Deployment", expectedContract: "gone" },
    ]);

    const snapshot = await manager().snapshot();

    const keys = snapshot.components.map(({ key }) => key);
    expect(keys).not.toContain("legacy-installer");
    expect(keys).toContain("signed-installer");
    // The ORM contract carries the ORM actually in use.
    expect(keys).toContain("database-orm");
    expect(keys).not.toContain("prisma-pg");
  });

  it("reports installation activation from the provisioned administrator", async () => {
    expect((await manager().snapshot()).installation).toMatchObject({ status: "UNKNOWN", activatedAt: null });

    await provisionAdministrator();

    const snapshot = await manager().snapshot();
    expect(snapshot.installation.status).toBe("ACTIVATED");
    expect(snapshot.installation.activatedAt).not.toBeNull();
  });
});

describe("DrizzleOnboardingManager architecture", () => {
  it("refuses a stale expected revision", async () => {
    await manager().snapshot();

    await expect(manager().updateArchitecture(principal, {
      topologyMode: "SEGMENTED", reason: "Isolating Hermes", expectedRevision: 99,
    } as never)).rejects.toBeInstanceOf(OnboardingConflictError);
  });

  it("completes the topology stage on a deployment nobody wrote a rationale for", async () => {
    /*
     * The stage gated PASSED on `reason`, a nullable column whose only writer is
     * `updateArchitecture` -- and the web client that called it was removed, so
     * on every install created at v8.9.0 or later it is null forever. One FAILED
     * check makes `applyValidation` write the step BLOCKED, so `system-topology`
     * could never complete on any deployment, for a reason no operator could act
     * on. Nothing is touched here before validating: this is a fresh install.
     */
    await provisionAdministrator();

    await manager().runValidation(principal, { stageKey: "system-topology" } as never);

    const snapshot = await manager().snapshot();
    expect(snapshot.steps.find(({ key }) => key === "system-topology")?.status).toBe("COMPLETED");
    expect(snapshot.architecture.reason).toBeNull();
  });

  it("invalidates every contract and stage when the architecture changes", async () => {
    await provisionAdministrator();
    await manager().runValidation(principal, { stageKey: "activate-installation" } as never);
    const before = await manager().snapshot();
    expect(before.steps.find(({ key }) => key === "activate-installation")?.status).toBe("COMPLETED");

    const updated = await manager().updateArchitecture(principal, {
      targetEnvironment: "PRODUCTION", reason: "Going to production", expectedRevision: before.architecture.revision,
    } as never);

    expect(updated).toMatchObject({ targetEnvironment: "PRODUCTION", revision: before.architecture.revision + 1 });
    const after = await manager().snapshot();
    expect(after.components.every(({ status }) => status === "NOT_TESTED")).toBe(true);
    // activate-installation is deliberately spared: the installation did not change.
    expect(after.steps.find(({ key }) => key === "activate-installation")?.status).toBe("COMPLETED");
    expect(after.steps.find(({ key }) => key === "system-topology")?.status).toBe("NOT_STARTED");
    expect(after.journey.currentStepKey).toBe("system-topology");
  });

  it("keeps evidence when only the rationale changes", async () => {
    await provisionAdministrator();
    await manager().runValidation(principal, { stageKey: "activate-installation" } as never);
    const before = await manager().snapshot();

    await manager().updateArchitecture(principal, {
      reason: "Clarifying the rationale", expectedRevision: before.architecture.revision,
    } as never);

    const after = await manager().snapshot();
    expect(after.steps.find(({ key }) => key === "activate-installation")?.status).toBe("COMPLETED");
  });
});

describe("DrizzleOnboardingManager contracts and stages", () => {
  it("records an external attestation alongside the contract change", async () => {
    const before = await manager().snapshot();
    const target = before.components.find(({ key }) => key === "signed-installer")!;

    const after = await manager().updateComponent(principal, "signed-installer", {
      status: "PASSED", note: "Installer verified against the signed bundle.",
      observedVersion: "1.21.6", attestationAuthority: "release-engineering",
      expectedRevision: target.revision,
    } as never);

    expect(after.components.find(({ key }) => key === "signed-installer")).toMatchObject({
      status: "PASSED", observedVersion: "1.21.6",
    });
    const evidence = await context.database.select().from(onboardingEvidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ source: "EXTERNAL_ATTESTATION", code: "external-attestation-signed-installer" });
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toContain("onboarding.component_updated");
  });

  it("refuses a contract update against a stale revision or a missing key", async () => {
    await manager().snapshot();

    await expect(manager().updateComponent(principal, "signed-installer", {
      status: "PASSED", note: "x", expectedRevision: 99,
    } as never)).rejects.toBeInstanceOf(OnboardingConflictError);
    await expect(manager().updateComponent(principal, "not-a-contract", {
      status: "PASSED", note: "x", expectedRevision: 0,
    } as never)).rejects.toBeInstanceOf(OnboardingNotFoundError);
  });

  it("refuses to complete a stage by hand", async () => {
    const before = await manager().snapshot();
    const step = before.steps.find(({ key }) => key === "ai-services")!;

    await expect(manager().updateStep(principal, "ai-services", {
      status: "COMPLETED", note: "trust me", expectedRevision: step.revision,
    } as never)).rejects.toThrow(/automated validation evidence/);

    // Any other transition is allowed.
    const after = await manager().updateStep(principal, "ai-services", {
      status: "IN_PROGRESS", note: "Connecting the inference server.", expectedRevision: step.revision,
    } as never);
    expect(after.steps.find(({ key }) => key === "ai-services")?.status).toBe("IN_PROGRESS");
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toContain("onboarding.step_updated");
  });
});

describe("DrizzleOnboardingManager validation", () => {
  it("passes installation activation once an administrator exists", async () => {
    const blocked = await manager().runValidation(principal, { stageKey: "activate-installation" } as never);
    expect(blocked.steps.find(({ key }) => key === "activate-installation")?.status).toBe("BLOCKED");

    await provisionAdministrator();
    const passed = await manager().runValidation(principal, { stageKey: "activate-installation" } as never);

    expect(passed.steps.find(({ key }) => key === "activate-installation")).toMatchObject({
      status: "COMPLETED", evidenceRefs: [expect.stringMatching(/^validation:/)],
    });
  });

  it("reads the live PostgreSQL version through the raw query path", async () => {
    const snapshot = await manager().runValidation(principal, { stageKey: "system-topology" } as never);

    const postgres = snapshot.components.find(({ key }) => key === "postgresql");
    expect(postgres?.observedVersion).toMatch(/PostgreSQL/);
    expect(snapshot.components.find(({ key }) => key === "database-orm")).toMatchObject({
      status: "PASSED", observedVersion: "0.45.2",
    });
  });


  it("passes the Hermes profile stage from a checksummed distribution", async () => {
    const [profile] = await context.database
      .insert(agentProfile)
      .values({ slug: "support", status: "STANDBY", currentVersion: 1, activeVersion: 1 })
      .returning({ id: agentProfile.id });
    await context.database.insert(agentProfileVersion).values({
      profileId: profile!.id, version: 1, displayName: "Support", purpose: "Answer questions.",
      instructions: "Answer only the authorized request.", soulMd: "Careful assistant.",
      modelAlias: "hermes-agent", maxTurns: 1, timeoutSeconds: 120, maxConcurrentRuns: 1,
      distributionDigest: "a".repeat(64),
    });

    const snapshot = await manager().runValidation(principal, { stageKey: "hermes-profiles" } as never);

    expect(snapshot.steps.find(({ key }) => key === "hermes-profiles")?.status).toBe("COMPLETED");
  });

  it("treats the zero-tool posture as the passing development baseline", async () => {
    // GuardrailPolicy_activation_check still demands an activation timestamp on
    // an ACTIVE row, so the seed has to carry one.
    await context.database.insert(guardrailPolicy).values({
      slug: "baseline", displayName: "Baseline", description: "Conservative baseline.",
      version: "1", status: "ACTIVE", maxInputCharacters: 32_000,
      firstActivatedAt: new Date(),
    });

    const snapshot = await manager().runValidation(principal, { stageKey: "guardrails-tools" } as never);

    expect(snapshot.steps.find(({ key }) => key === "guardrails-tools")?.status).toBe("COMPLETED");
  });

  it("refuses a stage that does not exist", async () => {
    await expect(manager().runValidation(principal, { stageKey: "not-a-stage" } as never))
      .rejects.toBeInstanceOf(OnboardingNotFoundError);
  });

  it("does not let a warning demote a contract that already passed", async () => {
    await manager().runValidation(principal, { stageKey: "system-topology" } as never);
    const passed = await manager().snapshot();
    expect(passed.components.find(({ key }) => key === "database-orm")?.status).toBe("PASSED");

    // Production downgrades contract checks to warnings; the earlier pass stands.
    const architecture = passed.architecture;
    await manager().updateComponent(principal, "database-orm", {
      status: "PASSED", note: "Attested.", expectedRevision:
        passed.components.find(({ key }) => key === "database-orm")!.revision,
    } as never);
    await manager().updateArchitecture(principal, {
      targetEnvironment: "PRODUCTION", reason: "Going to production", expectedRevision: architecture.revision,
    } as never);
    await manager().updateComponent(principal, "database-orm", {
      status: "PASSED", note: "Attested.", expectedRevision:
        (await manager().snapshot()).components.find(({ key }) => key === "database-orm")!.revision,
    } as never);

    await manager().runValidation(principal, { stageKey: "system-topology" } as never);

    expect((await manager().snapshot()).components.find(({ key }) => key === "database-orm")?.status).toBe("PASSED");
  });
});

describe("DrizzleOnboardingManager recovery kit", () => {
  it("exports a kit and verifies it back into the recovery record", async () => {
    const before = await manager().snapshot();
    expect(before.recovery.status).toBe("NOT_EXPORTED");

    const exported = await manager().exportRecoveryKit(principal, {
      passphrase: "a-sufficiently-long-recovery-passphrase",
      recoveryOwner: "Security Officer",
      expectedRevision: before.recovery.revision,
    } as never);

    expect(exported.fileName).toMatch(/^orcasynapse-recovery-[0-9a-f]{12}\.json$/);
    const afterExport = await manager().snapshot();
    expect(afterExport.recovery).toMatchObject({
      status: "EXPORTED", recoveryOwner: "Security Officer", kitChecksum: exported.checksum,
    });

    const afterVerify = await manager().verifyRecoveryKit(principal, {
      serializedKit: exported.serializedKit,
      passphrase: "a-sufficiently-long-recovery-passphrase",
      expectedRevision: afterExport.recovery.revision,
    } as never);

    expect(afterVerify.recovery.status).toBe("VERIFIED");
  }, 60_000);

  it("refuses to verify a kit that is not the current export", async () => {
    const before = await manager().snapshot();
    const first = await manager().exportRecoveryKit(principal, {
      passphrase: "a-sufficiently-long-recovery-passphrase",
      recoveryOwner: "Security Officer",
      expectedRevision: before.recovery.revision,
    } as never);
    const afterFirst = await manager().snapshot();
    // A second export supersedes the first, so the first kit no longer matches.
    await manager().exportRecoveryKit(principal, {
      passphrase: "a-sufficiently-long-recovery-passphrase",
      recoveryOwner: "Security Officer",
      expectedRevision: afterFirst.recovery.revision,
    } as never);

    await expect(manager().verifyRecoveryKit(principal, {
      serializedKit: first.serializedKit,
      passphrase: "a-sufficiently-long-recovery-passphrase",
      expectedRevision: (await manager().snapshot()).recovery.revision,
    } as never)).rejects.toBeInstanceOf(OnboardingConflictError);
  }, 90_000);
});

describe("DrizzleOnboardingManager activation", () => {
  it("refuses to activate while blockers remain", async () => {
    const snapshot = await manager().snapshot();
    expect(snapshot.gate.ready).toBe(false);

    await expect(manager().complete(principal, {
      reason: "Shipping it", expectedRevision: snapshot.journey.revision,
    } as never)).rejects.toThrow(/remains blocked/);
  });

  it("records the activated environment once the gate is clear", async () => {
    await provisionAdministrator();
    // Attest every contract and stage the development gate requires.
    for (const component of (await manager().snapshot()).components.filter(({ required }) => required)) {
      await manager().updateComponent(principal, component.key, {
        status: "PASSED", note: "Attested for the development baseline.", expectedRevision: component.revision,
      } as never);
    }
    await context.database
      .update(onboardingStep)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(onboardingStep.key, onboardingStep.key));

    const ready = await manager().snapshot();
    expect(ready.gate.ready).toBe(true);

    const completed = await manager().complete(principal, {
      reason: "Development activation", expectedRevision: ready.journey.revision,
    } as never);

    expect(completed.journey).toMatchObject({
      status: "COMPLETED", activatedEnvironment: "DEVELOPMENT", currentStepKey: null,
    });
  }, 60_000);
});

describe("calculateOnboardingGate", () => {
  const architecture = {
    topologyMode: "COMPACT" as const, targetEnvironment: "DEVELOPMENT" as const, reason: "x",
    revision: 0, updatedBy: null, updatedAt: new Date().toISOString(),
  };

  it("blocks on a required contract and stage that have not passed", () => {
    const gate = calculateOnboardingGate(
      architecture,
      [{ required: true, status: "FAILED", displayName: "PostgreSQL" }] as never,
      [{ required: true, status: "BLOCKED", title: "System and topology" }] as never,
    );

    expect(gate.ready).toBe(false);
    expect(gate.blockers).toEqual(["PostgreSQL: failed", "System and topology: blocked"]);
    expect(gate).toMatchObject({ requiredComponents: 1, passedComponents: 0, requiredSteps: 1, completedSteps: 0 });
  });

  it("reports an optional failure as a warning rather than a blocker", () => {
    const gate = calculateOnboardingGate(
      architecture,
      [{ required: false, status: "FAILED", displayName: "MCP gateway" }] as never,
      [],
    );

    expect(gate.ready).toBe(true);
    expect(gate.warnings).toEqual(["MCP gateway: optional contract is failed"]);
  });

  it("requires verified recovery and readiness only for production", () => {
    const production = { ...architecture, targetEnvironment: "PRODUCTION" } as never;

    expect(calculateOnboardingGate(production, [], [], { status: "EXPORTED" } as never, "READY").blockers)
      .toEqual(["Credential recovery: an encrypted off-host recovery kit must be verified"]);
    expect(calculateOnboardingGate(production, [], [], { status: "VERIFIED" } as never, "UNAVAILABLE").blockers)
      .toEqual(["Production readiness: the readiness authority is unavailable"]);
    expect(calculateOnboardingGate(production, [], [], { status: "VERIFIED" } as never, "READY").ready).toBe(true);
    expect(calculateOnboardingGate(production, [], [], { status: "VERIFIED" } as never, "NOT_READY").ready).toBe(true);
    expect(calculateOnboardingGate(production, [], [], { status: "VERIFIED" } as never, "NOT_READY", 3).blockers)
      .toEqual(["Production readiness: status is not ready"]);
  });
});

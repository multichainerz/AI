import { ADMIN_SCOPES, type AdministratorSession, type OnboardingSnapshot } from "@aihub/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { OnboardingConflictError, type OnboardingManager } from "./onboarding-manager.js";

const TOKEN = "o".repeat(43);
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const session: AdministratorSession = {
  id: ADMIN_ID, subject: "phase9-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z", idleExpiresAt: "2026-07-30T00:15:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

const snapshot: OnboardingSnapshot = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  installation: { status: "CLAIMED", claimedAt: "2026-07-30T00:00:00.000Z" },
  architecture: {
    topologyMode: "CONTROL_PLANE", targetEnvironment: "DEVELOPMENT", installMethod: "SIGNED_INSTALLER", localInference: false,
    liteLlmOwnershipMode: "EXTERNAL_VALIDATED", supermemoryStorageMode: "EMBEDDED",
    supermemoryEmbeddingMode: "LOCAL", hermesMemoryMode: "MEDIATED", gpuSchedulingMode: "DEDICATED_LLM",
    reason: null, revision: 0, updatedBy: null, updatedAt: "2026-07-30T00:00:00.000Z",
  },
  journey: {
    status: "NOT_STARTED", currentStepKey: "system-topology", activatedEnvironment: null, reason: null, revision: 0,
    startedAt: null, completedAt: null, updatedBy: null, updatedAt: "2026-07-30T00:00:00.000Z",
  },
  components: [{
    key: "hermes-api", displayName: "Hermes API Server", category: "Agents", required: true,
    requirementReason: "Development runtime baseline", expectedContract: "Pinned Runs and SSE contract.", status: "NOT_TESTED", evidenceSource: null, observedVersion: null,
    evidenceRef: null, note: null, testedAt: null, updatedBy: null, revision: 0, updatedAt: "2026-07-30T00:00:00.000Z",
  }],
  steps: [{
    key: "system-topology", ordinal: 2, title: "System and topology", description: "Verify deployment evidence.",
    required: true, automated: true, action: "Validate host", status: "NOT_STARTED", evidenceRefs: [], note: null, revision: 0, updatedBy: null,
    completedAt: null, updatedAt: "2026-07-30T00:00:00.000Z",
  }],
  recovery: { status: "NOT_EXPORTED", keyFingerprint: null, kitChecksum: null, recoveryOwner: null, exportedAt: null, verifiedAt: null, revision: 0 },
  evidence: [],
  gate: { ready: false, targetEnvironment: "DEVELOPMENT", requiredComponents: 1, passedComponents: 0, requiredSteps: 1, completedSteps: 0, blockers: ["Hermes API Server: not tested"], warnings: [] },
};

class Sessions implements AdminSessionManager {
  async createBootstrapSession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return true; }
}

function manager(): OnboardingManager {
  return {
    snapshot: vi.fn(async () => snapshot),
    updateArchitecture: vi.fn(async (_principal, input) => ({ ...snapshot.architecture, ...input, revision: 1, updatedBy: ADMIN_ID })),
    updateComponent: vi.fn(async () => snapshot),
    updateStep: vi.fn(async () => snapshot),
    runValidation: vi.fn(async () => snapshot),
    exportRecoveryKit: vi.fn(async () => ({ fileName: "recovery.json", serializedKit: "{" + "x".repeat(120) + "}", checksum: "a".repeat(64), keyFingerprint: "b".repeat(64) })),
    verifyRecoveryKit: vi.fn(async () => snapshot),
    complete: vi.fn(async () => ({ ...snapshot, journey: { ...snapshot.journey, status: "COMPLETED" as const } })),
  };
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function testApp(onboardingManager = manager()) {
  const app = await createApp({ logger: false, runtime: { bootstrapState: "READY", sessionManager: new Sessions(), onboardingManager } });
  apps.push(app);
  return { app, onboardingManager };
}

describe("Phase 9 onboarding routes", () => {
  it("requires administrator readiness access", async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/onboarding/" })).statusCode).toBe(401);
  });

  it("returns the evidence-backed setup snapshot and validates passed evidence", async () => {
    const { app, onboardingManager } = await testApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/onboarding/", headers })).json()).toMatchObject({ gate: { ready: false }, components: [{ key: "hermes-api" }] });
    const invalid = await app.inject({
      method: "PATCH", url: "/api/v1/admin/onboarding/components/hermes-api", headers,
      payload: { status: "PASSED", note: "Checked the target.", expectedRevision: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({
      method: "PATCH", url: "/api/v1/admin/onboarding/components/hermes-api", headers,
      payload: { status: "PASSED", observedVersion: "0.13.0", evidenceRef: "report:hermes:42", attestationAuthority: "MPM Security", note: "Checked the target.", expectedRevision: 0 },
    });
    expect(valid.statusCode).toBe(200);
    expect(onboardingManager.updateComponent).toHaveBeenCalledWith(expect.objectContaining({ id: ADMIN_ID }), "hermes-api", expect.objectContaining({ status: "PASSED" }));
  });

  it("maps stale completion attempts to a stable conflict", async () => {
    const onboardingManager = manager();
    onboardingManager.complete = vi.fn(async () => { throw new OnboardingConflictError("Evidence is stale."); });
    const { app } = await testApp(onboardingManager);
    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/onboarding/complete",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` }, payload: { reason: "Approve the reviewed evidence.", expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "ONBOARDING_CONFLICT" });
  });

  it("runs an automated stage validation through the readiness manager", async () => {
    const { app, onboardingManager } = await testApp();
    const response = await app.inject({
      method: "POST", url: "/api/v1/admin/onboarding/validate",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` }, payload: { stageKey: "system-topology" },
    });

    expect(response.statusCode).toBe(200);
    expect(onboardingManager.runValidation).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      { stageKey: "system-topology" },
    );
  });

  it("keeps recovery passphrases at the API boundary while returning the encrypted kit", async () => {
    const { app, onboardingManager } = await testApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    const passphrase = "a-customer-held-recovery-passphrase";
    const exported = await app.inject({
      method: "POST", url: "/api/v1/admin/onboarding/recovery/export", headers,
      payload: { recoveryOwner: "MPM Infrastructure", passphrase, expectedRevision: 0 },
    });
    const verified = await app.inject({
      method: "POST", url: "/api/v1/admin/onboarding/recovery/verify", headers,
      payload: { serializedKit: "{" + "x".repeat(120) + "}", passphrase, expectedRevision: 1 },
    });

    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ fileName: "recovery.json", checksum: "a".repeat(64) });
    expect(verified.statusCode).toBe(200);
    expect(onboardingManager.exportRecoveryKit).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      expect.objectContaining({ recoveryOwner: "MPM Infrastructure", passphrase }),
    );
    expect(onboardingManager.verifyRecoveryKit).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      expect.objectContaining({ passphrase, expectedRevision: 1 }),
    );
  });
});

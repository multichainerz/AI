import { ADMIN_SCOPES, type AdministratorSession, type OnboardingSnapshot } from "@orcasynapse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import type { OnboardingManager } from "./onboarding-manager.js";

const TOKEN = "o".repeat(43);
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const session: AdministratorSession = {
  id: ADMIN_ID, subject: "phase9-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: "2026-07-30T00:00:00.000Z", idleExpiresAt: "2026-07-30T00:15:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

const snapshot: OnboardingSnapshot = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  installation: { status: "ACTIVATED", activatedAt: "2026-07-30T00:00:00.000Z" },
  architecture: {
    topologyMode: "CONTROL_PLANE", targetEnvironment: "DEVELOPMENT",
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
  async createInstallationKeySession() { return null; }
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

describe("production onboarding routes", () => {
  it("requires administrator readiness access", async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/onboarding/" })).statusCode).toBe(401);
  });

  it("returns the evidence-backed setup snapshot", async () => {
    const { app } = await testApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/onboarding/", headers })).json()).toMatchObject({ gate: { ready: false }, components: [{ key: "hermes-api" }] });
  });

  it("no longer serves the retired onboarding write routes", async () => {
    const { app, onboardingManager } = await testApp();
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/onboarding/", headers })).statusCode).toBe(200);
    for (const [method, url] of [
      ["PATCH", "/api/v1/admin/onboarding/architecture"],
      ["PATCH", "/api/v1/admin/onboarding/components/hermes-api"],
      ["PATCH", "/api/v1/admin/onboarding/steps/system-topology"],
      ["POST", "/api/v1/admin/onboarding/complete"],
    ] as const) {
      expect((await app.inject({ method, url, headers, payload: {} })).statusCode).toBe(404);
    }
    expect(onboardingManager.updateArchitecture).not.toHaveBeenCalled();
    expect(onboardingManager.updateComponent).not.toHaveBeenCalled();
    expect(onboardingManager.updateStep).not.toHaveBeenCalled();
    expect(onboardingManager.complete).not.toHaveBeenCalled();
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
      payload: { recoveryOwner: "OrcaSynapse Infrastructure", passphrase, expectedRevision: 0 },
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
      expect.objectContaining({ recoveryOwner: "OrcaSynapse Infrastructure", passphrase }),
    );
    expect(onboardingManager.verifyRecoveryKit).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      expect.objectContaining({ passphrase, expectedRevision: 1 }),
    );
  });
});

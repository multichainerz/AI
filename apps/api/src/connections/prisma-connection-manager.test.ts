import type { CreateServiceConnection } from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { describe, expect, it } from "vitest";
import { ConnectionAuthorizationError } from "./connection-manager.js";
import {
  diagnosticTransitionForUpdate,
  parseStoredRevision,
  PrismaConnectionManager,
} from "./prisma-connection-manager.js";

const revision = {
  slug: "inference-primary",
  displayName: "Inference Primary",
  kind: "INFERENCE",
  environment: "PRODUCTION",
  baseUrl: "https://vllm.orcasynapse.internal",
  enabled: true,
  configuration: { healthPath: "/health", modelsPath: "/v1/models" },
  secretFieldNames: ["apiKey"],
};

describe("parseStoredRevision", () => {
  it("reads an immutable revision for a supported connection kind", () => {
    expect(parseStoredRevision(revision)).toMatchObject({
      kind: "INFERENCE",
      configuration: { healthPath: "/health", modelsPath: "/v1/models" },
    });
  });

  it("rejects revisions for retired connection kinds", () => {
    expect(() => parseStoredRevision({ ...revision, kind: "OBJECT_STORE" })).toThrow("stored revision is malformed");
  });
});

describe("diagnosticTransitionForUpdate", () => {
  it("preserves fresh health evidence when a tested connection is enabled", () => {
    expect(diagnosticTransitionForUpdate(
      { status: "HEALTHY" },
      { enabled: true },
      true,
    )).toEqual({ status: "HEALTHY", clearEvidence: false });
  });

  it("invalidates health evidence when connectivity settings change", () => {
    expect(diagnosticTransitionForUpdate(
      { status: "HEALTHY" },
      { enabled: true, baseUrl: "https://replacement.example.internal" },
      true,
    )).toEqual({ status: "NOT_TESTED", clearEvidence: true });
  });

  it("keeps a connection disabled when activation validation has not passed", () => {
    expect(diagnosticTransitionForUpdate(
      { status: "DEGRADED" },
      { enabled: false },
      false,
    )).toEqual({ status: "DISABLED", clearEvidence: true });
  });
});

const oidcConnection: CreateServiceConnection = {
  slug: "enterprise-oidc",
  displayName: "Enterprise OIDC",
  kind: "OIDC",
  environment: "PRODUCTION",
  baseUrl: "https://identity.example.internal",
  enabled: true,
  configuration: {
    clientId: "orcasynapse",
    redirectUri: "https://orcasynapse.example.internal/api/v1/auth/oidc/callback",
    scopes: ["openid", "profile", "email", "groups"],
    groupsClaim: "groups",
    allowedGroups: ["OrcaSynapse-Users"],
    platformAdminGroups: ["OrcaSynapse-Platform-Admins"],
  },
  secrets: { clientSecret: "write-only-secret" },
};

describe("PrismaConnectionManager identity authority", () => {
  it("prevents a Security Administrator from assigning Platform Administrator groups", async () => {
    const manager = new PrismaConnectionManager(
      {} as OrcaSynapsePrismaClient,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.create(oidcConnection, {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "security-admin",
      role: "SECURITY_ADMIN",
    })).rejects.toBeInstanceOf(ConnectionAuthorizationError);
  });
});

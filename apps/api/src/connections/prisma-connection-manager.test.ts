import type { CreateServiceConnection } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { EnvelopeEncryption } from "@aihub/security";
import { describe, expect, it } from "vitest";
import { ConnectionAuthorizationError } from "./connection-manager.js";
import { parseStoredRevision, PrismaConnectionManager } from "./prisma-connection-manager.js";

const revision = {
  slug: "inference-primary",
  displayName: "Inference Primary",
  kind: "VLLM",
  environment: "PRODUCTION",
  baseUrl: "https://vllm.mpm.internal",
  enabled: true,
  configuration: { healthPath: "/health", modelsPath: "/v1/models" },
  secretFieldNames: ["apiKey"],
};

describe("parseStoredRevision", () => {
  it("reads an immutable revision for a supported connection kind", () => {
    expect(parseStoredRevision(revision)).toMatchObject({
      kind: "VLLM",
      configuration: { healthPath: "/health", modelsPath: "/v1/models" },
    });
  });

  it("rejects revisions for retired connection kinds", () => {
    expect(() => parseStoredRevision({ ...revision, kind: "OBJECT_STORE" })).toThrow("stored revision is malformed");
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
    clientId: "aihub",
    redirectUri: "https://aihub.example.internal/api/v1/auth/oidc/callback",
    scopes: ["openid", "profile", "email", "groups"],
    groupsClaim: "groups",
    allowedGroups: ["AIHub-Users"],
    platformAdminGroups: ["AIHub-Platform-Admins"],
  },
  secrets: { clientSecret: "write-only-secret" },
};

describe("PrismaConnectionManager identity authority", () => {
  it("prevents a Security Administrator from assigning Platform Administrator groups", async () => {
    const manager = new PrismaConnectionManager(
      {} as AIHubPrismaClient,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.create(oidcConnection, {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "security-admin",
      role: "SECURITY_ADMIN",
    })).rejects.toBeInstanceOf(ConnectionAuthorizationError);
  });
});

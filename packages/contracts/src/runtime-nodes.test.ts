import { describe, expect, it } from "vitest";
import {
  createHermesNodeInvitationSchema,
  enrollHermesNodeSchema,
  hermesNodeHeartbeatSchema,
  mutateHermesRuntimeNodeSchema,
  registerHermesNodeMemorySchema,
} from "./runtime-nodes.js";

describe("Hermes runtime-node contracts", () => {
  it("accepts a bounded one-time invitation definition", () => {
    expect(createHermesNodeInvitationSchema.safeParse({
      slug: "hermes-runtime-01",
      displayName: "Hermes Runtime 01",
      baseUrl: "http://10.0.0.12:8642",
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesImage: `nousresearch/hermes-agent@sha256:${"a".repeat(64)}`,
      expiresInMinutes: 30,
    }).success).toBe(true);
    expect(createHermesNodeInvitationSchema.safeParse({
      slug: "Hermes Runtime",
      displayName: "Hermes Runtime 01",
      baseUrl: "ssh://10.0.0.12",
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesImage: "nousresearch/hermes-agent",
    }).success).toBe(false);
    expect(createHermesNodeInvitationSchema.safeParse({
      slug: "hermes-runtime-01",
      displayName: "Hermes Runtime 01",
      baseUrl: "http://10.0.0.12:8642/admin",
      controlPlaneUrl: "https://orcasynapse.internal/setup?token=unsafe",
      hermesImage: "nousresearch/hermes-agent",
    }).success).toBe(false);
  });

  it("keeps enrollment identity and runtime API credentials explicit", () => {
    const input = {
      nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
      token: "t".repeat(43),
      hostname: "hermes-01.internal",
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(80)}\n-----END PUBLIC KEY-----`,
      controlPlaneUrl: "https://orcasynapse.internal",
      apiKey: "k".repeat(64),
      hermesVersion: "nousresearch/hermes-agent:latest",
      installerVersion: "ai-v1.7.0",
      capabilities: ["gateway-api", "signed-heartbeat"],
    };
    expect(enrollHermesNodeSchema.safeParse(input).success).toBe(true);
    expect(enrollHermesNodeSchema.safeParse({ ...input, apiKey: "short" }).success).toBe(false);
  });

  it("rejects unbounded heartbeat and lifecycle input", () => {
    expect(registerHermesNodeMemorySchema.safeParse({
      baseUrl: "http://10.0.0.12:6767",
      apiKey: `sm_${"a".repeat(32)}`,
      observedVersion: "0.1.0",
    }).success).toBe(true);
    expect(registerHermesNodeMemorySchema.safeParse({
      baseUrl: "http://10.0.0.12:6767/v3",
      apiKey: `sm_${"a".repeat(32)}`,
      observedVersion: "0.1.0",
    }).success).toBe(false);
    expect(hermesNodeHeartbeatSchema.safeParse({
      observedAt: "2026-07-30T00:00:00.000Z",
      status: "ONLINE",
      hermesVersion: "0.1.0",
      capabilities: [],
      command: "unexpected",
    }).success).toBe(false);
    expect(mutateHermesRuntimeNodeSchema.safeParse({
      action: "REVOKE",
      reason: "Replace the compromised runtime identity.",
      expectedRevision: 3,
    }).success).toBe(true);
  });
});

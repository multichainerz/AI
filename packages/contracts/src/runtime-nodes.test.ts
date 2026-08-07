import { describe, expect, it } from "vitest";
import {
  createHermesNodeInvitationSchema,
  enrollHermesNodeSchema,
  hermesNodeHeartbeatSchema,
  mutateHermesRuntimeNodeSchema,
} from "./runtime-nodes.js";

describe("Hermes runtime-node contracts", () => {
  it("accepts a bounded one-time invitation definition", () => {
    const base = {
      slug: "hermes-runtime-01",
      displayName: "Hermes Runtime 01",
      baseUrl: "http://10.0.0.12:8642",
      controlPlaneUrl: "https://orcasynapse.internal",
      expiresInMinutes: 30,
    };
    expect(createHermesNodeInvitationSchema.safeParse({
      ...base,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
    }).success).toBe(true);

    // Uppercase is the same commit, so it is normalized rather than refused --
    // GitHub renders SHAs either way and an operator will paste both.
    expect(createHermesNodeInvitationSchema.parse({
      ...base,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d".toUpperCase(),
    }).hermesCommit).toBe("c015663b215c0e14de4295346b0727db602cbb1d");

    // An abbreviated SHA is the mistake worth catching: it looks pinned, it
    // works on the machine that typed it, and it can become ambiguous later.
    expect(createHermesNodeInvitationSchema.safeParse({
      ...base,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d".slice(0, 12),
    }).success).toBe(false);
    // A branch is not a pin at all.
    expect(createHermesNodeInvitationSchema.safeParse({ ...base, hermesCommit: "main" }).success).toBe(false);
    // The image reference this replaced must not slip through.
    expect(createHermesNodeInvitationSchema.safeParse({
      ...base,
      hermesCommit: "nousresearch/hermes-agent:latest",
    }).success).toBe(false);

    expect(createHermesNodeInvitationSchema.safeParse({
      ...base, slug: "Hermes Runtime", baseUrl: "ssh://10.0.0.12", hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
    }).success).toBe(false);
    expect(createHermesNodeInvitationSchema.safeParse({
      ...base,
      baseUrl: "http://10.0.0.12:8642/admin",
      controlPlaneUrl: "https://orcasynapse.internal/setup?token=unsafe",
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
    }).success).toBe(false);

    // Defaulted rather than required: an operator who does not care still gets
    // a pinned runtime, which is the whole point.
    const defaulted = createHermesNodeInvitationSchema.parse({ ...base });
    expect(defaulted.hermesCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps enrollment identity and runtime API credentials explicit", () => {
    const input = {
      nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
      token: "t".repeat(43),
      hostname: "hermes-01.internal",
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(80)}\n-----END PUBLIC KEY-----`,
      controlPlaneUrl: "https://orcasynapse.internal",
      apiKey: "k".repeat(64),
      hermesVersion: "c015663b215c0e14de4295346b0727db602cbb1d",
      installerVersion: "v1.70.0",
      capabilities: ["gateway-api", "signed-heartbeat"],
    };
    expect(enrollHermesNodeSchema.safeParse(input).success).toBe(true);
    expect(enrollHermesNodeSchema.safeParse({ ...input, apiKey: "short" }).success).toBe(false);
  });


  it("rejects unbounded heartbeat and lifecycle input", () => {
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

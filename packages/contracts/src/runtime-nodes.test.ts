import { describe, expect, it } from "vitest";
import {
  createHermesNodeInvitationSchema,
  enrollHermesNodeSchema,
  hermesNodeHeartbeatSchema,
  hermesRuntimeNodeSchema,
  mutateHermesRuntimeNodeSchema,
  runtimeDesiredStateDocumentSchema,
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

describe("the signed runtime desired-state document", () => {
  const document = {
    format: "orcasynapse-runtime-desired-state/v1",
    nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
    generatedAt: "2026-08-15T00:00:00.000Z",
    admittedToolsets: ["clarify"],
    hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
  };

  it("names the Hermes commit the node should be running", () => {
    expect(runtimeDesiredStateDocumentSchema.parse(document).hermesCommit)
      .toBe("c015663b215c0e14de4295346b0727db602cbb1d");
    // Uppercase is the same commit; the node compares it against a lowercase
    // `commit-pin` file, so normalizing here is what keeps them comparable.
    expect(runtimeDesiredStateDocumentSchema.parse({
      ...document,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d".toUpperCase(),
    }).hermesCommit).toBe("c015663b215c0e14de4295346b0727db602cbb1d");
  });

  it("refuses a document that says nothing about the commit", () => {
    // Required, not optional. An absent instruction and a real one must not be
    // confusable: a node that reads no commit leaves itself where it is, so an
    // optional field would let a control-plane bug look like "stay put".
    const { hermesCommit, ...withoutCommit } = document;
    expect(runtimeDesiredStateDocumentSchema.safeParse(withoutCommit).success).toBe(false);
    expect(runtimeDesiredStateDocumentSchema.safeParse({ ...document, hermesCommit: null }).success).toBe(false);
    expect(runtimeDesiredStateDocumentSchema.safeParse({ ...document, hermesCommit: "" }).success).toBe(false);
  });

  it("refuses anything that is not a full commit SHA", () => {
    // The node re-runs the Hermes installer at whatever this says, so a moving
    // reference here would be an unpinned root install on VM2.
    expect(runtimeDesiredStateDocumentSchema.safeParse({ ...document, hermesCommit: "main" }).success).toBe(false);
    expect(runtimeDesiredStateDocumentSchema.safeParse({
      ...document,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d".slice(0, 12),
    }).success).toBe(false);
    expect(runtimeDesiredStateDocumentSchema.safeParse({
      ...document,
      hermesCommit: `${"c015663b215c0e14de4295346b0727db602cbb1d".slice(0, 39)}z`,
    }).success).toBe(false);
  });
});

describe("the runtime node summary", () => {
  const summary = {
    id: "9de260d7-bc51-4558-9d20-06916d393072",
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    baseUrl: "http://10.0.0.12:8642",
    expectedHostname: null,
    hostname: "hermes-01.internal",
    status: "ONLINE",
    identityFingerprint: null,
    hermesVersion: "c015663b215c0e14de4295346b0727db602cbb1d",
    expectedHermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
    installerVersion: "v5.3.0",
    capabilities: [],
    units: null,
    serviceConnectionId: null,
    serviceConnectionStatus: null,
    lastSeenAt: null,
    enrolledAt: null,
    revokedAt: null,
    revision: 0,
    controlPlaneUrl: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };

  it("reports the commit the control plane expects alongside the one the node runs", () => {
    // Two different facts: `hermesVersion` is what the node last said it was
    // running, `expectedHermesCommit` is what the control plane recorded for it.
    // A screen with only the first cannot show a node that failed to move.
    expect(hermesRuntimeNodeSchema.parse(summary).expectedHermesCommit)
      .toBe("c015663b215c0e14de4295346b0727db602cbb1d");
    const { expectedHermesCommit, ...withoutExpected } = summary;
    expect(hermesRuntimeNodeSchema.safeParse(withoutExpected).success).toBe(false);
  });

  it("allows no recorded commit, but not a half-recorded one", () => {
    // Null is a node enrolled before the pin was recorded. A truncated SHA is a
    // bug, and rendering it as the expected commit would invent drift.
    expect(hermesRuntimeNodeSchema.parse({ ...summary, expectedHermesCommit: null }).expectedHermesCommit).toBeNull();
    expect(hermesRuntimeNodeSchema.safeParse({ ...summary, expectedHermesCommit: "c015663b" }).success).toBe(false);
  });
});

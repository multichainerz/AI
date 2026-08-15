/**
 * The three steps of bringing a deployment up, and every reason each one is
 * not yet done.
 *
 * These live apart from the view because the branching they replace was a
 * four-way nested ternary inside a JSX array (`onboarding-view.tsx:300`),
 * testable only by rendering to markup and grepping the string. The rules
 * below are enforced by the API — each case names the guard it mirrors, so a
 * server change that moves a gate fails here rather than in production.
 */
import type { HermesRuntimeNode, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { deriveSetupSteps, type SetupStepsInput } from "./setup-steps.js";
import type { WorkspaceReadiness } from "./platform-readiness.js";

function readiness(overrides: Partial<WorkspaceReadiness> = {}): WorkspaceReadiness {
  return {
    inferenceReady: false,
    hermesReady: false,
    runtimeNodeReady: false,
    profileReady: false,
    executionReady: false,
    agenticInfrastructureReady: false,
    chatReady: false,
    agenticReady: false,
    nextChatStep: null,
    ...overrides,
  };
}

function inference(overrides: Partial<ServiceConnectionSummary> = {}): ServiceConnectionSummary {
  return {
    kind: "INFERENCE",
    enabled: true,
    status: "HEALTHY",
    configuration: { modelAlias: "laguna-s" },
    ...overrides,
  } as ServiceConnectionSummary;
}

function node(overrides: Partial<HermesRuntimeNode> = {}): HermesRuntimeNode {
  return { status: "ONLINE", revokedAt: null, ...overrides } as HermesRuntimeNode;
}

function input(overrides: Partial<SetupStepsInput> = {}): SetupStepsInput {
  return {
    readiness: readiness(),
    connections: [],
    runtimeNodes: [],
    targetEnvironment: "DEVELOPMENT",
    ...overrides,
  };
}

const blockers = (steps: ReturnType<typeof deriveSetupSteps>, key: string) =>
  steps.find((step) => step.key === key)?.blockedBy ?? [];

describe("the three setup steps", () => {
  it("are always the same three, in the order the server enforces", () => {
    const steps = deriveSetupSteps(input());
    expect(steps.map((step) => step.key)).toEqual(["inference", "runtime", "profile"]);
    expect(steps.map((step) => step.ordinal)).toEqual([1, 2, 3]);
  });

  it("marks the first unfinished step current and the rest blocked", () => {
    const steps = deriveSetupSteps(input());
    expect(steps.map((step) => step.status)).toEqual(["current", "blocked", "blocked"]);

    const enrolled = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference()],
    }));
    expect(enrolled.map((step) => step.status)).toEqual(["done", "current", "blocked"]);
  });

  it("reports every step done once execution is ready", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({
        inferenceReady: true, hermesReady: true, runtimeNodeReady: true,
        agenticInfrastructureReady: true, profileReady: true, executionReady: true,
      }),
      connections: [inference()],
      runtimeNodes: [node()],
    }));
    // Length first: `[].every()` is true, so without this the case passes
    // against a function that returns nothing at all.
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => step.status === "done")).toBe(true);
    expect(steps.flatMap((step) => step.blockedBy)).toEqual([]);
  });
});

describe("step 1 — the inference server", () => {
  it("is not satisfied by a healthy connection with no served model", () => {
    /*
     * `seedableInferenceModelAlias` (drizzle-runtime-node-manager.ts:94-104)
     * returns null without a non-empty `configuration.modelAlias`, so a
     * connection that tests HEALTHY still cannot seed an enrolment.
     */
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference({ configuration: {} as ServiceConnectionSummary["configuration"] })],
    }));
    expect(blockers(steps, "inference").join(" ")).toMatch(/served model/i);
    expect(steps[0]?.status).not.toBe("done");
  });

  it("names the absence of a connection rather than reporting a bare failure", () => {
    expect(blockers(deriveSetupSteps(input()), "inference").join(" ")).toMatch(/no inference connection/i);
  });
});

describe("step 2 — the agent runtime", () => {
  it("blocks on a second healthy inference connection, naming the cause", () => {
    /*
     * The trap nothing in the product states today: `connections.length !== 1`
     * returns null, so adding a second healthy endpoint silently breaks
     * enrolment rather than adding redundancy.
     */
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference(), inference()],
    }));
    expect(blockers(steps, "runtime").join(" ")).toMatch(/exactly one/i);
    expect(blockers(steps, "runtime").join(" ")).toMatch(/2/);
  });

  it("waits for a heartbeat rather than treating enrolment as arrival", () => {
    // `enroll` leaves the node PENDING; status is first written by its own
    // heartbeat (drizzle-runtime-node-manager.ts:751-756).
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, hermesReady: true }),
      connections: [inference()],
      runtimeNodes: [node({ status: "PENDING" })],
    }));
    expect(blockers(steps, "runtime").join(" ")).toMatch(/heartbeat/i);
  });

  it("demands commit-pinned artifacts for PRODUCTION and not for PILOT", () => {
    // productionArtifactViolation (drizzle-runtime-node-manager.ts:161-174).
    const production = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference()],
      targetEnvironment: "PRODUCTION",
      hermesCommit: "not-a-sha",
      controlPlaneUrl: "http://orca.internal",
    }));
    expect(blockers(production, "runtime").join(" ")).toMatch(/commit/i);
    expect(blockers(production, "runtime").join(" ")).toMatch(/https/i);

    const pilot = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference()],
      targetEnvironment: "PILOT",
      hermesCommit: "not-a-sha",
      controlPlaneUrl: "http://orca.internal",
    }));
    expect(pilot.find((step) => step.key === "runtime")?.blockedBy.join(" ")).not.toMatch(/commit|https/i);
  });

  it("accepts a 40-character commit SHA over HTTPS for PRODUCTION", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference()],
      targetEnvironment: "PRODUCTION",
      hermesCommit: "a".repeat(40),
      controlPlaneUrl: "https://orca.internal",
    }));
    // A negative match on a missing step is vacuously true, so prove the step
    // is there before asserting what it does not say.
    expect(steps.find((step) => step.key === "runtime")).toBeTruthy();
    expect(blockers(steps, "runtime").join(" ")).not.toMatch(/commit|https/i);
  });
});

describe("step 3 — the agent profile", () => {
  it("distinguishes no active profile from a disabled execution boundary", () => {
    const noProfile = deriveSetupSteps(input({
      readiness: readiness({
        inferenceReady: true, hermesReady: true, runtimeNodeReady: true,
        agenticInfrastructureReady: true,
      }),
      connections: [inference()],
      runtimeNodes: [node()],
    }));
    expect(blockers(noProfile, "profile").join(" ")).toMatch(/no agent profile/i);

    const boundaryOff = deriveSetupSteps(input({
      readiness: readiness({
        inferenceReady: true, hermesReady: true, runtimeNodeReady: true,
        agenticInfrastructureReady: true, profileReady: true,
      }),
      connections: [inference()],
      runtimeNodes: [node()],
    }));
    expect(blockers(boundaryOff, "profile").join(" ")).toMatch(/execution boundary/i);
  });

  it("summarises an unfinished runtime in one line instead of repeating its faults", () => {
    /*
     * The case the rule exists for: the runtime step is carrying several
     * blockers at once, and the profile step must not echo them. A step that
     * restates its predecessor's problems is how one fault reads as three on
     * the same screen.
     *
     * Asserted against a state where the runtime genuinely *has* blockers —
     * checking this once the runtime is already done proves nothing, because
     * there is then nothing available to leak.
     */
    const steps = deriveSetupSteps(input({ connections: [] }));
    const runtime = blockers(steps, "runtime");
    const profile = blockers(steps, "profile");

    expect(runtime.length).toBeGreaterThan(0);
    expect(profile).toEqual(["Enrol the agent runtime first."]);
    expect(profile.join(" ")).not.toMatch(/inference|heartbeat/i);
  });
});

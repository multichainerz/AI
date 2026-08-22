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
import type { AgentProfile, AgentRuntimeControl } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { deriveSetupSteps, type SetupStepsInput } from "./setup-steps.js";
import { deriveWorkspaceReadiness, type WorkspaceReadiness } from "./platform-readiness.js";

function readiness(overrides: Partial<WorkspaceReadiness> = {}): WorkspaceReadiness {
  return {
    inferenceReady: false,
    agentModelReady: false,
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
    id: "inference-1",
    kind: "INFERENCE",
    enabled: true,
    status: "HEALTHY",
    configuration: {},
    ...overrides,
  } as ServiceConnectionSummary;
}

function node(overrides: Partial<HermesRuntimeNode> = {}): HermesRuntimeNode {
  // `lastSeenAt` is part of what ONLINE means: the API demotes a node whose
  // last heartbeat is older than `NODE_STALE_AFTER_MS`, so a fixture without
  // one describes a payload the server would never send.
  return { status: "ONLINE", revokedAt: null, lastSeenAt: new Date().toISOString(), ...overrides } as HermesRuntimeNode;
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
      readiness: readiness({ inferenceReady: true, agentModelReady: true }),
      connections: [inference()],
    }));
    expect(enrolled.map((step) => step.status)).toEqual(["done", "current", "blocked"]);
  });

  it("reports every step done once execution is ready", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({
        inferenceReady: true, agentModelReady: true, hermesReady: true, runtimeNodeReady: true,
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
  it("is done with exactly one HEALTHY connection and an empty modelAlias", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true }),
      connections: [inference()],
    }));
    expect(steps[0]?.status).toBe("done");
    expect(blockers(steps, "inference")).toEqual([]);
  });

  it("is still blocked when the only inference row is untested", () => {
    const steps = deriveSetupSteps(input({
      connections: [inference({ status: "NOT_TESTED" })],
    }));
    expect(blockers(steps, "inference").join(" ")).toMatch(/health test/i);
    expect(steps[0]?.status).not.toBe("done");
  });

  it("names the absence of a connection rather than reporting a bare failure", () => {
    expect(blockers(deriveSetupSteps(input()), "inference").join(" ")).toMatch(/no inference connection/i);
  });

  it("stays Done when two healthy endpoints exist — the runtime step carries that blocker", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: false }),
      connections: [inference(), inference()],
    }));

    expect(steps[0]?.status).toBe("done");
    expect(blockers(steps, "inference")).toEqual([]);
    expect(blockers(steps, "runtime").join(" ")).toMatch(/exactly one/i);
    expect(blockers(steps, "runtime").join(" ")).not.toMatch(/Gateway → Models/);
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
      readiness: readiness({ inferenceReady: false, agentModelReady: false }),
      connections: [inference(), inference()],
    }));
    expect(blockers(steps, "runtime").join(" ")).toMatch(/exactly one/i);
    expect(blockers(steps, "runtime").join(" ")).toMatch(/2/);
    expect(blockers(steps, "runtime").join(" ")).not.toMatch(/Gateway → Models/);
  });

  it("blocks enrolment until an ACTIVE default AGENT route exists", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, agentModelReady: false }),
      connections: [inference()],
    }));
    expect(blockers(steps, "runtime")).toContain("Activate a default Agent model on Gateway → Models.");
    expect(steps[0]?.status).toBe("done");
    expect(steps[1]?.status).not.toBe("done");
  });

  it("waits for a heartbeat rather than treating enrolment as arrival", () => {
    // `enroll` leaves the node PENDING; status is first written by its own
    // heartbeat (drizzle-runtime-node-manager.ts:751-756).
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, agentModelReady: true, hermesReady: true }),
      connections: [inference()],
      runtimeNodes: [node({ status: "PENDING" })],
    }));
    expect(blockers(steps, "runtime").join(" ")).toMatch(/heartbeat/i);
  });

  it("demands commit-pinned artifacts for PRODUCTION and not for PILOT", () => {
    // productionArtifactViolation (drizzle-runtime-node-manager.ts:161-174).
    const production = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, agentModelReady: true }),
      connections: [inference()],
      targetEnvironment: "PRODUCTION",
      hermesCommit: "not-a-sha",
      controlPlaneUrl: "http://orca.internal",
    }));
    expect(blockers(production, "runtime").join(" ")).toMatch(/commit/i);
    expect(blockers(production, "runtime").join(" ")).toMatch(/https/i);

    const pilot = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, agentModelReady: true }),
      connections: [inference()],
      targetEnvironment: "PILOT",
      hermesCommit: "not-a-sha",
      controlPlaneUrl: "http://orca.internal",
    }));
    expect(pilot.find((step) => step.key === "runtime")?.blockedBy.join(" ")).not.toMatch(/commit|https/i);
  });

  it("accepts a 40-character commit SHA over HTTPS for PRODUCTION", () => {
    const steps = deriveSetupSteps(input({
      readiness: readiness({ inferenceReady: true, agentModelReady: true }),
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
        inferenceReady: true, agentModelReady: true, hermesReady: true, runtimeNodeReady: true,
        agenticInfrastructureReady: true,
      }),
      connections: [inference()],
      runtimeNodes: [node()],
    }));
    expect(blockers(noProfile, "profile").join(" ")).toMatch(/no agent profile/i);

    const boundaryOff = deriveSetupSteps(input({
      readiness: readiness({
        inferenceReady: true, agentModelReady: true, hermesReady: true, runtimeNodeReady: true,
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

/**
 * The two screens, asked the same question about the same deployment.
 *
 * They used to answer it three different ways: the Dashboard took the first
 * connection matching a kind and stopped at HEALTHY, Setup counted the enabled
 * healthy ones, and the API seeded from the connection alias. After v9.7.0
 * both screens treat the endpoint and the default AGENT route as separate
 * facts, so a missing Models default cannot make step 1 look unfinished.
 *
 * These cases are the contract between them: whatever the derivation says, both
 * screens say the same thing, in both directions.
 */
describe("the Dashboard and Setup on one deployment", () => {
  const hermes = () => ({ kind: "HERMES", enabled: true, status: "HEALTHY", configuration: {} }) as ServiceConnectionSummary;
  const profiles = [{ status: "ACTIVE" } as AgentProfile];
  const runtimeControl = { enabled: true } as AgentRuntimeControl;
  const defaultAgent = [{
    workload: "AGENT" as const,
    status: "ACTIVE" as const,
    isDefault: true,
    connection: { id: "inference-1" },
  }];

  function bothScreens(
    connections: ServiceConnectionSummary[],
    runtimeNodes: HermesRuntimeNode[],
    modelDeployments = defaultAgent,
  ) {
    const workspace = deriveWorkspaceReadiness({
      connections, runtimeNodes, profiles, runtime: runtimeControl, modelDeployments,
    });
    const steps = deriveSetupSteps({ readiness: workspace, connections, runtimeNodes, targetEnvironment: "DEVELOPMENT" });
    return { workspace, steps, allDone: steps.length === 3 && steps.every((step) => step.status === "done") };
  }

  it("agree that a fully enrolled deployment is ready", () => {
    // Both directions matter: a rule strict enough to catch the two failures
    // below is worthless if it also refuses the deployment that works.
    const { workspace, allDone } = bothScreens([inference(), hermes()], [node()]);

    expect(workspace.chatReady).toBe(true);
    expect(allDone).toBe(true);
  });

  it("agree that a missing default AGENT route blocks chat and the runtime step, not step 1", () => {
    const { workspace, steps, allDone } = bothScreens([inference(), hermes()], [node()], []);

    expect(workspace.inferenceReady).toBe(true);
    expect(workspace.chatReady).toBe(false);
    expect(allDone).toBe(false);
    expect(steps[0]?.status).toBe("done");
    expect(steps.flatMap((step) => step.blockedBy)).toContain("Activate a default Agent model on Gateway → Models.");
  });

  it("agree that a second healthy inference connection blocks the path", () => {
    const { workspace, steps, allDone } = bothScreens(
      [inference(), inference({ id: "inference-2" }), hermes()],
      [node()],
    );

    expect(workspace.chatReady).toBe(false);
    expect(allDone).toBe(false);
    expect(steps[0]?.status).toBe("done");
    expect(steps.flatMap((step) => step.blockedBy).join(" ")).toMatch(/exactly one/i);
    expect(steps.flatMap((step) => step.blockedBy).join(" ")).not.toMatch(/Gateway → Models/);
  });

  it("agree that a node which stopped beating is not answering", () => {
    const quiet = node({ lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    const { workspace, steps, allDone } = bothScreens([inference(), hermes()], [quiet]);

    expect(workspace.runtimeNodeReady).toBe(false);
    expect(allDone).toBe(false);
    expect(steps.flatMap((step) => step.blockedBy).join(" ")).toMatch(/heartbeat/i);
  });
});

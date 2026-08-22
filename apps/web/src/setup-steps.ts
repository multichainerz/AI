import type { HermesRuntimeNode, ServiceConnectionSummary } from "@orcasynapse/contracts";
import {
  deriveInferenceReadiness,
  deriveRuntimeNodeReadiness,
  type WorkspaceReadiness,
} from "./platform-readiness.js";

export type SetupStepKey = "inference" | "runtime" | "profile";
export type SetupStepStatus = "done" | "current" | "blocked";
export type TargetEnvironment = "DEVELOPMENT" | "PILOT" | "PRODUCTION";

export interface SetupStep {
  key: SetupStepKey;
  ordinal: number;
  title: string;
  purpose: string;
  status: SetupStepStatus;
  /** Every unmet condition, in the words an operator can act on. */
  blockedBy: string[];
}

export interface SetupStepsInput {
  readiness: WorkspaceReadiness;
  connections: ServiceConnectionSummary[];
  runtimeNodes: HermesRuntimeNode[];
  targetEnvironment: TargetEnvironment;
  hermesCommit?: string | null;
  controlPlaneUrl?: string | null;
}

/**
 * The three steps between a fresh install and a working session, with every
 * unmet condition attached to the step it actually blocks.
 *
 * Each rule mirrors a server guard rather than a layout decision, because the
 * screen this replaces inferred ordering from the order of its cards. Where a
 * guard lives in the API, the comment names it — a gate that moves upstream
 * should break a test here, not surprise an operator at the point of use.
 *
 * Endpoint health lives on step 1; the first default AGENT is picked on
 * step 2 (OpenRouter `:free` variants, or the local catalogue). Gateway →
 * Models remains the place to admit more routes. Dashboard `inferenceReady`
 * is the endpoint half only.
 */
export function deriveSetupSteps(input: SetupStepsInput): SetupStep[] {
  const { readiness, connections, runtimeNodes, targetEnvironment } = input;

  const inference = deriveInferenceReadiness(connections);
  const healthy = inference.healthy;
  const { enrolled, online } = deriveRuntimeNodeReadiness(runtimeNodes);

  const inferenceBlockers: string[] = [];
  if (connections.every((c) => c.kind !== "INFERENCE")) {
    inferenceBlockers.push("No inference connection is registered.");
  } else if (healthy.length === 0) {
    inferenceBlockers.push("The inference connection has not passed a health test.");
  }
  const inferenceDone = inferenceBlockers.length === 0;

  const runtimeBlockers: string[] = [];
  if (!inferenceDone) {
    runtimeBlockers.push("Connect and test an inference server first.");
  }
  if (healthy.length > 1) {
    // The trap: `connections.length !== 1` returns null, so a second healthy
    // endpoint removes the ability to enrol rather than adding redundancy.
    runtimeBlockers.push(
      `Exactly one healthy inference connection is required; ${healthy.length} are healthy.`,
    );
  }
  if (healthy.length === 1 && !readiness.agentModelReady) {
    runtimeBlockers.push("Pick a default Agent model on this step before generating the installer.");
  }
  if (targetEnvironment === "PRODUCTION") {
    if (!/^[0-9a-f]{40}$/.test(input.hermesCommit ?? "")) {
      runtimeBlockers.push("Production enrolment requires a 40-character Hermes commit SHA.");
    }
    if (!input.controlPlaneUrl?.startsWith("https://")) {
      runtimeBlockers.push("Production enrolment requires an HTTPS OrcaSynapse origin.");
    }
  }
  if (inferenceDone) {
    if (enrolled.length === 0) {
      runtimeBlockers.push("No VM2 node is enrolled.");
    } else if (online.length === 0) {
      // Enrolment leaves the node PENDING; only its own signed heartbeat
      // promotes it, so "enrolled" and "answering" are different facts — and a
      // beat older than `NODE_STALE_AFTER_MS` has stopped being an answer.
      runtimeBlockers.push("VM2 is enrolled but has not sent a healthy heartbeat yet.");
    }
    if (!readiness.hermesReady && enrolled.length > 0) {
      runtimeBlockers.push("The Hermes connection has not passed a health test.");
    }
  }
  const runtimeDone = readiness.agenticInfrastructureReady && runtimeBlockers.length === 0;

  const profileBlockers: string[] = [];
  if (!runtimeDone) {
    // Deliberately one line, not a copy of the runtime step's list: a step
    // that restates its predecessor's faults makes one problem read as three.
    profileBlockers.push("Enrol the agent runtime first.");
  } else if (!readiness.profileReady) {
    profileBlockers.push("No Agent Profile is active.");
  } else if (!readiness.executionReady) {
    profileBlockers.push("The Hermes execution boundary is not enabled.");
  }
  const profileDone = readiness.executionReady && profileBlockers.length === 0;

  const done = [inferenceDone, runtimeDone, profileDone];
  const first = done.indexOf(false);

  return [
    {
      key: "inference" as const,
      title: "Connect an inference server",
      purpose: "Where models are served. OrcaSynapse and Hermes both call this endpoint.",
      blockedBy: inferenceBlockers,
    },
    {
      key: "runtime" as const,
      title: "Install the agent runtime",
      purpose: "An isolated Ubuntu VM that runs Hermes under a signed node identity.",
      blockedBy: runtimeBlockers,
    },
    {
      key: "profile" as const,
      title: "Create an Agent Profile",
      purpose: "The behaviour, model, and tools a session is allowed to use.",
      blockedBy: profileBlockers,
    },
  ].map((step, index) => ({
    ...step,
    ordinal: index + 1,
    status: done[index] ? "done" : index === first ? "current" : "blocked",
  }));
}

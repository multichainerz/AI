import type {
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { isConnectionReady } from "./connection-readiness.js";

export type WorkspaceSetupTarget = "Deployment" | "Agents";

export interface WorkspaceSetupStep {
  target: WorkspaceSetupTarget;
  title: string;
  detail: string;
}

export interface WorkspaceReadiness {
  inferenceReady: boolean;
  hermesReady: boolean;
  runtimeNodeReady: boolean;
  profileReady: boolean;
  executionReady: boolean;
  agenticInfrastructureReady: boolean;
  chatReady: boolean;
  agenticReady: boolean;
  nextChatStep: WorkspaceSetupStep | null;
}

export function connectionFor(
  connections: ServiceConnectionSummary[],
  kind: ServiceKind,
): ServiceConnectionSummary | undefined {
  return connections.find((connection) => connection.kind === kind);
}

export function deriveWorkspaceReadiness(input: {
  connections: ServiceConnectionSummary[];
  runtimeNodes: HermesRuntimeNode[];
  profiles: AgentProfile[];
  runtime: AgentRuntimeControl | null;
}): WorkspaceReadiness {
  const inferenceReady = isConnectionReady(connectionFor(input.connections, "INFERENCE"));
  const hermesReady = isConnectionReady(connectionFor(input.connections, "HERMES"));
  const runtimeNodeReady = input.runtimeNodes.some(({ status }) => status === "ONLINE");
  const profileReady = input.profiles.some(({ status }) => status === "ACTIVE");
  const executionReady = input.runtime?.enabled === true && profileReady;
  // The agentic infrastructure is the isolated runtime: a healthy Hermes
  // connection and an online node. Knowledge is served by the control plane
  // itself and is not part of this boundary.
  const agenticInfrastructureReady = hermesReady && runtimeNodeReady;
  const chatReady = inferenceReady && hermesReady && runtimeNodeReady && executionReady;

  let nextChatStep: WorkspaceSetupStep | null = null;
  if (!inferenceReady) {
    nextChatStep = {
      target: "Deployment",
      title: "Connect AI Inference",
      detail: "Connect and validate an approved OpenAI-compatible inference endpoint.",
    };
  } else if (!hermesReady || !runtimeNodeReady) {
    nextChatStep = {
      target: "Deployment",
      title: "Finish the Agentic System",
      detail: "Enroll VM2 and wait for its signed Hermes heartbeat to become healthy.",
    };
  } else if (!executionReady) {
    nextChatStep = {
      target: "Agents",
      title: "Create an Agent Profile",
      detail: "Create and activate one Profile; OrcaSynapse enables execution automatically.",
    };
  }

  return {
    inferenceReady,
    hermesReady,
    runtimeNodeReady,
    profileReady,
    executionReady,
    agenticInfrastructureReady,
    chatReady,
    // Document knowledge is local to the control plane, so a ready agentic
    // workspace is exactly a ready chat path; there is no second plane to wait on.
    agenticReady: chatReady,
    nextChatStep,
  };
}

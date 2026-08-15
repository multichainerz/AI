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

/**
 * The first connection of a kind, for the surfaces that draw one.
 *
 * A *display* lookup, deliberately kept as one: the endpoint URL, the lifecycle
 * chip and the "which drawer does this button open" decision all want a single
 * representative row. It is not a readiness decision and must not be used as
 * one — `deriveInferenceReadiness` below is what the API actually enforces, and
 * this function cannot see the second connection that breaks enrolment.
 */
export function connectionFor(
  connections: ServiceConnectionSummary[],
  kind: ServiceKind,
): ServiceConnectionSummary | undefined {
  return connections.find((connection) => connection.kind === kind);
}

/**
 * The heartbeat window after which the API stops believing a node.
 *
 * Mirrors `NODE_STALE_AFTER_MS` (drizzle-runtime-node-manager.ts:57), which
 * `summarize()` applies when it builds the list — so a node arrives ONLINE only
 * if it had beaten within this window *at the moment of the read*. The status
 * field then ages in this client's hands between polls, which is why the check
 * is repeated here rather than trusted once.
 */
export const NODE_STALE_AFTER_MS = 180_000;

/** What the API's own inference gate sees, in the one place both screens read. */
export interface InferenceReadiness {
  /** Every enabled, HEALTHY INFERENCE connection — the set the seed counts. */
  healthy: ServiceConnectionSummary[];
  /** Those of them carrying a non-empty served model alias. */
  serving: ServiceConnectionSummary[];
  /** The alias an enrolment would seed VM2 with, or null if it would refuse. */
  seedableModelAlias: string | null;
  ready: boolean;
}

/** The runtime nodes that are actually answering, by the API's own definition. */
export interface RuntimeNodeReadiness {
  /** Nodes that still hold an identity. A revoked node is not a node. */
  enrolled: HermesRuntimeNode[];
  /** Enrolled nodes whose own signed heartbeat landed inside the stale window. */
  online: HermesRuntimeNode[];
  ready: boolean;
}

function servedModelAlias(connection: ServiceConnectionSummary | undefined): string | null {
  const configuration = connection?.configuration as { modelAlias?: unknown } | undefined;
  return typeof configuration?.modelAlias === "string" && configuration.modelAlias.trim().length > 0
    ? configuration.modelAlias.trim()
    : null;
}

/**
 * Inference readiness, derived once for every screen that reports it.
 *
 * This is `seedableInferenceModelAlias` (drizzle-runtime-node-manager.ts:94-104)
 * restated: **exactly one** enabled, HEALTHY inference connection, carrying a
 * non-empty `configuration.modelAlias`. HEALTHY alone is not the gate — the
 * Dashboard used to think it was, and reported a ready path on a deployment
 * whose Setup screen was refusing to enrol anything from it.
 *
 * `serving` is separate from `ready` on purpose: the two failures have different
 * owners. "No model is selected" is a fault in the connection and belongs to
 * step 1; "two endpoints are healthy" is a fault in the *enrolment seed* and
 * belongs to step 2, which is where an operator can act on it.
 */
export function deriveInferenceReadiness(connections: ServiceConnectionSummary[]): InferenceReadiness {
  const healthy = connections.filter((c) => c.kind === "INFERENCE" && c.enabled && c.status === "HEALTHY");
  const serving = healthy.filter((connection) => servedModelAlias(connection) !== null);
  const seedableModelAlias = healthy.length === 1 ? servedModelAlias(healthy[0]) : null;
  return { healthy, serving, seedableModelAlias, ready: seedableModelAlias !== null };
}

/**
 * Node readiness, derived once for every screen that reports it.
 *
 * `status` is a snapshot the server computed when it built the response, not a
 * standing fact: `summarize()` demotes ONLINE to OFFLINE past
 * `NODE_STALE_AFTER_MS`, but this client holds the list for fifteen seconds at
 * a time and keeps it across a failed poll. Re-checking the beat is what stops
 * a VM2 that died two minutes ago from still reading as "answering" here.
 *
 * The comparison is against the browser's clock and `lastSeenAt` is the API's,
 * so a badly skewed workstation can read a live node as quiet. That costs a
 * false blocker on one screen; trusting a stale ONLINE costs an operator
 * twenty minutes wondering why a ready-looking session never answers.
 */
/**
 * Whether exactly one Hermes connection is usable, mirroring the gateway.
 *
 * `inference-gateway.ts` resolves the runtime by taking HERMES connections that
 * are enabled and whose node is neither SUSPENDED nor REVOKED, and refusing
 * unless there is exactly one. This is the browser's half of that rule.
 *
 * It replaces a first-match-by-kind lookup that had a specific failure: revoking
 * a node keeps its connection row and only disables it, so after a
 * revoke-and-replace two HERMES rows exist. `connectionFor` returns whichever
 * sorts first by display name, and if that was the retired one the whole
 * dashboard read `hermesReady: false` — and therefore `chatReady: false` —
 * permanently, while a healthy replacement node sat online beside it.
 *
 * The node join itself stays on the server: a connection summary carries no
 * node reference, so filtering on `enabled` is what the browser can see, and it
 * is sufficient here because revocation is what clears that flag.
 */
export function deriveHermesReadiness(
  connections: ServiceConnectionSummary[],
): { ready: boolean; usable: ServiceConnectionSummary[] } {
  const usable = connections.filter((connection) =>
    connection.kind === "HERMES" && isConnectionReady(connection));
  return { ready: usable.length === 1, usable };
}

export function deriveRuntimeNodeReadiness(
  nodes: HermesRuntimeNode[],
  now: number = Date.now(),
): RuntimeNodeReadiness {
  const enrolled = nodes.filter((node) => node.revokedAt === null);
  const online = enrolled.filter(({ status, lastSeenAt }) =>
    status === "ONLINE" && lastSeenAt !== null && now - Date.parse(lastSeenAt) <= NODE_STALE_AFTER_MS);
  return { enrolled, online, ready: online.length > 0 };
}

export function deriveWorkspaceReadiness(input: {
  connections: ServiceConnectionSummary[];
  runtimeNodes: HermesRuntimeNode[];
  profiles: AgentProfile[];
  runtime: AgentRuntimeControl | null;
}): WorkspaceReadiness {
  const inferenceReady = deriveInferenceReadiness(input.connections).ready;
  const hermesReady = deriveHermesReadiness(input.connections).ready;
  const runtimeNodeReady = deriveRuntimeNodeReadiness(input.runtimeNodes).ready;
  const profileReady = input.profiles.some(({ status }) => status === "ACTIVE");
  const executionReady = input.runtime?.enabled === true && profileReady;
  // The agentic infrastructure is the isolated runtime: a healthy Hermes
  // connection and an online node.
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
    // A ready agentic workspace is exactly a ready Hermes chat path.
    agenticReady: chatReady,
    nextChatStep,
  };
}

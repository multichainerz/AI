import { timingSafeEqual } from "node:crypto";
import type { InferenceBackend, InferenceGatewayChatRequest } from "@orcasynapse/contracts";
import { and, eq, gte, isNotNull, notInArray, sql } from "drizzle-orm";
import {
  auditEvent,
  guardrailPolicy,
  modelDeployment,
  serviceConnection,
  hermesRuntimeNode,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";
import { advisoryLock } from "../database-support.js";
import { inspectInputText, type RuntimeTextPolicy } from "../guardrails/runtime-policy.js";

const DEFAULT_POLICY: RuntimeTextPolicy = {
  maxInputCharacters: 32_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
};

export class InferenceGatewayError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "NOT_CONFIGURED" | "POLICY_REJECTED" | "RATE_LIMITED" | "UPSTREAM_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "InferenceGatewayError";
  }
}

export interface InferenceGatewayResult {
  response: Response;
  maxResponseBytes: number;
}

function numbers(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function messageText(message: InferenceGatewayChatRequest["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return "";
}

function endpointFor(connection: ResolvedConnection): URL {
  if (!connection.baseUrl) throw new InferenceGatewayError("NOT_CONFIGURED", "The approved inference route has no endpoint.");
  const path = typeof connection.configuration.chatPath === "string"
    ? connection.configuration.chatPath
    : "/v1/chat/completions";
  try {
    const endpoint = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
    return endpoint;
  } catch {
    throw new InferenceGatewayError("NOT_CONFIGURED", "The approved inference route is invalid.");
  }
}

const COMPATIBILITY_HINTS = ["reasoning_effort", "stream_options"] as const;
type CompatibilityHint = typeof COMPATIBILITY_HINTS[number];

function inferenceBackend(connection: ResolvedConnection): InferenceBackend {
  const value = connection.configuration.inferenceBackend;
  return ["VLLM", "LLAMA_CPP", "SGLANG", "TGI", "OLLAMA", "CUSTOM_OPENAI_COMPATIBLE"].includes(String(value))
    ? value as InferenceBackend
    : "CUSTOM_OPENAI_COMPATIBLE";
}

function compatibilityHintsFor(backend: InferenceBackend): Set<CompatibilityHint> {
  // llama.cpp intentionally implements a compact OpenAI-compatible surface and
  // rejects these optional OpenAI request hints instead of ignoring them.
  return new Set(backend === "LLAMA_CPP" ? COMPATIBILITY_HINTS : []);
}

async function rejectedCompatibilityHints(response: Response): Promise<Set<CompatibilityHint>> {
  if (response.status !== 400) return new Set();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return new Set();
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return new Set();
  }
  if (new TextEncoder().encode(text).byteLength > 16_384) return new Set();
  if (!/(unrecognized|unknown|unexpected|extra|not permitted)/i.test(text)) return new Set();
  return new Set(COMPATIBILITY_HINTS.filter((hint) => text.includes(hint)));
}

export class DrizzleInferenceGateway {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly connections: ConnectionDiagnosticStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async authenticate(token: string | undefined): Promise<string> {
    if (!token) throw new InferenceGatewayError("UNAUTHORIZED", "A runtime gateway credential is required.");
    // OrcaSynapse enrols exactly one Hermes runtime per installation, the same
    // invariant the worker enforces before it will execute a run. Reading two
    // rows lets an unexpected second enrolment fail closed instead of silently
    // picking one, and keeps authentication to a single secret decryption.
    const candidates = await this.database
      .select({ id: serviceConnection.id })
      .from(serviceConnection)
      .innerJoin(hermesRuntimeNode, eq(hermesRuntimeNode.serviceConnectionId, serviceConnection.id))
      .where(
        and(
          eq(serviceConnection.kind, "HERMES"),
          eq(serviceConnection.enabled, true),
          notInArray(hermesRuntimeNode.status, ["SUSPENDED", "REVOKED"]),
        ),
      )
      .limit(2);
    // Every failure reports one message. An unauthenticated caller must not be
    // able to tell a misconfigured installation from a wrong credential.
    const invalid = () => new InferenceGatewayError("UNAUTHORIZED", "The runtime gateway credential is invalid.");
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (!candidate) throw invalid();
    let runtime: ResolvedConnection;
    try {
      runtime = await this.connections.resolveForDiagnostic(candidate.id);
    } catch {
      throw invalid();
    }
    const expected = runtime.secrets.inferenceGatewayKey;
    if (!expected || !secureEqual(token, expected)) throw invalid();
    return runtime.id;
  }

  private async resolvePolicy(): Promise<RuntimeTextPolicy> {
    const [enforced] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(guardrailPolicy)
      .where(isNotNull(guardrailPolicy.firstActivatedAt));
    if ((enforced?.total ?? 0) === 0) return DEFAULT_POLICY;

    const active = await this.database
      .select({
        maxInputCharacters: guardrailPolicy.maxInputCharacters,
        maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
        blockControlCharacters: guardrailPolicy.blockControlCharacters,
        blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
      })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.status, "ACTIVE"))
      .limit(2);
    if (active.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one evaluated OrcaSynapse guardrail policy must be active.");
    }
    return active[0]!;
  }

  private async resolveInference(): Promise<{ connection: ResolvedConnection; modelAlias: string; maxOutputTokens: number; requestsPerMinute: number }> {
    const [enforced] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(modelDeployment)
      .where(and(eq(modelDeployment.workload, "AGENT"), isNotNull(modelDeployment.firstActivatedAt)));
    const catalogueEnforced = (enforced?.total ?? 0) > 0;

    const routes = catalogueEnforced
      ? await this.database
        .select({
          connectionId: modelDeployment.connectionId,
          modelAlias: modelDeployment.modelAlias,
          maxOutputTokens: modelDeployment.maxOutputTokens,
        })
        .from(modelDeployment)
        .where(
          and(
            eq(modelDeployment.workload, "AGENT"),
            eq(modelDeployment.status, "ACTIVE"),
            eq(modelDeployment.isDefault, true),
          ),
        )
        .limit(2)
      : [];
    if (catalogueEnforced && routes.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one evaluated default Agent model route must be active.");
    }
    const route = routes[0];

    const candidates = await this.database
      .select({ id: serviceConnection.id })
      .from(serviceConnection)
      .where(
        and(
          eq(serviceConnection.kind, "INFERENCE"),
          eq(serviceConnection.enabled, true),
          eq(serviceConnection.status, "HEALTHY"),
          ...(route ? [eq(serviceConnection.id, route.connectionId)] : []),
        ),
      )
      .limit(2);
    if (candidates.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one healthy inference server route is required.");
    }
    const connection = await this.connections.resolveForDiagnostic(candidates[0]!.id);
    const configuredAlias = connection.configuration.modelAlias;
    const modelAlias = route?.modelAlias ?? (typeof configuredAlias === "string" ? configuredAlias : "");
    if (!modelAlias) throw new InferenceGatewayError("NOT_CONFIGURED", "The approved Agent model alias is missing.");
    return {
      connection,
      modelAlias,
      maxOutputTokens: Math.trunc(route?.maxOutputTokens ?? numbers(connection.configuration.maxOutputTokens, 4_096, 64, 32_768)),
      requestsPerMinute: Math.trunc(numbers(connection.configuration.requestsPerMinute, 30, 1, 600)),
    };
  }

  private async consumeRateLimit(runtimeConnectionId: string, requestsPerMinute: number, modelAlias: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // Serialises counting and recording for this runtime, so two concurrent
      // requests cannot both observe a count below the limit and pass.
      await transaction.execute(advisoryLock(`orcasynapse-inference-gateway:${runtimeConnectionId}`));
      const [recent] = await transaction
        .select({ total: sql<number>`count(*)::int` })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, "inference.gateway_requested"),
            eq(auditEvent.resourceId, runtimeConnectionId),
            gte(auditEvent.occurredAt, new Date(Date.now() - 60_000)),
          ),
        );
      if ((recent?.total ?? 0) >= requestsPerMinute) {
        throw new InferenceGatewayError("RATE_LIMITED", "The Hermes inference gateway is at its request limit.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: runtimeConnectionId,
        action: "inference.gateway_requested",
        resourceType: "ServiceConnection",
        resourceId: runtimeConnectionId,
        outcome: "SUCCESS",
        metadata: { modelAlias, enforcementPlane: "ORCASYNAPSE" },
      });
    });
  }

  async models(token: string | undefined): Promise<Record<string, unknown>> {
    await this.authenticate(token);
    const runtime = await this.resolveInference();
    return {
      object: "list",
      data: [{ id: runtime.modelAlias, object: "model", owned_by: "orcasynapse" }],
    };
  }

  async chat(
    token: string | undefined,
    input: InferenceGatewayChatRequest,
    signal: AbortSignal,
  ): Promise<InferenceGatewayResult> {
    const runtimeConnectionId = await this.authenticate(token);
    const [runtime, policy] = await Promise.all([this.resolveInference(), this.resolvePolicy()]);
    for (const message of input.messages) {
      const text = messageText(message);
      if (!text) continue;
      const violation = inspectInputText(text, policy);
      if (violation) {
        throw new InferenceGatewayError("POLICY_REJECTED", `OrcaSynapse rejected the runtime request (${violation}).`);
      }
    }
    await this.consumeRateLimit(runtimeConnectionId, runtime.requestsPerMinute, runtime.modelAlias);
    const endpoint = endpointFor(runtime.connection);
    const timeoutMs = Math.trunc(numbers(runtime.connection.configuration.inferenceTimeoutMs, 300_000, 5_000, 900_000));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const forwardedInput: Record<string, unknown> = { ...input };
    delete forwardedInput.max_completion_tokens;
    forwardedInput.max_tokens = Math.min(
      input.max_completion_tokens ?? input.max_tokens ?? runtime.maxOutputTokens,
      runtime.maxOutputTokens,
    );
    const backend = inferenceBackend(runtime.connection);
    const omittedHints = compatibilityHintsFor(backend);
    const requestBody = (additionalOmissions: Set<CompatibilityHint> = new Set()): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        ...forwardedInput,
        model: runtime.modelAlias,
        user: `hermes:${runtimeConnectionId}`,
      };
      for (const hint of new Set([...omittedHints, ...additionalOmissions])) delete body[hint];
      if (input.stream && !omittedHints.has("stream_options") && !additionalOmissions.has("stream_options")) {
        body.stream_options = { include_usage: true };
      }
      return body;
    };
    const send = (body: Record<string, unknown>) => this.fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, timeoutSignal]),
      headers: {
        "content-type": "application/json",
        accept: input.stream ? "text/event-stream" : "application/json",
        ...(runtime.connection.secrets.apiKey ? { authorization: `Bearer ${runtime.connection.secrets.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    let response: Response;
    try {
      response = await send(requestBody());
      const rejectedHints = await rejectedCompatibilityHints(response);
      if (rejectedHints.size > 0) response = await send(requestBody(rejectedHints));
    } catch {
      throw new InferenceGatewayError("UPSTREAM_FAILED", "The approved inference server could not be reached.");
    }
    if (!response.ok) {
      throw new InferenceGatewayError("UPSTREAM_FAILED", `The approved inference server returned status ${response.status}.`);
    }
    return {
      response,
      maxResponseBytes: Math.min(8_000_000, Math.max(65_536, policy.maxOutputCharacters * 8)),
    };
  }
}

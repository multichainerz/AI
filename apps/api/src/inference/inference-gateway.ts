import { timingSafeEqual } from "node:crypto";
import type { InferenceGatewayChatRequest } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";
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
  if (!connection.baseUrl) throw new InferenceGatewayError("NOT_CONFIGURED", "The approved vLLM route has no endpoint.");
  const path = typeof connection.configuration.chatPath === "string"
    ? connection.configuration.chatPath
    : "/v1/chat/completions";
  try {
    const endpoint = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
    return endpoint;
  } catch {
    throw new InferenceGatewayError("NOT_CONFIGURED", "The approved vLLM route is invalid.");
  }
}

export class PrismaInferenceGateway {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly connections: ConnectionDiagnosticStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async authenticate(token: string | undefined): Promise<string> {
    if (!token) throw new InferenceGatewayError("UNAUTHORIZED", "A runtime gateway credential is required.");
    const candidates = await this.prisma.serviceConnection.findMany({
      where: {
        kind: "HERMES",
        enabled: true,
        hermesRuntimeNode: { is: { status: { notIn: ["SUSPENDED", "REVOKED"] } } },
      },
      select: { id: true },
      take: 100,
    });
    const runtimes = await Promise.all(candidates.map(async (candidate) => {
      try {
        return await this.connections.resolveForDiagnostic(candidate.id);
      } catch {
        return null;
      }
    }));
    const matches = runtimes.filter((runtime) => {
      if (!runtime) return false;
      const expected = runtime.secrets.inferenceGatewayKey;
      return Boolean(expected && secureEqual(token, expected));
    }) as ResolvedConnection[];
    if (matches.length !== 1) {
      throw new InferenceGatewayError("UNAUTHORIZED", "The runtime gateway credential is invalid.");
    }
    return matches[0]!.id;
  }

  private async resolvePolicy(): Promise<RuntimeTextPolicy> {
    const enforced = await this.prisma.guardrailPolicy.count({ where: { firstActivatedAt: { not: null } } }) > 0;
    if (!enforced) return DEFAULT_POLICY;
    const active = await this.prisma.guardrailPolicy.findMany({
      where: { status: "ACTIVE" },
      select: {
        maxInputCharacters: true,
        maxOutputCharacters: true,
        blockControlCharacters: true,
        blockCredentialPatterns: true,
      },
      take: 2,
    });
    if (active.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one evaluated AIHub guardrail policy must be active.");
    }
    return active[0]!;
  }

  private async resolveInference(): Promise<{ connection: ResolvedConnection; modelAlias: string; maxOutputTokens: number; requestsPerMinute: number }> {
    const catalogueEnforced = await this.prisma.modelDeployment.count({
      where: { workload: "AGENT", firstActivatedAt: { not: null } },
    }) > 0;
    const routes = catalogueEnforced ? await this.prisma.modelDeployment.findMany({
      where: { workload: "AGENT", status: "ACTIVE", isDefault: true },
      select: { connectionId: true, modelAlias: true, maxOutputTokens: true },
      take: 2,
    }) : [];
    if (catalogueEnforced && routes.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one evaluated default Agent model route must be active.");
    }
    const route = routes[0];
    const candidates = await this.prisma.serviceConnection.findMany({
      where: route
        ? { id: route.connectionId, kind: "VLLM", enabled: true, status: "HEALTHY" }
        : { kind: "VLLM", enabled: true, status: "HEALTHY" },
      select: { id: true },
      take: 2,
    });
    if (candidates.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one healthy vLLM inference route is required.");
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
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-inference-gateway:${runtimeConnectionId}`}, 0))`;
      const recent = await transaction.auditEvent.count({
        where: {
          action: "inference.gateway_requested",
          resourceId: runtimeConnectionId,
          occurredAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      if (recent >= requestsPerMinute) throw new InferenceGatewayError("RATE_LIMITED", "The Hermes inference gateway is at its request limit.");
      await transaction.auditEvent.create({ data: {
        actorType: "SERVICE",
        actorId: runtimeConnectionId,
        action: "inference.gateway_requested",
        resourceType: "ServiceConnection",
        resourceId: runtimeConnectionId,
        outcome: "SUCCESS",
        metadata: { modelAlias, enforcementPlane: "AIHUB" },
      } });
    });
  }

  async models(token: string | undefined): Promise<Record<string, unknown>> {
    await this.authenticate(token);
    const runtime = await this.resolveInference();
    return {
      object: "list",
      data: [{ id: runtime.modelAlias, object: "model", owned_by: "mpm-aihub" }],
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
        throw new InferenceGatewayError("POLICY_REJECTED", `AIHub rejected the runtime request (${violation}).`);
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
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, timeoutSignal]),
        headers: {
          "content-type": "application/json",
          accept: input.stream ? "text/event-stream" : "application/json",
          ...(runtime.connection.secrets.apiKey ? { authorization: `Bearer ${runtime.connection.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...forwardedInput,
          model: runtime.modelAlias,
          user: `hermes:${runtimeConnectionId}`,
          ...(input.stream ? { stream_options: { include_usage: true } } : {}),
        }),
      });
    } catch {
      throw new InferenceGatewayError("UPSTREAM_FAILED", "The approved vLLM route could not be reached.");
    }
    if (!response.ok) {
      throw new InferenceGatewayError("UPSTREAM_FAILED", `The approved vLLM route returned status ${response.status}.`);
    }
    return {
      response,
      maxResponseBytes: Math.min(8_000_000, Math.max(65_536, policy.maxOutputCharacters * 8)),
    };
  }
}

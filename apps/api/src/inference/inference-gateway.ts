import { timingSafeEqual } from "node:crypto";
import type { GuardrailRule, InferenceBackend, InferenceGatewayChatRequest } from "@orcasynapse/contracts";
import { and, eq, gte, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import {
  auditEvent,
  inferenceGatewayRequest,
  guardrailPolicy,
  modelDeployment,
  serviceConnection,
  hermesRuntimeNode,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";
import { endpointUrl } from "../connections/diagnostics/http.js";
import { advisoryLock } from "../database-support.js";
import {
  inspectInput,
  type GuardrailRuleMatch,
  type RuntimePolicyViolation,
  type RuntimeTextPolicy,
} from "../guardrails/runtime-policy.js";

/**
 * The policy a deployment runs under before any has ever been activated, plus
 * the rules that policy carries.
 *
 * `rules` is on the resolved policy rather than beside it because a rule list
 * and the thresholds it runs after are one configuration: resolving them
 * separately is how one caller ends up enforcing thresholds from the active
 * policy and rules from nowhere.
 */
type ResolvedPolicy = RuntimeTextPolicy & { rules: GuardrailRule[] };

const DEFAULT_POLICY: ResolvedPolicy = {
  maxInputCharacters: 32_000,
  maxOutputCharacters: 200_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  rules: [],
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
  /** True when the body is SSE, so the route can end it in a way the caller can read. */
  stream: boolean;
}

/**
 * Wire bytes to allow per token of a streamed completion.
 *
 * `maxOutputCharacters` bounds *content*, and on a single JSON body content and
 * bytes stay within a small constant of each other. On SSE they do not: every
 * token arrives as its own framed chunk — `data: ` plus a whole
 * chat-completion envelope plus a blank line — measured at about 231 wire bytes
 * per four characters of content, roughly 50:1. Reasoning models are worse
 * again, because `reasoning_content` deltas cost wire bytes and produce no
 * output characters at all.
 *
 * So a streamed budget is derived from the deployment's token ceiling, which is
 * the real bound on how many frames the approved route can emit, times what a
 * frame costs with headroom for reasoning deltas and keepalives. Deriving it
 * from characters at 8 bytes each cut the default 200,000-character policy off
 * after ~6,900 frames — below an 8,192-token deployment — and cut it *after*
 * the headers were flushed, which the caller could not tell from a complete
 * answer.
 */
const SSE_WIRE_BYTES_PER_TOKEN = 512;
/** A streamed body is piped, never buffered, so this bounds the wire and not the heap. */
const MAX_STREAM_RESPONSE_BYTES = 64_000_000;
const MAX_JSON_RESPONSE_BYTES = 8_000_000;
const MIN_RESPONSE_BYTES = 65_536;

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

type GatewayMessage = InferenceGatewayChatRequest["messages"][number];
type GatewayContentPart = Exclude<GatewayMessage["content"], string | null | undefined>[number];

/**
 * Whether one content part carries guarded text. Only `text` parts do —
 * image, audio and file parts are opaque extensions the guardrail layer has
 * nothing to read in — and the schema types text parts fully so the rewrite
 * below can put a redacted string back exactly where the original sat.
 */
function isTextPart(part: GatewayContentPart): part is Extract<GatewayContentPart, { type: "text"; text: string }> {
  return part.type === "text" && "text" in part && typeof part.text === "string";
}

function endpointFor(connection: ResolvedConnection): URL {
  if (!connection.baseUrl) throw new InferenceGatewayError("NOT_CONFIGURED", "The approved inference route has no endpoint.");
  const path = typeof connection.configuration.chatPath === "string"
    ? connection.configuration.chatPath
    : "/v1/chat/completions";
  try {
    // Re-checked at use, not only where it was written. A stored path that
    // reached the row without contract validation could otherwise resolve to
    // another origin and turn the gateway into a request forwarder.
    return endpointUrl(connection.baseUrl, path);
  } catch {
    throw new InferenceGatewayError("NOT_CONFIGURED", "The approved inference route is invalid.");
  }
}

/*
 * Optional request fields a compact OpenAI-compatible server may reject
 * instead of ignoring. `max_completion_tokens` is a swap rather than a drop:
 * the gateway forwards the modern field — OpenAI's reasoning models refuse
 * the deprecated `max_tokens` — and a backend that rejects it gets the same
 * cap re-sent under the old name.
 */
const COMPATIBILITY_HINTS = ["reasoning_effort", "stream_options", "max_completion_tokens"] as const;
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

/**
 * Reads at most `limit` bytes, then stops pulling and cancels the body.
 *
 * The declared-length check above cannot stand alone: `content-length` is
 * absent on a chunked response, `Number(null)` is 0, and 0 is not greater than
 * the limit — so every chunked error body fell straight through to an unbounded
 * `.text()` and the size check ran only after the whole thing was already in
 * the heap. An upstream that answers 400 with a multi-gigabyte chunked body
 * (an error page, or a validation error echoing the prompt) took the API with
 * it, and the rate limiter is consumed before the upstream call, so a node can
 * drive this repeatedly.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (read > limit) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * Exported for its own test; not part of the gateway's public surface.
 *
 * Reads the rejected response's own body, never a clone of it. `clone()` tees
 * the stream: every chunk the read branch pulls is also queued on the branch
 * nobody reads, so the bound stopped nothing from being retained, and — worse —
 * a tee branch's `cancel()` only settles once *both* branches are cancelled, so
 * the bounded read's own cleanup never returned. A chunked 400 therefore hung
 * the gateway request with no timeout covering it and left the upstream body
 * open. Consuming the body here is safe because a 400 is never handed on: it is
 * either retried as a fresh request without the named hints, or turned into
 * UPSTREAM_FAILED.
 */
export async function rejectedCompatibilityHints(response: Response): Promise<Set<CompatibilityHint>> {
  if (response.status !== 400) return new Set();
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return new Set();
  let text = "";
  try {
    text = await readBounded(response, 16_384);
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

  private async resolvePolicy(): Promise<ResolvedPolicy> {
    // Latched on "a policy has been authored", like chat and agent runs: a
    // catalogue of never-activated drafts must refuse, not silently default.
    const [enforced] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(guardrailPolicy);
    if ((enforced?.total ?? 0) === 0) return DEFAULT_POLICY;

    const active = await this.database
      .select({
        maxInputCharacters: guardrailPolicy.maxInputCharacters,
        maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
        blockControlCharacters: guardrailPolicy.blockControlCharacters,
        blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
        rules: guardrailPolicy.rules,
      })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.status, "ACTIVE"))
      .limit(2);
    if (active.length !== 1) {
      throw new InferenceGatewayError("NOT_CONFIGURED", "Exactly one evaluated OrcaSynapse guardrail policy must be active.");
    }
    const policy = active[0]!;
    return { ...policy, rules: policy.rules as GuardrailRule[] };
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

  /**
   * The record that a request was refused, which nothing used to keep.
   *
   * Every accepted request writes `inference.gateway_requested` from inside
   * `consumeRateLimit`'s transaction. A refused one wrote nothing at all, and
   * the two refusals reached that state by different routes: `POLICY_REJECTED`
   * is thrown in `chat`'s message loop *before* `consumeRateLimit` is called,
   * and `RATE_LIMITED` is thrown *inside* that transaction, so a row written
   * beside it is rolled back with it. Guardrails could therefore block every
   * request in a deployment while the audit trail showed nothing happening,
   * and the only signal was an HTTP status on a machine-to-machine call.
   *
   * Written outside any transaction for exactly that second reason, and
   * best-effort for the first: the refusal is the outcome that matters, and an
   * audit insert that fails must not turn a clean 429 into a 500. Same
   * treatment the worker gives its own non-critical audit writes.
   */
  /** A redaction the gateway applied before forwarding. Counts and labels only. */
  private async recordRedaction(
    runtimeConnectionId: string,
    modelAlias: string,
    rules: readonly GuardrailRuleMatch[],
  ): Promise<void> {
    await this.database.insert(auditEvent).values({
      actorType: "SERVICE",
      actorId: runtimeConnectionId,
      action: "inference.gateway_redacted",
      resourceType: "ServiceConnection",
      resourceId: runtimeConnectionId,
      outcome: "SUCCESS",
      metadata: {
        modelAlias,
        enforcementPlane: "ORCASYNAPSE",
        rules: rules.map(({ ruleId, label, action, count }) => ({ ruleId, label, action, count })),
      },
    }).catch(() => undefined);
  }

  private async recordRejection(
    runtimeConnectionId: string,
    modelAlias: string,
    metadata:
      | {
        reason: "POLICY";
        violation: RuntimePolicyViolation;
        rules: Array<Pick<GuardrailRuleMatch, "ruleId" | "label" | "action" | "count">>;
      }
      | { reason: "RATE_LIMIT" },
  ): Promise<void> {
    await this.database.insert(auditEvent).values({
      actorType: "SERVICE",
      actorId: runtimeConnectionId,
      action: "inference.gateway_rejected",
      resourceType: "ServiceConnection",
      resourceId: runtimeConnectionId,
      outcome: "FAILURE",
      metadata: { ...metadata, modelAlias, enforcementPlane: "ORCASYNAPSE" },
    }).catch(() => undefined);
  }

  private async consumeRateLimit(runtimeConnectionId: string, requestsPerMinute: number, modelAlias: string): Promise<void> {
    try {
      await this.rateLimitTransaction(runtimeConnectionId, requestsPerMinute, modelAlias);
    } catch (error) {
      // Only after the transaction has unwound. Recording the refusal inside it
      // would enlist the row in the rollback that the refusal itself causes,
      // which is the reason there was no record of a rate limit to begin with.
      if (error instanceof InferenceGatewayError && error.code === "RATE_LIMITED") {
        await this.recordRejection(runtimeConnectionId, modelAlias, { reason: "RATE_LIMIT" });
      }
      throw error;
    }
  }

  private async rateLimitTransaction(runtimeConnectionId: string, requestsPerMinute: number, modelAlias: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // Serialises counting and recording for this runtime, so two concurrent
      // requests cannot both observe a count below the limit and pass.
      await transaction.execute(advisoryLock(`orcasynapse-inference-gateway:${runtimeConnectionId}`));
      const windowStartedAt = new Date(Date.now() - 60_000);
      // Pruning first keeps the counter proportional to the limit rather than to
      // lifetime traffic, which is why this no longer counts from AuditEvent.
      await transaction
        .delete(inferenceGatewayRequest)
        .where(and(
          eq(inferenceGatewayRequest.connectionId, runtimeConnectionId),
          lt(inferenceGatewayRequest.occurredAt, windowStartedAt),
        ));
      const [recent] = await transaction
        .select({ total: sql<number>`count(*)::int` })
        .from(inferenceGatewayRequest)
        .where(
          and(
            eq(inferenceGatewayRequest.connectionId, runtimeConnectionId),
            gte(inferenceGatewayRequest.occurredAt, windowStartedAt),
          ),
        );
      if ((recent?.total ?? 0) >= requestsPerMinute) {
        throw new InferenceGatewayError("RATE_LIMITED", "The Hermes inference gateway is at its request limit.");
      }
      await transaction.insert(inferenceGatewayRequest).values({ connectionId: runtimeConnectionId });
      // The audit trail still records every gateway request in full.
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
    /*
     * Inspected message by message, and rebuilt from what inspection returned.
     *
     * The rebuilt array is what gets forwarded: a REDACT rule that rewrote a
     * message here has to be the version the model sees, or the redaction is
     * decoration. `messages` is reassigned rather than mutated in place because
     * `input` is the parsed request body and the caller's copy of it should not
     * change under them.
     */
    const inspected: InferenceGatewayChatRequest["messages"] = [];
    const redactions: GuardrailRuleMatch[] = [];
    /*
     * The length ceiling is the one check that must be role-aware, because a
     * message may only be re-checked against the ceiling it was produced
     * under. Person-typed input was authored under `maxInputCharacters` and
     * already refused at the composer if it broke it; assistant and tool
     * messages were produced under `maxOutputCharacters`, which the policy
     * deliberately sets far higher. Re-bounding those at the input ceiling on
     * echo was the bug this replaces: the first answer or tool page longer
     * than 32k characters made every later turn of its conversation refuse
     * with INPUT_CHARACTER_LIMIT -- a thread poisoned by its own history.
     * Detectors and the operator's rules still run on every role; only the
     * length check varies.
     */
    const ceilingFor = (role: InferenceGatewayChatRequest["messages"][number]["role"]) =>
      role === "assistant" || role === "tool" ? policy.maxOutputCharacters : policy.maxInputCharacters;
    const inspectText = async (text: string, maxInputCharacters: number) => {
      const inspection = inspectInput(text, { ...policy, maxInputCharacters }, policy.rules);
      if (inspection.decision === "BLOCK") {
        // The violation name and the rule labels, never the text that carried
        // them. A CREDENTIAL_PATTERN rejection exists because the message
        // contained something that looked like a key; copying the message into
        // the audit trail to explain that would store the key.
        await this.recordRejection(runtimeConnectionId, runtime.modelAlias, {
          reason: "POLICY",
          violation: inspection.reason!,
          rules: inspection.matches.map(({ ruleId, label, action, count }) => ({ ruleId, label, action, count })),
        });
        throw new InferenceGatewayError("POLICY_REJECTED", `OrcaSynapse rejected the runtime request (${inspection.reason}).`);
      }
      redactions.push(...inspection.matches.filter(({ action }) => action !== "FLAG"));
      return inspection.text;
    };
    for (const message of input.messages) {
      if (typeof message.content === "string" && message.content) {
        const text = await inspectText(message.content, ceilingFor(message.role));
        inspected.push(text === message.content ? message : { ...message, content: text });
        continue;
      }
      /*
       * Content-parts form: every text part is guarded exactly as a string
       * body is, and a redaction is written back into the part it came from.
       * Skipping this walk would make the guardrails a string-only formality
       * the moment a caller switches to the array form both APIs prefer.
       */
      if (Array.isArray(message.content)) {
        let changed = false;
        const parts: GatewayContentPart[] = [];
        for (const part of message.content) {
          if (isTextPart(part) && part.text) {
            const text = await inspectText(part.text, ceilingFor(message.role));
            if (text !== part.text) {
              changed = true;
              parts.push({ ...part, text });
              continue;
            }
          }
          parts.push(part);
        }
        inspected.push(changed ? { ...message, content: parts } : message);
        continue;
      }
      inspected.push(message);
    }
    const guarded: InferenceGatewayChatRequest = { ...input, messages: inspected };
    if (redactions.length > 0) {
      await this.recordRedaction(runtimeConnectionId, runtime.modelAlias, redactions);
    }
    await this.consumeRateLimit(runtimeConnectionId, runtime.requestsPerMinute, runtime.modelAlias);
    const endpoint = endpointFor(runtime.connection);
    const timeoutMs = Math.trunc(numbers(runtime.connection.configuration.inferenceTimeoutMs, 300_000, 5_000, 900_000));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // `guarded`, not `input` — this spread is what actually reaches the model,
    // so spreading the pre-inspection body here is how a redaction becomes
    // decoration that only the audit trail believes in.
    const forwardedInput: Record<string, unknown> = { ...guarded };
    delete forwardedInput.max_completion_tokens;
    delete forwardedInput.max_tokens;
    const outputTokenCap = Math.min(
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
      const omitted = new Set([...omittedHints, ...additionalOmissions]);
      for (const hint of omitted) delete body[hint];
      // The cap always travels; only its spelling adapts. Modern field first —
      // OpenAI's reasoning models refuse `max_tokens` — and the deprecated one
      // for a backend that rejected the modern name.
      if (omitted.has("max_completion_tokens")) body.max_tokens = outputTokenCap;
      else body.max_completion_tokens = outputTokenCap;
      if (input.stream && !omitted.has("stream_options")) {
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
    const jsonResponseBytes = Math.min(
      MAX_JSON_RESPONSE_BYTES,
      Math.max(MIN_RESPONSE_BYTES, policy.maxOutputCharacters * 8),
    );
    return {
      response,
      // Never below the JSON budget: the guardrail's own character allowance
      // must not be the thing that truncates a stream.
      maxResponseBytes: input.stream
        ? Math.min(
          MAX_STREAM_RESPONSE_BYTES,
          Math.max(jsonResponseBytes, runtime.maxOutputTokens * SSE_WIRE_BYTES_PER_TOKEN),
        )
        : jsonResponseBytes,
      stream: input.stream === true,
    };
  }
}

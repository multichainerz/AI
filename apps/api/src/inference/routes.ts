import { Readable } from "node:stream";
import { inferenceGatewayChatRequestSchema } from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InferenceGatewayError, type InferenceGatewayResult, type DrizzleInferenceGateway } from "./inference-gateway.js";

export interface InferenceGatewayRouteOptions {
  gateway?: Pick<DrizzleInferenceGateway, "models" | "chat">;
}

function bearer(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

function sendGatewayError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof InferenceGatewayError)) throw error;
  const status = error.code === "UNAUTHORIZED"
    ? 401
    : error.code === "POLICY_REJECTED"
      ? 400
      : error.code === "RATE_LIMITED"
        ? 429
        : error.code === "NOT_CONFIGURED"
          ? 503
          : 502;
  return reply.code(status).send({ error: { type: error.code.toLowerCase(), message: error.message } });
}

function gatewayOrLocked(options: InferenceGatewayRouteOptions, reply: FastifyReply) {
  if (options.gateway) return options.gateway;
  void reply.code(503).send({ error: { type: "gateway_unavailable", message: "OrcaSynapse inference services are not ready." } });
  return null;
}

/**
 * The one thing a caller can read once the headers are gone.
 *
 * The limit is reached mid-body, long after the status line went out, so there
 * is no status code left to say it with. An `error` frame is how the
 * OpenAI-compatible wire says it instead: both the official Python and
 * JavaScript clients raise on a data frame carrying `error`, and a client that
 * does not understand it still sees a stream that ended deliberately rather
 * than one that simply stopped.
 */
const RESPONSE_LIMIT_FRAMES = new TextEncoder().encode(
  // Leading blank line: the cut lands on a read boundary, which need not be a
  // frame boundary, so this closes whatever frame was half-written before the
  // error frame begins.
  `\n\ndata: ${JSON.stringify({
    error: {
      type: "response_limit_exceeded",
      code: "orcasynapse_response_limit",
      message: "OrcaSynapse stopped this response at its size limit. The answer is incomplete.",
    },
  })}\n\ndata: [DONE]\n\n`,
);

function boundedResponseStream(
  { response, maxResponseBytes, stream }: InferenceGatewayResult,
  onLimit: () => void,
): Readable {
  if (!response.body) return Readable.from([]);
  const body = response.body;
  return Readable.from((async function* () {
    const reader = body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          onLimit();
          // A JSON body cut short is already self-evidently truncated, and
          // there is nothing honest to append to it. A stream is not: without
          // this frame it reads as an answer that finished.
          if (stream) yield RESPONSE_LIMIT_FRAMES;
          else throw new Error("OrcaSynapse inference response limit exceeded.");
          return;
        }
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })());
}

export async function registerInferenceGatewayRoutes(
  app: FastifyInstance,
  options: InferenceGatewayRouteOptions,
): Promise<void> {
  app.get("/models", async (request, reply) => {
    const gateway = gatewayOrLocked(options, reply);
    if (!gateway) return reply;
    try {
      return await gateway.models(bearer(request));
    } catch (error) {
      return sendGatewayError(error, reply);
    }
  });

  /*
   * 16 MiB, on this one route only: this-turn `data:image` parts plus the
   * replayed transcript. Hermes persist stores `[screenshot]`, so later
   * turns do not re-send old pixels; the ceiling is the current user
   * message, not a historical-PNG lock. Nginx `client_max_body_size` on
   * `/internal/v1/` must stay at least this high. Every other route keeps
   * the tight default as its own defense.
   */
  app.post("/chat/completions", { bodyLimit: 16 * 1_048_576 }, async (request, reply) => {
    const gateway = gatewayOrLocked(options, reply);
    if (!gateway) return reply;
    const parsed = inferenceGatewayChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      /*
       * An unrecognised field is named, and named as version skew.
       *
       * The request schema is a strict allowlist, which is deliberate -- this
       * gateway is the one path an enrolled node has to a model, and it should
       * carry what the product understands and nothing else. But the allowlist
       * is pinned in this repository while the node's runtime is pinned by a
       * commit an administrator can now change from the dashboard, and the two
       * are not tied together. A Hermes build that begins sending one new field
       * therefore fails *every* model call, while the node keeps reporting
       * ONLINE because its heartbeat is a different route entirely.
       *
       * Zod's default message for that case is "Unrecognized key(s) in object",
       * which sends an operator looking at their prompt. Naming the key and the
       * cause turns a silent, total outage into a one-line diagnosis.
       */
      const unrecognized = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
      const keys = unrecognized && "keys" in unrecognized ? (unrecognized.keys as string[]).join(", ") : "";
      const message = keys
        ? `This OrcaSynapse release does not accept the request field(s): ${keys}. `
          + "This usually means the Agentic System runtime is pinned to a commit newer than the control plane."
        : parsed.error.issues[0]?.message ?? "Invalid request.";
      return reply.code(400).send({ error: { type: "invalid_request_error", message } });
    }
    /*
     * Server-generated message fields come back out of every history
     * round-trip — Hermes echoes assistant messages exactly as the model
     * returned them — and upstreams reject most of their own output fields on
     * the way back in. Accepted by the schema so the request parses, removed
     * here so the upstream only ever receives what it accepts.
     *
     * `reasoning_details` is deliberately NOT in this list: OpenRouter asks
     * clients to echo it to preserve reasoning across turns, and no other
     * upstream produces it, so forwarding it can only reach the upstream
     * that minted it.
     */
    const outbound = {
      ...parsed.data,
      messages: parsed.data.messages.map(
        ({ reasoning_content, reasoning, refusal, annotations, audio, images, ...message }) => message,
      ),
    };
    const abort = new AbortController();
    const abortOnDisconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
    request.raw.once("aborted", abortOnDisconnect);
    reply.raw.once("close", abortOnDisconnect);
    let handedOff = false;
    try {
      const result = await gateway.chat(bearer(request), outbound, abort.signal);
      void reply.code(result.response.status);
      void reply.header("content-type", result.response.headers.get("content-type") ?? (parsed.data.stream ? "text/event-stream" : "application/json"));
      void reply.header("cache-control", "no-store");
      void reply.header("x-content-type-options", "nosniff");
      handedOff = true;
      return reply.send(boundedResponseStream(result, () => {
        request.log.warn(
          { maxResponseBytes: result.maxResponseBytes, stream: result.stream },
          "OrcaSynapse truncated an inference response at its size limit.",
        );
      }));
    } catch (error) {
      return sendGatewayError(error, reply);
    } finally {
      if (!handedOff) {
        request.raw.off("aborted", abortOnDisconnect);
        reply.raw.off("close", abortOnDisconnect);
      }
    }
  });
}

import { Readable } from "node:stream";
import { inferenceGatewayChatRequestSchema } from "@aihub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InferenceGatewayError, type InferenceGatewayResult, type PrismaInferenceGateway } from "./inference-gateway.js";

export interface InferenceGatewayRouteOptions {
  gateway?: Pick<PrismaInferenceGateway, "models" | "chat">;
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
  void reply.code(503).send({ error: { type: "gateway_unavailable", message: "AIHub inference services are not ready." } });
  return null;
}

function boundedResponseStream({ response, maxResponseBytes }: InferenceGatewayResult): Readable {
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
        if (bytes > maxResponseBytes) throw new Error("AIHub inference response limit exceeded.");
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

  app.post("/chat/completions", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const gateway = gatewayOrLocked(options, reply);
    if (!gateway) return reply;
    const parsed = inferenceGatewayChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: parsed.error.issues[0]?.message ?? "Invalid request." } });
    }
    const abort = new AbortController();
    const abortOnDisconnect = () => { if (!reply.raw.writableEnded) abort.abort(); };
    request.raw.once("aborted", abortOnDisconnect);
    reply.raw.once("close", abortOnDisconnect);
    let handedOff = false;
    try {
      const result = await gateway.chat(bearer(request), parsed.data, abort.signal);
      void reply.code(result.response.status);
      void reply.header("content-type", result.response.headers.get("content-type") ?? (parsed.data.stream ? "text/event-stream" : "application/json"));
      void reply.header("cache-control", "no-store");
      void reply.header("x-content-type-options", "nosniff");
      handedOff = true;
      return reply.send(boundedResponseStream(result));
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

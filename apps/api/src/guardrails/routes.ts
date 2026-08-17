import {
  changeGuardrailPolicyStateSchema,
  createGuardrailPolicySchema,
  guardrailPolicyIdentifierSchema,
  guardrailPolicyListSchema,
  guardrailPolicySchema,
  updateGuardrailPolicySchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { GuardrailPatternError } from "./rule-compiler.js";
import { GuardrailConflictError, GuardrailNotFoundError, type GuardrailManager } from "./guardrail-manager.js";

interface GuardrailRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: GuardrailManager;
}

/**
 * A refused pattern, reported as what was wrong with it.
 *
 * `refusal` travels beside the message so the screen can be specific without
 * parsing prose: "nested quantifier" and "lookahead" call for different edits,
 * and an operator told only "invalid pattern" has nothing to act on.
 */
async function sendPatternRefusal(error: unknown, reply: FastifyReply): Promise<FastifyReply | null> {
  if (!(error instanceof GuardrailPatternError)) return null;
  return reply.code(400).send({
    error: "INVALID_GUARDRAIL_RULE",
    refusal: error.refusal,
    message: error.message,
  });
}

export async function registerGuardrailRoutes(app: FastifyInstance, dependencies: GuardrailRouteDependencies): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  app.get("/", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "guardrails:read"))) return;
    return guardrailPolicyListSchema.parse(await dependencies.manager!.list());
  });

  app.post("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "guardrails:manage");
    if (!principal) return;
    const input = createGuardrailPolicySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_GUARDRAIL_POLICY", message: "Guardrail policy configuration is invalid.", issues: input.error.issues });
    try {
      return reply.code(201).send(guardrailPolicySchema.parse(await dependencies.manager!.create(principal, input.data)));
    } catch (error) {
      const refused = await sendPatternRefusal(error, reply);
      if (refused) return refused;
      if (error instanceof GuardrailConflictError) return reply.code(409).send({ error: "GUARDRAIL_CONFLICT", message: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "guardrails:manage");
    if (!principal) return;
    if (!guardrailPolicyIdentifierSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: "INVALID_GUARDRAIL_POLICY", message: "Guardrail policy identifier is invalid." });
    }
    const input = updateGuardrailPolicySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_GUARDRAIL_POLICY", message: "Guardrail policy update is invalid.", issues: input.error.issues });
    try {
      return guardrailPolicySchema.parse(await dependencies.manager!.update(principal, request.params.id, input.data));
    } catch (error) {
      const refused = await sendPatternRefusal(error, reply);
      if (refused) return refused;
      if (error instanceof GuardrailNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
      if (error instanceof GuardrailConflictError) return reply.code(409).send({ error: "GUARDRAIL_CONFLICT", message: error.message });
      throw error;
    }
  });

  for (const action of ["activate", "suspend"] as const) {
    app.post<{ Params: { id: string } }>(`/:id/${action}`, async (request, reply) => {
      const principal = await requireAdmin(request, reply, dependencies.sessionManager, "guardrails:manage");
      if (!principal) return;
      if (!guardrailPolicyIdentifierSchema.safeParse(request.params.id).success) {
        return reply.code(400).send({ error: "INVALID_GUARDRAIL_POLICY", message: "Guardrail policy identifier is invalid." });
      }
      const input = changeGuardrailPolicyStateSchema.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: "INVALID_GUARDRAIL_DECISION", message: "Guardrail policy decision is invalid.", issues: input.error.issues });
      try {
        const result = action === "activate"
          ? await dependencies.manager!.activate(principal, request.params.id, input.data)
          : await dependencies.manager!.suspend(principal, request.params.id, input.data);
        return guardrailPolicySchema.parse(result);
      } catch (error) {
        if (error instanceof GuardrailNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
        if (error instanceof GuardrailConflictError) return reply.code(409).send({ error: "GUARDRAIL_CONFLICT", message: error.message });
        throw error;
      }
    });
  }
}

import {
  architectureDecisionSchema,
  completeOnboardingSchema,
  componentCompatibilityKeySchema,
  onboardingSnapshotSchema,
  onboardingStepKeySchema,
  exportRecoveryKitSchema,
  recoveryKitExportSchema,
  runOnboardingValidationSchema,
  updateArchitectureDecisionSchema,
  updateComponentCompatibilitySchema,
  updateOnboardingStepSchema,
  verifyRecoveryKitSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import { OnboardingConflictError, OnboardingNotFoundError, type OnboardingManager } from "./onboarding-manager.js";

export interface OnboardingRouteOptions {
  sessionManager?: AdminSessionManager;
  manager?: OnboardingManager;
}

function managerOrLocked(options: OnboardingRouteOptions, reply: FastifyReply): OnboardingManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Onboarding services are not ready." });
  return null;
}

async function sendError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof OnboardingNotFoundError) return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
  if (error instanceof OnboardingConflictError) return reply.code(409).send({ error: "ONBOARDING_CONFLICT", message: error.message });
  throw error;
}

export async function registerOnboardingRoutes(app: FastifyInstance, options: OnboardingRouteOptions): Promise<void> {
  app.get("/", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:read");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    return onboardingSnapshotSchema.parse(await manager.snapshot());
  });

  app.patch("/architecture", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = updateArchitectureDecisionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_ARCHITECTURE_DECISION", message: input.error.issues[0]?.message });
    try {
      return architectureDecisionSchema.parse(await manager.updateArchitecture(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.patch<{ Params: { componentKey: string } }>("/components/:componentKey", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const key = componentCompatibilityKeySchema.safeParse(request.params.componentKey);
    const input = updateComponentCompatibilitySchema.safeParse(request.body);
    if (!key.success || !input.success) return reply.code(400).send({ error: "INVALID_COMPONENT_EVIDENCE", message: key.success ? input.error?.issues[0]?.message : "The component key is invalid." });
    try {
      return onboardingSnapshotSchema.parse(await manager.updateComponent(principal, key.data, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.patch<{ Params: { stepKey: string } }>("/steps/:stepKey", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const key = onboardingStepKeySchema.safeParse(request.params.stepKey);
    const input = updateOnboardingStepSchema.safeParse(request.body);
    if (!key.success || !input.success) return reply.code(400).send({ error: "INVALID_ONBOARDING_STEP", message: key.success ? input.error?.issues[0]?.message : "The onboarding step key is invalid." });
    try {
      return onboardingSnapshotSchema.parse(await manager.updateStep(principal, key.data, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/validate", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = runOnboardingValidationSchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: "INVALID_VALIDATION_REQUEST", message: input.error.issues[0]?.message });
    try {
      return onboardingSnapshotSchema.parse(await manager.runValidation(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/recovery/export", async (request, reply) => {
    // `readiness:approve`, not `readiness:manage`. What this returns is the
    // platform master encryption key wrapped under a passphrase the caller
    // chooses, so anyone who can call it and can also read the SecretRecord
    // table — from a backup, a replica, or a snapshot — holds every stored
    // connection secret. `readiness:manage` is an OPERATIONS_ADMIN scope, a
    // role otherwise denied every write and every secret value, which made
    // exporting the master key cheaper than the `/complete` route beside it.
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:approve");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = exportRecoveryKitSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_RECOVERY_EXPORT", message: input.error.issues[0]?.message });
    try {
      return recoveryKitExportSchema.parse(await manager.exportRecoveryKit(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/recovery/verify", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:manage");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = verifyRecoveryKitSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_RECOVERY_VERIFICATION", message: input.error.issues[0]?.message });
    try {
      return onboardingSnapshotSchema.parse(await manager.verifyRecoveryKit(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/complete", async (request, reply) => {
    const principal = await requireAdmin(request, reply, options.sessionManager, "readiness:approve");
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return reply;
    const input = completeOnboardingSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_COMPLETION", message: input.error.issues[0]?.message });
    try {
      return onboardingSnapshotSchema.parse(await manager.complete(principal, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });
}

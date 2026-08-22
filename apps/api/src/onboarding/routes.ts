import {
  onboardingSnapshotSchema,
  exportRecoveryKitSchema,
  recoveryKitExportSchema,
  runOnboardingValidationSchema,
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
    // role otherwise denied every write and every secret value. Exporting the
    // master key must stay on the approval scope.
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
}

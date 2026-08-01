import {
  agentMetricsSchema,
  agentProfileListSchema,
  agentProfileSchema,
  agentRunListSchema,
  agentRunEventListSchema,
  agentRunSchema,
  agentRuntimeControlSchema,
  createAgentProfileSchema,
  submitAgentRunSchema,
  updateAgentProfileSchema,
  updateAgentRuntimeControlSchema,
  type AdminScope,
} from "@aihub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminSessionToken, type AdminSessionManager } from "../auth/admin-session.js";
import { enterpriseSessionToken, type EnterpriseIdentityManager } from "../identity/enterprise-session.js";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentRuntimeDisabledError,
  type AgentManager,
  type AgentPrincipal,
} from "./agent-manager.js";

export interface AgentRouteOptions {
  sessionManager?: AdminSessionManager;
  identityManager?: EnterpriseIdentityManager;
  manager?: AgentManager;
}

async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AgentRouteOptions,
  settings: { adminOnly?: boolean; adminScope?: AdminScope } = {},
): Promise<AgentPrincipal | null> {
  const administrator = await options.sessionManager?.authenticate(adminSessionToken(request));
  if (administrator) {
    if (settings.adminScope && !administrator.scopes.includes(settings.adminScope)) {
      await reply.code(403).send({ error: "FORBIDDEN", message: `The administrator session does not grant '${settings.adminScope}'.` });
      return null;
    }
    return { id: administrator.id, subject: administrator.subject, identityMode: "ADMINISTRATOR_PREVIEW", scopes: administrator.scopes };
  }
  if (!settings.adminOnly) {
    const enterprise = await options.identityManager?.authenticate(enterpriseSessionToken(request.headers.cookie));
    if (enterprise) {
      if (!enterprise.scopes.includes("agents:use")) {
        await reply.code(403).send({ error: "FORBIDDEN", message: "The enterprise session does not grant agent access." });
        return null;
      }
      return { id: enterprise.id, subject: enterprise.subject, identityMode: "ENTERPRISE", scopes: enterprise.scopes };
    }
  }
  if (!options.sessionManager && !options.identityManager) {
    await reply.code(423).send({ error: "PLATFORM_LOCKED", message: "AIHub identity services are not ready." });
    return null;
  }
  await reply.code(401).send({ error: "UNAUTHORIZED", message: "An active AIHub session is required." });
  return null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

async function sendAgentError(reply: FastifyReply, error: unknown): Promise<void> {
  if (error instanceof AgentNotFoundError) {
    await reply.code(404).send({ error: "AGENT_NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof AgentConflictError) {
    await reply.code(409).send({ error: "AGENT_CONFLICT", message: error.message });
    return;
  }
  if (error instanceof AgentRuntimeDisabledError) {
    await reply.code(423).send({ error: "AGENT_RUNTIME_DISABLED", message: error.message });
    return;
  }
  throw error;
}

function managerOrLocked(options: AgentRouteOptions, reply: FastifyReply): AgentManager | null {
  if (options.manager) return options.manager;
  void reply.code(423).send({ error: "PLATFORM_LOCKED", message: "Agent services are not ready." });
  return null;
}

export async function registerAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): Promise<void> {
  app.get("/profiles", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:read" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentProfileListSchema.parse(await manager.listProfiles(principal, false));
  });

  app.get("/runs", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:read" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentRunListSchema.parse(await manager.listRuns(principal, false));
  });

  app.post("/runs", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:control" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const input = submitAgentRunSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try {
      return reply.code(202).send(agentRunSchema.parse(await manager.submitRun(principal, input.data)));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.get("/runs/:runId", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:read" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const runId = uuid((request.params as Record<string, unknown>).runId);
    if (!runId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent run ID is invalid." });
    try {
      return agentRunSchema.parse(await manager.getRun(principal, runId, false));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.get("/runs/:runId/events", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:read" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const runId = uuid((request.params as Record<string, unknown>).runId);
    if (!runId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent run ID is invalid." });
    try {
      return agentRunEventListSchema.parse(await manager.listRunEvents(principal, runId, false));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.post("/runs/:runId/cancel", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, options, { adminScope: "agents:control" });
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const runId = uuid((request.params as Record<string, unknown>).runId);
    if (!runId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent run ID is invalid." });
    try {
      return agentRunSchema.parse(await manager.cancelRun(principal, runId, false));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });
}

export async function registerAdminAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): Promise<void> {
  const admin = (scope: AdminScope) => async (request: FastifyRequest, reply: FastifyReply) =>
    requirePrincipal(request, reply, options, { adminOnly: true, adminScope: scope });

  app.get("/profiles", async (request, reply) => {
    const principal = await admin("agents:read")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentProfileListSchema.parse(await manager.listProfiles(principal, true));
  });

  app.post("/profiles", async (request, reply) => {
    const principal = await admin("agents:manage")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const input = createAgentProfileSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try {
      return reply.code(201).send(agentProfileSchema.parse(await manager.createProfile(principal, input.data)));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.patch("/profiles/:profileId", async (request, reply) => {
    const principal = await admin("agents:manage")(request, reply);
    const manager = managerOrLocked(options, reply);
    const profileId = uuid((request.params as Record<string, unknown>).profileId);
    const input = updateAgentProfileSchema.safeParse(request.body);
    if (!principal || !manager) return;
    if (!profileId || !input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: profileId ? input.error?.issues[0]?.message : "Agent profile ID is invalid." });
    try {
      return agentProfileSchema.parse(await manager.updateProfile(principal, profileId, input.data));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  for (const action of ["standby", "activate", "suspend"] as const) {
    app.post(`/profiles/:profileId/${action}`, async (request, reply) => {
      const principal = await admin("agents:manage")(request, reply);
      const manager = managerOrLocked(options, reply);
      const profileId = uuid((request.params as Record<string, unknown>).profileId);
      if (!principal || !manager) return;
      if (!profileId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent profile ID is invalid." });
      try {
        const result = action === "activate"
          ? await manager.activateProfile(principal, profileId)
          : action === "standby"
            ? await manager.standbyProfile(principal, profileId)
            : await manager.suspendProfile(principal, profileId);
        return agentProfileSchema.parse(result);
      } catch (error) {
        await sendAgentError(reply, error);
      }
    });
  }

  app.get("/runs", async (request, reply) => {
    const principal = await admin("agents:read")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentRunListSchema.parse(await manager.listRuns(principal, true));
  });

  app.get("/runs/:runId/events", async (request, reply) => {
    const principal = await admin("agents:read")(request, reply);
    const manager = managerOrLocked(options, reply);
    const runId = uuid((request.params as Record<string, unknown>).runId);
    if (!principal || !manager) return;
    if (!runId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent run ID is invalid." });
    try {
      return agentRunEventListSchema.parse(await manager.listRunEvents(principal, runId, true));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.post("/runs/:runId/cancel", async (request, reply) => {
    const principal = await admin("agents:control")(request, reply);
    const manager = managerOrLocked(options, reply);
    const runId = uuid((request.params as Record<string, unknown>).runId);
    if (!principal || !manager) return;
    if (!runId) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Agent run ID is invalid." });
    try {
      return agentRunSchema.parse(await manager.cancelRun(principal, runId, true));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.get("/runtime", async (request, reply) => {
    const principal = await admin("agents:read")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentRuntimeControlSchema.parse(await manager.getRuntimeControl());
  });

  app.patch("/runtime", async (request, reply) => {
    const principal = await admin("agents:control")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    const input = updateAgentRuntimeControlSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: input.error.issues[0]?.message });
    try {
      return agentRuntimeControlSchema.parse(await manager.updateRuntimeControl(principal, input.data));
    } catch (error) {
      await sendAgentError(reply, error);
    }
  });

  app.get("/metrics", async (request, reply) => {
    const principal = await admin("agents:read")(request, reply);
    const manager = managerOrLocked(options, reply);
    if (!principal || !manager) return;
    return agentMetricsSchema.parse(await manager.metrics());
  });
}

import {
  attachBenchmarkEvidenceSchema,
  benchmarkRunListSchema,
  benchmarkRunSchema,
  evaluationRunSchema,
  benchmarkSuiteListSchema,
  benchmarkSuiteSchema,
  createBenchmarkSuiteSchema,
  startBenchmarkRunSchema,
  updateBenchmarkSuiteSchema,
} from "@orcasynapse/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAdmin, type AdminSessionManager } from "../auth/admin-session.js";
import {
  BenchmarkRunNotFoundError,
  BenchmarkSuiteConflictError,
  BenchmarkSuiteNotFoundError,
  BenchmarkTargetUnavailableError,
  type BenchmarkManager,
} from "./benchmark-manager.js";

interface BenchmarkRouteDependencies {
  sessionManager?: AdminSessionManager;
  manager?: BenchmarkManager;
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof BenchmarkSuiteNotFoundError || error instanceof BenchmarkRunNotFoundError) {
    return reply.code(404).send({ error: "NOT_FOUND", message: error.message });
  }
  if (error instanceof BenchmarkSuiteConflictError) {
    return reply.code(409).send({ error: "BENCHMARK_SUITE_CONFLICT", message: error.message });
  }
  /*
   * 409, never a queued run.
   *
   * With no active Profile there is nothing to measure. Queuing anyway would
   * produce a 0% result that reads as a regression, and the history would then
   * contain a failure the model never caused.
   */
  if (error instanceof BenchmarkTargetUnavailableError) {
    return reply.code(409).send({ error: "BENCHMARK_TARGET_UNAVAILABLE", message: error.message });
  }
  throw error;
}

export async function registerBenchmarkRoutes(
  app: FastifyInstance,
  dependencies: BenchmarkRouteDependencies,
): Promise<void> {
  app.addHook("preHandler", async (_request, reply) => {
    if (!dependencies.sessionManager || !dependencies.manager) {
      return reply.code(423).send({ error: "PLATFORM_LOCKED", message: "OrcaSynapse installation trust is not ready." });
    }
  });

  /*
   * Benchmarks reuse the evaluation scopes rather than inventing their own. A
   * run is evaluation work — its output is the evidence an evaluation is
   * promoted on — so anyone trusted to manage evaluations is trusted to run
   * one, and no existing role needs a new grant.
   */
  app.get("/suites", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:read"))) return;
    return benchmarkSuiteListSchema.parse(await dependencies.manager!.listSuites());
  });

  app.post("/suites", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    const input = createBenchmarkSuiteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_BENCHMARK_SUITE", message: input.error.issues[0]?.message });
    }
    try {
      const created = await dependencies.manager!.createSuite(principal, input.data);
      return reply.code(201).send(benchmarkSuiteSchema.parse(created));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/suites/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    const input = updateBenchmarkSuiteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_BENCHMARK_SUITE", message: input.error.issues[0]?.message });
    }
    try {
      return benchmarkSuiteSchema.parse(await dependencies.manager!.updateSuite(principal, request.params.id, input.data));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/suites/:id", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    try {
      await dependencies.manager!.deleteSuite(principal, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.get<{ Querystring: { suiteId?: string; limit?: string } }>("/runs", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:read"))) return;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return reply.code(400).send({ error: "INVALID_BENCHMARK_QUERY", message: "limit must be between 1 and 200." });
    }
    // Results carry prompts and answer excerpts, so they must not sit in a
    // shared cache.
    void reply.header("cache-control", "no-store");
    return benchmarkRunListSchema.parse(await dependencies.manager!.listRuns(request.query.suiteId, limit));
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:read"))) return;
    try {
      void reply.header("cache-control", "no-store");
      return benchmarkRunSchema.parse(await dependencies.manager!.getRun(request.params.id));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/runs", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    const input = startBenchmarkRunSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_BENCHMARK_RUN", message: input.error.issues[0]?.message });
    }
    try {
      const run = await dependencies.manager!.startRun(principal, input.data);
      return reply.code(202).send(benchmarkRunSchema.parse(run));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  /*
   * Files a completed run into the evaluation ledger.
   *
   * The same scope as starting one: recording evidence a release will be
   * promoted on is evaluation work, and an auditor who may read a result is
   * deliberately not able to enter it as a gate.
   */
  app.post<{ Params: { id: string } }>("/runs/:id/evaluation", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    const input = attachBenchmarkEvidenceSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "INVALID_BENCHMARK_EVIDENCE", message: input.error.issues[0]?.message });
    }
    try {
      const evaluation = await dependencies.manager!.attachEvidence(principal, request.params.id, input.data);
      return reply.code(201).send(evaluationRunSchema.parse(evaluation));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (request, reply) => {
    const principal = await requireAdmin(request, reply, dependencies.sessionManager, "evaluations:manage");
    if (!principal) return;
    try {
      return benchmarkRunSchema.parse(await dependencies.manager!.cancelRun(principal, request.params.id));
    } catch (error) {
      return sendError(error, reply);
    }
  });
}

import type {
  BenchmarkRun,
  BenchmarkRunList,
  BenchmarkSuite,
  BenchmarkSuiteList,
  CreateBenchmarkSuite,
  StartBenchmarkRun,
  UpdateBenchmarkSuite,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export class BenchmarkSuiteNotFoundError extends Error {}
export class BenchmarkRunNotFoundError extends Error {}
export class BenchmarkSuiteConflictError extends Error {}

/**
 * A run cannot start because the thing it would measure is not there.
 *
 * Distinct from a failed run on purpose: "no active Agent Profile" is a setup
 * problem the operator fixes, whereas a failed run is a result. Recording the
 * first as a 0% score would put a fake regression in the history.
 */
export class BenchmarkTargetUnavailableError extends Error {}

export interface BenchmarkManager {
  listSuites(): Promise<BenchmarkSuiteList>;
  createSuite(principal: AdminPrincipal, input: CreateBenchmarkSuite): Promise<BenchmarkSuite>;
  updateSuite(principal: AdminPrincipal, id: string, input: UpdateBenchmarkSuite): Promise<BenchmarkSuite>;
  deleteSuite(principal: AdminPrincipal, id: string): Promise<void>;

  /**
   * Queues a run. Execution belongs to the worker, not to this request.
   *
   * A suite of forty cases against a governed agent is minutes of inference;
   * holding the HTTP connection open for it would tie the outcome to a browser
   * tab staying open, and a closed tab would lose the result.
   */
  startRun(principal: AdminPrincipal, input: StartBenchmarkRun): Promise<BenchmarkRun>;
  listRuns(suiteId?: string, limit?: number): Promise<BenchmarkRunList>;
  getRun(id: string): Promise<BenchmarkRun>;
  cancelRun(principal: AdminPrincipal, id: string): Promise<BenchmarkRun>;
}

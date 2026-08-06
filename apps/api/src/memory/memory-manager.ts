import type {
  AgentMemoryQuery,
  AgentMemoryRecordList,
  ChangeMemoryPolicyState,
  CreateMemoryPolicy,
  ForgetMatchingAgentMemory,
  ForgetMatchingResult,
  MemoryPolicy,
  MemoryPolicyList,
  PurgeAgentMemory,
  UpdateMemoryPolicy,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface MemoryManager {
  list(): Promise<MemoryPolicyList>;
  create(principal: AdminPrincipal, input: CreateMemoryPolicy): Promise<MemoryPolicy>;
  update(principal: AdminPrincipal, id: string, input: UpdateMemoryPolicy): Promise<MemoryPolicy>;
  activate(principal: AdminPrincipal, id: string, input: ChangeMemoryPolicyState): Promise<MemoryPolicy>;
  suspend(principal: AdminPrincipal, id: string, input: ChangeMemoryPolicyState): Promise<MemoryPolicy>;

  /** Administrative view across owners. */
  records(query: AgentMemoryQuery): Promise<AgentMemoryRecordList>;
  /** What one person's agents have stored about them. */
  recordsForOwner(ownerSubject: string, limit?: number): Promise<AgentMemoryRecordList>;
  forget(principal: { id: string; ownerSubject?: string }, memoryId: string, reason: string): Promise<void>;
  /** Bulk forget by topic, previewed on a dry run. */
  forgetMatching(
    principal: { id: string; ownerSubject?: string },
    input: ForgetMatchingAgentMemory,
  ): Promise<ForgetMatchingResult>;
  purge(principal: AdminPrincipal, input: PurgeAgentMemory): Promise<number>;
}

export class MemoryPolicyNotFoundError extends Error {
  constructor(message = "The memory policy does not exist.") {
    super(message);
    this.name = "MemoryPolicyNotFoundError";
  }
}

export class MemoryPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPolicyConflictError";
  }
}

/**
 * Raised when forget-matching cannot reach a model to decide with.
 *
 * Distinct from "nothing matched" on purpose: an operator who asked to forget a
 * topic and is told nothing matched will assume the topic is not stored, and
 * that would be a false assurance rather than a failed request.
 */
export class ForgetMatchingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgetMatchingUnavailableError";
  }
}

export class AgentMemoryNotFoundError extends Error {
  constructor(message = "The memory record does not exist within your scope.") {
    super(message);
    this.name = "AgentMemoryNotFoundError";
  }
}

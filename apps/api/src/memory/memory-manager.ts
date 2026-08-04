import type {
  AgentMemoryQuery,
  AgentMemoryRecordList,
  ChangeMemoryPolicyState,
  CreateMemoryPolicy,
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

export class AgentMemoryNotFoundError extends Error {
  constructor(message = "The memory record does not exist within your scope.") {
    super(message);
    this.name = "AgentMemoryNotFoundError";
  }
}

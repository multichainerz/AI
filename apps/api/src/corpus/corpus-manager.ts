import type {
  CreateHermesCorpusMutation,
  DecideHermesCorpusMutation,
  HermesCorpusEntry,
  HermesCorpusMutation,
  HermesCorpusMutationResult,
  HermesCorpusOverview,
  HermesCorpusRevision,
  HermesCorpusSignedDesiredState,
  HermesCorpusSnapshotReceipt,
  HermesCorpusSnapshotUpload,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";

export interface HermesCorpusQuery {
  nodeId: string;
  query?: string | undefined;
  kind?: HermesCorpusEntry["kind"] | undefined;
  includeDeleted?: boolean | undefined;
  includeContent?: boolean | undefined;
}

export interface HermesCorpusManager {
  overview(): Promise<HermesCorpusOverview>;
  entries(query: HermesCorpusQuery): Promise<HermesCorpusEntry[]>;
  revisions(entryId: string, includeContent: boolean): Promise<HermesCorpusRevision[]>;
  mutations(nodeId?: string): Promise<HermesCorpusMutation[]>;
  createMutation(principal: AdminPrincipal, input: CreateHermesCorpusMutation): Promise<HermesCorpusMutation>;
  decideMutation(principal: AdminPrincipal, mutationId: string, input: DecideHermesCorpusMutation): Promise<HermesCorpusMutation>;
  uploadSnapshot(nodeId: string, headers: NodeSignatureHeaders, input: HermesCorpusSnapshotUpload): Promise<HermesCorpusSnapshotReceipt>;
  desiredState(nodeId: string, headers: NodeSignatureHeaders): Promise<HermesCorpusSignedDesiredState>;
  completeMutation(nodeId: string, headers: NodeSignatureHeaders, input: HermesCorpusMutationResult): Promise<{ accepted: true; serverTime: string }>;
}

export class CorpusNotFoundError extends Error {
  constructor(message = "The requested Hermes corpus resource does not exist.") {
    super(message);
    this.name = "CorpusNotFoundError";
  }
}

export class CorpusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusConflictError";
  }
}

export class CorpusValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusValidationError";
  }
}

import type { MemoryMetrics, MemoryPublicationList } from "@aihub/contracts";

export interface MemoryManager {
  list(): Promise<MemoryPublicationList>;
  metrics(): Promise<MemoryMetrics>;
  reindex(documentId: string, actorId: string): Promise<void>;
}

export class MemoryPublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPublicationConflictError";
  }
}

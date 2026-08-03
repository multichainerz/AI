import type { RuntimeOperationsSnapshot } from "@orcasynapse/contracts";

export interface OperationsManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Promise<RuntimeOperationsSnapshot>;
}

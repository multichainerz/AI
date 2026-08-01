import type { RuntimeOperationsSnapshot } from "@aihub/contracts";

export interface OperationsManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Promise<RuntimeOperationsSnapshot>;
}

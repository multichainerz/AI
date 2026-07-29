import type {
  JobOperationsSnapshot,
  JobProbeResult,
  JobQueueName,
} from "@aihub/contracts";
import type { AdminActor } from "../connections/connection-manager.js";

export interface OperationsManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): Promise<JobOperationsSnapshot>;
  sendProbe(requestedBy: string, actor?: AdminActor): Promise<JobProbeResult>;
  retry(queue: JobQueueName, jobId: string, actor?: AdminActor): Promise<void>;
  redriveDeadLetters(limit: number, actor?: AdminActor): Promise<number>;
}

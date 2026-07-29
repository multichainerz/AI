import { z } from "zod";

export const JOB_QUEUE_NAMES = [
  "aihub.system.probe",
  "aihub.documents.convert",
  "aihub.documents.ocr",
  "aihub.memory.index",
  "aihub.dead-letter",
] as const;

export const jobQueueNameSchema = z.enum(JOB_QUEUE_NAMES);
export const jobIdentifierSchema = z.uuid();

export const systemProbePayloadSchema = z.object({
  requestedAt: z.iso.datetime(),
  requestedBy: z.string().min(1).max(120),
});

export const jobQueueSnapshotSchema = z.object({
  name: jobQueueNameSchema,
  displayName: z.string(),
  configured: z.boolean(),
  readyCount: z.number().int().nonnegative(),
  deferredCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  capturedAt: z.iso.datetime(),
});

export const workerNodeSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["ONLINE", "STALE", "STOPPED"]),
  startedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  version: z.string(),
  queues: z.array(jobQueueNameSchema),
});

export const jobOperationsSnapshotSchema = z.object({
  engine: z.literal("pg-boss"),
  status: z.enum(["ONLINE", "DEGRADED"]),
  statusReasons: z.array(z.string()),
  queues: z.array(jobQueueSnapshotSchema),
  workers: z.array(workerNodeSnapshotSchema),
  capturedAt: z.iso.datetime(),
});

export const jobProbeResultSchema = z.object({
  jobId: z.uuid(),
  queue: z.literal("aihub.system.probe"),
  queuedAt: z.iso.datetime(),
});

export const jobActionResultSchema = z.object({
  accepted: z.literal(true),
  message: z.string(),
});

export const deadLetterRedriveRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
}).strict();

export type JobQueueName = z.infer<typeof jobQueueNameSchema>;
export type SystemProbePayload = z.infer<typeof systemProbePayloadSchema>;
export type JobQueueSnapshot = z.infer<typeof jobQueueSnapshotSchema>;
export type WorkerNodeSnapshot = z.infer<typeof workerNodeSnapshotSchema>;
export type JobOperationsSnapshot = z.infer<typeof jobOperationsSnapshotSchema>;
export type JobProbeResult = z.infer<typeof jobProbeResultSchema>;
export type JobActionResult = z.infer<typeof jobActionResultSchema>;

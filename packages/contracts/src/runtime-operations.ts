import { z } from "zod";

export const RUNTIME_WORKLOAD_NAMES = ["hermes-runs"] as const;
export const runtimeWorkloadNameSchema = z.enum(RUNTIME_WORKLOAD_NAMES);

export const runtimeWorkloadSnapshotSchema = z.object({
  name: runtimeWorkloadNameSchema,
  displayName: z.string(),
  pendingCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const runtimeExecutorSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["ONLINE", "STALE", "STOPPED"]),
  startedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  version: z.string(),
  workloads: z.array(runtimeWorkloadNameSchema),
});

export const runtimeOperationsSnapshotSchema = z.object({
  engine: z.literal("postgresql-state"),
  status: z.enum(["ONLINE", "DEGRADED"]),
  statusReasons: z.array(z.string()),
  workloads: z.array(runtimeWorkloadSnapshotSchema),
  executors: z.array(runtimeExecutorSnapshotSchema),
  capturedAt: z.iso.datetime(),
});

export type RuntimeWorkloadName = z.infer<typeof runtimeWorkloadNameSchema>;
export type RuntimeWorkloadSnapshot = z.infer<typeof runtimeWorkloadSnapshotSchema>;
export type RuntimeExecutorSnapshot = z.infer<typeof runtimeExecutorSnapshotSchema>;
export type RuntimeOperationsSnapshot = z.infer<typeof runtimeOperationsSnapshotSchema>;

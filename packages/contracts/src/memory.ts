import { z } from "zod";
import { documentClassificationSchema } from "./documents.js";

export const MEMORY_SYNC_STATUSES = [
  "NOT_INDEXED",
  "QUEUED",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETE_PENDING",
  "DELETED",
] as const;

export const memorySyncStatusSchema = z.enum(MEMORY_SYNC_STATUSES);

export const knowledgeSourceSchema = z.object({
  documentId: z.uuid(),
  fileName: z.string().min(1).max(255),
  classification: documentClassificationSchema,
  score: z.number().min(0).max(1),
  excerpt: z.string().min(1).max(4_000),
});

export const memoryPublicationSchema = z.object({
  documentId: z.uuid(),
  fileName: z.string().min(1).max(255),
  classification: documentClassificationSchema,
  generation: z.number().int().nonnegative(),
  status: memorySyncStatusSchema,
  externalDocumentId: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  retryable: z.boolean(),
  queuedAt: z.iso.datetime().nullable(),
  syncedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const memoryPublicationListSchema = z.object({
  items: z.array(memoryPublicationSchema),
});

export const memoryMetricsSchema = z.object({
  generatedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deletePending: z.number().int().nonnegative(),
});

export const memoryIndexJobPayloadSchema = z.object({
  documentId: z.uuid(),
  generation: z.number().int().nonnegative(),
  action: z.enum(["UPSERT", "DELETE"]),
}).strict();

export type MemorySyncStatus = z.infer<typeof memorySyncStatusSchema>;
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type MemoryPublication = z.infer<typeof memoryPublicationSchema>;
export type MemoryPublicationList = z.infer<typeof memoryPublicationListSchema>;
export type MemoryMetrics = z.infer<typeof memoryMetricsSchema>;
export type MemoryIndexJobPayload = z.infer<typeof memoryIndexJobPayloadSchema>;

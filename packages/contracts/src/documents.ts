import { z } from "zod";

export const DOCUMENT_STATUSES = [
  "QUARANTINED",
  "QUEUED",
  "CONVERTING",
  "OCR_PENDING",
  "OCR_PROCESSING",
  "READY",
  "FAILED",
  "REJECTED",
  "DELETING",
  "DELETED",
] as const;

export const DOCUMENT_CLASSIFICATIONS = [
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
] as const;

export const DOCUMENT_ARTIFACT_KINDS = [
  "ORIGINAL",
  "PAGE_IMAGE",
  "OCR_TEXT",
  "OCR_MARKDOWN",
  "OCR_JSON",
] as const;

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export const documentClassificationSchema = z.enum(DOCUMENT_CLASSIFICATIONS);
export const documentArtifactKindSchema = z.enum(DOCUMENT_ARTIFACT_KINDS);

export const documentArtifactSchema = z.object({
  id: z.uuid(),
  kind: documentArtifactKindSchema,
  pageNumber: z.number().int().positive().nullable(),
  mediaType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

export const documentSummarySchema = z.object({
  id: z.uuid(),
  fileName: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  classification: documentClassificationSchema,
  status: documentStatusSchema,
  pageCount: z.number().int().nonnegative().nullable(),
  processingGeneration: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  retentionUntil: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const documentDetailSchema = documentSummarySchema.extend({
  textPreview: z.string().max(4_000).nullable(),
  artifacts: z.array(documentArtifactSchema),
});

export const documentListSchema = z.object({
  items: z.array(documentSummarySchema),
});

export const documentUploadMetadataSchema = z.object({
  classification: documentClassificationSchema.default("INTERNAL"),
  retentionDays: z.coerce.number().int().min(1).max(3_650).default(365),
}).strict();

export const quarantineDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const documentMetricsSchema = z.object({
  generatedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
});

export const documentConversionJobPayloadSchema = z.object({
  documentId: z.uuid(),
  generation: z.number().int().positive(),
}).strict();

export const documentOcrJobPayloadSchema = documentConversionJobPayloadSchema.extend({
  pageNumbers: z.array(z.number().int().positive()).min(1).max(500),
});

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type DocumentClassification = z.infer<typeof documentClassificationSchema>;
export type DocumentArtifactKind = z.infer<typeof documentArtifactKindSchema>;
export type DocumentArtifact = z.infer<typeof documentArtifactSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type DocumentList = z.infer<typeof documentListSchema>;
export type DocumentUploadMetadata = z.infer<typeof documentUploadMetadataSchema>;
export type QuarantineDecision = z.infer<typeof quarantineDecisionSchema>;
export type DocumentMetrics = z.infer<typeof documentMetricsSchema>;
export type DocumentConversionJobPayload = z.infer<typeof documentConversionJobPayloadSchema>;
export type DocumentOcrJobPayload = z.infer<typeof documentOcrJobPayloadSchema>;

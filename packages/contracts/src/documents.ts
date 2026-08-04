import { z } from "zod";

export const DOCUMENT_STATUSES = [
  "QUARANTINED",
  "QUEUED",
  "CONVERTING",
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

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);
export const documentClassificationSchema = z.enum(DOCUMENT_CLASSIFICATIONS);

export const documentSummarySchema = z.object({
  id: z.uuid(),
  fileName: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  classification: documentClassificationSchema,
  status: documentStatusSchema,
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  retentionUntil: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const documentDetailSchema = documentSummarySchema;

export const documentListSchema = z.object({
  items: z.array(documentSummarySchema),
});

export const documentUploadMetadataSchema = z.object({
  classification: documentClassificationSchema.default("INTERNAL"),
  retentionDays: z.coerce.number().int().min(1).max(3_650).default(365),
}).strict();

export const documentMetricsSchema = z.object({
  generatedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  retainedSourceBytes: z.literal(0),
});

/**
 * The document formats OrcaSynapse can extract text from, and the file
 * extensions that carry them.
 *
 * This is the single source of truth for three consumers that previously
 * disagreed: the upload picker, the upload route's validation, and the
 * extractor. The dashboard offered image types the extractor rejects and
 * withheld spreadsheets and presentations it accepts, so a supported file could
 * not be selected and an unsupported one failed only after its bytes uploaded.
 * `extraction.test.ts` asserts the extractor's own map still matches this list.
 */
export const SUPPORTED_DOCUMENT_TYPES = [
  { mediaType: "text/plain", extension: ".txt" },
  { mediaType: "text/markdown", extension: ".md" },
  { mediaType: "text/html", extension: ".html" },
  { mediaType: "text/csv", extension: ".csv" },
  { mediaType: "application/json", extension: ".json" },
  { mediaType: "application/pdf", extension: ".pdf" },
  { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
  { mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" },
  { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" },
] as const;

export const SUPPORTED_DOCUMENT_MEDIA_TYPES: readonly string[] =
  SUPPORTED_DOCUMENT_TYPES.map(({ mediaType }) => mediaType);

/** The `accept` attribute for a file input, extensions first so pickers label them. */
export const DOCUMENT_UPLOAD_ACCEPT: string = [
  ...SUPPORTED_DOCUMENT_TYPES.map(({ extension }) => extension),
  ...SUPPORTED_DOCUMENT_MEDIA_TYPES,
].join(",");

/** A browser may send a charset parameter; the media type is the part before it. */
export function isSupportedDocumentMediaType(declared: string): boolean {
  const mediaType = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_DOCUMENT_MEDIA_TYPES.includes(mediaType);
}

export type DocumentStatus = z.infer<typeof documentStatusSchema>;
export type DocumentClassification = z.infer<typeof documentClassificationSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export type DocumentList = z.infer<typeof documentListSchema>;
export type DocumentUploadMetadata = z.infer<typeof documentUploadMetadataSchema>;
export type DocumentMetrics = z.infer<typeof documentMetricsSchema>;

import { z } from "zod";

export const HERMES_CORPUS_ENTRY_KINDS = [
  "MEMORY",
  "SKILL",
  "SKILL_FILE",
  "SKILL_BUNDLE",
  "PROVENANCE",
  "PENDING_CHANGE",
] as const;

export const HERMES_CORPUS_MUTATION_OPERATIONS = [
  "MEMORY_ADD",
  "MEMORY_REPLACE",
  "MEMORY_REMOVE",
  "SKILL_CREATE",
  "SKILL_EDIT",
  "SKILL_DELETE",
  "SKILL_WRITE_FILE",
  "SKILL_REMOVE_FILE",
] as const;

export const HERMES_CORPUS_MUTATION_STATUSES = [
  "PENDING_APPROVAL",
  "QUEUED",
  "DISPATCHED",
  "APPLIED",
  "REJECTED",
  "CONFLICT",
  "FAILED",
  "EXPIRED",
] as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const corpusSizeBytesWireSchema = z.string().regex(/^(0|[1-9][0-9]{0,7})$/).refine(
  (value) => Number(value) <= 10 * 1024 * 1024,
  "Corpus file size exceeds the 10 MiB observation limit.",
);
const corpusPathSchema = z.string().trim().min(1).max(1_024).refine(
  (value) => !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "Corpus paths must be normalized relative paths.",
);

export const hermesCorpusEntryKindSchema = z.enum(HERMES_CORPUS_ENTRY_KINDS);
export const hermesCorpusMutationOperationSchema = z.enum(HERMES_CORPUS_MUTATION_OPERATIONS);
export const hermesCorpusMutationStatusSchema = z.enum(HERMES_CORPUS_MUTATION_STATUSES);

export const hermesCorpusSnapshotEntrySchema = z.object({
  path: corpusPathSchema,
  kind: hermesCorpusEntryKindSchema,
  mediaType: z.string().trim().min(1).max(160),
  // Signed node payloads intentionally contain no JSON numbers because the
  // installer/Python/JavaScript canonicalizers do not agree for every numeric
  // spelling. The control plane converts this bounded decimal after verifying
  // the node signature.
  sizeBytes: corpusSizeBytesWireSchema,
  sha256: sha256Schema,
  content: z.string().max(131_072).nullable().default(null),
  structuredEntries: z.array(z.string().max(2_200)).max(256).nullable().default(null),
  readOnly: z.boolean().default(false),
}).strict();

export const hermesCorpusSnapshotUploadSchema = z.object({
  format: z.literal("orcasynapse-hermes-corpus-snapshot/v1"),
  observedAt: z.iso.datetime(),
  rootHash: sha256Schema,
  entries: z.array(hermesCorpusSnapshotEntrySchema).max(1_000),
}).strict().superRefine((value, context) => {
  const paths = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (paths.has(entry.path)) context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "Corpus snapshot paths must be unique." });
    paths.add(entry.path);
  }
});

export const hermesCorpusSnapshotReceiptSchema = z.object({
  accepted: z.literal(true),
  snapshotId: z.uuid(),
  serverTime: z.iso.datetime(),
}).strict();

export const hermesCorpusEntrySchema = hermesCorpusSnapshotEntrySchema.omit({ sizeBytes: true }).extend({
  id: z.uuid(),
  nodeId: z.uuid(),
  sizeBytes: z.number().int().nonnegative().max(10 * 1024 * 1024),
  revision: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
}).strict();

export const hermesCorpusStatusSchema = z.object({
  nodeId: z.uuid(),
  nodeSlug: z.string().min(1).max(64),
  nodeDisplayName: z.string().min(1).max(120),
  available: z.boolean(),
  writable: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  rootHash: sha256Schema.nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  stale: z.boolean(),
}).strict();

export const hermesCorpusOverviewSchema = z.object({
  nodes: z.array(hermesCorpusStatusSchema),
}).strict();

export const hermesCorpusEntryListSchema = z.object({
  items: z.array(hermesCorpusEntrySchema),
}).strict();

export const createHermesCorpusMutationSchema = z.object({
  nodeId: z.uuid(),
  operation: hermesCorpusMutationOperationSchema,
  path: corpusPathSchema,
  expectedHash: sha256Schema.nullable().default(null),
  content: z.string().max(131_072).nullable().default(null),
  oldText: z.string().trim().min(1).max(16_384).nullable().default(null),
  reason: z.string().trim().min(3).max(1_000),
  idempotencyKey: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  const needsContent = ["MEMORY_ADD", "MEMORY_REPLACE", "SKILL_CREATE", "SKILL_EDIT", "SKILL_WRITE_FILE"].includes(value.operation);
  const needsOldText = ["MEMORY_REPLACE", "MEMORY_REMOVE"].includes(value.operation);
  if (needsContent && !value.content) context.addIssue({ code: "custom", path: ["content"], message: "Content is required for this mutation." });
  if (!needsContent && value.content !== null) context.addIssue({ code: "custom", path: ["content"], message: "Content is not accepted for this mutation." });
  if (needsOldText && !value.oldText) context.addIssue({ code: "custom", path: ["oldText"], message: "Existing entry text is required for this mutation." });
  if (!needsOldText && value.oldText !== null) context.addIssue({ code: "custom", path: ["oldText"], message: "Existing entry text is not accepted for this mutation." });
  if (["MEMORY_ADD", "SKILL_CREATE"].includes(value.operation) && value.expectedHash !== null) {
    context.addIssue({ code: "custom", path: ["expectedHash"], message: "Append and create mutations do not accept an existing content hash." });
  }
  if (!["MEMORY_ADD", "SKILL_CREATE", "SKILL_WRITE_FILE"].includes(value.operation) && !value.expectedHash) {
    context.addIssue({ code: "custom", path: ["expectedHash"], message: "The observed content hash is required for conflict-safe mutation." });
  }
});

export const hermesCorpusMutationSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  operation: hermesCorpusMutationOperationSchema,
  path: corpusPathSchema,
  expectedHash: sha256Schema.nullable(),
  content: z.string().nullable(),
  oldText: z.string().nullable(),
  reason: z.string(),
  status: hermesCorpusMutationStatusSchema,
  requestedBy: z.uuid(),
  requestedBySubject: z.string().min(1).max(320),
  approvedBy: z.uuid().nullable(),
  approvedBySubject: z.string().min(1).max(320).nullable(),
  beforeHash: sha256Schema.nullable(),
  afterHash: sha256Schema.nullable(),
  error: z.string().nullable(),
  idempotencyKey: z.uuid(),
  requestedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
}).strict();

export const hermesCorpusMutationListSchema = z.object({ items: z.array(hermesCorpusMutationSchema) }).strict();

export const hermesCorpusRevisionSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  path: corpusPathSchema,
  revision: z.number().int().positive(),
  changeKind: z.enum(["DISCOVERED", "CHANGED", "DELETED", "RESTORED"]),
  beforeHash: sha256Schema.nullable(),
  afterHash: sha256Schema.nullable(),
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  mutationId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
}).strict();

export const hermesCorpusRevisionListSchema = z.object({ items: z.array(hermesCorpusRevisionSchema) }).strict();

export const decideHermesCorpusMutationSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const hermesCorpusMutationCommandSchema = z.object({
  format: z.literal("orcasynapse-hermes-corpus-mutation/v1"),
  mutationId: z.uuid(),
  nodeId: z.uuid(),
  operation: hermesCorpusMutationOperationSchema,
  path: corpusPathSchema,
  expectedHash: sha256Schema.nullable(),
  content: z.string().max(131_072).nullable(),
  oldText: z.string().max(16_384).nullable(),
  expiresAt: z.iso.datetime(),
}).strict();

export const hermesCorpusDesiredStateDocumentSchema = z.object({
  format: z.literal("orcasynapse-hermes-corpus-desired-state/v1"),
  nodeId: z.uuid(),
  generatedAt: z.iso.datetime(),
  mutation: hermesCorpusMutationCommandSchema.nullable(),
}).strict();

export const hermesCorpusSignedDesiredStateSchema = z.object({
  documentBase64: z.string().min(1).max(524_288),
  signature: z.string().min(1).max(512),
  publicKeyFingerprint: z.string().min(1).max(100),
}).strict();

export const hermesCorpusMutationResultSchema = z.object({
  mutationId: z.uuid(),
  status: z.enum(["APPLIED", "CONFLICT", "FAILED"]),
  observedHash: sha256Schema.nullable().default(null),
  message: z.string().trim().min(1).max(4_000),
  completedAt: z.iso.datetime(),
}).strict();

export const hermesCorpusMutationReceiptSchema = z.object({
  accepted: z.literal(true),
  serverTime: z.iso.datetime(),
}).strict();

export type HermesCorpusSnapshotEntry = z.infer<typeof hermesCorpusSnapshotEntrySchema>;
export type HermesCorpusSnapshotUpload = z.infer<typeof hermesCorpusSnapshotUploadSchema>;
export type HermesCorpusSnapshotReceipt = z.infer<typeof hermesCorpusSnapshotReceiptSchema>;
export type HermesCorpusEntry = z.infer<typeof hermesCorpusEntrySchema>;
export type HermesCorpusStatus = z.infer<typeof hermesCorpusStatusSchema>;
export type HermesCorpusOverview = z.infer<typeof hermesCorpusOverviewSchema>;
export type CreateHermesCorpusMutation = z.infer<typeof createHermesCorpusMutationSchema>;
export type HermesCorpusMutation = z.infer<typeof hermesCorpusMutationSchema>;
export type HermesCorpusRevision = z.infer<typeof hermesCorpusRevisionSchema>;
export type DecideHermesCorpusMutation = z.infer<typeof decideHermesCorpusMutationSchema>;
export type HermesCorpusMutationCommand = z.infer<typeof hermesCorpusMutationCommandSchema>;
export type HermesCorpusDesiredStateDocument = z.infer<typeof hermesCorpusDesiredStateDocumentSchema>;
export type HermesCorpusSignedDesiredState = z.infer<typeof hermesCorpusSignedDesiredStateSchema>;
export type HermesCorpusMutationResult = z.infer<typeof hermesCorpusMutationResultSchema>;

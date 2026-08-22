import { z } from "zod";

/**
 * Run artifacts: files an agent produced on VM2, published to the control
 * plane so a person can find and download them after the run.
 *
 * The wire format follows the corpus snapshot conventions deliberately -- the
 * same node-signed channel carries both -- but the two are different things
 * and stay in different tables: the corpus mirrors *desired state* that an
 * operator approves onto the node, while an artifact is *output* that already
 * exists and needs no approval to be true.
 */

export const CHAT_ARTIFACT_STORAGE = ["INLINE", "NODE"] as const;

/**
 * Files at or under this size arrive with their bytes and are retained in the
 * control plane's database; anything larger is metadata only (`storage:
 * "NODE"`), listed honestly as existing on the node without being centrally
 * retained. Enforced at write and rejected, never truncated: a truncated file
 * is worse than a refused one.
 */
export const CHAT_ARTIFACT_INLINE_LIMIT_BYTES = 4 * 1024 * 1024;
/** ceil(limit / 3) * 4: the base64 spelling of exactly the inline limit. */
export const CHAT_ARTIFACT_CONTENT_BASE64_MAX = 5_592_408;

const INJECTABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function normalizeMediaType(mediaType: string): string {
  const trimmed = mediaType.trim().toLowerCase();
  // JavaScript `split(sep, limit)` caps the *returned array length*.
  // `split(";", 1)` is therefore the whole string, not the type without
  // parameters. Python `split(";", 1)` is the other convention. Cut with
  // `split(";")[0]` or `indexOf(";")`.
  const base = (trimmed.split(";")[0] ?? trimmed).trim();
  return base === "image/jpg" ? "image/jpeg" : base;
}

export function injectableImageMediaType(
  mediaType: string,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const normalized = normalizeMediaType(mediaType);
  return (INJECTABLE_IMAGE_TYPES.has(normalized) ? normalized : null) as
    "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null;
}

const INJECTABLE_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/ld+json",
]);
const INJECTABLE_TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json"]);

/** Media-type (or octet-stream + extension) that *may* be inlined as text. Bytes still have to decode. */
export function injectableTextMediaType(mediaType: string, name: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  if (INJECTABLE_TEXT_TYPES.has(normalized)) return true;
  if (normalized !== "application/octet-stream") return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return INJECTABLE_TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Signed node payloads carry no JSON numbers (the canonicalizers disagree on
 * numeric spellings -- see the corpus contract), so sizes travel as bounded
 * decimal strings. The bound is an observation ceiling, not the retention
 * policy: a 40 MB export still deserves a row saying it exists.
 */
const artifactSizeBytesWireSchema = z.string().regex(/^(0|[1-9][0-9]{0,9})$/).refine(
  (value) => Number(value) <= 1024 * 1024 * 1024,
  "Artifact size exceeds the 1 GiB observation limit.",
);
const artifactPathSchema = z.string().trim().min(1).max(1_024).refine(
  (value) => !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "Artifact paths must be normalized relative paths.",
);

export const chatArtifactStorageSchema = z.enum(CHAT_ARTIFACT_STORAGE);

/**
 * Where a file came from, said on every row: `AGENT` is a deliverable a
 * governed run saved on its node, `UPLOADED` is a file a person attached from
 * the composer. The two share one store and one Files screen because they are
 * both "files that belong to this conversation" — but a reader deciding
 * whether to trust a file needs to know which hands touched it, so the origin
 * is a labelled fact rather than an inference from null columns.
 */
export const CHAT_ARTIFACT_ORIGINS = ["AGENT", "UPLOADED"] as const;
export const chatArtifactOriginSchema = z.enum(CHAT_ARTIFACT_ORIGINS);

/**
 * A person's upload from the composer. Unlike the node path there is no
 * signed envelope and no session: the conversation is named directly, the
 * owner and division come from the authenticated principal, and the bytes are
 * required — an upload past the inline limit is refused, because there is no
 * runtime node for it to remain on.
 */
export const uploadChatArtifactSchema = z.object({
  conversationId: z.uuid(),
  name: z.string().trim().min(1).max(160).refine(
    (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
    "Upload names must be bare file names.",
  ),
  mediaType: z.string().trim().min(1).max(160).default("application/octet-stream"),
  contentBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).min(1).max(CHAT_ARTIFACT_CONTENT_BASE64_MAX),
}).strict();

export const hermesArtifactUploadEntrySchema = z.object({
  path: artifactPathSchema,
  mediaType: z.string().trim().min(1).max(160),
  sizeBytes: artifactSizeBytesWireSchema,
  sha256: sha256Schema,
  modifiedAt: z.iso.datetime(),
  /**
   * Null when the file exceeds the inline limit (or the publisher could not
   * read it back consistently). Never a partial file: the manager rejects
   * content whose decoded length disagrees with `sizeBytes` or whose hash
   * disagrees with `sha256`.
   */
  contentBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(CHAT_ARTIFACT_CONTENT_BASE64_MAX).nullable().default(null),
}).strict();

export const hermesArtifactUploadSchema = z.object({
  format: z.literal("orcasynapse-hermes-artifacts/v1"),
  observedAt: z.iso.datetime(),
  /**
   * The Hermes session the files belong to, as `AgentRun.sessionId`. The
   * control plane resolves division, conversation and owner from the run it
   * already authorized -- never from anything the node asserts. An upload
   * whose session matches no run is refused outright: an artifact that cannot
   * be attributed has no tenant, and storing it would make `divisionId: null`
   * ambiguous between "deployment-wide profile" and "we lost track".
   */
  sessionId: z.string().trim().min(1).max(200),
  artifacts: z.array(hermesArtifactUploadEntrySchema).max(20),
  /**
   * Paths the publisher previously reported that no longer exist on disk.
   * Reconciliation, not deletion authority: the control plane acts on a
   * tombstone only for `storage: "NODE"` rows, whose listing would otherwise
   * promise a file nobody can fetch. An inline artifact is unaffected --
   * central retention surviving node cleanup is the point of inlining.
   */
  removedPaths: z.array(artifactPathSchema).max(200).default([]),
}).strict().superRefine((value, context) => {
  if (value.artifacts.length === 0 && value.removedPaths.length === 0) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "An upload must carry at least one artifact or one removal." });
  }
  const paths = new Set<string>();
  for (const [index, entry] of value.artifacts.entries()) {
    if (paths.has(entry.path)) context.addIssue({ code: "custom", path: ["artifacts", index, "path"], message: "Artifact paths must be unique per upload." });
    paths.add(entry.path);
  }
});

export const hermesArtifactReceiptEntrySchema = z.object({
  path: artifactPathSchema,
  artifactId: z.uuid(),
  storage: chatArtifactStorageSchema,
  /** True when the row already held this exact content and nothing changed. */
  unchanged: z.boolean(),
}).strict();

export const hermesArtifactReceiptSchema = z.object({
  accepted: z.literal(true),
  results: z.array(hermesArtifactReceiptEntrySchema),
  /** NODE-storage rows dropped because their file left the node. */
  removed: z.number().int().nonnegative().default(0),
  serverTime: z.iso.datetime(),
}).strict();

/** The read side: what a list or a download's metadata reports. */
export const chatArtifactSchema = z.object({
  id: z.uuid(),
  /** Null on an uploaded file: no governed run produced it. */
  runId: z.uuid().nullable(),
  conversationId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  /** Null on an uploaded file: the bytes never lived on a runtime node. */
  nodeId: z.uuid().nullable(),
  origin: chatArtifactOriginSchema,
  divisionId: z.uuid().nullable(),
  name: z.string().min(1).max(160),
  path: artifactPathSchema,
  mediaType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative().max(1024 * 1024 * 1024),
  sha256: sha256Schema,
  storage: chatArtifactStorageSchema,
  conversationTitle: z.string().max(160).nullable(),
  profileName: z.string().max(120).nullable(),
  observedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
}).strict();

export const chatArtifactListSchema = z.object({
  items: z.array(chatArtifactSchema).max(200),
}).strict();

export type ChatArtifactStorage = z.infer<typeof chatArtifactStorageSchema>;
export type ChatArtifactOrigin = z.infer<typeof chatArtifactOriginSchema>;
export type UploadChatArtifact = z.infer<typeof uploadChatArtifactSchema>;
export type HermesArtifactUploadEntry = z.infer<typeof hermesArtifactUploadEntrySchema>;
export type HermesArtifactUpload = z.infer<typeof hermesArtifactUploadSchema>;
export type HermesArtifactReceipt = z.infer<typeof hermesArtifactReceiptSchema>;
export type ChatArtifact = z.infer<typeof chatArtifactSchema>;
export type ChatArtifactList = z.infer<typeof chatArtifactListSchema>;

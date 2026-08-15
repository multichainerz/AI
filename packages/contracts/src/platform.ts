import { z } from "zod";

export const platformMetaSchema = z.object({
  product: z.literal("OrcaSynapse"),
  version: z.string(),
  phase: z.string(),
  configurationMode: z.literal("dashboard"),
  bootstrapState: z.enum(["REQUIRED", "READY", "LOCKED"]),
});

/**
 * The release an operator has approved this deployment to move to.
 *
 * Intent, not an action: recording a target does not update anything. Host
 * agents on VM1 and VM2 read it and apply it, which is why `desiredCommit` is
 * pinned here — the tag it was resolved from can be re-pointed afterwards, and
 * an agent must not be able to apply something other than what was approved.
 */
export const platformReleaseTargetSchema = z.object({
  desiredVersion: z.string().min(1).max(64),
  desiredCommit: z.string().regex(/^[0-9a-f]{40}$/),
  approvedBy: z.uuid().nullable(),
  approvedBySubject: z.string().min(1).max(320),
  approvedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
});

export const platformUpdateSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string(),
  updateAvailable: z.boolean(),
  releaseUrl: z.url(),
  updateCommand: z.string().min(1),
  automaticUpdateSupported: z.literal(false),
  automaticUpdateReason: z.string().min(1),
  checkedAt: z.iso.datetime(),
  /**
   * Nullable rather than optional: the panel routes on "nothing approved" and
   * has to be able to tell that apart from a response that simply did not say.
   * The unauthenticated `/api/v1/platform/update` check never carries one.
   */
  target: platformReleaseTargetSchema.nullable(),
});

/**
 * Only the tag is accepted. The commit is resolved server-side from the release
 * lookup, so a caller cannot name a version and pin it to a commit of its own.
 */
export const approveReleaseTargetSchema = z.object({
  desiredVersion: z.string().trim().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  timestamp: z.iso.datetime(),
});

export type PlatformMeta = z.infer<typeof platformMetaSchema>;
export type PlatformReleaseTarget = z.infer<typeof platformReleaseTargetSchema>;
export type PlatformUpdate = z.infer<typeof platformUpdateSchema>;
export type ApproveReleaseTarget = z.infer<typeof approveReleaseTargetSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

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
  /**
   * A boolean rather than `z.literal(false)`, which is what it was.
   *
   * The literal encoded a true statement about the deployment — the dashboard
   * has no host-root or Docker control — as a permanent one about the product.
   * The host update agent does not weaken that boundary; it works precisely
   * because the host reads the approved target rather than the container
   * pushing anything. So the premise still holds and the conclusion no longer
   * follows, and whether an approval will actually be applied now depends on
   * whether a given VM1 has the agent installed. That is a fact about the
   * deployment, which is what this field now reports.
   */
  automaticUpdateSupported: z.boolean(),
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

/**
 * The phases the VM1 update agent reports, in the order a run passes through
 * them. `idle` and `blocked` are only ever the agent's own state; the rest
 * belong to a run.
 *
 * `unknown` is not one the agent writes. It is what the API maps unrecognised
 * text to, so that a row written by a differently-versioned agent renders as a
 * phase this release does not know rather than failing to parse — this is the
 * screen an operator opens when an upgrade has gone wrong, and it must not be
 * the second thing that breaks.
 */
export const platformUpdatePhaseSchema = z.enum([
  "idle", "blocked", "upgrading", "verifying", "recovering", "healthy", "rolled-back", "failed", "unknown",
]);

/**
 * That the agent exists and when it last looked.
 *
 * Null on a deployment whose VM1 predates the agent, which is the case this
 * exists to make visible: without it, "installed and idle" and "not installed
 * at all" both look like an empty run list, and an operator who has approved a
 * release is left watching for something that will never happen.
 */
export const platformUpdateAgentSchema = z.object({
  phase: platformUpdatePhaseSchema,
  detail: z.string(),
  installedVersion: z.string().nullable(),
  installedCommit: z.string().nullable(),
  currentRunId: z.uuid().nullable(),
  checkedAt: z.iso.datetime(),
});

const updateRunFields = {
  id: z.uuid(),
  phase: platformUpdatePhaseSchema,
  detail: z.string(),
  targetVersion: z.string().nullable(),
  targetCommit: z.string().nullable(),
  installedVersion: z.string().nullable(),
  installedCommit: z.string().nullable(),
  rollback: z.string().nullable(),
  logTruncated: z.boolean(),
  startedAt: z.iso.datetime(),
  /**
   * When the API's unavailability budget expires, written before the upgrade
   * takes the stack down. A dashboard that cannot reach the control plane while
   * this is in the future is looking at a restart; after it, at a stall.
   */
  apiUnavailableUntil: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
} as const;

export const platformUpdateRunSummarySchema = z.object({ ...updateRunFields, hasLog: z.boolean() });

export const platformUpdateRunSchema = z.object({ ...updateRunFields, log: z.string().nullable() });

/**
 * Logs are carried for the newest run only. They are capped at 128 KB each by
 * the agent, so returning one per row would put megabytes on a page whose
 * question — did the last upgrade work — is answered by one of them.
 */
export const platformUpdateActivitySchema = z.object({
  agent: platformUpdateAgentSchema.nullable(),
  latest: platformUpdateRunSchema.nullable(),
  recent: z.array(platformUpdateRunSummarySchema),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  timestamp: z.iso.datetime(),
});

export type PlatformMeta = z.infer<typeof platformMetaSchema>;
export type PlatformReleaseTarget = z.infer<typeof platformReleaseTargetSchema>;
export type PlatformUpdate = z.infer<typeof platformUpdateSchema>;
export type ApproveReleaseTarget = z.infer<typeof approveReleaseTargetSchema>;
export type PlatformUpdatePhase = z.infer<typeof platformUpdatePhaseSchema>;
export type PlatformUpdateAgent = z.infer<typeof platformUpdateAgentSchema>;
export type PlatformUpdateRun = z.infer<typeof platformUpdateRunSchema>;
export type PlatformUpdateRunSummary = z.infer<typeof platformUpdateRunSummarySchema>;
export type PlatformUpdateActivity = z.infer<typeof platformUpdateActivitySchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;

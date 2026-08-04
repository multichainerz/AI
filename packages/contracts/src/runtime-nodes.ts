import { z } from "zod";
import { serviceEndpointSchema } from "./connections.js";

export const HERMES_RUNTIME_NODE_STATUSES = [
  "PENDING",
  "ONLINE",
  "DEGRADED",
  "DRAINING",
  "SUSPENDED",
  "REVOKED",
  "OFFLINE",
] as const;

export const HERMES_NODE_ENROLLMENT_STATUSES = [
  "ISSUED",
  "CONSUMED",
  "REVOKED",
  "EXPIRED",
] as const;

export const hermesRuntimeNodeStatusSchema = z.enum(HERMES_RUNTIME_NODE_STATUSES);
export const hermesNodeEnrollmentStatusSchema = z.enum(HERMES_NODE_ENROLLMENT_STATUSES);

const nodeSlugSchema = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const runtimeOriginSchema = serviceEndpointSchema.regex(
  /^https?:\/\/[^/?#]+\/?$/i,
  "Runtime service addresses must be origins without a path, query, or fragment.",
);
const imageReferenceSchema = z.string().trim().min(3).max(500).regex(
  /^(?:[a-zA-Z0-9.-]+(?::\d+)?\/)?(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+(?:@sha256:[a-f0-9]{64})?|@sha256:[a-f0-9]{64})$/,
  "Use a tagged or digest-pinned container image reference.",
);
const releaseVersionSchema = z.string().trim().min(1).max(120).regex(
  /^(?:latest|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/,
  "Use 'latest' for development or an exact release version for controlled environments.",
).refine(
  (value) => value.replace(/^v/, "") !== "0.0.6",
  "Supermemory v0.0.6 is blocked because its published workflow runtime cannot process documents.",
);

export const hermesRuntimeNodeSchema = z.object({
  id: z.uuid(),
  slug: nodeSlugSchema,
  displayName: z.string().min(2).max(120),
  baseUrl: runtimeOriginSchema,
  expectedHostname: z.string().nullable(),
  hostname: z.string().nullable(),
  status: hermesRuntimeNodeStatusSchema,
  identityFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hermesVersion: z.string().nullable(),
  installerVersion: z.string().nullable(),
  capabilities: z.array(z.string().min(1).max(120)).max(100),
  serviceConnectionId: z.uuid().nullable(),
  serviceConnectionStatus: z.enum(["NOT_TESTED", "HEALTHY", "DEGRADED", "UNREACHABLE", "DISABLED"]).nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  enrolledAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const hermesRuntimeNodeListSchema = z.object({
  items: z.array(hermesRuntimeNodeSchema),
}).strict();

export const createHermesNodeInvitationSchema = z.object({
  slug: nodeSlugSchema,
  displayName: z.string().trim().min(2).max(120),
  baseUrl: runtimeOriginSchema,
  expectedHostname: z.string().trim().min(1).max(253).optional(),
  controlPlaneUrl: runtimeOriginSchema,
  hermesImage: imageReferenceSchema.default("nousresearch/hermes-agent:latest"),
  supermemoryVersion: releaseVersionSchema.default("0.0.7-rc.2"),
  expiresInMinutes: z.number().int().min(10).max(1_440).default(30),
}).strict();

export const hermesNodeEnrollmentBundleSchema = z.object({
  format: z.literal("orcasynapse-hermes-enrollment/v1"),
  nodeId: z.uuid(),
  nodeSlug: nodeSlugSchema,
  token: z.string().min(32).max(512),
  controlPlaneUrl: runtimeOriginSchema,
  hermesBaseUrl: runtimeOriginSchema,
  hermesImage: imageReferenceSchema,
  supermemoryVersion: releaseVersionSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export const hermesNodeInvitationSchema = z.object({
  node: hermesRuntimeNodeSchema,
  bundle: hermesNodeEnrollmentBundleSchema,
}).strict();

export const resolveHermesNodeInvitationSchema = z.object({
  token: z.string().min(32).max(512),
}).strict();

export const enrollHermesNodeSchema = z.object({
  nodeId: z.uuid(),
  token: z.string().min(32).max(512),
  hostname: z.string().trim().min(1).max(253),
  publicKeyPem: z.string().min(80).max(4_096),
  controlPlaneUrl: runtimeOriginSchema,
  apiKey: z.string().min(32).max(1_024),
  // 256, not 120: a digest-pinned reference through a private registry mirror
  // (host:port/team/image@sha256:...) legitimately exceeds 120 characters.
  hermesVersion: z.string().trim().min(1).max(256).default("unknown"),
  installerVersion: z.string().trim().min(1).max(256),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).strict();

export const hermesNodeEnrollmentResultSchema = z.object({
  node: hermesRuntimeNodeSchema,
  heartbeatPath: z.string().startsWith("/"),
  modelBootstrap: z.object({
    provider: z.literal("custom"),
    baseUrl: serviceEndpointSchema,
    modelAlias: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(16_384),
  }).strict(),
}).strict();

export const hermesNodeHeartbeatSchema = z.object({
  observedAt: z.iso.datetime(),
  status: z.enum(["ONLINE", "DEGRADED"]),
  hermesVersion: z.string().trim().min(1).max(256),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).strict();

export const hermesNodeHeartbeatResultSchema = z.object({
  accepted: z.literal(true),
  serverTime: z.iso.datetime(),
}).strict();

export const registerHermesNodeMemorySchema = z.object({
  baseUrl: runtimeOriginSchema,
  apiKey: z.string().min(20).max(16_384),
  observedVersion: z.string().trim().min(1).max(120),
}).strict();

export const registerHermesNodeMemoryResultSchema = z.object({
  accepted: z.literal(true),
  connectionId: z.uuid(),
}).strict();

export const mutateHermesRuntimeNodeSchema = z.object({
  action: z.enum(["DRAIN", "RESUME", "SUSPEND", "REVOKE"]),
  reason: z.string().trim().min(3).max(1_000),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const removeHermesRuntimeNodeSchema = z.object({
  confirmation: nodeSlugSchema,
  reason: z.string().trim().min(3).max(1_000),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export type HermesRuntimeNodeStatus = z.infer<typeof hermesRuntimeNodeStatusSchema>;
export type HermesRuntimeNode = z.infer<typeof hermesRuntimeNodeSchema>;
export type HermesRuntimeNodeList = z.infer<typeof hermesRuntimeNodeListSchema>;
export type CreateHermesNodeInvitation = z.infer<typeof createHermesNodeInvitationSchema>;
export type HermesNodeInvitation = z.infer<typeof hermesNodeInvitationSchema>;
export type ResolveHermesNodeInvitation = z.infer<typeof resolveHermesNodeInvitationSchema>;
export type HermesNodeEnrollmentBundle = z.infer<typeof hermesNodeEnrollmentBundleSchema>;
export type EnrollHermesNode = z.infer<typeof enrollHermesNodeSchema>;
export type HermesNodeEnrollmentResult = z.infer<typeof hermesNodeEnrollmentResultSchema>;
export type HermesNodeHeartbeat = z.infer<typeof hermesNodeHeartbeatSchema>;
export type HermesNodeHeartbeatResult = z.infer<typeof hermesNodeHeartbeatResultSchema>;
export type RegisterHermesNodeMemory = z.infer<typeof registerHermesNodeMemorySchema>;
export type RegisterHermesNodeMemoryResult = z.infer<typeof registerHermesNodeMemoryResultSchema>;
export type MutateHermesRuntimeNode = z.infer<typeof mutateHermesRuntimeNodeSchema>;
export type RemoveHermesRuntimeNode = z.infer<typeof removeHermesRuntimeNodeSchema>;

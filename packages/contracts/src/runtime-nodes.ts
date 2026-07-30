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
const imageReferenceSchema = z.string().trim().min(3).max(500).regex(
  /^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/,
  "Use a tagged or digest-pinned container image reference.",
);

export const hermesRuntimeNodeSchema = z.object({
  id: z.uuid(),
  slug: nodeSlugSchema,
  displayName: z.string().min(2).max(120),
  baseUrl: serviceEndpointSchema,
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
  baseUrl: serviceEndpointSchema,
  expectedHostname: z.string().trim().min(1).max(253).optional(),
  controlPlaneUrl: serviceEndpointSchema,
  hermesImage: imageReferenceSchema.default("nousresearch/hermes-agent:latest"),
  expiresInMinutes: z.number().int().min(10).max(1_440).default(30),
}).strict();

export const hermesNodeEnrollmentBundleSchema = z.object({
  format: z.literal("aihub-hermes-enrollment/v1"),
  nodeId: z.uuid(),
  nodeSlug: nodeSlugSchema,
  token: z.string().min(32).max(512),
  controlPlaneUrl: serviceEndpointSchema,
  hermesBaseUrl: serviceEndpointSchema,
  hermesImage: imageReferenceSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export const hermesNodeInvitationSchema = z.object({
  node: hermesRuntimeNodeSchema,
  bundle: hermesNodeEnrollmentBundleSchema,
}).strict();

export const enrollHermesNodeSchema = z.object({
  nodeId: z.uuid(),
  token: z.string().min(32).max(512),
  hostname: z.string().trim().min(1).max(253),
  publicKeyPem: z.string().min(80).max(4_096),
  apiKey: z.string().min(32).max(1_024),
  hermesVersion: z.string().trim().min(1).max(120).default("unknown"),
  installerVersion: z.string().trim().min(1).max(120),
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
  hermesVersion: z.string().trim().min(1).max(120),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).strict();

export const hermesNodeHeartbeatResultSchema = z.object({
  accepted: z.literal(true),
  serverTime: z.iso.datetime(),
}).strict();

export const mutateHermesRuntimeNodeSchema = z.object({
  action: z.enum(["DRAIN", "RESUME", "SUSPEND", "REVOKE"]),
  reason: z.string().trim().min(3).max(1_000),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export type HermesRuntimeNodeStatus = z.infer<typeof hermesRuntimeNodeStatusSchema>;
export type HermesRuntimeNode = z.infer<typeof hermesRuntimeNodeSchema>;
export type HermesRuntimeNodeList = z.infer<typeof hermesRuntimeNodeListSchema>;
export type CreateHermesNodeInvitation = z.infer<typeof createHermesNodeInvitationSchema>;
export type HermesNodeInvitation = z.infer<typeof hermesNodeInvitationSchema>;
export type EnrollHermesNode = z.infer<typeof enrollHermesNodeSchema>;
export type HermesNodeEnrollmentResult = z.infer<typeof hermesNodeEnrollmentResultSchema>;
export type HermesNodeHeartbeat = z.infer<typeof hermesNodeHeartbeatSchema>;
export type HermesNodeHeartbeatResult = z.infer<typeof hermesNodeHeartbeatResultSchema>;
export type MutateHermesRuntimeNode = z.infer<typeof mutateHermesRuntimeNodeSchema>;

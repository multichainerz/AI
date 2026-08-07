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
/**
 * The Hermes runtime is pinned to a git commit, not a container image.
 *
 * VM2 installs Hermes natively through its own installer, which takes
 * `--commit`. A commit SHA is a cryptographic digest of the tree, so this is
 * exactly as strong an artifact identity as the `@sha256:` image digest it
 * replaces — and unlike a tag it cannot be moved, so there is no unpinned form
 * to accept and then refuse at the production gate.
 */
const hermesCommitSchema = z.string().trim().toLowerCase().regex(
  /^[0-9a-f]{40}$/,
  "Pin the Hermes runtime to a full 40-character git commit SHA.",
);

/**
 * The commit a new invitation offers unless an operator names another.
 *
 * A real, installable commit rather than a moving reference: the whole point of
 * the pin is that two nodes enrolled a month apart run identical code.
 */
const DEFAULT_HERMES_COMMIT = "c015663b215c0e14de4295346b0727db602cbb1d";
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
  hermesCommit: hermesCommitSchema.default(DEFAULT_HERMES_COMMIT),
  expiresInMinutes: z.number().int().min(10).max(1_440).default(30),
}).strict();

export const hermesNodeEnrollmentBundleSchema = z.object({
  format: z.literal("orcasynapse-hermes-enrollment/v1"),
  nodeId: z.uuid(),
  nodeSlug: nodeSlugSchema,
  token: z.string().min(32).max(512),
  controlPlaneUrl: runtimeOriginSchema,
  hermesBaseUrl: runtimeOriginSchema,
  hermesCommit: hermesCommitSchema,
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
  // The commit the node resolved after installing, read back with
  // `git rev-parse HEAD`. Left a free string rather than the commit schema:
  // a node that could not resolve one reports "unknown", and refusing that
  // would lose the heartbeat rather than the information.
  hermesVersion: z.string().trim().min(1).max(256).default("unknown"),
  installerVersion: z.string().trim().min(1).max(256),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).strict();

export const hermesNodeEnrollmentResultSchema = z.object({
  node: hermesRuntimeNodeSchema,
  heartbeatPath: z.string().startsWith("/"),
  // Pinned by the node at enrollment. A node that never received one must
  // refuse to act on a desired-state document rather than trust it unverified.
  controlPlanePublicKeyPem: z.string().min(80).max(4_096),
  desiredStatePath: z.string().startsWith("/"),
  modelBootstrap: z.object({
    provider: z.literal("custom"),
    baseUrl: serviceEndpointSchema,
    modelAlias: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(16_384),
  }).strict(),
}).strict();

/**
 * What the control plane tells a runtime node to be.
 *
 * `admittedToolsets` is the whole desired state: the node enables exactly
 * these and nothing else. An empty array is a real instruction — disable
 * everything — not an absence of one, which is why the document is always
 * served rather than omitted when nothing is admitted.
 */
export const runtimeDesiredStateDocumentSchema = z.object({
  format: z.literal("orcasynapse-runtime-desired-state/v1"),
  nodeId: z.uuid(),
  generatedAt: z.iso.datetime(),
  admittedToolsets: z.array(z.string().trim().min(1).max(120)).max(200),
}).strict();

/**
 * The document is carried base64-encoded and signed over those exact bytes.
 *
 * The verifier is a shell script on the runtime host, so it must not have to
 * reproduce a canonical JSON serialization to check the signature — it decodes
 * what it was given, verifies, and only then parses.
 */
export const runtimeDesiredStateSchema = z.object({
  documentBase64: z.string().min(1).max(65_536),
  signature: z.string().min(1).max(512),
  publicKeyFingerprint: z.string().min(1).max(100),
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
export type RuntimeDesiredStateDocument = z.infer<typeof runtimeDesiredStateDocumentSchema>;
export type RuntimeDesiredState = z.infer<typeof runtimeDesiredStateSchema>;
export type HermesNodeHeartbeat = z.infer<typeof hermesNodeHeartbeatSchema>;
export type HermesNodeHeartbeatResult = z.infer<typeof hermesNodeHeartbeatResultSchema>;
export type MutateHermesRuntimeNode = z.infer<typeof mutateHermesRuntimeNodeSchema>;
export type RemoveHermesRuntimeNode = z.infer<typeof removeHermesRuntimeNodeSchema>;

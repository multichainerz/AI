import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type {
  CreateHermesNodeInvitation,
  EnrollHermesNode,
  HermesNodeEnrollmentBundle,
  HermesNodeEnrollmentResult,
  HermesNodeHeartbeat,
  HermesNodeHeartbeatResult,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  RemoveHermesRuntimeNode,
  RuntimeDesiredState,
  RuntimeDesiredStateDocument,
} from "@orcasynapse/contracts";
import {
  auditEvent,
  configurationRevision,
  controlPlaneSigningKey,
  hermesNodeEnrollment,
  hermesNodeRequestNonce,
  hermesRuntimeNode,
  localAdministrator,
  platformArchitectureDecision,
  runtimeToolsetAdmission,
  secretRecord,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { assertSignableBody, canonicalize } from "../canonical-json.js";
import { encryptedSecretData, sealedColumns, storedEnvelope } from "../secret-envelope.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { ConnectionTestService } from "../connections/diagnostics/connection-test-service.js";
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeConflictError,
  RuntimeNodeEnrollmentError,
  RuntimeNodeNotFoundError,
  type HermesNodeInstallerReadiness,
  type HermesRuntimeNodeManager,
  type NodeSignatureHeaders,
} from "./runtime-node-manager.js";

const SIGNATURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const NONCE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const NODE_STALE_AFTER_MS = 180_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Envelope AAD for the control plane's own signing key. */
const CONTROL_PLANE_KEY_CONTEXT = "control-plane:signing-key";

type StoredNode = {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string;
  expectedHostname: string | null;
  hostname: string | null;
  status: HermesRuntimeNode["status"];
  identityFingerprint: string | null;
  hermesVersion: string | null;
  installerVersion: string | null;
  capabilities: unknown;
  serviceConnectionId: string | null;
  serviceConnection?: { status: HermesRuntimeNode["serviceConnectionStatus"] } | null;
  lastSeenAt: Date | null;
  enrolledAt: Date | null;
  revokedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

type RuntimePrerequisites = {
  dashboardReady: boolean;
  inferenceReady: boolean;
};

type InferenceSeedCandidate = {
  baseUrl: string | null;
  configuration: unknown;
};

export function seedableInferenceModelAlias(connections: readonly InferenceSeedCandidate[]): string | null {
  if (connections.length !== 1 || !connections[0]?.baseUrl) return null;
  const configuration = connections[0].configuration
    && typeof connections[0].configuration === "object"
    && !Array.isArray(connections[0].configuration)
    ? connections[0].configuration as Record<string, unknown>
    : {};
  return typeof configuration.modelAlias === "string" && configuration.modelAlias.trim().length > 0
    ? configuration.modelAlias.trim()
    : null;
}

function digest(value: string): Uint8Array<ArrayBuffer> {
  const bytes = createHash("sha256").update(value, "utf8").digest();
  const result = new Uint8Array(bytes.length);
  result.set(bytes);
  return result;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function inferenceGatewayBaseUrl(controlPlaneUrl: string): string {
  const url = new URL(controlPlaneUrl);
  url.pathname = "/internal/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function summarize(node: StoredNode): HermesRuntimeNode {
  const capabilities = Array.isArray(node.capabilities)
    ? node.capabilities.filter((value): value is string => typeof value === "string")
    : [];
  const status = ["ONLINE", "DEGRADED"].includes(node.status) && (!node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > NODE_STALE_AFTER_MS)
    ? "OFFLINE"
    : node.status;
  return {
    id: node.id,
    slug: node.slug,
    displayName: node.displayName,
    baseUrl: node.baseUrl,
    expectedHostname: node.expectedHostname,
    hostname: node.hostname,
    status,
    identityFingerprint: node.identityFingerprint,
    hermesVersion: node.hermesVersion,
    installerVersion: node.installerVersion,
    capabilities,
    serviceConnectionId: node.serviceConnectionId,
    serviceConnectionStatus: node.serviceConnection?.status ?? null,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    enrolledAt: node.enrolledAt?.toISOString() ?? null,
    revokedAt: node.revokedAt?.toISOString() ?? null,
    revision: node.revision,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

function connectionEnvironment(target: "DEVELOPMENT" | "PILOT" | "PRODUCTION") {
  if (target === "PRODUCTION") return "PRODUCTION" as const;
  if (target === "PILOT") return "STAGING" as const;
  return "DEVELOPMENT" as const;
}

/**
 * Whether a control-plane origin is reachable only from the machine itself.
 *
 * The transport rule below exempts these because a loopback origin has no
 * network path to sit on, so a single-box development install stays workable
 * without weakening anything that is actually exposed.
 */
function isLoopbackOrigin(url: string | null): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, "");
    // Anchored at both ends: a prefix test lets `127.0.0.1.attacker.example`
    // resolve as loopback and re-open the plain-HTTP path this rule closes.
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function enrollmentArtifactViolation(
  target: "DEVELOPMENT" | "PILOT" | "PRODUCTION" | undefined,
  artifacts: { hermesCommit: string | null; controlPlaneUrl: string | null },
): string | null {
  /*
   * The transport rule applies to every target, not just PRODUCTION.
   *
   * Enrollment hands VM2 a one-time claim, its Hermes API key and a minted
   * inference gateway key, and the dashboard prints an installer command of the
   * form `curl -fsSL <origin>/install/agentic-node.sh | sudo bash`. That route
   * is necessarily unauthenticated and the script carries no signature, so over
   * plain HTTP anyone on the path can substitute the body and take root on VM2.
   * PRODUCTION was refused; DEVELOPMENT and PILOT were not, which made the
   * weakest deployments the ones handing out root.
   */
  if (!isLoopbackOrigin(artifacts.controlPlaneUrl) && !artifacts.controlPlaneUrl?.startsWith("https://")) {
    return "Agentic System enrollment requires an HTTPS OrcaSynapse origin, or a loopback address for a single-machine install.";
  }
  if (target !== "PRODUCTION") return null;
  // A 40-character commit SHA, not a container digest: VM2 installs Hermes
  // natively and pins with `--commit`. The guarantee is unchanged -- an
  // artifact identity that cannot be moved after the fact.
  if (!/^[0-9a-f]{40}$/.test(artifacts.hermesCommit ?? "")) {
    return "Production enrollment requires a commit-pinned Hermes runtime.";
  }
  if (!artifacts.controlPlaneUrl?.startsWith("https://")) return "Production enrollment requires an HTTPS OrcaSynapse origin.";
  return null;
}

function parseIdentity(publicKeyPem: string): { normalizedPem: string; fingerprint: string } {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("The key is not Ed25519.");
    }
    const normalizedPem = key.export({ type: "spki", format: "pem" }).toString();
    const der = key.export({ type: "spki", format: "der" });
    return { normalizedPem, fingerprint: createHash("sha256").update(der).digest("hex") };
  } catch {
    throw new RuntimeNodeEnrollmentError("The node identity must be a valid Ed25519 public key.", "INVALID");
  }
}

/**
 * The bytes a node signs, and the reason the first two lines exist.
 *
 * The message used to be `timestamp\nnonce\nchecksum(body)`, which bound
 * everything about a request except which request it was. Two live endpoints
 * authenticate over an identical `null` body — this module's `/desired-state`
 * and the corpus plane's — so one valid header triple was byte-valid on the
 * other path. An attacker positioned to capture a runtime desired-state poll
 * *and prevent it arriving* (the nonce is single-use deployment-wide, so the
 * legitimate request would otherwise burn it) could replay it against the
 * corpus endpoint, which leases the next queued mutation, returns its full
 * content, and marks it DISPATCHED.
 *
 * Binding the method and path makes a signature mean "this node authorised
 * this operation" rather than "this node authorised something". The path is
 * the resolved request path with no query string; neither side ever signs a
 * host, so a control-plane origin change does not invalidate an enrolled node.
 */
function signatureMessage(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: unknown,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${checksum(body)}`;
}

/**
 * The request a signature is bound to.
 *
 * Deliberately a required parameter in second position rather than an optional
 * one appended last: an optional operation would let a new call site omit it
 * and silently return to signing "something" instead of "this".
 */
export interface NodeRequestOperation {
  method: string;
  path: string;
}

export function verifyNodeRequestSignature(
  publicKeyPem: string,
  operation: NodeRequestOperation,
  headers: NodeSignatureHeaders,
  body: unknown,
  now = Date.now(),
): void {
  const timestamp = headers.timestamp;
  const nonce = headers.nonce;
  const signature = headers.signature;
  if (!timestamp || !nonce || !signature || !UUID_PATTERN.test(nonce)) {
    throw new RuntimeNodeAuthenticationError();
  }
  const requestTime = new Date(timestamp);
  if (Number.isNaN(requestTime.getTime()) || Math.abs(now - requestTime.getTime()) > SIGNATURE_CLOCK_SKEW_MS) {
    throw new RuntimeNodeAuthenticationError("The runtime node request timestamp is outside the allowed window.");
  }
  // Fails loudly if a body was added that two canonical-JSON implementations
  // would serialize differently, rather than producing a signature mismatch.
  assertSignableBody(body);
  const signatureBytes = Buffer.from(signature, "base64url");
  const valid = signatureBytes.length === 64 && verify(
    null,
    Buffer.from(signatureMessage(operation.method, operation.path, timestamp, nonce, body), "utf8"),
    publicKeyPem,
    signatureBytes,
  );
  if (!valid) throw new RuntimeNodeAuthenticationError();
}

export class DrizzleHermesRuntimeNodeManager implements HermesRuntimeNodeManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly encryption: EnvelopeEncryption,
    private readonly connectionTester?: ConnectionTestService,
  ) {}

  async list(): Promise<HermesRuntimeNode[]> {
    // A node that stopped reporting must not keep presenting as available.
    await this.database
      .update(hermesRuntimeNode)
      .set({ status: "OFFLINE", revision: increment(hermesRuntimeNode.revision) })
      .where(and(
        inArray(hermesRuntimeNode.status, ["ONLINE", "DEGRADED"]),
        or(
          isNull(hermesRuntimeNode.lastSeenAt),
          lt(hermesRuntimeNode.lastSeenAt, new Date(Date.now() - NODE_STALE_AFTER_MS)),
        ),
      ));
    const nodes = await this.database
      .select({ node: hermesRuntimeNode, connectionStatus: serviceConnection.status })
      .from(hermesRuntimeNode)
      .leftJoin(serviceConnection, eq(hermesRuntimeNode.serviceConnectionId, serviceConnection.id))
      .orderBy(asc(hermesRuntimeNode.displayName));
    return nodes.map(({ node, connectionStatus }) =>
      summarize({ ...node, serviceConnection: connectionStatus ? { status: connectionStatus } : null } as StoredNode));
  }

  private async runtimePrerequisites(): Promise<RuntimePrerequisites> {
    const [administrators, inferenceConnections] = await Promise.all([
      this.database
        .select({ total: count() })
        .from(localAdministrator)
        .where(and(
          isNull(localAdministrator.disabledAt),
          eq(localAdministrator.passwordChangeRequired, false),
        )),
      this.database
        .select({ baseUrl: serviceConnection.baseUrl, configuration: serviceConnection.configuration })
        .from(serviceConnection)
        .where(and(
          eq(serviceConnection.kind, "INFERENCE"),
          eq(serviceConnection.enabled, true),
          eq(serviceConnection.status, "HEALTHY"),
        ))
        .limit(2),
    ]);
    return {
      dashboardReady: (administrators[0]?.total ?? 0) > 0,
      inferenceReady: seedableInferenceModelAlias(inferenceConnections) !== null,
    };
  }

  async installerReadiness(): Promise<HermesNodeInstallerReadiness> {
    const [prerequisites, activeInvitations] = await Promise.all([
      this.runtimePrerequisites(),
      this.database
        .select({ total: count() })
        .from(hermesNodeEnrollment)
        .where(and(eq(hermesNodeEnrollment.status, "ISSUED"), gt(hermesNodeEnrollment.expiresAt, new Date()))),
    ]);
    const invitationReady = (activeInvitations[0]?.total ?? 0) > 0;
    return {
      ...prerequisites,
      invitationReady,
      // The installer contains no claim or reusable credential. Keep it
      // available after enrollment so a partially installed node can rerun the
      // exact same command and resume from its protected local journal.
      ready: prerequisites.dashboardReady && prerequisites.inferenceReady,
    };
  }

  async createInvitation(principal: AdminPrincipal, input: CreateHermesNodeInvitation): Promise<HermesNodeInvitation> {
    const prerequisites = await this.runtimePrerequisites();
    if (!prerequisites.dashboardReady) {
      throw new RuntimeNodeConflictError("Complete the dashboard administrator setup before enrolling the Agentic System.");
    }
    if (!prerequisites.inferenceReady) {
      throw new RuntimeNodeConflictError("Configure and test exactly one healthy AI Inference route with a served model before enrolling Hermes.");
    }
    const architecture = await this.architectureTarget();
    const productionViolation = enrollmentArtifactViolation(architecture, input);
    if (productionViolation) throw new RuntimeNodeConflictError(productionViolation);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digest(token);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);

    try {
      const node = await this.database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.slug, input.slug)).limit(1);
        if (existing?.identityPublicKeyPem || existing?.enrolledAt) {
          throw new RuntimeNodeConflictError(`Hermes node '${input.slug}' is already enrolled.`);
        }
        const [pending] = existing
          ? await transaction
            .update(hermesRuntimeNode)
            .set({
              displayName: input.displayName,
              baseUrl: input.baseUrl,
              expectedHostname: input.expectedHostname ?? null,
              revision: increment(hermesRuntimeNode.revision),
            })
            .where(eq(hermesRuntimeNode.id, existing.id))
            .returning()
          : await transaction
            .insert(hermesRuntimeNode)
            .values({
              slug: input.slug,
              displayName: input.displayName,
              baseUrl: input.baseUrl,
              expectedHostname: input.expectedHostname ?? null,
              createdBy: principal.id,
            })
            .returning();
        if (!pending) throw new RuntimeNodeConflictError("The runtime node record could not be prepared.");

        // Issuing a new claim retires any outstanding one for this node.
        await transaction
          .update(hermesNodeEnrollment)
          .set({ status: "REVOKED", revokedAt: new Date() })
          .where(and(eq(hermesNodeEnrollment.nodeId, pending.id), eq(hermesNodeEnrollment.status, "ISSUED")));
        await transaction.insert(hermesNodeEnrollment).values({
          nodeId: pending.id,
          tokenHash,
          controlPlaneUrl: input.controlPlaneUrl.replace(/\/$/, ""),
          hermesCommit: input.hermesCommit,
          expiresAt,
          createdBy: principal.id,
        });
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "hermes.node.invitation-issued",
          resourceType: "HermesRuntimeNode",
          resourceId: pending.id,
          outcome: "SUCCESS",
          metadata: { expiresAt: expiresAt.toISOString(), expectedHostname: input.expectedHostname ?? null },
        });
        return pending;
      });
      return {
        node: summarize(node as StoredNode),
        bundle: {
          format: "orcasynapse-hermes-enrollment/v1",
          nodeId: node.id,
          nodeSlug: node.slug,
          token,
          controlPlaneUrl: input.controlPlaneUrl.replace(/\/$/, ""),
          hermesBaseUrl: input.baseUrl.replace(/\/$/, ""),
          hermesCommit: input.hermesCommit,
          expiresAt: expiresAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeNodeConflictError) throw error;
      if (isUniqueViolation(error)) {
        throw new RuntimeNodeConflictError(`Hermes node '${input.slug}' already exists.`);
      }
      throw error;
    }
  }

  /** The single architecture row's target, defaulting fail-safe to development. */
  private async architectureTarget(): Promise<"DEVELOPMENT" | "PILOT" | "PRODUCTION" | undefined> {
    const [row] = await this.database
      .select({ targetEnvironment: platformArchitectureDecision.targetEnvironment })
      .from(platformArchitectureDecision)
      .where(eq(platformArchitectureDecision.id, "global"))
      .limit(1);
    return row?.targetEnvironment;
  }

  async resolveInvitation(token: string): Promise<HermesNodeEnrollmentBundle> {
    const tokenHash = digest(token);
    const [row] = await this.database
      .select({ enrollment: hermesNodeEnrollment, node: hermesRuntimeNode })
      .from(hermesNodeEnrollment)
      .innerJoin(hermesRuntimeNode, eq(hermesNodeEnrollment.nodeId, hermesRuntimeNode.id))
      .where(eq(hermesNodeEnrollment.tokenHash, tokenHash))
      .limit(1);
    const enrollment = row ? { ...row.enrollment, node: row.node } : undefined;
    if (!enrollment) {
      throw new RuntimeNodeEnrollmentError("The enrollment claim is invalid.", "INVALID");
    }
    if (enrollment.status === "CONSUMED") {
      throw new RuntimeNodeEnrollmentError("The enrollment claim has already been used.", "CONSUMED");
    }
    if (enrollment.status !== "ISSUED") {
      throw new RuntimeNodeEnrollmentError("The enrollment claim is no longer active.", "INVALID");
    }
    if (enrollment.expiresAt <= new Date()) {
      await this.database
        .update(hermesNodeEnrollment)
        .set({ status: "EXPIRED" })
        .where(and(eq(hermesNodeEnrollment.id, enrollment.id), eq(hermesNodeEnrollment.status, "ISSUED")));
      throw new RuntimeNodeEnrollmentError("The enrollment claim has expired.", "EXPIRED");
    }
    if (!enrollment.controlPlaneUrl || !enrollment.hermesCommit) {
      throw new RuntimeNodeEnrollmentError(
        "This invitation predates direct VM2 bootstrap; use its downloaded enrollment JSON or issue a new invitation.",
        "INVALID",
      );
    }
    return {
      format: "orcasynapse-hermes-enrollment/v1",
      nodeId: enrollment.node.id,
      nodeSlug: enrollment.node.slug,
      token,
      controlPlaneUrl: enrollment.controlPlaneUrl,
      hermesBaseUrl: enrollment.node.baseUrl,
      hermesCommit: enrollment.hermesCommit,
      expiresAt: enrollment.expiresAt.toISOString(),
    };
  }

  async enroll(input: EnrollHermesNode, sourceIp?: string): Promise<HermesNodeEnrollmentResult> {
    const identity = parseIdentity(input.publicKeyPem);
    const tokenHash = digest(input.token);
    const now = new Date();

    const enrolled = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock("orcasynapse-hermes-primary-runtime"));
      const [row] = await transaction
        .select({ enrollment: hermesNodeEnrollment, node: hermesRuntimeNode })
        .from(hermesNodeEnrollment)
        .innerJoin(hermesRuntimeNode, eq(hermesNodeEnrollment.nodeId, hermesRuntimeNode.id))
        .where(eq(hermesNodeEnrollment.tokenHash, tokenHash))
        .limit(1);
      const enrollment = row ? { ...row.enrollment, node: row.node } : undefined;
      if (!enrollment || enrollment.nodeId !== input.nodeId) {
        throw new RuntimeNodeEnrollmentError("The enrollment claim is invalid.", "INVALID");
      }
      if (enrollment.status === "CONSUMED") {
        throw new RuntimeNodeEnrollmentError("The enrollment claim has already been used.", "CONSUMED");
      }
      if (enrollment.status !== "ISSUED") {
        throw new RuntimeNodeEnrollmentError("The enrollment claim is no longer active.", "INVALID");
      }
      if (enrollment.controlPlaneUrl !== input.controlPlaneUrl.replace(/\/$/, "")) {
        throw new RuntimeNodeEnrollmentError("The enrollment control-plane origin does not match the invitation.", "INVALID");
      }
      if (enrollment.expiresAt <= now) {
        await transaction
          .update(hermesNodeEnrollment)
          .set({ status: "EXPIRED" })
          .where(eq(hermesNodeEnrollment.id, enrollment.id));
        return { expired: true as const };
      }
      if (enrollment.node.expectedHostname && enrollment.node.expectedHostname.toLowerCase() !== input.hostname.toLowerCase()) {
        throw new RuntimeNodeEnrollmentError("The runtime hostname does not match the invitation.", "HOSTNAME_MISMATCH");
      }
      // Exactly one runtime may hold the execution boundary at a time.
      const [activeRuntime] = await transaction
        .select({ slug: hermesRuntimeNode.slug })
        .from(hermesRuntimeNode)
        .where(and(
          ne(hermesRuntimeNode.id, input.nodeId),
          isNotNull(hermesRuntimeNode.enrolledAt),
          ne(hermesRuntimeNode.status, "REVOKED"),
        ))
        .limit(1);
      if (activeRuntime) {
        throw new RuntimeNodeEnrollmentError(`Hermes runtime '${activeRuntime.slug}' is already the active OrcaSynapse execution boundary.`, "INVALID");
      }

      const inferenceConnections = await transaction
        .select()
        .from(serviceConnection)
        .where(and(
          eq(serviceConnection.kind, "INFERENCE"),
          eq(serviceConnection.enabled, true),
          eq(serviceConnection.status, "HEALTHY"),
        ))
        .limit(2);
      const modelAlias = seedableInferenceModelAlias(inferenceConnections);
      if (!modelAlias) {
        throw new RuntimeNodeEnrollmentError("Exactly one healthy inference server route with a model alias is required.", "INVALID");
      }
      const gatewayKey = randomBytes(32).toString("base64url");
      const modelBootstrap = {
        provider: "custom" as const,
        baseUrl: inferenceGatewayBaseUrl(input.controlPlaneUrl),
        modelAlias,
        apiKey: gatewayKey,
      };

      const [architecture] = await transaction
        .select({ targetEnvironment: platformArchitectureDecision.targetEnvironment })
        .from(platformArchitectureDecision)
        .where(eq(platformArchitectureDecision.id, "global"))
        .limit(1);
      const productionViolation = enrollmentArtifactViolation(architecture?.targetEnvironment, enrollment);
      if (productionViolation) {
        throw new RuntimeNodeEnrollmentError(productionViolation, "INVALID");
      }
      const environment = connectionEnvironment(architecture?.targetEnvironment ?? "DEVELOPMENT");
      const connectionId = randomUUID();
      const configuration = {
        timeoutMs: 8_000,
        healthPath: "/health",
        capabilitiesPath: "/v1/capabilities",
        sessionsPath: "/api/sessions",
        toolsetsPath: "/v1/toolsets",
        runPollIntervalMs: 1_000,
      };
      const connectionSlug = `hermes-node-${enrollment.node.slug}`.slice(0, 64);
      const revisionState = {
        slug: connectionSlug,
        displayName: `${enrollment.node.displayName} Hermes`,
        kind: "HERMES",
        environment,
        baseUrl: enrollment.node.baseUrl,
        enabled: true,
        configuration,
        secretFieldNames: ["apiKey", "inferenceGatewayKey"],
      };
      await transaction.insert(serviceConnection).values({
        id: connectionId,
        slug: connectionSlug,
        displayName: `${enrollment.node.displayName} Hermes`,
        kind: "HERMES",
        environment,
        baseUrl: enrollment.node.baseUrl,
        enabled: true,
        status: "NOT_TESTED",
        configuration,
      });
      // Prisma nested these under the connection; Drizzle writes each table.
      await transaction.insert(secretRecord).values([
        { ...encryptedSecretData(connectionId, "apiKey", input.apiKey, this.encryption), serviceConnectionId: connectionId, createdBy: null },
        { ...encryptedSecretData(connectionId, "inferenceGatewayKey", gatewayKey, this.encryption), serviceConnectionId: connectionId, createdBy: null },
      ]);
      await transaction.insert(configurationRevision).values({
        serviceConnectionId: connectionId,
        revision: 1,
        configuration: revisionState,
        secretFieldNames: ["apiKey", "inferenceGatewayKey"],
        checksum: checksum(revisionState),
        activatedAt: now,
      });
      await transaction
        .update(hermesNodeEnrollment)
        .set({ status: "CONSUMED", consumedAt: now, consumedSourceIp: sourceIp ?? null })
        .where(eq(hermesNodeEnrollment.id, enrollment.id));
      const [updated] = await transaction
        .update(hermesRuntimeNode)
        .set({
          hostname: input.hostname,
          identityPublicKeyPem: identity.normalizedPem,
          identityFingerprint: identity.fingerprint,
          hermesVersion: input.hermesVersion,
          installerVersion: input.installerVersion,
          capabilities: input.capabilities,
          serviceConnectionId: connectionId,
          enrolledAt: now,
          revision: increment(hermesRuntimeNode.revision),
        })
        .where(eq(hermesRuntimeNode.id, enrollment.nodeId))
        .returning();
      if (!updated) throw new RuntimeNodeEnrollmentError("The runtime node could not be enrolled.", "INVALID");
      await transaction.insert(auditEvent).values([
        {
          actorType: "SERVICE",
          action: "hermes.node.enrolled",
          resourceType: "HermesRuntimeNode",
          resourceId: updated.id,
          outcome: "SUCCESS",
          sourceIp: sourceIp ?? null,
          metadata: { hostname: input.hostname, identityFingerprint: identity.fingerprint },
        },
        {
          actorType: "SYSTEM",
          action: "connection.created",
          resourceType: "ServiceConnection",
          resourceId: connectionId,
          outcome: "SUCCESS",
          metadata: { kind: "HERMES", environment, managedBy: "HermesRuntimeNode" },
        },
      ]);
      return { expired: false as const, node: updated, modelBootstrap };
    }).catch((error: unknown) => {
      if (error instanceof RuntimeNodeEnrollmentError) throw error;
      if (isUniqueViolation(error)) {
        throw new RuntimeNodeEnrollmentError(
          "The runtime identity or generated Hermes connection is already enrolled.",
          "INVALID",
        );
      }
      throw error;
    });
    if (enrolled.expired) {
      throw new RuntimeNodeEnrollmentError("The enrollment claim has expired.", "EXPIRED");
    }
    if (enrolled.node.serviceConnectionId && this.connectionTester) {
      await this.connectionTester.test(enrolled.node.serviceConnectionId).catch(() => undefined);
    }
    const { publicKeyPem } = await this.controlPlanePublicKey();
    return {
      node: summarize(enrolled.node as StoredNode),
      heartbeatPath: `/api/v1/runtime-nodes/${enrolled.node.id}/heartbeat`,
      controlPlanePublicKeyPem: publicKeyPem,
      desiredStatePath: `/api/v1/runtime-nodes/${enrolled.node.id}/desired-state`,
      modelBootstrap: enrolled.modelBootstrap,
    };
  }

  private async authenticate(
    nodeId: string,
    operation: NodeRequestOperation,
    headers: NodeSignatureHeaders,
    body: unknown,
  ) {
    const nonce = headers.nonce;
    if (!nonce) {
      throw new RuntimeNodeAuthenticationError();
    }
    const [node] = await this.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, nodeId)).limit(1);
    if (!node?.identityPublicKeyPem) {
      throw new RuntimeNodeAuthenticationError();
    }
    verifyNodeRequestSignature(node.identityPublicKeyPem, operation, headers, body);
    // Only disclose lifecycle state after possession of the enrolled private
    // key has been proven. This keeps enumeration fail-closed while giving a
    // legitimate VM2 operator an actionable recovery reason.
    if (node.status === "REVOKED" || node.status === "SUSPENDED") {
      throw new RuntimeNodeAuthenticationError(
        `The runtime node is ${node.status.toLowerCase()} and is not allowed to authenticate.`,
      );
    }
    // The unique constraint on the nonce is what makes a replay impossible.
    try {
      await this.database.insert(hermesNodeRequestNonce).values({ nodeId, nonce });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RuntimeNodeAuthenticationError("The runtime node request was replayed.");
      }
      throw error;
    }
    void this.database
      .delete(hermesNodeRequestNonce)
      .where(lt(hermesNodeRequestNonce.receivedAt, new Date(Date.now() - NONCE_RETENTION_MS)))
      .catch(() => undefined);
    return node;
  }

  /**
   * The control plane's signing identity, generated once on first use.
   *
   * Created lazily rather than at install time so an existing installation
   * gains one on upgrade without a migration that has to invent key material.
   * The insert is conflict-tolerant because two API instances can race here,
   * and both must end up agreeing on a single key.
   */
  private async signingKey(): Promise<{ privateKeyPem: string; publicKeyPem: string; fingerprint: string }> {
    const [existing] = await this.database.select().from(controlPlaneSigningKey).limit(1);
    if (existing) {
      return {
        privateKeyPem: this.encryption.decrypt(storedEnvelope(existing), CONTROL_PLANE_KEY_CONTEXT),
        publicKeyPem: existing.publicKeyPem,
        fingerprint: existing.publicKeyFingerprint,
      };
    }
    const generated = generateKeyPairSync("ed25519");
    const privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256")
      .update(generated.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    const sealed = sealedColumns(this.encryption.encrypt(privateKeyPem, CONTROL_PLANE_KEY_CONTEXT));
    await this.database
      .insert(controlPlaneSigningKey)
      .values({ id: "primary", publicKeyPem, publicKeyFingerprint: fingerprint, ...sealed })
      .onConflictDoNothing();
    // Re-read rather than trusting the generated pair: if another instance won
    // the race, its key is the one nodes will have pinned.
    const [stored] = await this.database.select().from(controlPlaneSigningKey).limit(1);
    if (!stored) throw new Error("The control-plane signing key could not be established.");
    return {
      privateKeyPem: this.encryption.decrypt(storedEnvelope(stored), CONTROL_PLANE_KEY_CONTEXT),
      publicKeyPem: stored.publicKeyPem,
      fingerprint: stored.publicKeyFingerprint,
    };
  }

  async controlPlanePublicKey(): Promise<{ publicKeyPem: string; fingerprint: string }> {
    const { publicKeyPem, fingerprint } = await this.signingKey();
    return { publicKeyPem, fingerprint };
  }

  /**
   * Shared enrolled-node authentication for adjacent VM2-owned planes.
   *
   * The caller passes its own method and path so its signatures cannot be
   * replayed here, and this module's cannot be replayed there.
   */
  async authenticateNodeRequest(
    nodeId: string,
    operation: NodeRequestOperation,
    headers: NodeSignatureHeaders,
    body: unknown,
  ): Promise<void> {
    await this.authenticate(nodeId, operation, headers, body);
  }

  /** Sign an opaque JSON document with the identity VM2 pinned at enrollment. */
  async signNodeDocument(document: unknown): Promise<RuntimeDesiredState> {
    assertSignableBody(document);
    const { privateKeyPem, fingerprint } = await this.signingKey();
    const bytes = Buffer.from(JSON.stringify(document), "utf8");
    return {
      documentBase64: bytes.toString("base64"),
      signature: sign(null, bytes, privateKeyPem).toString("base64"),
      publicKeyFingerprint: fingerprint,
    };
  }

  /**
   * What this node should be running, signed so the node can trust it.
   *
   * Authenticated by the node's own signature, exactly like the heartbeat, so
   * one node cannot read another's desired state. A revoked or suspended node
   * is refused by `authenticate` before any document is produced.
   */
  async desiredState(nodeId: string, headers: NodeSignatureHeaders): Promise<RuntimeDesiredState> {
    await this.authenticate(
      nodeId,
      { method: "GET", path: `/api/v1/runtime-nodes/${nodeId}/desired-state` },
      headers,
      null,
    );
    const admissions = await this.database
      .select({ toolsetName: runtimeToolsetAdmission.toolsetName })
      .from(runtimeToolsetAdmission)
      .where(eq(runtimeToolsetAdmission.admitted, true))
      .orderBy(asc(runtimeToolsetAdmission.toolsetName));
    const document: RuntimeDesiredStateDocument = {
      format: "orcasynapse-runtime-desired-state/v1",
      nodeId,
      generatedAt: new Date().toISOString(),
      admittedToolsets: admissions.map((row) => row.toolsetName),
    };
    return this.signNodeDocument(document);
  }

  async heartbeat(nodeId: string, headers: NodeSignatureHeaders, input: HermesNodeHeartbeat): Promise<HermesNodeHeartbeatResult> {
    const current = await this.authenticate(
      nodeId,
      { method: "POST", path: `/api/v1/runtime-nodes/${nodeId}/heartbeat` },
      headers,
      input,
    );
    const effectiveStatus = current.status === "DRAINING" ? "DRAINING" : input.status;
    const receivedAt = new Date();
    await this.database
      .update(hermesRuntimeNode)
      .set({
        status: effectiveStatus,
        hermesVersion: input.hermesVersion,
        capabilities: input.capabilities,
        // Availability is based on control-plane receipt time. A skewed or
        // malicious node clock must not keep a dead runtime looking online.
        lastSeenAt: receivedAt,
        // Deliberately does NOT bump `revision`. That field is the optimistic
        // concurrency token for operator actions -- `mutate` requires an exact
        // match on it. A node heartbeats every minute, so bumping it here made
        // the token a clock: any dashboard tab open longer than a minute had a
        // stale revision and its first Drain/Suspend/Revoke failed with a 409,
        // including the emergency revoke path for a compromised node.
      })
      .where(eq(hermesRuntimeNode.id, nodeId));
    return { accepted: true, serverTime: receivedAt.toISOString() };
  }

  async mutate(principal: AdminPrincipal, nodeId: string, input: MutateHermesRuntimeNode): Promise<HermesRuntimeNode> {
    const [current] = await this.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, nodeId)).limit(1);
    if (!current) throw new RuntimeNodeNotFoundError();
    if (current.status === "REVOKED") throw new RuntimeNodeConflictError("A revoked runtime node cannot be changed.");
    const nextStatus = input.action === "DRAIN"
      ? "DRAINING"
      : input.action === "SUSPEND"
        ? "SUSPENDED"
        : input.action === "REVOKE"
          ? "REVOKED"
          : current.lastSeenAt && Date.now() - current.lastSeenAt.getTime() < 120_000
            ? "ONLINE"
            : "OFFLINE";
    const now = new Date();
    const result = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(hermesRuntimeNode)
        .set({
          status: nextStatus,
          revokedAt: nextStatus === "REVOKED" ? now : null,
          revision: increment(hermesRuntimeNode.revision),
        })
        .where(and(
          eq(hermesRuntimeNode.id, nodeId),
          eq(hermesRuntimeNode.revision, input.expectedRevision),
        ))
        .returning();
      const [applied] = updated;
      if (updated.length !== 1 || !applied) {
        throw new RuntimeNodeConflictError("The runtime node changed before this action was applied.");
      }
      if (nextStatus === "REVOKED") {
        // Revocation also burns the outstanding claim and disables every
        // connection this node's enrollment generated.
        await transaction
          .update(hermesNodeEnrollment)
          .set({ status: "REVOKED", revokedAt: now })
          .where(and(eq(hermesNodeEnrollment.nodeId, nodeId), eq(hermesNodeEnrollment.status, "ISSUED")));
        if (current.serviceConnectionId) {
          await transaction
            .update(serviceConnection)
            .set({ enabled: false, status: "DISABLED" })
            .where(eq(serviceConnection.id, current.serviceConnectionId));
        }
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: `hermes.node.${input.action.toLowerCase()}`,
        resourceType: "HermesRuntimeNode",
        resourceId: nodeId,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, previousStatus: current.status, nextStatus },
      });
      return applied;
    });
    return summarize(result as StoredNode);
  }

  async remove(principal: AdminPrincipal, nodeId: string, input: RemoveHermesRuntimeNode): Promise<void> {
    const [current] = await this.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, nodeId)).limit(1);
    if (!current) throw new RuntimeNodeNotFoundError();
    if (current.status !== "REVOKED") {
      throw new RuntimeNodeConflictError("Revoke the runtime node before permanently removing its control-plane record.");
    }
    if (current.revision !== input.expectedRevision) {
      throw new RuntimeNodeConflictError("The runtime node changed before permanent removal was confirmed.");
    }
    if (input.confirmation !== current.slug) {
      throw new RuntimeNodeConflictError(`Type '${current.slug}' to confirm permanent removal.`);
    }

    await this.database.transaction(async (transaction) => {
      const removed = await transaction
        .delete(hermesRuntimeNode)
        .where(and(
          eq(hermesRuntimeNode.id, nodeId),
          eq(hermesRuntimeNode.status, "REVOKED"),
          eq(hermesRuntimeNode.revision, input.expectedRevision),
        ))
        .returning({ id: hermesRuntimeNode.id });
      if (removed.length !== 1) {
        throw new RuntimeNodeConflictError("The runtime node changed before permanent removal was applied.");
      }

      // Only the connection this enrollment generated is removed with the node.
      const removedConnections = current.serviceConnectionId
        ? await transaction
          .delete(serviceConnection)
          .where(eq(serviceConnection.id, current.serviceConnectionId))
          .returning({ id: serviceConnection.id })
        : [];
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "hermes.node.removed",
        resourceType: "HermesRuntimeNode",
        resourceId: nodeId,
        outcome: "SUCCESS",
        metadata: {
          reason: input.reason,
          slug: current.slug,
          displayName: current.displayName,
          identityFingerprint: current.identityFingerprint,
          removedConnections: removedConnections.length,
          hostDestruction: "OPERATOR_ATTESTED",
        },
      });
    });
  }
}

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
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
  RegisterHermesNodeMemory,
  RegisterHermesNodeMemoryResult,
} from "@orcasynapse/contracts";
import {
  auditEvent,
  configurationRevision,
  hermesNodeEnrollment,
  hermesNodeRequestNonce,
  hermesRuntimeNode,
  localAdministrator,
  platformArchitectureDecision,
  secretRecord,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { ConnectionTestService } from "../connections/diagnostics/connection-test-service.js";
import { SUPERMEMORY_LOCAL_READY_PATH } from "../connections/diagnostics/supermemory-adapter.js";
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

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
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

function encryptedSecretData(connectionId: string, fieldName: string, value: string, encryption: EnvelopeEncryption) {
  const envelope = encryption.encrypt(value, `${connectionId}:${fieldName}`);
  const databaseBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  };
  return {
    fieldName,
    encryptedValue: databaseBytes(envelope.encryptedValue),
    valueNonce: databaseBytes(envelope.valueNonce),
    valueAuthTag: databaseBytes(envelope.valueAuthTag),
    wrappedDataKey: databaseBytes(envelope.wrappedDataKey),
    keyNonce: databaseBytes(envelope.keyNonce),
    keyAuthTag: databaseBytes(envelope.keyAuthTag),
    encryptionVersion: envelope.encryptionVersion,
    masterKeyVersion: envelope.masterKeyVersion,
  };
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

function productionArtifactViolation(
  target: "DEVELOPMENT" | "PILOT" | "PRODUCTION" | undefined,
  artifacts: { hermesImage: string | null; supermemoryVersion: string; controlPlaneUrl: string | null },
): string | null {
  if (target !== "PRODUCTION") return null;
  if (!artifacts.hermesImage?.includes("@sha256:")) return "Production enrollment requires a digest-pinned Hermes image.";
  if (artifacts.supermemoryVersion === "latest") return "Production enrollment requires an exact Supermemory release.";
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

function signatureMessage(timestamp: string, nonce: string, body: unknown): string {
  return `${timestamp}\n${nonce}\n${checksum(body)}`;
}

export function verifyNodeRequestSignature(
  publicKeyPem: string,
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
  const signatureBytes = Buffer.from(signature, "base64url");
  const valid = signatureBytes.length === 64 && verify(
    null,
    Buffer.from(signatureMessage(timestamp, nonce, body), "utf8"),
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
    const productionViolation = productionArtifactViolation(architecture, input);
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
          hermesImage: input.hermesImage,
          supermemoryVersion: input.supermemoryVersion,
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
          hermesImage: input.hermesImage,
          supermemoryVersion: input.supermemoryVersion,
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
    if (!enrollment.controlPlaneUrl || !enrollment.hermesImage) {
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
      hermesImage: enrollment.hermesImage,
      supermemoryVersion: enrollment.supermemoryVersion,
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
      const productionViolation = productionArtifactViolation(architecture?.targetEnvironment, enrollment);
      if (productionViolation) {
        throw new RuntimeNodeEnrollmentError(productionViolation, "INVALID");
      }
      const environment = connectionEnvironment(architecture?.targetEnvironment ?? "DEVELOPMENT");
      const connectionId = randomUUID();
      const configuration = {
        timeoutMs: 8_000,
        healthPath: "/health",
        capabilitiesPath: "/v1/capabilities",
        runsPath: "/v1/runs",
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
    return {
      node: summarize(enrolled.node as StoredNode),
      heartbeatPath: `/api/v1/runtime-nodes/${enrolled.node.id}/heartbeat`,
      modelBootstrap: enrolled.modelBootstrap,
    };
  }

  private async authenticate(nodeId: string, headers: NodeSignatureHeaders, body: unknown) {
    const nonce = headers.nonce;
    if (!nonce) {
      throw new RuntimeNodeAuthenticationError();
    }
    const [node] = await this.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, nodeId)).limit(1);
    if (!node?.identityPublicKeyPem) {
      throw new RuntimeNodeAuthenticationError();
    }
    verifyNodeRequestSignature(node.identityPublicKeyPem, headers, body);
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

  async heartbeat(nodeId: string, headers: NodeSignatureHeaders, input: HermesNodeHeartbeat): Promise<HermesNodeHeartbeatResult> {
    const current = await this.authenticate(nodeId, headers, input);
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
        revision: increment(hermesRuntimeNode.revision),
      })
      .where(eq(hermesRuntimeNode.id, nodeId));
    return { accepted: true, serverTime: receivedAt.toISOString() };
  }

  async registerMemory(
    nodeId: string,
    headers: NodeSignatureHeaders,
    input: RegisterHermesNodeMemory,
  ): Promise<RegisterHermesNodeMemoryResult> {
    const node = await this.authenticate(nodeId, headers, input);
    const [hermesConnection] = node.serviceConnectionId
      ? await this.database
        .select({ baseUrl: serviceConnection.baseUrl })
        .from(serviceConnection)
        .where(eq(serviceConnection.id, node.serviceConnectionId))
        .limit(1)
      : [];
    if (!hermesConnection?.baseUrl) {
      throw new RuntimeNodeConflictError("The enrolled Hermes route is unavailable for memory registration.");
    }
    const hermesUrl = new URL(hermesConnection.baseUrl);
    const memoryUrl = new URL(input.baseUrl);
    if (memoryUrl.hostname !== hermesUrl.hostname || memoryUrl.port !== "6767") {
      throw new RuntimeNodeConflictError("Supermemory must be registered on the enrolled Hermes host at TCP 6767.");
    }
    const environment = connectionEnvironment(await this.architectureTarget() ?? "DEVELOPMENT");
    const slug = `supermemory-node-${node.slug}`.slice(0, 64);
    const now = new Date();
    const connectionId = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-supermemory-node:${nodeId}`));
      const [existing] = await transaction
        .select().from(serviceConnection).where(eq(serviceConnection.slug, slug)).limit(1);
      if (existing && existing.kind !== "SUPERMEMORY") {
        throw new RuntimeNodeConflictError("The managed Supermemory connection slug is already used by another service kind.");
      }
      const id = existing?.id ?? randomUUID();
      const configuration = {
        timeoutMs: 8_000,
        healthPath: SUPERMEMORY_LOCAL_READY_PATH,
        documentsPath: "/v3/documents",
        searchPath: "/v3/search",
        memoryTimeoutMs: 300_000,
        memoryPollIntervalMs: 2_000,
        retrievalLimit: 6,
        retrievalThreshold: 0.25,
        observedVersion: input.observedVersion,
      };
      const revision = (existing?.activeRevision ?? 0) + 1;
      const revisionState = {
        slug,
        displayName: `${node.displayName} Supermemory`,
        kind: "SUPERMEMORY",
        environment,
        baseUrl: input.baseUrl,
        enabled: true,
        configuration,
        secretFieldNames: ["apiKey"],
      };
      if (existing) {
        // A rotated credential is retired rather than deleted.
        await transaction
          .update(secretRecord)
          .set({ active: false, retiredAt: now })
          .where(and(
            eq(secretRecord.serviceConnectionId, id),
            eq(secretRecord.fieldName, "apiKey"),
            eq(secretRecord.active, true),
          ));
        await transaction.insert(secretRecord).values({
          ...encryptedSecretData(id, "apiKey", input.apiKey, this.encryption),
          serviceConnectionId: id,
          createdBy: null,
        });
        await transaction
          .update(serviceConnection)
          .set({ baseUrl: input.baseUrl, enabled: true, status: "NOT_TESTED", environment, configuration, activeRevision: revision })
          .where(eq(serviceConnection.id, id));
        await transaction.insert(configurationRevision).values({
          serviceConnectionId: id, revision, configuration: revisionState,
          secretFieldNames: ["apiKey"], checksum: checksum(revisionState), activatedAt: now,
        });
      } else {
        await transaction.insert(serviceConnection).values({
          id,
          slug,
          displayName: `${node.displayName} Supermemory`,
          kind: "SUPERMEMORY",
          environment,
          baseUrl: input.baseUrl,
          enabled: true,
          status: "NOT_TESTED",
          configuration,
        });
        await transaction.insert(secretRecord).values({
          ...encryptedSecretData(id, "apiKey", input.apiKey, this.encryption),
          serviceConnectionId: id,
          createdBy: null,
        });
        await transaction.insert(configurationRevision).values({
          serviceConnectionId: id, revision, configuration: revisionState,
          secretFieldNames: ["apiKey"], checksum: checksum(revisionState), activatedAt: now,
        });
      }
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE",
        actorId: nodeId,
        action: "hermes.node.memory_registered",
        resourceType: "ServiceConnection",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { nodeId, observedVersion: input.observedVersion, managedBy: "HermesRuntimeNode" },
      });
      return id;
    });
    await this.connectionTester?.test(connectionId).catch(() => undefined);
    return { accepted: true, connectionId };
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
        await transaction
          .update(serviceConnection)
          .set({ enabled: false, status: "DISABLED" })
          .where(and(
            eq(serviceConnection.slug, `supermemory-node-${current.slug}`.slice(0, 64)),
            eq(serviceConnection.kind, "SUPERMEMORY"),
          ));
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

    const supermemorySlug = `supermemory-node-${current.slug}`.slice(0, 64);
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

      // Only connections this enrollment generated are removed with the node.
      const removedConnections = await transaction
        .delete(serviceConnection)
        .where(or(
          ...(current.serviceConnectionId ? [eq(serviceConnection.id, current.serviceConnectionId)] : []),
          and(eq(serviceConnection.slug, supermemorySlug), eq(serviceConnection.kind, "SUPERMEMORY")),
        ))
        .returning({ id: serviceConnection.id });
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

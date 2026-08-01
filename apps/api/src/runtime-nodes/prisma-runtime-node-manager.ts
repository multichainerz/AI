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
  HermesNodeEnrollmentResult,
  HermesNodeHeartbeat,
  HermesNodeHeartbeatResult,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  RegisterHermesNodeMemory,
  RegisterHermesNodeMemoryResult,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import { EnvelopeEncryption } from "@aihub/security";
import type { AdminPrincipal } from "../auth/admin-session.js";
import type { ConnectionTestService } from "../connections/diagnostics/connection-test-service.js";
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeConflictError,
  RuntimeNodeEnrollmentError,
  RuntimeNodeNotFoundError,
  type HermesRuntimeNodeManager,
  type NodeSignatureHeaders,
} from "./runtime-node-manager.js";

const SIGNATURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const NONCE_RETENTION_MS = 24 * 60 * 60 * 1_000;
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
  const status = ["ONLINE", "DEGRADED"].includes(node.status) && (!node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 180_000)
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

export class PrismaHermesRuntimeNodeManager implements HermesRuntimeNodeManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly encryption: EnvelopeEncryption,
    private readonly connectionTester?: ConnectionTestService,
  ) {}

  async list(): Promise<HermesRuntimeNode[]> {
    const nodes = await this.prisma.hermesRuntimeNode.findMany({
      include: { serviceConnection: { select: { status: true } } },
      orderBy: [{ displayName: "asc" }],
    });
    return nodes.map((node) => summarize(node as StoredNode));
  }

  async createInvitation(principal: AdminPrincipal, input: CreateHermesNodeInvitation): Promise<HermesNodeInvitation> {
    const inferenceCount = await this.prisma.serviceConnection.count({
      where: { kind: "VLLM", enabled: true, status: "HEALTHY" },
    });
    if (inferenceCount !== 1) {
      throw new RuntimeNodeConflictError("Configure and test exactly one healthy vLLM connection before enrolling Hermes.");
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digest(token);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);

    try {
      const node = await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.hermesRuntimeNode.findUnique({ where: { slug: input.slug } });
        if (existing?.identityPublicKeyPem || existing?.enrolledAt) {
          throw new RuntimeNodeConflictError(`Hermes node '${input.slug}' is already enrolled.`);
        }
        const pending = existing
          ? await transaction.hermesRuntimeNode.update({
              where: { id: existing.id },
              data: {
                displayName: input.displayName,
                baseUrl: input.baseUrl,
                expectedHostname: input.expectedHostname ?? null,
                revision: { increment: 1 },
              },
            })
          : await transaction.hermesRuntimeNode.create({
              data: {
                slug: input.slug,
                displayName: input.displayName,
                baseUrl: input.baseUrl,
                expectedHostname: input.expectedHostname ?? null,
                createdBy: principal.id,
              },
            });

        await transaction.hermesNodeEnrollment.updateMany({
          where: { nodeId: pending.id, status: "ISSUED" },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
        await transaction.hermesNodeEnrollment.create({
          data: {
            nodeId: pending.id,
            tokenHash,
            controlPlaneUrl: input.controlPlaneUrl.replace(/\/$/, ""),
            expiresAt,
            createdBy: principal.id,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorType: "USER",
            actorId: principal.id,
            action: "hermes.node.invitation-issued",
            resourceType: "HermesRuntimeNode",
            resourceId: pending.id,
            outcome: "SUCCESS",
            metadata: { expiresAt: expiresAt.toISOString(), expectedHostname: input.expectedHostname ?? null },
          },
        });
        return pending;
      });
      return {
        node: summarize(node as StoredNode),
        bundle: {
          format: "aihub-hermes-enrollment/v1",
          nodeId: node.id,
          nodeSlug: node.slug,
          token,
          controlPlaneUrl: input.controlPlaneUrl.replace(/\/$/, ""),
          hermesBaseUrl: input.baseUrl.replace(/\/$/, ""),
          hermesImage: input.hermesImage,
          expiresAt: expiresAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeNodeConflictError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RuntimeNodeConflictError(`Hermes node '${input.slug}' already exists.`);
      }
      throw error;
    }
  }

  async enroll(input: EnrollHermesNode, sourceIp?: string): Promise<HermesNodeEnrollmentResult> {
    const identity = parseIdentity(input.publicKeyPem);
    const tokenHash = digest(input.token);
    const now = new Date();

    const enrolled = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aihub-hermes-primary-runtime', 0))`;
      const enrollment = await transaction.hermesNodeEnrollment.findUnique({
        where: { tokenHash },
        include: { node: true },
      });
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
        await transaction.hermesNodeEnrollment.update({
          where: { id: enrollment.id },
          data: { status: "EXPIRED" },
        });
        return { expired: true as const };
      }
      if (enrollment.node.expectedHostname && enrollment.node.expectedHostname.toLowerCase() !== input.hostname.toLowerCase()) {
        throw new RuntimeNodeEnrollmentError("The runtime hostname does not match the invitation.", "HOSTNAME_MISMATCH");
      }
      const activeRuntime = await transaction.hermesRuntimeNode.findFirst({
        where: { id: { not: input.nodeId }, enrolledAt: { not: null }, status: { not: "REVOKED" } },
        select: { slug: true },
      });
      if (activeRuntime) {
        throw new RuntimeNodeEnrollmentError(`Hermes runtime '${activeRuntime.slug}' is already the active AIHub execution boundary.`, "INVALID");
      }

      const inferenceConnections = await transaction.serviceConnection.findMany({
        where: { kind: "VLLM", enabled: true, status: "HEALTHY" },
        take: 2,
      });
      const inference = inferenceConnections[0];
      const inferenceSettings = inference?.configuration && typeof inference.configuration === "object" && !Array.isArray(inference.configuration)
        ? inference.configuration as Record<string, unknown>
        : {};
      if (inferenceConnections.length !== 1 || !inference?.baseUrl || typeof inferenceSettings.modelAlias !== "string") {
        throw new RuntimeNodeEnrollmentError("Exactly one healthy vLLM route with a model alias is required.", "INVALID");
      }
      const gatewayKey = randomBytes(32).toString("base64url");
      const modelBootstrap = {
        provider: "custom" as const,
        baseUrl: inferenceGatewayBaseUrl(input.controlPlaneUrl),
        modelAlias: inferenceSettings.modelAlias,
        apiKey: gatewayKey,
      };

      const architecture = await transaction.platformArchitectureDecision.findUnique({ where: { id: "global" } });
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
      const connection = await transaction.serviceConnection.create({
        data: {
          id: connectionId,
          slug: connectionSlug,
          displayName: `${enrollment.node.displayName} Hermes`,
          kind: "HERMES",
          environment,
          baseUrl: enrollment.node.baseUrl,
          enabled: true,
          status: "NOT_TESTED",
          configuration,
          secrets: {
            create: [
              { ...encryptedSecretData(connectionId, "apiKey", input.apiKey, this.encryption), createdBy: null },
              { ...encryptedSecretData(connectionId, "inferenceGatewayKey", gatewayKey, this.encryption), createdBy: null },
            ],
          },
          revisions: {
            create: {
              revision: 1,
              configuration: revisionState,
              secretFieldNames: ["apiKey", "inferenceGatewayKey"],
              checksum: checksum(revisionState),
              activatedAt: now,
            },
          },
        },
      });
      await transaction.hermesNodeEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "CONSUMED", consumedAt: now, consumedSourceIp: sourceIp ?? null },
      });
      const updated = await transaction.hermesRuntimeNode.update({
        where: { id: enrollment.nodeId },
        data: {
          hostname: input.hostname,
          identityPublicKeyPem: identity.normalizedPem,
          identityFingerprint: identity.fingerprint,
          hermesVersion: input.hermesVersion,
          installerVersion: input.installerVersion,
          capabilities: input.capabilities,
          serviceConnectionId: connection.id,
          enrolledAt: now,
          revision: { increment: 1 },
        },
      });
      await transaction.auditEvent.createMany({
        data: [
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
            resourceId: connection.id,
            outcome: "SUCCESS",
            metadata: { kind: "HERMES", environment, managedBy: "HermesRuntimeNode" },
          },
        ],
      });
      return { expired: false as const, node: updated, modelBootstrap };
    }).catch((error: unknown) => {
      if (error instanceof RuntimeNodeEnrollmentError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
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
    const node = await this.prisma.hermesRuntimeNode.findUnique({ where: { id: nodeId } });
    if (!node?.identityPublicKeyPem || node.status === "REVOKED" || node.status === "SUSPENDED") {
      throw new RuntimeNodeAuthenticationError();
    }
    verifyNodeRequestSignature(node.identityPublicKeyPem, headers, body);
    try {
      await this.prisma.hermesNodeRequestNonce.create({ data: { nodeId, nonce } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new RuntimeNodeAuthenticationError("The runtime node request was replayed.");
      }
      throw error;
    }
    void this.prisma.hermesNodeRequestNonce.deleteMany({
      where: { receivedAt: { lt: new Date(Date.now() - NONCE_RETENTION_MS) } },
    }).catch(() => undefined);
    return node;
  }

  async heartbeat(nodeId: string, headers: NodeSignatureHeaders, input: HermesNodeHeartbeat): Promise<HermesNodeHeartbeatResult> {
    const current = await this.authenticate(nodeId, headers, input);
    const effectiveStatus = current.status === "DRAINING" ? "DRAINING" : input.status;
    const receivedAt = new Date();
    await this.prisma.hermesRuntimeNode.update({
      where: { id: nodeId },
      data: {
        status: effectiveStatus,
        hermesVersion: input.hermesVersion,
        capabilities: input.capabilities,
        // Availability is based on control-plane receipt time. A skewed or
        // malicious node clock must not keep a dead runtime looking online.
        lastSeenAt: receivedAt,
        revision: { increment: 1 },
      },
    });
    return { accepted: true, serverTime: receivedAt.toISOString() };
  }

  async registerMemory(
    nodeId: string,
    headers: NodeSignatureHeaders,
    input: RegisterHermesNodeMemory,
  ): Promise<RegisterHermesNodeMemoryResult> {
    const node = await this.authenticate(nodeId, headers, input);
    const hermesConnection = node.serviceConnectionId
      ? await this.prisma.serviceConnection.findUnique({ where: { id: node.serviceConnectionId }, select: { baseUrl: true } })
      : null;
    if (!hermesConnection?.baseUrl) {
      throw new RuntimeNodeConflictError("The enrolled Hermes route is unavailable for memory registration.");
    }
    const hermesUrl = new URL(hermesConnection.baseUrl);
    const memoryUrl = new URL(input.baseUrl);
    if (memoryUrl.hostname !== hermesUrl.hostname || memoryUrl.port !== "6767") {
      throw new RuntimeNodeConflictError("Supermemory must be registered on the enrolled Hermes host at TCP 6767.");
    }
    const architecture = await this.prisma.platformArchitectureDecision.findUnique({ where: { id: "global" } });
    const environment = connectionEnvironment(architecture?.targetEnvironment ?? "DEVELOPMENT");
    const slug = `supermemory-node-${node.slug}`.slice(0, 64);
    const now = new Date();
    const connectionId = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-supermemory-node:${nodeId}`}, 0))`;
      const existing = await transaction.serviceConnection.findUnique({ where: { slug } });
      if (existing && existing.kind !== "SUPERMEMORY") {
        throw new RuntimeNodeConflictError("The managed Supermemory connection slug is already used by another service kind.");
      }
      const id = existing?.id ?? randomUUID();
      const configuration = {
        timeoutMs: 8_000,
        healthPath: "/health",
        documentsPath: "/v3/documents",
        searchPath: "/v3/search",
        memoryTimeoutMs: 300_000,
        memoryPollIntervalMs: 2_000,
        retrievalLimit: 6,
        retrievalThreshold: 0.25,
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
        await transaction.secretRecord.updateMany({
          where: { serviceConnectionId: id, fieldName: "apiKey", active: true },
          data: { active: false, retiredAt: now },
        });
        await transaction.secretRecord.create({
          data: { ...encryptedSecretData(id, "apiKey", input.apiKey, this.encryption), serviceConnectionId: id, createdBy: null },
        });
        await transaction.serviceConnection.update({
          where: { id },
          data: { baseUrl: input.baseUrl, enabled: true, status: "NOT_TESTED", environment, configuration, activeRevision: revision },
        });
        await transaction.configurationRevision.create({
          data: { serviceConnectionId: id, revision, configuration: revisionState, secretFieldNames: ["apiKey"], checksum: checksum(revisionState), activatedAt: now },
        });
      } else {
        await transaction.serviceConnection.create({ data: {
          id,
          slug,
          displayName: `${node.displayName} Supermemory`,
          kind: "SUPERMEMORY",
          environment,
          baseUrl: input.baseUrl,
          enabled: true,
          status: "NOT_TESTED",
          configuration,
          secrets: { create: { ...encryptedSecretData(id, "apiKey", input.apiKey, this.encryption), createdBy: null } },
          revisions: { create: { revision, configuration: revisionState, secretFieldNames: ["apiKey"], checksum: checksum(revisionState), activatedAt: now } },
        } });
      }
      await transaction.auditEvent.create({ data: {
        actorType: "SERVICE",
        actorId: nodeId,
        action: "hermes.node.memory_registered",
        resourceType: "ServiceConnection",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { nodeId, observedVersion: input.observedVersion, managedBy: "HermesRuntimeNode" },
      } });
      return id;
    });
    await this.connectionTester?.test(connectionId).catch(() => undefined);
    return { accepted: true, connectionId };
  }

  async mutate(principal: AdminPrincipal, nodeId: string, input: MutateHermesRuntimeNode): Promise<HermesRuntimeNode> {
    const current = await this.prisma.hermesRuntimeNode.findUnique({ where: { id: nodeId } });
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
    const result = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.hermesRuntimeNode.updateMany({
        where: { id: nodeId, revision: input.expectedRevision },
        data: {
          status: nextStatus,
          revokedAt: nextStatus === "REVOKED" ? now : null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new RuntimeNodeConflictError("The runtime node changed before this action was applied.");
      if (nextStatus === "REVOKED") {
        await transaction.hermesNodeEnrollment.updateMany({
          where: { nodeId, status: "ISSUED" },
          data: { status: "REVOKED", revokedAt: now },
        });
        if (current.serviceConnectionId) {
          await transaction.serviceConnection.update({
            where: { id: current.serviceConnectionId },
            data: { enabled: false, status: "DISABLED" },
          });
        }
        await transaction.serviceConnection.updateMany({
          where: { slug: `supermemory-node-${current.slug}`.slice(0, 64), kind: "SUPERMEMORY" },
          data: { enabled: false, status: "DISABLED" },
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: principal.id,
          action: `hermes.node.${input.action.toLowerCase()}`,
          resourceType: "HermesRuntimeNode",
          resourceId: nodeId,
          outcome: "SUCCESS",
          metadata: { reason: input.reason, previousStatus: current.status, nextStatus },
        },
      });
      return transaction.hermesRuntimeNode.findUniqueOrThrow({ where: { id: nodeId } });
    });
    return summarize(result as StoredNode);
  }
}

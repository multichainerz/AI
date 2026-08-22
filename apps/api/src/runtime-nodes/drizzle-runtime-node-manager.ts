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
import { DEFAULT_HERMES_COMMIT, hermesNodeUnitSchema } from "@orcasynapse/contracts";
import {
  auditEvent,
  configurationRevision,
  controlPlaneSigningKey,
  hermesNodeEnrollment,
  hermesNodeRequestNonce,
  hermesRuntimeNode,
  localAdministrator,
  modelDeployment,
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

/**
 * What a newly enrolled node is allowed to run before an operator says anything.
 *
 * The same names the installer writes into managed scope
 * (`platform_toolsets: api_server: [memory, file]`), stated here because the
 * dashboard and the node have to agree on the starting position: the reconciler
 * computes what to suppress as everything-minus-admitted, so an admission set
 * wider than this one silently empties that suppression list.
 *
 * `memory` is the built-in the runbook names. `file` is native read/write/patch
 * so a Session upload materialized under `artifacts/<session>/inbox/` can be
 * edited on the node. MCP discovery is on until an operator admits `no_mcp`
 * under Agents → Tools; that sentinel is not a baseline capability.
 *
 * Widening native toolsets past this set is a product decision, not a
 * deployment one. An operator widens their own deployment through the
 * admission screen, which is the recorded, audited path this seeding
 * deliberately does not replace.
 */
const BASELINE_ADMITTED_TOOLSETS = ["memory", "file"] as const;

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
  units: unknown;
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
  uniqueHealthyInference: boolean;
};

type InferenceSeedCandidate = {
  id: string;
  baseUrl: string | null;
};

type DefaultAgentRoute = {
  modelAlias: string;
  connectionId: string;
};

export function seedableInferenceModelAlias(
  connections: readonly InferenceSeedCandidate[],
  defaultAgentRoutes: readonly DefaultAgentRoute[],
): string | null {
  if (connections.length !== 1 || !connections[0]?.baseUrl) return null;
  if (defaultAgentRoutes.length !== 1) return null;
  const connection = connections[0]!;
  const route = defaultAgentRoutes[0]!;
  if (route.connectionId !== connection.id) return null;
  const alias = route.modelAlias.trim();
  return alias.length > 0 ? alias : null;
}

async function activeDefaultAgentRoutes(
  executor: { select: OrcaSynapseDatabase["select"] },
): Promise<DefaultAgentRoute[]> {
  return executor
    .select({
      modelAlias: modelDeployment.modelAlias,
      connectionId: modelDeployment.connectionId,
    })
    .from(modelDeployment)
    .where(and(
      eq(modelDeployment.workload, "AGENT"),
      eq(modelDeployment.status, "ACTIVE"),
      eq(modelDeployment.isDefault, true),
    ))
    .limit(2);
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

/**
 * A value usable as a Hermes pin, or null.
 *
 * Both inputs it guards are free text: the enrollment column is `text`, and a
 * node reports `hermesVersion` as whatever `git rev-parse` gave it — "unknown"
 * when it could not resolve one. Anything that is not a full commit is not an
 * installable target, and passing it on would put a value in the signed
 * document that the node is required to refuse.
 */
function installableCommit(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

/**
 * The units column, validated rather than trusted.
 *
 * Null for a node that has never reported them, and null again for a column
 * holding anything this release cannot read. Both are "unknown", which is the
 * honest answer and the one the dashboard renders differently from "healthy" —
 * whereas an empty array would claim the node has no units at all.
 */
function storedUnits(value: unknown): HermesRuntimeNode["units"] {
  if (!Array.isArray(value)) return null;
  // The contract schema's own array(), rather than importing zod here: this
  // package does not depend on zod directly and should not start doing so.
  const parsed = hermesNodeUnitSchema.array().max(16).safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * @param expectedHermesCommit the commit the control plane recorded for this
 * node. Required rather than defaulted: every caller knows the answer or can
 * look it up, and a default of null would quietly report "no target recorded"
 * for a node that has one.
 */
function summarize(
  node: StoredNode,
  expectedHermesCommit: string | null,
  controlPlaneUrl: string | null = null,
): HermesRuntimeNode {
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
    expectedHermesCommit: installableCommit(expectedHermesCommit),
    installerVersion: node.installerVersion,
    capabilities,
    units: storedUnits(node.units),
    serviceConnectionId: node.serviceConnectionId,
    serviceConnectionStatus: node.serviceConnection?.status ?? null,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    enrolledAt: node.enrolledAt?.toISOString() ?? null,
    revokedAt: node.revokedAt?.toISOString() ?? null,
    revision: node.revision,
    controlPlaneUrl,
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

/**
 * An RFC 1918 address, by literal IP only — never by name, because a private
 * name is a DNS answer and DNS is exactly what an attacker on the path
 * controls. The allowance exists for control planes behind a tunnel or
 * Zero Trust front: the public origin demands an identity no machine has, so
 * VM2's channel has to run direct over the private network — where the public
 * scheme cannot follow, because the TLS terminator lives at the edge.
 */
function isPrivateNetworkOrigin(url: string | null): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return /^10(?:\.\d{1,3}){3}$/.test(hostname)
      || /^192\.168(?:\.\d{1,3}){2}$/.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(hostname);
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
  /*
   * Private-network HTTP is allowed below PRODUCTION, for control planes
   * behind a tunnel or Zero Trust front: their public origin refuses every
   * machine, so the node channel has to run direct on the LAN, and the LAN
   * has no TLS terminator. The MITM trade is real and stated in the wizard —
   * whoever can rewrite this LAN's traffic during enrollment can root VM2 —
   * which is why PRODUCTION still refuses it: production either terminates
   * TLS somewhere the machines can reach, or does not enroll.
   */
  if (
    !isLoopbackOrigin(artifacts.controlPlaneUrl)
    && !artifacts.controlPlaneUrl?.startsWith("https://")
    && !(target !== "PRODUCTION" && isPrivateNetworkOrigin(artifacts.controlPlaneUrl))
  ) {
    return target === "PRODUCTION"
      ? "Agentic System enrollment requires an HTTPS OrcaSynapse origin, or a loopback address for a single-machine install."
      : "Agentic System enrollment requires an HTTPS OrcaSynapse origin, a loopback address, or a private-network IP address (10.x, 192.168.x, 172.16–31.x) for a tunnel-fronted control plane.";
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

  /**
   * Seeds the approved baseline into `RuntimeToolsetAdmission` at enrolment.
   *
   * A fresh deployment had an empty table, and the seeded default tool set
   * tracks admission rather than listing members -- so "every toolset this
   * deployment admits" resolved to none, and an operator had to admit something
   * by hand before the agent could do anything at all. Enrolment is the first
   * moment there is anything to say.
   *
   * **The baseline, not the catalogue.** This used to admit every name the
   * newly enrolled runtime reported, which inverted the product's stated
   * posture: `docs/CURRENT_STATE_HANDOFF.md` invariant 7 is "native toolsets are
   * default-deny except built-in memory and explicit operator admissions", and
   * step 7 of the enrolment runbook promises "admitting only the built-in
   * `memory` tool" while disabling every other unapproved native toolset.
   * MCP discovery is left on; admitting `no_mcp` later is how an operator
   * pins it off. Reading the catalogue could not deliver that on two counts.
   *
   * The first is ordering: enrolment happens before the installer writes the
   * managed policy, so the catalogue read is of *stock* Hermes with its broad
   * default preset. The second is worse and independent of ordering --
   * `/v1/toolsets` is the complete registry with a per-toolset `enabled` flag,
   * and the reader interface typed that flag away, so the insert admitted on
   * name alone. Enrolment therefore allowlisted every toolset the runtime merely
   * *knew about*. Those admissions then flowed back out through `desiredState`
   * into the node reconciler, which computes `disabled_toolsets` as everything
   * minus admitted -- empty -- and so wrote no suppression block at all, one step
   * after the restrictive policy had been written. The install ended wide open
   * and reported success.
   *
   * Seeding a constant removes the ordering question rather than answering it,
   * and cannot be widened by what a node happens to report.
   *
   * **Existing decisions are never overwritten.** `onConflictDoNothing` is the
   * whole safety of this: re-enrolling a node -- which is how an upgrade is
   * performed -- must not silently re-admit a toolset an operator deliberately
   * revoked, nor re-deny one they admitted. Only names with no row yet are
   * written.
   *
   * Drift detection survives unchanged. Admission stays a recorded decision per
   * toolset, so a toolset that appears on the node after enrolment still has no
   * row, is still unadmitted, and still fails the boundary assertion.
   */
  private async admitBaselineToolsets(nodeId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const admitted = await transaction
        .insert(runtimeToolsetAdmission)
        .values(BASELINE_ADMITTED_TOOLSETS.map((toolsetName) => ({
          toolsetName,
          admitted: true,
          reason: "The approved baseline, admitted when the Agentic System node enrolled.",
        })))
        .onConflictDoNothing({ target: runtimeToolsetAdmission.toolsetName })
        .returning({ toolsetName: runtimeToolsetAdmission.toolsetName });
      if (admitted.length === 0) return;
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE",
        action: "tool.toolset_admitted_on_enrollment",
        resourceType: "HermesRuntimeNode",
        resourceId: nodeId,
        outcome: "SUCCESS",
        metadata: { toolsets: admitted.map(({ toolsetName }) => toolsetName) },
      });
    });
  }

  async list(): Promise<HermesRuntimeNode[]> {
    // A node that stopped reporting must not keep presenting as available.
    const offlined = await this.database
      .update(hermesRuntimeNode)
      .set({ status: "OFFLINE", revision: increment(hermesRuntimeNode.revision) })
      .where(and(
        inArray(hermesRuntimeNode.status, ["ONLINE", "DEGRADED"]),
        or(
          isNull(hermesRuntimeNode.lastSeenAt),
          lt(hermesRuntimeNode.lastSeenAt, new Date(Date.now() - NODE_STALE_AFTER_MS)),
        ),
      ))
      .returning({ id: hermesRuntimeNode.id, slug: hermesRuntimeNode.slug });
    if (offlined.length > 0) {
      await this.database.insert(auditEvent).values(offlined.map((node) => ({
        actorType: "SERVICE" as const,
        action: "hermes.node.marked_offline",
        resourceType: "HermesRuntimeNode",
        resourceId: node.id,
        outcome: "FAILURE",
        metadata: { slug: node.slug, reason: "heartbeat-stale" },
      })));
    }
    const nodes = await this.database
      .select({ node: hermesRuntimeNode, connectionStatus: serviceConnection.status })
      .from(hermesRuntimeNode)
      .leftJoin(serviceConnection, eq(hermesRuntimeNode.serviceConnectionId, serviceConnection.id))
      .orderBy(asc(hermesRuntimeNode.displayName));
    const ids = nodes.map(({ node }) => node.id);
    const [pins, origins] = await Promise.all([
      this.recordedHermesCommits(ids),
      this.recordedControlPlaneUrls(ids),
    ]);
    return nodes.map(({ node, connectionStatus }) =>
      summarize(
        { ...node, serviceConnection: connectionStatus ? { status: connectionStatus } : null } as StoredNode,
        pins.get(node.id) ?? null,
        origins.get(node.id) ?? null,
      ));
  }

  /**
   * The Hermes commit each of these nodes was pinned to, from its enrolment.
   *
   * One implementation for two callers on purpose. `desiredState` tells the
   * node what to run and `list` tells the dashboard what to expect; if they
   * read the pin differently the screen would report drift the node was never
   * asked to close, or hide drift it was.
   *
   * Read ascending and overwritten as it goes, so the newest row for a node
   * wins. A node has one enrolment that matters — `createInvitation` refuses to
   * issue a second claim for an enrolled node, and an unenrolled one has no
   * identity to authenticate with — but ordering makes that an observation
   * rather than an assumption.
   */
  private async recordedHermesCommits(nodeIds: string[]): Promise<Map<string, string>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await this.database
      .select({ nodeId: hermesNodeEnrollment.nodeId, hermesCommit: hermesNodeEnrollment.hermesCommit })
      .from(hermesNodeEnrollment)
      .where(and(
        inArray(hermesNodeEnrollment.nodeId, nodeIds),
        isNotNull(hermesNodeEnrollment.hermesCommit),
      ))
      .orderBy(asc(hermesNodeEnrollment.createdAt), asc(hermesNodeEnrollment.id));
    const pins = new Map<string, string>();
    for (const row of rows) {
      const commit = installableCommit(row.hermesCommit);
      if (commit) pins.set(row.nodeId, commit);
    }
    return pins;
  }

  /**
   * The origin each node was told to call back on.
   *
   * Same newest-row-wins read as the Hermes pin: the repair command has to
   * use this, not the browser origin, or a Zero Trust dashboard prints a
   * hostname the node cannot reach.
   */
  private async recordedControlPlaneUrls(nodeIds: string[]): Promise<Map<string, string>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await this.database
      .select({ nodeId: hermesNodeEnrollment.nodeId, controlPlaneUrl: hermesNodeEnrollment.controlPlaneUrl })
      .from(hermesNodeEnrollment)
      .where(and(
        inArray(hermesNodeEnrollment.nodeId, nodeIds),
        isNotNull(hermesNodeEnrollment.controlPlaneUrl),
      ))
      .orderBy(asc(hermesNodeEnrollment.createdAt), asc(hermesNodeEnrollment.id));
    const urls = new Map<string, string>();
    for (const row of rows) {
      if (row.controlPlaneUrl) urls.set(row.nodeId, row.controlPlaneUrl);
    }
    return urls;
  }

  private async runtimePrerequisites(): Promise<RuntimePrerequisites> {
    const [administrators, inferenceConnections, defaultAgentRoutes] = await Promise.all([
      this.database
        .select({ total: count() })
        .from(localAdministrator)
        .where(and(
          isNull(localAdministrator.disabledAt),
          eq(localAdministrator.passwordChangeRequired, false),
        )),
      this.database
        .select({ id: serviceConnection.id, baseUrl: serviceConnection.baseUrl })
        .from(serviceConnection)
        .where(and(
          eq(serviceConnection.kind, "INFERENCE"),
          eq(serviceConnection.enabled, true),
          eq(serviceConnection.status, "HEALTHY"),
        ))
        .limit(2),
      activeDefaultAgentRoutes(this.database),
    ]);
    const uniqueHealthyInference = inferenceConnections.length === 1 && Boolean(inferenceConnections[0]?.baseUrl);
    return {
      dashboardReady: (administrators[0]?.total ?? 0) > 0,
      uniqueHealthyInference,
      inferenceReady: seedableInferenceModelAlias(inferenceConnections, defaultAgentRoutes) !== null,
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
      dashboardReady: prerequisites.dashboardReady,
      inferenceReady: prerequisites.inferenceReady,
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
    if (!prerequisites.uniqueHealthyInference) {
      throw new RuntimeNodeConflictError("Configure and test exactly one healthy AI Inference route before enrolling Hermes.");
    }
    if (!prerequisites.inferenceReady) {
      throw new RuntimeNodeConflictError("Activate a default Agent model on Gateway → Models.");
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
        node: summarize(node as StoredNode, input.hermesCommit, input.controlPlaneUrl.replace(/\/$/, "")),
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
        .select({ id: serviceConnection.id, baseUrl: serviceConnection.baseUrl })
        .from(serviceConnection)
        .where(and(
          eq(serviceConnection.kind, "INFERENCE"),
          eq(serviceConnection.enabled, true),
          eq(serviceConnection.status, "HEALTHY"),
        ))
        .limit(2);
      const defaultAgentRoutes = await activeDefaultAgentRoutes(transaction);
      const modelAlias = seedableInferenceModelAlias(inferenceConnections, defaultAgentRoutes);
      if (!modelAlias) {
        throw new RuntimeNodeEnrollmentError(
          inferenceConnections.length === 1 && inferenceConnections[0]?.baseUrl
            ? "Activate a default Agent model on Gateway → Models."
            : "Exactly one healthy inference server route is required.",
          "INVALID",
        );
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
      return {
        expired: false as const,
        node: updated,
        modelBootstrap,
        hermesCommit: enrollment.hermesCommit,
        controlPlaneUrl: enrollment.controlPlaneUrl,
      };
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
    /*
     * Swallowed like the connection test above, and for the same reason: the
     * node is enrolled by this point, and failing the response would leave the
     * installer reporting a failure for a node that is actually registered.
     * A seed that did not land leaves the admissions empty, which is the
     * restrictive answer -- an operator admits by hand -- rather than a broken
     * enrolment.
     */
    await this.admitBaselineToolsets(enrolled.node.id).catch(() => undefined);
    const { publicKeyPem } = await this.controlPlanePublicKey();
    return {
      node: summarize(enrolled.node as StoredNode, enrolled.hermesCommit, enrolled.controlPlaneUrl),
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
    const node = await this.authenticate(
      nodeId,
      { method: "GET", path: `/api/v1/runtime-nodes/${nodeId}/desired-state` },
      headers,
      null,
    );
    const [admissions, pins] = await Promise.all([
      this.database
        .select({ toolsetName: runtimeToolsetAdmission.toolsetName })
        .from(runtimeToolsetAdmission)
        .where(eq(runtimeToolsetAdmission.admitted, true))
        .orderBy(asc(runtimeToolsetAdmission.toolsetName)),
      this.recordedHermesCommits([nodeId]),
    ]);
    const document: RuntimeDesiredStateDocument = {
      format: "orcasynapse-runtime-desired-state/v1",
      nodeId,
      generatedAt: new Date().toISOString(),
      admittedToolsets: admissions.map((row) => row.toolsetName),
      /*
       * This node's own recorded target, in preference order.
       *
       * A node deliberately pinned at enrolment must not be moved by a global
       * constant, so the enrolment pin comes first. Enrolments predating that
       * column have none; echoing what the node last reported running is the
       * one answer that is guaranteed to be a no-op for it, which is the right
       * default when the control plane has no target of its own to state.
       * `DEFAULT_HERMES_COMMIT` is the last resort, reached only by a node that
       * never resolved a commit to report either — the document must still
       * carry an installable one, because an absent instruction and a real one
       * must not be confusable.
       *
       * This is a Hermes commit. `PlatformReleaseTarget.desiredCommit` is a
       * commit of OrcaSynapse itself and must never be read here.
       */
      hermesCommit: pins.get(nodeId)
        ?? installableCommit(node.hermesVersion)
        ?? DEFAULT_HERMES_COMMIT,
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
        /*
         * Only when the node sent them. A node whose installer predates the
         * field omits it, and writing null on every one of its beats would
         * overwrite nothing with nothing forever -- harmless, but it would also
         * mean a node that reported once and then downgraded kept its stale
         * list. Absent stays absent; reported replaces.
         */
        ...(input.units ? { units: input.units } : {}),
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
    const [pins, origins] = await Promise.all([
      this.recordedHermesCommits([nodeId]),
      this.recordedControlPlaneUrls([nodeId]),
    ]);
    return summarize(result as StoredNode, pins.get(nodeId) ?? null, origins.get(nodeId) ?? null);
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

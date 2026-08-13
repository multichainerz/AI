import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  CreateHermesCorpusMutation,
  DecideHermesCorpusMutation,
  HermesCorpusDesiredStateDocument,
  HermesCorpusEntry,
  HermesCorpusMutation,
  HermesCorpusMutationResult,
  HermesCorpusOverview,
  HermesCorpusRevision,
  HermesCorpusSignedDesiredState,
  HermesCorpusSnapshotReceipt,
  HermesCorpusSnapshotUpload,
} from "@orcasynapse/contracts";
import {
  auditEvent,
  hermesCorpusEntry,
  hermesCorpusMutation,
  hermesCorpusRevision,
  hermesCorpusSnapshot,
  hermesRuntimeNode,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, desc, eq, gte, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, isUniqueViolation } from "../database-support.js";
import type { NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";
import type { DrizzleHermesRuntimeNodeManager } from "../runtime-nodes/drizzle-runtime-node-manager.js";
import {
  CorpusConflictError,
  CorpusNotFoundError,
  CorpusValidationError,
  type HermesCorpusManager,
  type HermesCorpusQuery,
} from "./corpus-manager.js";

const CORPUS_CAPABILITY = "corpus-sync-v1";
const CORPUS_STALE_MS = 3 * 60 * 1_000;
const MUTATION_LEASE_MS = 2 * 60 * 1_000;
const MUTATION_EXPIRY_MS = 10 * 60 * 1_000;
const MEMORY_PATHS = new Set(["memories/MEMORY.md", "memories/USER.md"]);
const SNAPSHOT_ROOTS = new Set(["skills", "skill-bundles", "pending"]);
const DENIED_SNAPSHOT_SEGMENTS = new Set(["__pycache__", ".git", ".venv", ".pytest_cache", "node_modules", "cache"]);
const DENIED_SNAPSHOT_NAMES = new Set([".env", "credentials.json", "auth.json", "state.db", "hermes.db", "id_rsa", "id_ed25519", ".netrc", ".npmrc", ".git-credentials", "pip.conf"]);
const DENIED_SNAPSHOT_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"];
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{20,}/i,
  /AKIA[0-9A-Z]{16}/,
  /bearer\s+[A-Za-z0-9_\-/.+=]{20,}/i,
  /(?:sk-[A-Za-z0-9_-]{20,}|gh[opsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/,
];
const HERMES_SKILL_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HERMES_SKILL_SUPPORT_DIRS = new Set(["references", "templates", "scripts", "assets"]);
const DESTRUCTIVE_OPERATIONS = new Set<CreateHermesCorpusMutation["operation"]>([
  "MEMORY_REMOVE", "SKILL_DELETE", "SKILL_REMOVE_FILE",
]);

type StoredEntry = typeof hermesCorpusEntry.$inferSelect;
type StoredMutation = typeof hermesCorpusMutation.$inferSelect;

function snapshotRoot(entries: HermesCorpusSnapshotUpload["entries"]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")))) {
    hash.update(entry.path, "utf8").update("\0").update(entry.sha256, "ascii").update("\n");
  }
  return hash.digest("hex");
}

function assertSnapshotEntry(entry: HermesCorpusSnapshotUpload["entries"][number]): void {
  const parts = entry.path.split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  const hiddenPath = (name.startsWith(".") && name !== ".bundled_manifest")
    || parts.slice(0, -1).some((part) => part.startsWith(".") && part !== ".hub");
  if (DENIED_SNAPSHOT_NAMES.has(name) || name.startsWith(".env.") || hiddenPath
    || parts.some((part) => DENIED_SNAPSHOT_SEGMENTS.has(part))
    || DENIED_SNAPSHOT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw new CorpusValidationError("The corpus snapshot contains a denied sensitive path.");
  }
  const content = entry.content;
  const structuredText = entry.structuredEntries?.join("\n") ?? "";
  if ((content && SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content)))
    || (structuredText && SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(structuredText)))) {
    throw new CorpusValidationError("The corpus snapshot contains content that should have been redacted on VM2.");
  }
  if (content !== null) {
    if (Buffer.byteLength(content, "utf8") !== Number(entry.sizeBytes)
      || createHash("sha256").update(content, "utf8").digest("hex") !== entry.sha256) {
      throw new CorpusValidationError("The corpus snapshot content does not match its signed file metadata.");
    }
  }
  if (entry.structuredEntries !== null) {
    const parsed = content?.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
      .split("\n§\n").map((value) => value.trim()).filter(Boolean) ?? null;
    if (entry.kind !== "MEMORY" || !parsed || JSON.stringify(parsed) !== JSON.stringify(entry.structuredEntries)) {
      throw new CorpusValidationError("Structured memory entries do not match the mirrored native memory file.");
    }
  }
  if (entry.path.startsWith("memories/")) {
    if (!MEMORY_PATHS.has(entry.path) || entry.kind !== "MEMORY") {
      throw new CorpusValidationError("The corpus snapshot contains an invalid memory entry.");
    }
    return;
  }
  if (!SNAPSHOT_ROOTS.has(parts[0] ?? "")) throw new CorpusValidationError("The corpus snapshot contains a path outside its allowlist.");
  if (parts[0] === "skill-bundles" && (entry.kind !== "SKILL_BUNDLE" || !entry.readOnly)) {
    throw new CorpusValidationError("Skill bundles must be mirrored read-only.");
  }
  if (parts[0] === "pending" && (entry.kind !== "PENDING_CHANGE" || !entry.readOnly)) {
    throw new CorpusValidationError("Pending Hermes changes must be mirrored read-only.");
  }
  if (parts[0] === "skills") {
    const isMain = parts.length >= 3 && parts.at(-1) === "SKILL.md"
      && HERMES_SKILL_SEGMENT.test(parts.at(-2) ?? "");
    const writableMain = isMain && parts.slice(1, -1).every((part) => HERMES_SKILL_SEGMENT.test(part));
    const isProvenance = entry.path.startsWith("skills/.hub/") || entry.path.includes("/.hub/") || name === ".bundled_manifest";
    if (isMain ? !["SKILL", "SKILL_FILE"].includes(entry.kind) : isProvenance ? entry.kind !== "PROVENANCE" || !entry.readOnly : entry.kind !== "SKILL_FILE") {
      throw new CorpusValidationError("The corpus snapshot kind does not match its Skill path.");
    }
    if (entry.kind === "SKILL" && !writableMain && !entry.readOnly) {
      throw new CorpusValidationError("Unsupported Skill locations must be mirrored read-only.");
    }
    if (!isMain && !isProvenance) {
      const writableSupport = skillMainPathCandidates(entry.path).length > 0;
      if (!writableSupport && !entry.readOnly) {
        throw new CorpusValidationError("Unsupported Skill paths must be mirrored read-only.");
      }
    }
  }
}

function assertSnapshotTopology(entries: HermesCorpusSnapshotUpload["entries"]): void {
  const activeSkills = new Set(entries.filter(({ kind }) => kind === "SKILL").map(({ path }) => path));
  for (const entry of entries) {
    if (!entry.path.startsWith("skills/")) continue;
    const mainShaped = entry.path.endsWith("/SKILL.md");
    const observedParents = skillMainPathCandidates(entry.path).filter((path) => activeSkills.has(path));
    if (entry.kind === "SKILL_FILE" && mainShaped && observedParents.length === 0) {
      throw new CorpusValidationError("A nested SKILL.md must belong to an observed parent Skill.");
    }
    if (entry.kind === "SKILL" && observedParents.length > 0) {
      throw new CorpusValidationError("A SKILL.md inside an observed support tree must be classified as a support file.");
    }
    if (entry.kind === "SKILL_FILE" && !entry.readOnly && observedParents.length === 0) {
      throw new CorpusValidationError("Writable Skill support files must belong to an observed parent Skill.");
    }
  }
}

function entrySummary(row: StoredEntry, includeContent = true): HermesCorpusEntry {
  const structuredEntries = Array.isArray(row.structuredEntries)
    ? row.structuredEntries.filter((value): value is string => typeof value === "string")
    : null;
  return {
    id: row.id,
    nodeId: row.nodeId,
    path: row.path,
    kind: row.kind,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    content: includeContent ? row.content : null,
    structuredEntries: includeContent ? structuredEntries : null,
    readOnly: row.readOnly,
    revision: row.revision,
    observedAt: row.observedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

function mutationSummary(row: StoredMutation): HermesCorpusMutation {
  return {
    id: row.id,
    nodeId: row.nodeId,
    operation: row.operation,
    path: row.path,
    expectedHash: row.expectedHash,
    content: row.content,
    oldText: row.oldText,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedBySubject: row.requestedBySubject,
    approvedBy: row.approvedBy,
    approvedBySubject: row.approvedBySubject,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    error: row.error,
    idempotencyKey: row.idempotencyKey,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function skillFrontmatterName(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  const nameLine = /^name\s*:\s*(.*?)\s*$/m.exec(match[1] ?? "");
  if (!nameLine) return null;
  const raw = (nameLine[1] ?? "").trim().split(/\s+#/, 1)[0]!.trim();
  const unquoted = ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1)
    : raw;
  return HERMES_SKILL_SEGMENT.test(unquoted) ? unquoted : null;
}

function skillMainPathCandidates(path: string): string[] {
  const parts = path.split("/");
  const candidates: string[] = [];
  for (let index = 2; index < parts.length - 1; index += 1) {
    if (!HERMES_SKILL_SUPPORT_DIRS.has(parts[index] ?? "")) continue;
    const prefix = parts.slice(1, index);
    const suffix = parts.slice(index + 1);
    if (prefix.length > 0 && prefix.every((part) => HERMES_SKILL_SEGMENT.test(part))
      && suffix.length > 0 && suffix.every((part) => !part.startsWith("."))) {
      candidates.push(`${parts.slice(0, index).join("/")}/SKILL.md`);
    }
  }
  return candidates;
}

function assertMutationPath(input: CreateHermesCorpusMutation): void {
  const content = input.content;
  if (content && SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new CorpusValidationError("Secret-like content cannot be written through the mirrored corpus plane.");
  }
  if (input.operation.startsWith("MEMORY_")) {
    if (!MEMORY_PATHS.has(input.path)) throw new CorpusValidationError("Memory mutations are limited to MEMORY.md and USER.md.");
    return;
  }
  const parts = input.path.split("/");
  if (parts[0] !== "skills") {
    throw new CorpusValidationError("Skill mutations must target a normalized user skill path.");
  }
  const mainFile = parts.length >= 3 && parts.at(-1) === "SKILL.md"
    && parts.slice(1, -1).every((segment) => HERMES_SKILL_SEGMENT.test(segment));
  if (["SKILL_CREATE", "SKILL_EDIT", "SKILL_DELETE"].includes(input.operation) && !mainFile) {
    throw new CorpusValidationError("This operation must target a skill's SKILL.md.");
  }
  if (["SKILL_CREATE", "SKILL_EDIT"].includes(input.operation)
    && skillFrontmatterName(input.content ?? "") !== parts.at(-2)) {
    throw new CorpusValidationError("The SKILL.md frontmatter name must match its repository directory.");
  }
  if (input.operation === "SKILL_CREATE" && ![3, 4].includes(parts.length)) {
    throw new CorpusValidationError("New Skills may use only Hermes's optional single category level.");
  }
  if (["SKILL_WRITE_FILE", "SKILL_REMOVE_FILE"].includes(input.operation)) {
    const fileName = parts.at(-1)?.toLowerCase() ?? "";
    if (skillMainPathCandidates(input.path).length === 0
      || DENIED_SNAPSHOT_NAMES.has(fileName)
      || DENIED_SNAPSHOT_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
      throw new CorpusValidationError("Skill support files must stay in an approved skill subdirectory.");
    }
  }
}

function sameIdempotentMutation(
  existing: StoredMutation,
  principal: AdminPrincipal,
  input: CreateHermesCorpusMutation,
): boolean {
  return existing.nodeId === input.nodeId
    && existing.operation === input.operation
    && existing.path === input.path
    && existing.expectedHash === input.expectedHash
    && existing.content === input.content
    && existing.oldText === input.oldText
    && existing.reason === input.reason
    && existing.requestedBySubject === principal.subject;
}

export class DrizzleHermesCorpusManager implements HermesCorpusManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly nodeTrust: Pick<DrizzleHermesRuntimeNodeManager, "authenticateNodeRequest" | "signNodeDocument">,
  ) {}

  async overview(): Promise<HermesCorpusOverview> {
    const nodes = await this.database.select().from(hermesRuntimeNode).orderBy(asc(hermesRuntimeNode.displayName));
    const summaries = [];
    for (const node of nodes) {
      const [latest] = await this.database.select().from(hermesCorpusSnapshot)
        .where(eq(hermesCorpusSnapshot.nodeId, node.id)).orderBy(desc(hermesCorpusSnapshot.createdAt)).limit(1);
      const capabilities = Array.isArray(node.capabilities) ? node.capabilities : [];
      summaries.push({
        nodeId: node.id,
        nodeSlug: node.slug,
        nodeDisplayName: node.displayName,
        available: capabilities.includes(CORPUS_CAPABILITY),
        writable: capabilities.includes(CORPUS_CAPABILITY) && !["REVOKED", "SUSPENDED"].includes(node.status),
        entryCount: latest?.entryCount ?? 0,
        totalBytes: latest?.totalBytes ?? 0,
        rootHash: latest?.rootHash ?? null,
        lastSyncedAt: latest?.createdAt.toISOString() ?? null,
        stale: !latest || Date.now() - latest.createdAt.getTime() > CORPUS_STALE_MS,
      });
    }
    return { nodes: summaries };
  }

  async entries(query: HermesCorpusQuery): Promise<HermesCorpusEntry[]> {
    const conditions = [eq(hermesCorpusEntry.nodeId, query.nodeId)];
    if (!query.includeDeleted) conditions.push(isNull(hermesCorpusEntry.deletedAt));
    if (query.kind) conditions.push(eq(hermesCorpusEntry.kind, query.kind));
    if (query.query?.trim()) {
      const term = query.query.trim();
      const pathMatch = ilike(hermesCorpusEntry.path, `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      conditions.push(query.includeContent
        ? or(
            pathMatch,
            sql`to_tsvector('simple', coalesce(${hermesCorpusEntry.path}, '') || ' ' || coalesce(${hermesCorpusEntry.content}, '')) @@ plainto_tsquery('simple', ${term})`,
          )!
        : pathMatch);
    }
    const rows = await this.database.select().from(hermesCorpusEntry)
      .where(and(...conditions)).orderBy(asc(hermesCorpusEntry.path)).limit(1_000);
    return rows.map((row) => entrySummary(row, query.includeContent));
  }

  async revisions(entryId: string, includeContent: boolean): Promise<HermesCorpusRevision[]> {
    const rows = await this.database.select().from(hermesCorpusRevision)
      .where(eq(hermesCorpusRevision.entryId, entryId)).orderBy(desc(hermesCorpusRevision.revision)).limit(200);
    if (rows.length === 0) {
      const [entry] = await this.database.select({ id: hermesCorpusEntry.id }).from(hermesCorpusEntry)
        .where(eq(hermesCorpusEntry.id, entryId)).limit(1);
      if (!entry) throw new CorpusNotFoundError("The corpus entry does not exist.");
    }
    return rows.map((row) => ({
      id: row.id, nodeId: row.nodeId, path: row.path, revision: row.revision,
      changeKind: row.changeKind as HermesCorpusRevision["changeKind"],
      beforeHash: row.beforeHash, afterHash: row.afterHash,
      beforeContent: includeContent ? row.beforeContent : null,
      afterContent: includeContent ? row.afterContent : null,
      mutationId: row.mutationId, createdAt: row.createdAt.toISOString(),
    }));
  }

  async mutations(nodeId?: string): Promise<HermesCorpusMutation[]> {
    const rows = await this.database.select().from(hermesCorpusMutation)
      .where(nodeId ? eq(hermesCorpusMutation.nodeId, nodeId) : undefined)
      .orderBy(desc(hermesCorpusMutation.requestedAt)).limit(200);
    return rows.map(mutationSummary);
  }

  async createMutation(principal: AdminPrincipal, input: CreateHermesCorpusMutation): Promise<HermesCorpusMutation> {
    assertMutationPath(input);
    const [node] = await this.database.select().from(hermesRuntimeNode)
      .where(eq(hermesRuntimeNode.id, input.nodeId)).limit(1);
    if (!node) throw new CorpusNotFoundError("The Hermes runtime node does not exist.");
    const capabilities = Array.isArray(node.capabilities) ? node.capabilities : [];
    if (!capabilities.includes(CORPUS_CAPABILITY)) throw new CorpusConflictError("This node has not advertised corpus synchronization support.");
    if (["REVOKED", "SUSPENDED"].includes(node.status)) throw new CorpusConflictError("This node cannot accept corpus mutations.");

    if (input.idempotencyKey) {
      const [existing] = await this.database.select().from(hermesCorpusMutation)
        .where(eq(hermesCorpusMutation.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        if (!sameIdempotentMutation(existing, principal, input)) {
          throw new CorpusConflictError("This idempotency key already belongs to a different corpus mutation.");
        }
        return mutationSummary(existing);
      }
    }

    const [current] = await this.database.select().from(hermesCorpusEntry)
      .where(and(eq(hermesCorpusEntry.nodeId, input.nodeId), eq(hermesCorpusEntry.path, input.path), isNull(hermesCorpusEntry.deletedAt))).limit(1);
    if (current?.readOnly) throw new CorpusConflictError("This corpus entry is intentionally mirror-only and cannot be mutated.");
    if (input.operation === "SKILL_CREATE" && current) {
      throw new CorpusConflictError("A corpus entry already exists at this path. Refresh before creating it.");
    }
    if (input.operation === "SKILL_WRITE_FILE" && current && !input.expectedHash) {
      throw new CorpusConflictError("A corpus entry already exists at this path. Refresh before editing it.");
    }
    if (input.expectedHash && current?.sha256 !== input.expectedHash) throw new CorpusConflictError("The corpus entry changed after it was observed. Refresh before editing it.");
    if (!current && !["MEMORY_ADD", "SKILL_CREATE", "SKILL_WRITE_FILE"].includes(input.operation)) throw new CorpusConflictError("The target corpus entry is no longer present.");
    if (input.operation.startsWith("SKILL_")) {
      const activeSkills = await this.database.select({ path: hermesCorpusEntry.path, readOnly: hermesCorpusEntry.readOnly })
        .from(hermesCorpusEntry).where(and(
          eq(hermesCorpusEntry.nodeId, input.nodeId), eq(hermesCorpusEntry.kind, "SKILL"), isNull(hermesCorpusEntry.deletedAt),
        ));
      const requestedName = input.path.split("/").at(-2)!;
      if (input.operation === "SKILL_CREATE") {
        if (activeSkills.some(({ path }) => path.split("/").at(-2) === requestedName)) {
          throw new CorpusConflictError(`A Skill named '${requestedName}' already exists on this Hermes node.`);
        }
      } else {
        const parentPaths = ["SKILL_EDIT", "SKILL_DELETE"].includes(input.operation)
          ? [input.path]
          : skillMainPathCandidates(input.path);
        const parents = activeSkills.filter(({ path }) => parentPaths.includes(path));
        if (parents.length !== 1 || parents[0]!.readOnly) {
          throw new CorpusConflictError("The Skill parent is absent, ambiguous, or intentionally mirror-only.");
        }
        const parentName = parents[0]!.path.split("/").at(-2)!;
        if (activeSkills.filter(({ path }) => path.split("/").at(-2) === parentName).length !== 1) {
          throw new CorpusConflictError(`Hermes has more than one Skill named '${parentName}', so its native mutation target is ambiguous.`);
        }
      }
    }
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const status = DESTRUCTIVE_OPERATIONS.has(input.operation) ? "PENDING_APPROVAL" : "QUEUED";
    try {
      const [created] = await this.database.transaction(async (transaction) => {
        const rows = await transaction.insert(hermesCorpusMutation).values({
          nodeId: input.nodeId, operation: input.operation, path: input.path,
          expectedHash: input.expectedHash,
          content: input.content, oldText: input.oldText, reason: input.reason,
          status, requestedBy: principal.id, requestedBySubject: principal.subject,
          beforeHash: current?.sha256 ?? null, idempotencyKey,
        }).returning();
        const mutation = rows[0]!;
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "HERMES_CORPUS_MUTATION_REQUESTED",
          resourceType: "HermesCorpusMutation", resourceId: mutation.id, outcome: "SUCCESS",
          metadata: { nodeId: input.nodeId, operation: input.operation, path: input.path, status, beforeHash: current?.sha256 ?? null },
        });
        return rows;
      });
      return mutationSummary(created!);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [existing] = await this.database.select().from(hermesCorpusMutation)
        .where(eq(hermesCorpusMutation.idempotencyKey, idempotencyKey)).limit(1);
      if (!existing) throw error;
      if (!sameIdempotentMutation(existing, principal, input)) {
        throw new CorpusConflictError("This idempotency key already belongs to a different corpus mutation.");
      }
      return mutationSummary(existing);
    }
  }

  async decideMutation(principal: AdminPrincipal, mutationId: string, input: DecideHermesCorpusMutation): Promise<HermesCorpusMutation> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`corpus-mutation:${mutationId}`));
      const [current] = await transaction.select().from(hermesCorpusMutation)
        .where(eq(hermesCorpusMutation.id, mutationId)).limit(1);
      if (!current) throw new CorpusNotFoundError("The corpus mutation does not exist.");
      if (current.status !== "PENDING_APPROVAL") throw new CorpusConflictError("This mutation is not awaiting approval.");
      if (input.decision === "APPROVE" && current.requestedBySubject === principal.subject) {
        throw new CorpusConflictError("The requester cannot approve their own destructive mutation.");
      }
      const now = new Date();
      const status = input.decision === "APPROVE" ? "QUEUED" : "REJECTED";
      const [updated] = await transaction.update(hermesCorpusMutation).set({
        status, approvedBy: principal.id, approvedBySubject: principal.subject, approvedAt: now,
        ...(status === "REJECTED" ? { completedAt: now, error: input.reason } : {}),
      }).where(eq(hermesCorpusMutation.id, mutationId)).returning();
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: `HERMES_CORPUS_MUTATION_${input.decision}D`,
        resourceType: "HermesCorpusMutation", resourceId: mutationId, outcome: "SUCCESS",
        metadata: { nodeId: current.nodeId, operation: current.operation, path: current.path, decision: input.decision },
      });
      return mutationSummary(updated!);
    });
  }

  async uploadSnapshot(nodeId: string, headers: NodeSignatureHeaders, input: HermesCorpusSnapshotUpload): Promise<HermesCorpusSnapshotReceipt> {
    await this.nodeTrust.authenticateNodeRequest(nodeId, headers, input);
    if (snapshotRoot(input.entries) !== input.rootHash) throw new CorpusValidationError("The corpus snapshot root hash is invalid.");
    for (const entry of input.entries) assertSnapshotEntry(entry);
    assertSnapshotTopology(input.entries);
    const receivedAt = new Date();
    const observedAt = new Date(input.observedAt);
    const snapshot = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`corpus-snapshot:${nodeId}`));
      const [latest] = await transaction.select({ observedAt: hermesCorpusSnapshot.observedAt })
        .from(hermesCorpusSnapshot).where(eq(hermesCorpusSnapshot.nodeId, nodeId))
        .orderBy(desc(hermesCorpusSnapshot.observedAt)).limit(1);
      if (latest && observedAt < latest.observedAt) {
        throw new CorpusConflictError("This corpus snapshot is older than the node's accepted mirror state.");
      }
      const [created] = await transaction.insert(hermesCorpusSnapshot).values({
        nodeId, rootHash: input.rootHash, observedAt,
        entryCount: input.entries.length,
        totalBytes: input.entries.reduce((total, entry) => total + Number(entry.sizeBytes), 0),
      }).returning();
      const seen: string[] = [];
      for (const incoming of input.entries) {
        seen.push(incoming.path);
        const [existing] = await transaction.select().from(hermesCorpusEntry).where(and(
          eq(hermesCorpusEntry.nodeId, nodeId), eq(hermesCorpusEntry.path, incoming.path),
        )).limit(1);
        if (!existing) {
          const [applied] = await transaction.select({ id: hermesCorpusMutation.id }).from(hermesCorpusMutation).where(and(
            eq(hermesCorpusMutation.nodeId, nodeId),
            eq(hermesCorpusMutation.path, incoming.path),
            eq(hermesCorpusMutation.status, "APPLIED"), eq(hermesCorpusMutation.afterHash, incoming.sha256),
          )).orderBy(desc(hermesCorpusMutation.completedAt)).limit(1);
          const [inserted] = await transaction.insert(hermesCorpusEntry).values({
            nodeId, path: incoming.path, kind: incoming.kind, mediaType: incoming.mediaType,
            sizeBytes: Number(incoming.sizeBytes), sha256: incoming.sha256, content: incoming.content,
            structuredEntries: incoming.structuredEntries, readOnly: incoming.readOnly,
            lastSnapshotId: created!.id, observedAt,
          }).returning();
          await transaction.insert(hermesCorpusRevision).values({
            entryId: inserted!.id, nodeId, path: incoming.path, revision: 1, changeKind: "DISCOVERED",
            afterHash: incoming.sha256, afterContent: incoming.content, mutationId: applied?.id ?? null,
          });
          continue;
        }
        const changed = existing.sha256 !== incoming.sha256 || existing.deletedAt !== null;
        const nextRevision = changed ? existing.revision + 1 : existing.revision;
        await transaction.update(hermesCorpusEntry).set({
          kind: incoming.kind, mediaType: incoming.mediaType, sizeBytes: Number(incoming.sizeBytes),
          sha256: incoming.sha256, content: incoming.content, structuredEntries: incoming.structuredEntries,
          readOnly: incoming.readOnly, revision: nextRevision, lastSnapshotId: created!.id,
          observedAt, deletedAt: null,
        }).where(eq(hermesCorpusEntry.id, existing.id));
        if (changed) {
          const [applied] = await transaction.select({ id: hermesCorpusMutation.id }).from(hermesCorpusMutation).where(and(
            eq(hermesCorpusMutation.nodeId, nodeId), eq(hermesCorpusMutation.path, incoming.path),
            eq(hermesCorpusMutation.status, "APPLIED"), eq(hermesCorpusMutation.afterHash, incoming.sha256),
            gte(hermesCorpusMutation.completedAt, existing.updatedAt),
          )).orderBy(desc(hermesCorpusMutation.completedAt)).limit(1);
          await transaction.insert(hermesCorpusRevision).values({
            entryId: existing.id, nodeId, path: incoming.path, revision: nextRevision,
            changeKind: existing.deletedAt ? "RESTORED" : "CHANGED",
            beforeHash: existing.sha256, afterHash: incoming.sha256,
            beforeContent: existing.content, afterContent: incoming.content, mutationId: applied?.id ?? null,
          });
        }
      }
      const active = await transaction.select().from(hermesCorpusEntry).where(and(
        eq(hermesCorpusEntry.nodeId, nodeId), isNull(hermesCorpusEntry.deletedAt),
      ));
      for (const missing of active.filter((entry) => !seen.includes(entry.path))) {
        const nextRevision = missing.revision + 1;
        const [applied] = await transaction.select({ id: hermesCorpusMutation.id }).from(hermesCorpusMutation).where(and(
          eq(hermesCorpusMutation.nodeId, nodeId), eq(hermesCorpusMutation.path, missing.path),
          eq(hermesCorpusMutation.status, "APPLIED"),
          isNull(hermesCorpusMutation.afterHash),
          gte(hermesCorpusMutation.completedAt, missing.updatedAt),
        )).orderBy(desc(hermesCorpusMutation.completedAt)).limit(1);
        await transaction.update(hermesCorpusEntry).set({
          deletedAt: receivedAt, observedAt, revision: nextRevision, lastSnapshotId: created!.id,
        }).where(eq(hermesCorpusEntry.id, missing.id));
        await transaction.insert(hermesCorpusRevision).values({
          entryId: missing.id, nodeId, path: missing.path, revision: nextRevision,
          changeKind: "DELETED", beforeHash: missing.sha256, beforeContent: missing.content, mutationId: applied?.id ?? null,
        });
      }
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE", action: "HERMES_CORPUS_SNAPSHOT_ACCEPTED", resourceType: "HermesRuntimeNode",
        resourceId: nodeId, outcome: "SUCCESS",
        metadata: { snapshotId: created!.id, rootHash: input.rootHash, entryCount: input.entries.length },
      });
      return created!;
    });
    return { accepted: true, snapshotId: snapshot.id, serverTime: receivedAt.toISOString() };
  }

  async desiredState(nodeId: string, headers: NodeSignatureHeaders): Promise<HermesCorpusSignedDesiredState> {
    await this.nodeTrust.authenticateNodeRequest(nodeId, headers, null);
    const leaseBefore = new Date(Date.now() - MUTATION_LEASE_MS);
    const mutation = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`corpus-dispatch:${nodeId}`));
      const [candidate] = await transaction.select().from(hermesCorpusMutation).where(and(
        eq(hermesCorpusMutation.nodeId, nodeId),
        or(eq(hermesCorpusMutation.status, "QUEUED"), and(eq(hermesCorpusMutation.status, "DISPATCHED"), lt(hermesCorpusMutation.dispatchedAt, leaseBefore)))!,
      )).orderBy(asc(hermesCorpusMutation.requestedAt)).limit(1);
      if (!candidate) return null;
      const now = new Date();
      const [dispatched] = await transaction.update(hermesCorpusMutation).set({ status: "DISPATCHED", dispatchedAt: now })
        .where(eq(hermesCorpusMutation.id, candidate.id)).returning();
      return dispatched!;
    });
    const document: HermesCorpusDesiredStateDocument = {
      format: "orcasynapse-hermes-corpus-desired-state/v1", nodeId, generatedAt: new Date().toISOString(),
      mutation: mutation ? {
        format: "orcasynapse-hermes-corpus-mutation/v1", mutationId: mutation.id, nodeId,
        operation: mutation.operation, path: mutation.path,
        expectedHash: mutation.expectedHash, content: mutation.content, oldText: mutation.oldText,
        expiresAt: new Date(Date.now() + MUTATION_EXPIRY_MS).toISOString(),
      } : null,
    };
    return this.nodeTrust.signNodeDocument(document);
  }

  async completeMutation(nodeId: string, headers: NodeSignatureHeaders, input: HermesCorpusMutationResult): Promise<{ accepted: true; serverTime: string }> {
    await this.nodeTrust.authenticateNodeRequest(nodeId, headers, input);
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`corpus-mutation:${input.mutationId}`));
      const [current] = await transaction.select().from(hermesCorpusMutation).where(and(
        eq(hermesCorpusMutation.id, input.mutationId), eq(hermesCorpusMutation.nodeId, nodeId),
      )).limit(1);
      if (!current) throw new CorpusNotFoundError("The corpus mutation does not exist for this node.");
      if (["APPLIED", "CONFLICT", "FAILED"].includes(current.status)) return;
      if (current.status !== "DISPATCHED") throw new CorpusConflictError("The corpus mutation was not dispatched.");
      if (input.status === "APPLIED" && !["SKILL_DELETE", "SKILL_REMOVE_FILE"].includes(current.operation) && !input.observedHash) {
        throw new CorpusValidationError("Hermes did not return the post-mutation content hash.");
      }
      await transaction.update(hermesCorpusMutation).set({
        status: input.status, afterHash: input.status === "APPLIED" ? input.observedHash : null,
        error: input.status === "APPLIED" ? null : input.message, completedAt: now,
      }).where(eq(hermesCorpusMutation.id, input.mutationId));
      await transaction.insert(auditEvent).values({
        actorType: "SERVICE", action: "HERMES_CORPUS_MUTATION_COMPLETED", resourceType: "HermesCorpusMutation",
        resourceId: input.mutationId, outcome: input.status === "APPLIED" ? "SUCCESS" : "FAILURE",
        metadata: { nodeId, operation: current.operation, path: current.path, status: input.status, observedHash: input.observedHash },
      });
    });
    return { accepted: true, serverTime: now.toISOString() };
  }
}

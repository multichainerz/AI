import { generateDrizzleJson } from "drizzle-kit/api";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "./drizzle/schema.js";

const migrationsRoot = resolve(process.cwd(), "drizzle/migrations");
const migrationFiles = readdirSync(migrationsRoot)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const snapshotFiles = readdirSync(resolve(migrationsRoot, "meta"))
  .filter((name) => name.endsWith("_snapshot.json"))
  .sort();

function snapshot(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(migrationsRoot, "meta", name), "utf8")) as Record<string, unknown>;
}

function journal(): { entries: Array<{ idx: number; tag: string }> } {
  return JSON.parse(readFileSync(resolve(migrationsRoot, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
}

function sql(): string {
  return migrationFiles.map((name) => readFileSync(resolve(migrationsRoot, name), "utf8")).join("\n");
}

describe("committed Drizzle migrations", () => {
  it("keeps every migration an executable, non-empty artifact", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(new Set(migrationFiles).size).toBe(migrationFiles.length);
    for (const name of migrationFiles) {
      expect(readFileSync(resolve(migrationsRoot, name), "utf8").trim().length, name).toBeGreaterThan(0);
    }
  });

  it("keeps the journal consistent with the committed SQL files", () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrationsRoot, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    expect(journal.entries.length).toBe(migrationFiles.length);
    for (const entry of journal.entries) {
      expect(migrationFiles).toContain(`${entry.tag}.sql`);
    }
  });

  it("creates the whole control plane, not a partial schema", () => {
    const statements = sql();
    for (const table of [
      "AgentRun", "AgentProfile", "ChatConversation", "ChatMessage", "Document",
      "ServiceConnection", "SecretRecord", "AuditEvent", "HermesRuntimeNode",
      "GuardrailPolicy", "ModelDeployment", "EnterpriseUser", "WorkerNode",
    ]) {
      expect(statements, table).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("pins retrieval to the approved embedding width and index", () => {
    const statements = sql();
    // The column width is the contract: a substituted model of a different
    // dimension cannot be written at all.
    expect(statements).toContain('"embedding" vector(1024) NOT NULL');
    expect(statements).toContain("USING hnsw");
    expect(statements).toContain("vector_cosine_ops");
  });

  it("indexes chunk text without language-specific stemming", () => {
    // 'simple' keeps Indonesian and English terms indexed literally, so lexical
    // recall does not quietly degrade for non-English content.
    expect(sql()).toContain("to_tsvector('simple'::regconfig, content)");
  });

  it("carries no operator class beyond the one the vector index requires", () => {
    // drizzle-kit misassigned operator classes across multi-column indexes
    // during introspection, producing SQL PostgreSQL rejects outright.
    const explicit = sql().match(/_ops[,)]/g) ?? [];
    const cosine = sql().match(/vector_cosine_ops/g) ?? [];
    expect(explicit.length).toBe(cosine.length);
  });

  it("stores administrator role grants as an enum array rather than an opaque fallback", () => {
    const statements = sql();
    // Introspection could not parse AdministratorRole[] and fell back to
    // bytea[], so the baseline created a column no role value can be written to.
    // PostgreSQL has no bytea-to-enum cast, so the column is replaced outright.
    expect(statements).toContain('ADD COLUMN "allowedAdminRoles" "public"."AdministratorRole"[]');
    expect(statements).toContain('DROP COLUMN "allowedAdminRoles"');
    // The baseline's mistake is the only bytea array the schema may contain.
    expect(statements.match(/"bytea"\[\]/g) ?? []).toHaveLength(1);
  });

  it("defaults array columns to empty rather than a parsed fragment", () => {
    // Introspection rendered ARRAY[]::text[] as '{RAY}', which would have made
    // every new row default to a bogus single-element array.
    expect(sql()).not.toContain("RAY}");
  });
});

/*
 * The snapshot folder is what `drizzle-kit generate` diffs the schema against.
 * It reads exactly one of them -- `preparePrevSnapshot` takes
 * `snapshots[length - 1]` -- so a missing head snapshot is not a cosmetic gap.
 * Generate then believes every change made since that snapshot is still
 * pending, and stops to ask a human whether the adds and drops in between were
 * renames. With no TTY it exits, which is how five releases of hand-authored
 * migrations left `db:generate` unusable.
 *
 * `drizzle-kit check` cannot catch this. It validates the journal and looks for
 * two snapshots claiming the same parent; a snapshot that was never written
 * claims nothing, so check reported "Everything's fine" throughout.
 */
describe("drizzle snapshots", () => {
  const VOLATILE = new Set(["id", "prevId", "_meta"]);

  // id and prevId are freshly random on every serialisation, and _meta records
  // the rename decisions a generate run resolved rather than any schema.
  const comparable = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)));

  const headTag = (): string => {
    const { entries } = journal();
    const head = entries.at(-1);
    if (!head) throw new Error("journal has no entries");
    return `${String(head.idx).padStart(4, "0")}_snapshot.json`;
  };

  it("has a snapshot for the migration at the head of the journal", () => {
    expect(snapshotFiles).toContain(headTag());
  });

  it("keeps the head snapshot equal to what schema.ts serialises to", () => {
    /*
     * The one assertion that makes "the Drizzle schema is the source of truth"
     * enforceable rather than aspirational. Editing schema.ts without running
     * generate, or hand-writing a migration and leaving the snapshot behind,
     * both fail here -- at the point the mistake is cheap, instead of at the
     * next person's `db:generate`.
     */
    expect(comparable(generateDrizzleJson(schema) as Record<string, unknown>))
      .toEqual(comparable(snapshot(headTag())));
  });

  it("chains every snapshot to the one committed before it", () => {
    /*
     * Snapshots 0022-0025 were never written and are not reconstructed here:
     * the states they held are gone, and introspecting them back out of a
     * database would invent detail rather than recover it -- this schema has
     * been burned by introspection twice already, once on operator classes and
     * once on enum arrays. Generate never reads them. So the chain is checked
     * over what exists, which is what would catch a fork or a stale head.
     */
    for (const [index, name] of snapshotFiles.entries()) {
      if (index === 0) continue;
      const previous = snapshotFiles[index - 1]!;
      expect(snapshot(name).prevId, `${name} must follow ${previous}`).toBe(snapshot(previous).id);
    }
  });
});

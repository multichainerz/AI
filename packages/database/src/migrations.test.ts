import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsRoot = resolve(process.cwd(), "drizzle/migrations");
const migrationFiles = readdirSync(migrationsRoot)
  .filter((name) => name.endsWith(".sql"))
  .sort();

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

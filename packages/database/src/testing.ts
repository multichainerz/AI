import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDrizzleClient, type OrcaSynapseDatabase } from "./drizzle/client.js";
import { runMigrations } from "./drizzle/migrate.js";

const DEFAULT_URL = "postgresql://orcasynapse:orcasynapse@127.0.0.1:5432/postgres";

export function testDatabaseUrl(): string {
  return (
    process.env.ORCASYNAPSE_TEST_DATABASE_URL?.trim()
    || process.env.ORCASYNAPSE_INTEGRATION_DATABASE_URL?.trim()
    || DEFAULT_URL
  );
}

export interface TestDatabase {
  database: OrcaSynapseDatabase;
  /** Empties every table without re-running migrations. */
  reset(): Promise<void>;
  /**
   * Releases the database. Give the hook that calls this a real budget.
   *
   * DROP DATABASE forces an immediate checkpoint and waits for it, so what this
   * costs is set by how much the whole cluster has dirtied rather than by how
   * much this one file wrote. A recursive `pnpm test` finishes twenty files at
   * once, their drops queue behind one another's checkpoints, and a call that
   * takes 75ms on an idle machine was measured at up to 10.8s across a
   * concurrent run - straddling Vitest's 10s default, which failed suites on
   * cleanup after every one of their tests had passed. Callers pass the same
   * 120_000 their createTestDatabase hook already passes. The packages that run
   * these suites also declare it centrally in vitest.shared.ts, so a suite
   * written without the annotation still gets the budget rather than leaking
   * the database it provisioned.
   */
  drop(): Promise<void>;
}

function administrativeUrl(url: string): { admin: string; name: string } {
  const parsed = new URL(url);
  const name = `orcasynapse_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  parsed.pathname = "/postgres";
  return { admin: parsed.toString(), name };
}

function namedUrl(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Provisions an isolated, migrated database for one test file.
 *
 * Drizzle's query builder is a fluent chain rather than a flat set of methods,
 * so faking it would mean asserting on the builder's internal shape instead of
 * on behaviour. Running against real PostgreSQL keeps the tests checking what
 * the queries actually do - including the constraints, defaults and cascades
 * that a mock silently ignores.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  const { admin, name } = administrativeUrl(url);

  const adminPool = new Pool({ connectionString: admin });
  try {
    await adminPool.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await adminPool.end();
    throw new Error(
      `Could not create a test database at ${new URL(admin).host}. Start PostgreSQL with pgvector, or set ORCASYNAPSE_TEST_DATABASE_URL. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await adminPool.end();

  const connectionString = namedUrl(url, name);
  await runMigrations(connectionString);
  const { database, close } = createDrizzleClient(connectionString);

  const tables = await database.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const quoted = tables.rows
    .map(({ tablename }) => `"public"."${tablename}"`)
    .filter((table) => !table.includes("__drizzle"))
    .join(", ");

  return {
    database,
    async reset() {
      if (quoted) await database.execute(sql.raw(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`));
    },
    async drop() {
      await close();
      const cleanup = new Pool({ connectionString: admin });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Bare Drizzle client against an existing database, without migrating it. */
export function connectTestDatabase(connectionString: string): {
  database: OrcaSynapseDatabase;
  close: () => Promise<void>;
} {
  const pool = new Pool({ connectionString });
  return { database: drizzle(pool), close: () => pool.end() };
}

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

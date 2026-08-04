import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

/**
 * Resolves the committed migration folder from either the built or the source
 * layout, so the same entry point works in the container and in development.
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "../../drizzle/migrations"),
    resolve(here, "../../../drizzle/migrations"),
    resolve(process.cwd(), "packages/database/drizzle/migrations"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The committed Drizzle migration folder could not be located.");
}

/**
 * Applies every pending migration.
 *
 * pgvector is created first because drizzle-kit does not emit extension
 * statements, and the baseline declares a vector column that cannot be created
 * without it. `IF NOT EXISTS` keeps this safe to run on every start.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const database = drizzle(pool);
    await database.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await migrate(database, { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
}

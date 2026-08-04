import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as tables from "./schema.js";
import * as relations from "./relations.js";

// Relations must be registered alongside tables or db.query.*.with is unavailable,
// which is what replaces Prisma include.
const schema = { ...tables, ...relations };

export type OrcaSynapseDatabase = NodePgDatabase<typeof schema>;

/**
 * Drizzle runs on its own pool rather than borrowing Prisma's adapter, because
 * the two clients are migrated module by module and must be able to shut down
 * independently. Both point at the same PostgreSQL instance and the same tables.
 */
export function createDrizzleClient(connectionString: string): {
  database: OrcaSynapseDatabase;
  close: () => Promise<void>;
} {
  const pool = new Pool({ connectionString });
  return {
    database: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

export { schema };

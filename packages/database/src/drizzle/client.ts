import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

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

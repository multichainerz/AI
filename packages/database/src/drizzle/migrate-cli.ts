import { readBootstrapSecret } from "../bootstrap.js";
import { runMigrations } from "./migrate.js";

/**
 * Container entry point for the migration step. Reads the mounted database
 * secret exactly like the API and worker do, so migrations never take their
 * connection string from the environment.
 */
const connectionString = process.env.ORCASYNAPSE_INTEGRATION_MODE === "1"
  ? (process.env.ORCASYNAPSE_INTEGRATION_DATABASE_URL?.trim() ?? "")
  : readBootstrapSecret("orcasynapse_database_url");

if (!connectionString) {
  console.error("OrcaSynapse migrations require a database connection string.");
  process.exit(1);
}

try {
  await runMigrations(connectionString);
  console.info("OrcaSynapse database migrations are up to date.");
} catch (error) {
  console.error(
    "OrcaSynapse database migrations failed.",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

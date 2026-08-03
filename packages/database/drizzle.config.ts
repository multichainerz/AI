import { defineConfig } from "drizzle-kit";

/**
 * The Drizzle schema is the source of truth. `drizzle-kit generate` writes the
 * SQL under drizzle/migrations, and the runtime migrator applies it. Nothing
 * hand-authors migration SQL.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/drizzle/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url:
      process.env.ORCASYNAPSE_DRIZZLE_DATABASE_URL
      ?? "postgresql://orcasynapse:orcasynapse@localhost:5432/orcasynapse",
  },
});

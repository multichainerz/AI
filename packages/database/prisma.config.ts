import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

function readDatabaseUrl(): string {
  const integrationUrl = process.env.ORCASYNAPSE_INTEGRATION_MODE === "1"
    ? process.env.ORCASYNAPSE_INTEGRATION_DATABASE_URL?.trim()
    : undefined;
  if (integrationUrl) return integrationUrl;

  const candidates = [
    "/run/secrets/orcasynapse_database_url",
    resolve(process.cwd(), ".local/secrets/orcasynapse_database_url"),
    resolve(process.cwd(), "../../.local/secrets/orcasynapse_database_url"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const value = readFileSync(candidate, "utf8").trim();
      if (value.length > 0) return value;
    }
  }

  // This fallback supports local code generation and validation only.
  return "postgresql://orcasynapse:orcasynapse@localhost:5432/orcasynapse";
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: readDatabaseUrl(),
  },
});

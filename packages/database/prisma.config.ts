import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

function readDatabaseUrl(): string {
  const candidates = [
    "/run/secrets/aihub_database_url",
    resolve(process.cwd(), ".local/secrets/aihub_database_url"),
    resolve(process.cwd(), "../../.local/secrets/aihub_database_url"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const value = readFileSync(candidate, "utf8").trim();
      if (value.length > 0) return value;
    }
  }

  // This fallback supports local code generation and validation only.
  return "postgresql://aihub:aihub@localhost:5432/aihub";
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

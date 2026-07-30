import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const configuredUrl = process.env.AIHUB_INTEGRATION_DATABASE_URL?.trim();
if (!configuredUrl) {
  throw new Error("AIHUB_INTEGRATION_DATABASE_URL must point to a disposable PostgreSQL integration database.");
}

const baseUrl = new URL(configuredUrl);
if (!new Set(["postgres:", "postgresql:"]).has(baseUrl.protocol)) {
  throw new Error("AIHUB_INTEGRATION_DATABASE_URL must use PostgreSQL.");
}
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);
if (!localHosts.has(baseUrl.hostname) && process.env.AIHUB_ALLOW_REMOTE_INTEGRATION_DATABASE !== "1") {
  throw new Error("Remote integration databases require AIHUB_ALLOW_REMOTE_INTEGRATION_DATABASE=1.");
}

const schema = `aihub_verify_${Date.now()}_${process.pid}`;
if (!/^aihub_verify_[0-9]+_[0-9]+$/.test(schema)) throw new Error("Generated integration schema is unsafe.");
const administrativeUrl = new URL(baseUrl);
administrativeUrl.searchParams.delete("schema");
const migrationUrl = new URL(baseUrl);
migrationUrl.searchParams.set("schema", schema);
const administrator = new Client({ connectionString: administrativeUrl.toString() });
let verifier;

try {
  await administrator.connect();
  await administrator.query(`CREATE SCHEMA "${schema}"`);

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const migration = spawnSync(pnpm, ["exec", "prisma", "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      AIHUB_INTEGRATION_MODE: "1",
      AIHUB_INTEGRATION_DATABASE_URL: migrationUrl.toString(),
    },
    encoding: "utf8",
  });
  if (migration.stdout) process.stdout.write(migration.stdout);
  if (migration.stderr) process.stderr.write(migration.stderr);
  if (migration.status !== 0) throw new Error(`Prisma migration deployment failed with status ${migration.status ?? "unknown"}.`);

  verifier = new Client({ connectionString: administrativeUrl.toString() });
  await verifier.connect();
  await verifier.query(`SET search_path TO "${schema}"`);
  const migrations = await verifier.query('SELECT COUNT(*)::INTEGER AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
  const canonicalSteps = await verifier.query(`
    SELECT "key", "required"
    FROM "OnboardingStep"
    WHERE "key" = ANY($1::TEXT[])
    ORDER BY "ordinal"
  `, [[
    "claim-installation", "system-topology", "identity-recovery", "ai-services",
    "knowledge-workflow", "hermes-profiles", "guardrails-tools", "validate-activate",
  ]]);
  const legacyProfileStep = await verifier.query('SELECT "required" FROM "OnboardingStep" WHERE "key" = $1', ["profile-setup"]);
  if (migrations.rows[0]?.count < 1) throw new Error("No completed Prisma migrations were recorded.");
  if (canonicalSteps.rowCount !== 8 || canonicalSteps.rows.some((row) => row.required !== true)) {
    throw new Error("The canonical onboarding stages were not migrated correctly.");
  }
  if (legacyProfileStep.rows.some((row) => row.required !== false)) {
    throw new Error("The legacy profile-setup stage remains release-blocking.");
  }
  process.stdout.write(`PostgreSQL integration verification passed in disposable schema ${schema}.\n`);
} finally {
  if (verifier) await verifier.end().catch(() => undefined);
  if (!administrator.ended) {
    await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await administrator.end().catch(() => undefined);
  }
}

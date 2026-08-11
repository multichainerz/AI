import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const configuredUrl = process.env.ORCASYNAPSE_INTEGRATION_DATABASE_URL?.trim();
if (!configuredUrl) {
  throw new Error("ORCASYNAPSE_INTEGRATION_DATABASE_URL must point to a disposable PostgreSQL integration database.");
}

const baseUrl = new URL(configuredUrl);
if (!new Set(["postgres:", "postgresql:"]).has(baseUrl.protocol)) {
  throw new Error("ORCASYNAPSE_INTEGRATION_DATABASE_URL must use PostgreSQL.");
}
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);
if (!localHosts.has(baseUrl.hostname) && process.env.ORCASYNAPSE_ALLOW_REMOTE_INTEGRATION_DATABASE !== "1") {
  throw new Error("Remote integration databases require ORCASYNAPSE_ALLOW_REMOTE_INTEGRATION_DATABASE=1.");
}

// A disposable database rather than a schema: the production migrator targets
// public, so database-scoped isolation exercises the real deployment path.
const databaseName = `orcasynapse_verify_${Date.now()}_${process.pid}`;
if (!/^orcasynapse_verify_[0-9]+_[0-9]+$/.test(databaseName)) throw new Error("Generated integration database name is unsafe.");
const disposableUrl = new URL(baseUrl);
disposableUrl.pathname = `/${databaseName}`;
const legacyDatabaseName = `${databaseName}_legacy`;
if (!/^orcasynapse_verify_[0-9]+_[0-9]+_legacy$/.test(legacyDatabaseName)) {
  throw new Error("Generated legacy integration database name is unsafe.");
}
const legacyUrl = new URL(baseUrl);
legacyUrl.pathname = `/${legacyDatabaseName}`;
const migrateCli = fileURLToPath(new URL("../dist/drizzle/migrate-cli.js", import.meta.url));
const journalPath = fileURLToPath(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url));
const administrator = new Client({ connectionString: baseUrl.toString() });
let verifier;

function deployMigrations(label, targetUrl = disposableUrl, echo = true) {
  // The production entry point, not a reimplementation: compose runs this same
  // file on every stack start.
  const migration = spawnSync(process.execPath, [migrateCli], {
    env: {
      ...process.env,
      ORCASYNAPSE_INTEGRATION_MODE: "1",
      ORCASYNAPSE_INTEGRATION_DATABASE_URL: targetUrl.toString(),
    },
    encoding: "utf8",
  });
  if (echo && migration.stdout) process.stdout.write(migration.stdout);
  if (echo && migration.stderr) process.stderr.write(migration.stderr);
  if (migration.error) {
    throw new Error(`Unable to launch the ${label} migration deployment: ${migration.error.message}`);
  }
  if (migration.status !== 0) {
    const error = new Error(`The ${label} migration deployment failed with status ${migration.status ?? "unknown"}.`);
    error.output = `${migration.stdout ?? ""}\n${migration.stderr ?? ""}`;
    throw error;
  }
}

try {
  await administrator.connect();
  await administrator.query(`CREATE DATABASE "${databaseName}"`);
  await administrator.query(`CREATE DATABASE "${legacyDatabaseName}"`);

  const legacy = new Client({ connectionString: legacyUrl.toString() });
  try {
    await legacy.connect();
    await legacy.query('CREATE TABLE "LegacyControlPlaneState" ("id" integer PRIMARY KEY)');
  } finally {
    await legacy.end().catch(() => undefined);
  }
  try {
    deployMigrations("legacy-schema refusal", legacyUrl, false);
    throw new Error("The greenfield migrator accepted a pre-v3.16.0 database.");
  } catch (error) {
    const output = error && typeof error === "object" && "output" in error ? String(error.output) : "";
    if (!output.includes("requires a fresh installation")) throw error;
  }

  deployMigrations("initial");
  // Compose reruns the migrator on every start, so a second pass must be a
  // clean no-op.
  deployMigrations("repeated");

  verifier = new Client({ connectionString: disposableUrl.toString() });
  await verifier.connect();

  const journalEntries = JSON.parse(readFileSync(journalPath, "utf8")).entries;
  if (!Array.isArray(journalEntries) || journalEntries.length === 0) {
    throw new Error("The Drizzle migration journal is empty or unreadable.");
  }
  const migrations = await verifier.query('SELECT COUNT(*)::INTEGER AS count FROM drizzle."__drizzle_migrations"');
  if (migrations.rows[0]?.count !== journalEntries.length) {
    throw new Error(`Expected ${journalEntries.length} applied migrations, found ${migrations.rows[0]?.count ?? 0}.`);
  }

  const schemaEpoch = await verifier.query(`SELECT "epoch" FROM "SchemaMetadata" WHERE "id" = 'current'`);
  if (schemaEpoch.rows[0]?.epoch !== "hermes-native-v1") {
    throw new Error(`Unexpected schema epoch ${schemaEpoch.rows[0]?.epoch ?? "missing"}.`);
  }
  const vectorExtension = await verifier.query("SELECT COUNT(*)::INTEGER AS count FROM pg_extension WHERE extname = 'vector'");
  if (vectorExtension.rows[0]?.count !== 0) {
    throw new Error("The greenfield schema must not install the vector extension.");
  }
  const forbiddenTables = [
    "Document", "DocumentChunk", "ChatConversationDocument", "AgentMemory", "MemoryPolicy",
    "BenchmarkRun", "BenchmarkSuite", "BenchmarkCase",
  ];
  const retired = await verifier.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [forbiddenTables],
  );
  if (retired.rows.length > 0) {
    throw new Error(`Retired control-plane tables remain: ${retired.rows.map((row) => row.table_name).join(", ")}.`);
  }

  const versionColumns = await verifier.query(`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    WHERE a.attrelid = '"HermesRuntimeNode"'::regclass
      AND a.attname IN ('hermesVersion', 'installerVersion')
  `);
  for (const row of versionColumns.rows) {
    if (row.type !== "character varying(256)") {
      throw new Error(`HermesRuntimeNode.${row.name} is ${row.type}, expected character varying(256).`);
    }
  }
  if (versionColumns.rows.length !== 2) {
    throw new Error("The HermesRuntimeNode version columns were not found.");
  }

  const localAdministratorColumns = await verifier.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'LocalAdministrator'
  `);
  if (!new Set(localAdministratorColumns.rows.map((row) => row.column_name)).has("passwordHash")) {
    throw new Error("The local administrator credential schema was not migrated correctly.");
  }
  const serviceKinds = await verifier.query(`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
    WHERE pg_namespace.nspname = 'public' AND pg_type.typname = 'ServiceKind'
  `);
  const serviceKindLabels = new Set(serviceKinds.rows.map((row) => row.enumlabel));
  if (!serviceKindLabels.has("INFERENCE") || serviceKindLabels.has("VLLM")) {
    throw new Error("The provider-neutral inference service kind was not migrated correctly.");
  }
  // Onboarding stages and component-compatibility rows are seeded at API
  // runtime by the onboarding manager, not by migrations; row-level coverage
  // lives in the apps/api test suite. Here we only prove the relations exist.
  const seededRelations = await verifier.query(`
    SELECT to_regclass('public."OnboardingStep"') AS onboarding, to_regclass('public."ComponentCompatibility"') AS compatibility
  `);
  if (!seededRelations.rows[0]?.onboarding || !seededRelations.rows[0]?.compatibility) {
    throw new Error("The onboarding contract relations were not migrated correctly.");
  }
  process.stdout.write(`PostgreSQL integration verification passed in disposable database ${databaseName}.\n`);
} finally {
  if (verifier) await verifier.end().catch(() => undefined);
  if (!administrator.ended) {
    await administrator.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await administrator.query(`DROP DATABASE IF EXISTS "${legacyDatabaseName}" WITH (FORCE)`).catch(() => undefined);
    await administrator.end().catch(() => undefined);
  }
}

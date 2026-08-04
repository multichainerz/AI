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

// A disposable database rather than a schema: the Drizzle migrator targets
// public and creates the vector extension, so schema-scoped isolation cannot
// exercise the real migration path.
const databaseName = `orcasynapse_verify_${Date.now()}_${process.pid}`;
if (!/^orcasynapse_verify_[0-9]+_[0-9]+$/.test(databaseName)) throw new Error("Generated integration database name is unsafe.");
const disposableUrl = new URL(baseUrl);
disposableUrl.pathname = `/${databaseName}`;
const migrateCli = fileURLToPath(new URL("../dist/drizzle/migrate-cli.js", import.meta.url));
const journalPath = fileURLToPath(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url));
const administrator = new Client({ connectionString: baseUrl.toString() });
let verifier;

function deployMigrations(label) {
  // The production entry point, not a reimplementation: compose runs this same
  // file on every stack start.
  const migration = spawnSync(process.execPath, [migrateCli], {
    env: {
      ...process.env,
      ORCASYNAPSE_INTEGRATION_MODE: "1",
      ORCASYNAPSE_INTEGRATION_DATABASE_URL: disposableUrl.toString(),
    },
    encoding: "utf8",
  });
  if (migration.stdout) process.stdout.write(migration.stdout);
  if (migration.stderr) process.stderr.write(migration.stderr);
  if (migration.error) {
    throw new Error(`Unable to launch the ${label} migration deployment: ${migration.error.message}`);
  }
  if (migration.status !== 0) throw new Error(`The ${label} migration deployment failed with status ${migration.status ?? "unknown"}.`);
}

try {
  await administrator.connect();
  await administrator.query(`CREATE DATABASE "${databaseName}"`);

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

  const vectorExtension = await verifier.query("SELECT COUNT(*)::INTEGER AS count FROM pg_extension WHERE extname = 'vector'");
  if (vectorExtension.rows[0]?.count !== 1) {
    throw new Error("The pgvector extension was not created by the migrator.");
  }
  const embeddingColumn = await verifier.query(`
    SELECT format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    WHERE a.attrelid = '"DocumentChunk"'::regclass AND a.attname = 'embedding'
  `);
  if (embeddingColumn.rows[0]?.type !== "vector(1024)") {
    throw new Error(`DocumentChunk.embedding is ${embeddingColumn.rows[0]?.type ?? "missing"}, expected vector(1024).`);
  }
  const embeddingIndex = await verifier.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'DocumentChunk' AND indexname = 'DocumentChunk_embedding_idx'
  `);
  const indexDefinition = embeddingIndex.rows[0]?.indexdef ?? "";
  if (!indexDefinition.includes("hnsw") || !indexDefinition.includes("vector_cosine_ops")) {
    throw new Error("The DocumentChunk embedding index is not the expected HNSW cosine index.");
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
    await administrator.end().catch(() => undefined);
  }
}

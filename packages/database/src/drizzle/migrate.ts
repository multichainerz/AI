import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export const SCHEMA_EPOCH = "hermes-native-v1";

export function defaultAgentProfileDigest(): string {
  const profile = DEFAULT_AGENT_PROFILE;
  const canonical = {
    displayName: profile.displayName,
    purpose: profile.purpose,
    instructions: profile.instructions,
    soulMd: profile.soulMd,
    skills: [...profile.skills].sort((left, right) =>
      `${left.name}:${left.version}:${left.digest}`.localeCompare(`${right.name}:${right.version}:${right.digest}`)),
    modelAlias: profile.modelAlias,
    maxTurns: profile.maxTurns,
    timeoutSeconds: profile.timeoutSeconds,
    maxConcurrentRuns: profile.maxConcurrentRuns,
    safeMode: profile.safeMode,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

async function seedDefaultAgentProfile(pool: Pool): Promise<void> {
  const profile = DEFAULT_AGENT_PROFILE;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO "AgentProfile" ("slug", "status", "currentVersion", "activeVersion", "updatedAt")
     VALUES ($1, 'ACTIVE', 1, 1, CURRENT_TIMESTAMP)
     ON CONFLICT ("slug") DO NOTHING
     RETURNING "id"`,
    [profile.slug],
  );
  const profileId = inserted.rows[0]?.id ?? (await pool.query<{ id: string }>(
    `SELECT "id" FROM "AgentProfile" WHERE "slug" = $1 LIMIT 1`,
    [profile.slug],
  )).rows[0]?.id;
  if (!profileId) throw new Error("The default Hermes profile could not be resolved.");
  await pool.query(
    `INSERT INTO "AgentProfileVersion" (
       "profileId", "version", "displayName", "purpose", "instructions", "soulMd",
       "skills", "distributionDigest", "modelAlias", "maxTurns", "timeoutSeconds",
       "maxConcurrentRuns", "safeMode"
     ) VALUES ($1, 1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
     ON CONFLICT ("profileId", "version") DO NOTHING`,
    [
      profileId,
      profile.displayName,
      profile.purpose,
      profile.instructions,
      profile.soulMd,
      JSON.stringify(profile.skills),
      defaultAgentProfileDigest(),
      profile.modelAlias,
      profile.maxTurns,
      profile.timeoutSeconds,
      profile.maxConcurrentRuns,
      profile.safeMode,
    ],
  );
}

/** The slugs the seeded defaults own. Exported so tests can name them. */
export const DEFAULT_TOOL_SET_SLUG = "default-tool-set";
export const DEFAULT_SKILL_SET_SLUG = "default-skill-set";

/**
 * Seeds the two default sets and points every set-less profile version at them.
 *
 * ## Why the defaults track rather than snapshot
 *
 * `RuntimeToolsetAdmission` is empty when this runs. It is written only when an
 * operator admits toolsets, and on a fresh install no Hermes node has enrolled
 * to report any. A default set that captured "everything admitted right now"
 * would therefore contain nothing and would read on screen as a profile
 * permitted no tools at all -- the opposite of what a default means. So the
 * seeded rows carry `tracksAdmission` / `tracksRuntime`, and resolve to whatever
 * exists at the moment they are read. A set an operator names by hand lists its
 * members explicitly, which is the point of naming one.
 *
 * This is also the only *safe* default rather than merely the friendly one.
 * Handing Hermes a set narrower than what the node has enabled makes the tool
 * boundary assertion throw and the run fail, so "everything admitted" is the one
 * value that cannot break a fresh install from its own seed.
 *
 * ## Why the backfill lives here and not in the migration
 *
 * Migrations are generated, never hand-authored, and a generated `NOT NULL`
 * foreign key cannot be added ahead of rows that would satisfy it. So `0007`
 * adds both columns nullable and this fills them immediately afterwards, inside
 * the same `runMigrations` call. `ON CONFLICT DO NOTHING` on the sets and a
 * `WHERE ... IS NULL` on the backfill keep it idempotent: an upgrade that has
 * already run does nothing, and a version an operator has since pointed
 * elsewhere is left alone.
 */
async function seedDefaultConfigurationSets(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO "ToolSet" ("slug", "displayName", "description", "tracksAdmission", "updatedAt")
     VALUES ($1, 'Default tool set', 'Every Hermes toolset this deployment admits. Tracks admission rather than a fixed list, so newly admitted toolsets are included automatically.', true, CURRENT_TIMESTAMP)
     ON CONFLICT ("slug") DO NOTHING`,
    [DEFAULT_TOOL_SET_SLUG],
  );
  await pool.query(
    `INSERT INTO "SkillSet" ("slug", "displayName", "description", "tracksRuntime", "updatedAt")
     VALUES ($1, 'Default skill set', 'Every Skill the enrolled Hermes runtime reports. Tracks the runtime rather than a fixed list.', true, CURRENT_TIMESTAMP)
     ON CONFLICT ("slug") DO NOTHING`,
    [DEFAULT_SKILL_SET_SLUG],
  );
  await pool.query(
    `UPDATE "AgentProfileVersion"
     SET "toolSetId" = (SELECT "id" FROM "ToolSet" WHERE "slug" = $1)
     WHERE "toolSetId" IS NULL`,
    [DEFAULT_TOOL_SET_SLUG],
  );
  await pool.query(
    `UPDATE "AgentProfileVersion"
     SET "skillSetId" = (SELECT "id" FROM "SkillSet" WHERE "slug" = $1)
     WHERE "skillSetId" IS NULL`,
    [DEFAULT_SKILL_SET_SLUG],
  );
}

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
 * Applies the greenfield Hermes-native schema.
 *
 * v4.6.0 intentionally starts a new, incompatible schema generation.
 * An existing database without this epoch is rejected before any mutation.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const metadataTable = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public."SchemaMetadata"')::text AS table_name`,
    );
    if (metadataTable.rows[0]?.table_name) {
      const epoch = await pool.query<{ epoch: string }>(
        `SELECT "epoch" FROM "SchemaMetadata" WHERE "id" = 'current' LIMIT 1`,
      );
      if (epoch.rows[0]?.epoch !== SCHEMA_EPOCH) {
        throw new Error(`Unsupported OrcaSynapse database epoch. v4.6.0 requires a fresh installation (${SCHEMA_EPOCH}).`);
      }
    } else {
      const existing = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM pg_tables WHERE schemaname = 'public'`,
      );
      if (Number(existing.rows[0]?.total ?? 0) > 0) {
        throw new Error(`Existing pre-v4.6.0 database detected. This release requires a fresh installation (${SCHEMA_EPOCH}).`);
      }
    }
    const database = drizzle(pool);
    await migrate(database, { migrationsFolder: migrationsFolder() });
    await seedDefaultAgentProfile(pool);
    // After the profile, never before: the backfill claims every version that
    // has no set, and the seeded profile's version must be one of them.
    await seedDefaultConfigurationSets(pool);
    await pool.query(
      `INSERT INTO "SchemaMetadata" ("id", "epoch") VALUES ('current', $1)
       ON CONFLICT ("id") DO UPDATE SET "epoch" = EXCLUDED."epoch"`,
      [SCHEMA_EPOCH],
    );
  } finally {
    await pool.end();
  }
}

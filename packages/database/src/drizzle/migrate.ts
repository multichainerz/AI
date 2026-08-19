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
    /*
     * An empty list, kept in the canonical object deliberately.
     *
     * Approved Skills are gone from the Profile version -- recorded there and
     * delivered to nothing. The key stays because this hash is the seeded
     * default profile's `distributionDigest`, written into every deployment;
     * dropping it would change that digest and make an existing installation's
     * stored value disagree with the one this function derives. It sorted an
     * array that `DEFAULT_AGENT_PROFILE` always declared empty, so the hashed
     * bytes are identical either way.
     */
    skills: [] as never[],
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
       "distributionDigest", "modelAlias", "maxTurns", "timeoutSeconds",
       "maxConcurrentRuns", "safeMode"
     ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ("profileId", "version") DO NOTHING`,
    [
      profileId,
      profile.displayName,
      profile.purpose,
      profile.instructions,
      profile.soulMd,
      defaultAgentProfileDigest(),
      profile.modelAlias,
      profile.maxTurns,
      profile.timeoutSeconds,
      profile.maxConcurrentRuns,
      profile.safeMode,
    ],
  );
}

/**
 * Carries a changed default profile to installs that never customised it.
 *
 * `seedDefaultAgentProfile` is `ON CONFLICT DO NOTHING` on both rows, which is
 * right — it must never overwrite an operator's work — but it means a change to
 * `DEFAULT_AGENT_PROFILE` reaches new installs only. v8.4.0 made that visible:
 * the shipped prompt told the agent to call `remember` and `recall`, tools it
 * cannot reach, and the correction would have stopped at the installs that did
 * not have the problem yet.
 *
 * Version 1 is never rewritten. A version is immutable so a past run can
 * reproduce exactly what it was given, and a prompt edited underneath a
 * completed run would make its transcript unexplainable. This mints version 2
 * instead, which is what editing the profile in the dashboard does.
 *
 * **The guard is `currentVersion = 1`**: editing a profile mints a version, so
 * a profile still on its first has never been touched. Deliberately
 * conservative — an install that has taken ownership keeps what it chose, and
 * the failure mode is an upgrade that does not happen rather than an operator's
 * prompt being replaced.
 *
 * Note for the next time the default changes: this will not fire twice, because
 * an install upgraded here is left on version 2. Carrying a second change needs
 * the digests this project has shipped to be recorded, so "untouched" can be
 * recognised at any version rather than only at the first.
 */
async function upgradeDefaultAgentProfile(pool: Pool): Promise<void> {
  const profile = DEFAULT_AGENT_PROFILE;
  const [existing] = (await pool.query<{ id: string; currentVersion: number; digest: string | null }>(
    `SELECT p."id", p."currentVersion", v."distributionDigest" AS "digest"
       FROM "AgentProfile" p
       LEFT JOIN "AgentProfileVersion" v ON v."profileId" = p."id" AND v."version" = 1
      WHERE p."slug" = $1
      LIMIT 1`,
    [profile.slug],
  )).rows;
  // Absent: the seed above will have created it at the current content.
  // Customised, or already current: nothing to carry.
  if (!existing || existing.currentVersion !== 1) return;
  if (existing.digest === defaultAgentProfileDigest()) return;

  await pool.query(
    `INSERT INTO "AgentProfileVersion" (
       "profileId", "version", "displayName", "purpose", "instructions", "soulMd",
       "distributionDigest", "modelAlias", "maxTurns", "timeoutSeconds",
       "maxConcurrentRuns", "safeMode"
     ) VALUES ($1, 2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ("profileId", "version") DO NOTHING`,
    [
      existing.id, profile.displayName, profile.purpose, profile.instructions, profile.soulMd,
      defaultAgentProfileDigest(), profile.modelAlias,
      profile.maxTurns, profile.timeoutSeconds, profile.maxConcurrentRuns, profile.safeMode,
    ],
  );
  // Activated, not merely created. An operator who never chose a prompt is not
  // choosing to stay on a superseded one, and a version nothing points at would
  // leave the defect in place while looking as though it had been fixed.
  await pool.query(
    `UPDATE "AgentProfile"
        SET "currentVersion" = 2, "activeVersion" = 2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "currentVersion" = 1`,
    [existing.id],
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

/** The group every locally created person carries; grants name it to mean "everyone". */
const LOCAL_PEOPLE_GROUP = "orcasynapse:people";

/**
 * The governed built-in tools, and a grant for every profile version.
 *
 * Permissive on a fresh install, deliberately. An administrator who has just
 * installed this has no basis yet for deciding which agents should remember
 * things; making them configure it first would mean the feature is off for
 * everybody who did not already know it existed. They can narrow it later,
 * which is the direction that requires knowledge rather than the direction that
 * requires guessing.
 *
 * Permissive is also cheap here, because granting these changes no boundary.
 * All are `READ_ONLY`, none acts on the world, and the scope a call reads and
 * writes -- the division for memory, the conversation for attached files --
 * comes from the run authorization rather than the grant, so a wider grant
 * lets more agents use the feature, never lets any agent read another scope's
 * rows. A `CONSEQUENTIAL` tool would be a different decision, and still passes
 * through the human approval inbox at call time regardless.
 */
const BUILT_IN_TOOLS = [
  {
    slug: "remember",
    displayName: "Remember",
    description: "Save a note for this division. Only agents in the same division can read it back.",
    handlerKey: "orcasynapse.memory.remember",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to remember." } },
      required: ["text"],
    },
  },
  {
    slug: "recall",
    displayName: "Recall",
    description: "Search what this division has remembered.",
    handlerKey: "orcasynapse.memory.recall",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to search for. Omit for the most recent." } },
    },
  },
  {
    slug: "read-file",
    displayName: "Read attached file",
    description: "Read a file the user attached to this conversation. Text comes back in pages; a binary file reports its metadata only.",
    handlerKey: "orcasynapse.files.read",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The file's artifactId, as listed under ATTACHED FILES." },
        offset: { type: "number", description: "Character position to continue a long text file from. Omit to start at the beginning." },
      },
      required: ["artifactId"],
    },
  },
] as const;

async function seedBuiltInTools(pool: Pool): Promise<void> {
  for (const tool of BUILT_IN_TOOLS) {
    await pool.query(
      `INSERT INTO "GovernedTool" ("slug", "displayName", "description", "risk", "status", "handlerKey", "inputSchema", "updatedAt")
       VALUES ($1, $2, $3, 'READ_ONLY', 'ACTIVE', $4, $5::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT ("slug") DO NOTHING`,
      [tool.slug, tool.displayName, tool.description, tool.handlerKey, JSON.stringify(tool.inputSchema)],
    );
  }
  /*
   * Grant to every profile version that does not already have one.
   *
   * `WHERE NOT EXISTS` rather than a blanket insert, so an administrator who
   * has deliberately removed a grant does not have it restored on the next
   * upgrade -- the seed opens the door once, it does not keep reopening it.
   */
  await pool.query(
    `INSERT INTO "AgentToolGrant" ("profileVersionId", "toolId", "enabled", "allowedGroups", "allowedAdminRoles", "updatedAt")
     SELECT v."id", t."id", true, ARRAY[$1]::text[],
            ARRAY['PLATFORM_ADMIN','SECURITY_ADMIN','OPERATIONS_ADMIN','AUDITOR']::"AdministratorRole"[],
            CURRENT_TIMESTAMP
       FROM "AgentProfileVersion" v
       CROSS JOIN "GovernedTool" t
      WHERE t."handlerKey" = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "AgentToolGrant" g
           WHERE g."profileVersionId" = v."id" AND g."toolId" = t."id"
        )`,
    [LOCAL_PEOPLE_GROUP, BUILT_IN_TOOLS.map((tool) => tool.handlerKey)],
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
    // After the seed, so a fresh install is already current and this is a no-op
    // there; before the two below, so the version it may mint is claimed by the
    // set backfill and the memory grants like any other.
    await upgradeDefaultAgentProfile(pool);
    // After the profile, never before: the backfill claims every version that
    // has no set, and the seeded profile's version must be one of them.
    await seedDefaultConfigurationSets(pool);
    await seedBuiltInTools(pool);
    await pool.query(
      `INSERT INTO "SchemaMetadata" ("id", "epoch") VALUES ('current', $1)
       ON CONFLICT ("id") DO UPDATE SET "epoch" = EXCLUDED."epoch"`,
      [SCHEMA_EPOCH],
    );
  } finally {
    await pool.end();
  }
}

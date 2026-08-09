/**
 * The seed migration and the contract constant say the same thing.
 *
 * Migration 0028 carries the starting profile's text as SQL literals. The same
 * text is `DEFAULT_AGENT_PROFILE` in `@orcasynapse/contracts`, where the create
 * form reads it. Two copies of a 3,000-character system prompt is exactly the
 * arrangement that drifts: an operator improves the prompt in the form default,
 * every fresh install keeps being seeded with the old one, and nothing anywhere
 * disagrees loudly enough to notice.
 *
 * This reads the migration as text rather than running it, so it costs no
 * database and still fails the moment the two copies diverge.
 */
import { DEFAULT_AGENT_PROFILE } from "@orcasynapse/contracts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../drizzle/migrations/0028_default_agent_profile.sql", import.meta.url)),
  "utf8",
);

describe("default agent profile seed", () => {
  it("seeds exactly the text the create form offers", () => {
    for (const [field, value] of [
      ["slug", DEFAULT_AGENT_PROFILE.slug],
      ["displayName", DEFAULT_AGENT_PROFILE.displayName],
      ["purpose", DEFAULT_AGENT_PROFILE.purpose],
      ["instructions", DEFAULT_AGENT_PROFILE.instructions],
      ["soulMd", DEFAULT_AGENT_PROFILE.soulMd],
      ["modelAlias", DEFAULT_AGENT_PROFILE.modelAlias],
    ] as const) {
      expect(migration, `${field} in the migration does not match the contract`)
        .toContain(`$seed$${value}$seed$`);
    }
  });

  it("seeds the same limits the contract declares", () => {
    expect(migration).toContain(`1, ${DEFAULT_AGENT_PROFILE.timeoutSeconds}, ${DEFAULT_AGENT_PROFILE.maxConcurrentRuns}`);
    expect(migration).toContain(`'${DEFAULT_AGENT_PROFILE.memoryMode}'`);
  });

  it("dollar-quotes every literal, because the prompt contains apostrophes", () => {
    /*
     * "the organisation's own knowledge base" and "the reader's time" would end
     * a single-quoted SQL string early and leave the rest of the prompt as
     * broken syntax -- a migration that fails on every install, found only by
     * installing. `$seed$` cannot be terminated by anything the prompt contains.
     */
    expect(DEFAULT_AGENT_PROFILE.instructions).toContain("'");
    expect(migration).not.toContain("$seed$'");
    expect(migration.match(/\$seed\$/g)?.length).toBe(14);
  });

  it("can be applied twice", () => {
    // Migrations run on every start, and an operator who edits the seeded
    // profile must not have their edit reverted by the next deploy.
    expect(migration).toContain(`ON CONFLICT ("slug") DO NOTHING`);
    expect(migration).toContain(`ON CONFLICT ("profileId", "version") DO NOTHING`);
  });

  it("arrives active, or Chat is still blocked on setup", () => {
    // The whole point: `routeReady` needs a profile that is ACTIVE with an
    // active version, not a DRAFT sitting in the list.
    expect(migration).toContain("'ACTIVE', 1, 1");
  });

  it("respects the phase-5 boundary the table checks", () => {
    // `AgentProfileVersion_phase5_boundary_check` rejects any row with
    // maxTurns <> 1 or safeMode false, so a seed that ignored it would fail at
    // install rather than at review.
    expect(DEFAULT_AGENT_PROFILE.maxTurns).toBe(1);
    expect(DEFAULT_AGENT_PROFILE.safeMode).toBe(true);
    expect(migration).toContain("true, 'DOCUMENTS_ONLY', true");
  });
});

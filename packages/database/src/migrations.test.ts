import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsRoot = resolve(process.cwd(), "prisma/migrations");
const migrationDirectories = readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("committed PostgreSQL migrations", () => {
  it("keeps every ordered migration executable as a migration.sql artifact", () => {
    expect(migrationDirectories.length).toBeGreaterThan(0);
    expect(new Set(migrationDirectories).size).toBe(migrationDirectories.length);
    for (const directory of migrationDirectories) {
      const sql = readFileSync(resolve(migrationsRoot, directory, "migration.sql"), "utf8");
      expect(sql.trim().length, directory).toBeGreaterThan(0);
    }
  });

  it("migrates the canonical profile stage without retaining the legacy release blocker", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_recalibrated_onboarding"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    for (const key of [
      "claim-installation", "system-topology", "identity-recovery", "ai-services",
      "knowledge-workflow", "hermes-profiles", "guardrails-tools", "validate-activate",
    ]) {
      expect(sql).toContain(`('${key}'`);
    }
    expect(sql).toContain("'profile-setup'");
    expect(sql).toContain('SET "required" = false');
  });

  it("constrains deployment onboarding to the signed installer through a forward migration", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_installer_only_deployment"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('CREATE TYPE "DeploymentInstallMethod" AS ENUM (\'SIGNED_INSTALLER\')');
    expect(sql).toContain("infrastructure-installer-network-tls");
  });

  it("removes legacy installation-claim and bootstrap-administrator identities", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_terminology_cohesion"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain("'activate-installation'");
    expect(sql).toContain("'installation-key-administrator'");
  });
});

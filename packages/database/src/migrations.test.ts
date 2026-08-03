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

  it("adds local administrator credentials and restricts Installation Key sessions to recovery", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_local_administrator_accounts"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "LocalAdministrator"');
    expect(sql).toContain('"passwordHash" TEXT NOT NULL');
    expect(sql).toContain("'INSTALLATION_KEY_RECOVERY'");
    expect(sql).toContain('"passwordChangeRequired" = true');
  });

  it("migrates vLLM connections into the provider-neutral inference server contract", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_generalize_inference_server"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain("RENAME VALUE 'VLLM' TO 'INFERENCE'");
    expect(sql).toContain("'{inferenceBackend}'");
    expect(sql).toContain("'inference-server'");
  });

  it("persists the approved Hermes image for direct VM2 bootstrap", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_runtime_node_bootstrap"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "hermesImage" TEXT');
  });

  it("upserts the provider-neutral inference compatibility row for fresh databases", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_repair_inference_compatibility"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain("'inference-server'");
    expect(sql).toContain('ON CONFLICT ("key") DO UPDATE');
  });

  it("persists the dashboard-selected Supermemory release with each node invitation", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_pin_agentic_artifacts"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "supermemoryVersion" VARCHAR(120)');
  });

  it("defaults new Agentic System invitations to the known-working Supermemory release", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_pin_working_supermemory_release"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('ALTER COLUMN "supermemoryVersion" SET DEFAULT \'0.0.5\'');
  });

  it("moves new invitations to the release containing the large-document workflow fix", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_pin_supermemory_large_document_fix"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('ALTER COLUMN "supermemoryVersion" SET DEFAULT \'0.0.7-rc.2\'');
  });

  it("adds an expiring exclusive lease for durable Hermes run processing", () => {
    const directory = migrationDirectories.find((name) => name.endsWith("_harden_agent_run_leases"));
    expect(directory).toBeTruthy();
    const sql = readFileSync(resolve(migrationsRoot, directory!, "migration.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "processorLeaseOwner" VARCHAR(160)');
    expect(sql).toContain('ADD COLUMN "processorLeaseExpiresAt" TIMESTAMPTZ(6)');
    expect(sql).toContain('"AgentRun_status_processorLeaseExpiresAt_idx"');
  });
});

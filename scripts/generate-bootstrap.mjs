import { randomBytes } from "node:crypto";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const secretDirectory = resolve(process.cwd(), ".local/secrets");
await mkdir(secretDirectory, { recursive: true, mode: 0o700 });

const secretPaths = {
  postgres_password: resolve(secretDirectory, "postgres_password"),
  aihub_database_url: resolve(secretDirectory, "aihub_database_url"),
  aihub_master_key: resolve(secretDirectory, "aihub_master_key"),
  aihub_installation_key: resolve(secretDirectory, "aihub_installation_key"),
};

for (const secretPath of Object.values(secretPaths)) {
  try {
    await access(secretPath, constants.F_OK);
    throw new Error(
      `AIHub bootstrap generation stopped because '${secretPath}' already exists.`,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}

const postgresPassword = randomBytes(24).toString("base64url");
const databaseUrl = `postgresql://aihub:${encodeURIComponent(postgresPassword)}@postgres:5432/aihub`;
const masterKey = randomBytes(32).toString("base64");
const installationKey = randomBytes(32).toString("base64url");

await Promise.all([
  writeFile(secretPaths.postgres_password, postgresPassword, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.aihub_database_url, databaseUrl, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.aihub_master_key, masterKey, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.aihub_installation_key, installationKey, { mode: 0o600, flag: "wx" }),
]);

process.stdout.write(`AIHub bootstrap secrets created in ${secretDirectory}.\n`);
process.stdout.write("The permanent Installation Key was written to its protected secret file and was not printed.\n");
process.stdout.write("Back up the database and AIHub credential-encryption key securely before deployment.\n");

import { randomBytes } from "node:crypto";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const secretDirectory = resolve(process.cwd(), ".local/secrets");
await mkdir(secretDirectory, { recursive: true, mode: 0o700 });

const secretPaths = {
  postgres_password: resolve(secretDirectory, "postgres_password"),
  orcasynapse_database_url: resolve(secretDirectory, "orcasynapse_database_url"),
  orcasynapse_master_key: resolve(secretDirectory, "orcasynapse_master_key"),
  orcasynapse_installation_key: resolve(secretDirectory, "orcasynapse_installation_key"),
};

for (const secretPath of Object.values(secretPaths)) {
  try {
    await access(secretPath, constants.F_OK);
    throw new Error(
      `OrcaSynapse bootstrap generation stopped because '${secretPath}' already exists.`,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}

const postgresPassword = randomBytes(24).toString("base64url");
const databaseUrl = `postgresql://orcasynapse:${encodeURIComponent(postgresPassword)}@postgres:5432/orcasynapse`;
const masterKey = randomBytes(32).toString("base64");
const installationKey = randomBytes(32).toString("base64url");

await Promise.all([
  writeFile(secretPaths.postgres_password, postgresPassword, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.orcasynapse_database_url, databaseUrl, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.orcasynapse_master_key, masterKey, { mode: 0o600, flag: "wx" }),
  writeFile(secretPaths.orcasynapse_installation_key, installationKey, { mode: 0o600, flag: "wx" }),
]);

process.stdout.write(`OrcaSynapse bootstrap secrets created in ${secretDirectory}.\n`);
process.stdout.write("The permanent Installation Key was written to its protected secret file and was not printed.\n");
process.stdout.write("Back up the database and OrcaSynapse credential-encryption key securely before deployment.\n");

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BootstrapSecretName =
  | "orcasynapse_database_url"
  | "orcasynapse_master_key"
  | "orcasynapse_installation_key";

export function bootstrapSecretCandidates(name: BootstrapSecretName): string[] {
  return [
    `/run/secrets/${name}`,
    resolve(process.cwd(), `.local/secrets/${name}`),
    resolve(process.cwd(), `../../.local/secrets/${name}`),
  ];
}

export function readBootstrapSecret(name: BootstrapSecretName): string {
  for (const candidate of bootstrapSecretCandidates(name)) {
    if (!existsSync(candidate)) continue;

    const value = readFileSync(candidate, "utf8").trim();
    if (value.length > 0) return value;
  }

  throw new Error(`Required bootstrap secret '${name}' is not mounted.`);
}

export function hasBootstrapSecret(name: BootstrapSecretName): boolean {
  return bootstrapSecretCandidates(name).some((candidate) => {
    if (!existsSync(candidate)) return false;
    return readFileSync(candidate, "utf8").trim().length > 0;
  });
}

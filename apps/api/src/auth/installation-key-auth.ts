import { createHash, timingSafeEqual } from "node:crypto";

export interface InstallationKeyVerifier {
  verify(candidate: string | undefined): boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class InstallationKeyAuthenticator implements InstallationKeyVerifier {
  readonly #expectedDigest: Buffer;

  constructor(installationKey: string) {
    if (installationKey.length < 32) throw new Error("Installation Key is too short.");
    this.#expectedDigest = digest(installationKey);
  }

  verify(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return timingSafeEqual(this.#expectedDigest, digest(candidate));
  }
}

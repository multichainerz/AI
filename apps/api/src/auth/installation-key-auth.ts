import { createHash, timingSafeEqual } from "node:crypto";

export interface InstallationKeyVerifier {
  verify(candidate: string | undefined): boolean;
  /**
   * Whether a digest recorded earlier is still the digest of the mounted key.
   *
   * Rotation has to be detectable without anyone presenting the new key: an
   * operator responding to a leak writes a new key file and restarts, and
   * nothing in that sequence carries a candidate to verify against.
   */
  matchesDigest(storedDigest: Uint8Array): boolean;
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

  matchesDigest(storedDigest: Uint8Array): boolean {
    const stored = Buffer.from(storedDigest);
    return stored.byteLength === this.#expectedDigest.byteLength
      && timingSafeEqual(this.#expectedDigest, stored);
  }
}

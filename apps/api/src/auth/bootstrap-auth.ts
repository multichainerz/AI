import { createHash, timingSafeEqual } from "node:crypto";

export interface AdminAuthenticator {
  verify(candidate: string | undefined): boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class BootstrapTokenAuthenticator implements AdminAuthenticator {
  readonly #expectedDigest: Buffer;

  constructor(token: string) {
    if (token.length < 32) throw new Error("Installation claim is too short.");
    this.#expectedDigest = digest(token);
  }

  verify(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return timingSafeEqual(this.#expectedDigest, digest(candidate));
  }
}

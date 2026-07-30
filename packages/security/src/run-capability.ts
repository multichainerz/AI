import { createHash, createHmac } from "node:crypto";

const KEY_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RunCapability {
  token: string;
  tokenHash: Uint8Array<ArrayBuffer>;
}

/**
 * Derives a stable, retry-safe capability from the bootstrap key and run ID.
 * PostgreSQL stores only its digest; a worker can reproduce the same value
 * after a crash without persisting plaintext delivery material.
 */
export class RunCapabilityIssuer {
  readonly #capabilityKey: Buffer;

  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== KEY_BYTES) {
      throw new Error("Run capability issuance requires a 32-byte master key.");
    }
    this.#capabilityKey = createHmac("sha256", masterKey)
      .update("aihub:run-capability:key:v1", "utf8")
      .digest();
  }

  issue(runId: string): RunCapability {
    if (!UUID.test(runId)) throw new Error("Run capability issuance requires a valid run ID.");
    const token = createHmac("sha256", this.#capabilityKey)
      .update(`aihub:run-capability:v1:${runId}`, "utf8")
      .digest("base64url");
    const digest = createHash("sha256").update(token, "utf8").digest();
    const tokenHash = new Uint8Array(digest.length);
    tokenHash.set(digest);
    return { token, tokenHash };
  }
}

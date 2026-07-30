import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCredentialRecoveryKit,
  parseCredentialRecoveryKit,
  verifyCredentialRecoveryKit,
} from "./credential-recovery-kit.js";

describe("credential recovery kits", () => {
  it("wraps and verifies the active encryption key without serializing plaintext", async () => {
    const masterKey = randomBytes(32);
    const created = await createCredentialRecoveryKit(masterKey, "a strong offline recovery passphrase", new Date("2026-07-30T00:00:00.000Z"));

    expect(created.serialized).not.toContain(masterKey.toString("base64"));
    expect(parseCredentialRecoveryKit(created.serialized)).toMatchObject({
      format: "AIHUB-CREDENTIAL-RECOVERY",
      version: 1,
      generatedAt: "2026-07-30T00:00:00.000Z",
    });
    await expect(verifyCredentialRecoveryKit(created.serialized, "a strong offline recovery passphrase", masterKey))
      .resolves.toMatchObject({ keyFingerprint: created.keyFingerprint });
  });

  it("rejects an incorrect passphrase or a kit for another installation", async () => {
    const masterKey = randomBytes(32);
    const created = await createCredentialRecoveryKit(masterKey, "a strong offline recovery passphrase");

    await expect(verifyCredentialRecoveryKit(created.serialized, "this passphrase is incorrect", masterKey))
      .rejects.toThrow("verification failed");
    await expect(verifyCredentialRecoveryKit(created.serialized, "a strong offline recovery passphrase", randomBytes(32)))
      .rejects.toThrow("verification failed");
  });
});

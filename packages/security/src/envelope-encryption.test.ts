import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeMasterKey, EnvelopeEncryption } from "./envelope-encryption.js";

describe("EnvelopeEncryption", () => {
  it("round-trips a secret bound to its context", () => {
    const vault = new EnvelopeEncryption({ masterKey: randomBytes(32) });
    const envelope = vault.encrypt("very-secret-value", "connection-1:api-key");

    expect(vault.decrypt(envelope, "connection-1:api-key")).toBe("very-secret-value");
  });

  it("rejects a secret when the context changes", () => {
    const vault = new EnvelopeEncryption({ masterKey: randomBytes(32) });
    const envelope = vault.encrypt("very-secret-value", "connection-1:api-key");

    expect(() => vault.decrypt(envelope, "connection-2:api-key")).toThrow();
  });

  it("validates the encoded master key length", () => {
    expect(decodeMasterKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    expect(() => decodeMasterKey(randomBytes(16).toString("base64"))).toThrow(
      "base64-encoded 32-byte key",
    );
  });
});

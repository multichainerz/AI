import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeMasterKey, EnvelopeEncryption, storedEnvelope } from "./envelope-encryption.js";

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

describe("storedEnvelope", () => {
  const row = {
    encryptedValue: new Uint8Array([1]), valueNonce: new Uint8Array([2]), valueAuthTag: new Uint8Array([3]),
    wrappedDataKey: new Uint8Array([4]), keyNonce: new Uint8Array([5]), keyAuthTag: new Uint8Array([6]),
    encryptionVersion: 1, masterKeyVersion: 1,
  };

  it("passes a version this build understands straight through", () => {
    expect(storedEnvelope(row)).toMatchObject({ algorithm: "AES-256-GCM", encryptionVersion: 1, masterKeyVersion: 1 });
  });

  it("refuses a future format instead of pretending it is version 1", () => {
    // Read sites used to hardcode `encryptionVersion: 1`, so decrypt's guard
    // could never fire and a v2 row failed later as an auth-tag error instead.
    expect(() => storedEnvelope({ ...row, encryptionVersion: 2 }))
      .toThrow(/cannot read secret envelope version 2/);
  });
});

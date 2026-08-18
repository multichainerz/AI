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

  it("refuses an envelope wrapped under a different master key", () => {
    /*
     * The property the whole scheme rests on, and nothing exercised it: every
     * case used one vault, so a change that ignored the master key entirely --
     * deriving the data key from the context alone, say -- would have left this
     * file green while every deployment's secrets became readable by every
     * other. Two keys, one envelope, and the wrong key must fail rather than
     * return plaintext or an empty string.
     */
    const original = new EnvelopeEncryption({ masterKey: randomBytes(32) });
    const other = new EnvelopeEncryption({ masterKey: randomBytes(32) });
    const envelope = original.encrypt("very-secret-value", "connection-1:api-key");

    expect(() => other.decrypt(envelope, "connection-1:api-key")).toThrow();
    // And the right key still works, so the case above is about the key rather
    // than about the envelope having been damaged in construction.
    expect(original.decrypt(envelope, "connection-1:api-key")).toBe("very-secret-value");
  });

  it("refuses an envelope whose ciphertext was altered", () => {
    /*
     * AES-GCM authenticates as well as encrypts, and the authentication is the
     * half that matters here: this vault holds the upstream inference
     * credential and every node API key, so a flipped bit must be a refusal and
     * never a silently different plaintext. Untested until now.
     */
    const vault = new EnvelopeEncryption({ masterKey: randomBytes(32) });
    const envelope = vault.encrypt("very-secret-value", "connection-1:api-key");

    const tamperedValue = { ...envelope, encryptedValue: Uint8Array.from(envelope.encryptedValue) };
    tamperedValue.encryptedValue.set([envelope.encryptedValue[0]! ^ 0xff], 0);
    expect(() => vault.decrypt(tamperedValue, "connection-1:api-key")).toThrow();

    // The wrapped data key is the other half of the envelope, and is authenticated too.
    const tamperedKey = { ...envelope, wrappedDataKey: Uint8Array.from(envelope.wrappedDataKey) };
    tamperedKey.wrappedDataKey.set([envelope.wrappedDataKey[0]! ^ 0xff], 0);
    expect(() => vault.decrypt(tamperedKey, "connection-1:api-key")).toThrow();
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

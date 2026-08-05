import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptedEnvelope {
  algorithm: "AES-256-GCM";
  encryptionVersion: 1;
  masterKeyVersion: number;
  encryptedValue: Uint8Array;
  valueNonce: Uint8Array;
  valueAuthTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyNonce: Uint8Array;
  keyAuthTag: Uint8Array;
}

export interface EnvelopeEncryptionOptions {
  masterKey: Uint8Array;
  masterKeyVersion?: number;
}

function encryptAesGcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  additionalData: string,
): { ciphertext: Buffer; nonce: Buffer; authTag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function decryptAesGcm(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  authTag: Uint8Array,
  additionalData: string,
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(Buffer.from(additionalData, "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decodeMasterKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("OrcaSynapse master key must be a base64-encoded 32-byte key.");
  }
  return key;
}

export class EnvelopeEncryption {
  readonly #masterKey: Uint8Array;
  readonly #masterKeyVersion: number;

  constructor(options: EnvelopeEncryptionOptions) {
    if (options.masterKey.length !== KEY_BYTES) {
      throw new Error("Envelope encryption requires a 32-byte master key.");
    }
    this.#masterKey = Buffer.from(options.masterKey);
    this.#masterKeyVersion = options.masterKeyVersion ?? 1;
  }

  encrypt(value: string, context: string): EncryptedEnvelope {
    const dataKey = randomBytes(KEY_BYTES);
    const valueResult = encryptAesGcm(Buffer.from(value, "utf8"), dataKey, context);
    const keyContext = `orcasynapse:wrapped-data-key:v1:${this.#masterKeyVersion}`;
    const keyResult = encryptAesGcm(dataKey, this.#masterKey, keyContext);

    dataKey.fill(0);

    return {
      algorithm: "AES-256-GCM",
      encryptionVersion: 1,
      masterKeyVersion: this.#masterKeyVersion,
      encryptedValue: valueResult.ciphertext,
      valueNonce: valueResult.nonce,
      valueAuthTag: valueResult.authTag,
      wrappedDataKey: keyResult.ciphertext,
      keyNonce: keyResult.nonce,
      keyAuthTag: keyResult.authTag,
    };
  }

  decrypt(envelope: EncryptedEnvelope, context: string): string {
    if (envelope.algorithm !== "AES-256-GCM" || envelope.encryptionVersion !== 1) {
      throw new Error("Unsupported OrcaSynapse secret envelope format.");
    }
    if (envelope.masterKeyVersion !== this.#masterKeyVersion) {
      throw new Error("The requested master key version is not loaded.");
    }

    const keyContext = `orcasynapse:wrapped-data-key:v1:${envelope.masterKeyVersion}`;
    const dataKey = decryptAesGcm(
      envelope.wrappedDataKey,
      this.#masterKey,
      envelope.keyNonce,
      envelope.keyAuthTag,
      keyContext,
    );

    try {
      return decryptAesGcm(
        envelope.encryptedValue,
        dataKey,
        envelope.valueNonce,
        envelope.valueAuthTag,
        context,
      ).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}

export interface SealedRow {
  encryptedValue: Uint8Array;
  valueNonce: Uint8Array;
  valueAuthTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyNonce: Uint8Array;
  keyAuthTag: Uint8Array;
  encryptionVersion: number;
  masterKeyVersion: number;
}

/**
 * A stored row as an envelope, refusing a format this build cannot decrypt.
 *
 * Every read site used to build this object inline with `encryptionVersion: 1`
 * hardcoded, which meant `decrypt`'s version guard could never fire: a row
 * written under a future format would be presented as version 1 and fail later
 * as a confusing authentication-tag error. The narrowing from the row's plain
 * number to the literal `1` has to happen somewhere, and doing it silently is
 * what made the guard unreachable.
 */
export function storedEnvelope(row: SealedRow): EncryptedEnvelope {
  if (row.encryptionVersion !== 1) {
    throw new Error(
      `This build cannot read secret envelope version ${row.encryptionVersion}; it supports version 1.`,
    );
  }
  return {
    algorithm: "AES-256-GCM",
    encryptionVersion: 1,
    masterKeyVersion: row.masterKeyVersion,
    encryptedValue: row.encryptedValue,
    valueNonce: row.valueNonce,
    valueAuthTag: row.valueAuthTag,
    wrappedDataKey: row.wrappedDataKey,
    keyNonce: row.keyNonce,
    keyAuthTag: row.keyAuthTag,
  };
}

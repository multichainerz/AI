import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const FORMAT = "AIHUB-CREDENTIAL-RECOVERY";
const AAD = "aihub:credential-recovery-kit:v1";

export interface CredentialRecoveryKitV1 {
  format: typeof FORMAT;
  version: 1;
  generatedAt: string;
  keyFingerprint: string;
  cipher: "AES-256-GCM";
  kdf: {
    name: "scrypt";
    n: number;
    r: number;
    p: number;
    salt: string;
  };
  nonce: string;
  authTag: string;
  ciphertext: string;
}

export interface CreatedCredentialRecoveryKit {
  kit: CredentialRecoveryKitV1;
  serialized: string;
  checksum: string;
  keyFingerprint: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encoded(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decoded(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Recovery kit ${field} is invalid.`);
  return Buffer.from(value, "base64url");
}

function deriveKey(passphrase: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

function validateMasterKey(masterKey: Uint8Array): void {
  if (masterKey.byteLength !== KEY_BYTES) {
    throw new Error("Credential recovery requires the active 32-byte AIHub encryption key.");
  }
}

export function credentialKeyFingerprint(masterKey: Uint8Array): string {
  validateMasterKey(masterKey);
  return sha256(masterKey);
}

export function recoveryKitChecksum(serialized: string): string {
  return sha256(serialized);
}

export function parseCredentialRecoveryKit(serialized: string): CredentialRecoveryKitV1 {
  if (serialized.length < 100 || serialized.length > 16_384) {
    throw new Error("Recovery kit size is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Recovery kit is not valid JSON.");
  }
  if (!value || typeof value !== "object") throw new Error("Recovery kit is invalid.");
  const candidate = value as Partial<CredentialRecoveryKitV1>;
  if (
    candidate.format !== FORMAT || candidate.version !== 1 || candidate.cipher !== "AES-256-GCM"
    || candidate.kdf?.name !== "scrypt" || candidate.kdf.n !== SCRYPT_N
    || candidate.kdf.r !== SCRYPT_R || candidate.kdf.p !== SCRYPT_P
    || typeof candidate.generatedAt !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.keyFingerprint ?? "")
    || typeof candidate.kdf.salt !== "string" || typeof candidate.nonce !== "string"
    || typeof candidate.authTag !== "string" || typeof candidate.ciphertext !== "string"
  ) {
    throw new Error("Recovery kit format is unsupported or malformed.");
  }
  if (Number.isNaN(Date.parse(candidate.generatedAt))) throw new Error("Recovery kit timestamp is invalid.");
  return candidate as CredentialRecoveryKitV1;
}

export async function createCredentialRecoveryKit(
  masterKey: Uint8Array,
  passphrase: string,
  generatedAt = new Date(),
): Promise<CreatedCredentialRecoveryKit> {
  validateMasterKey(masterKey);
  if (passphrase.length < 16 || passphrase.length > 1_024) {
    throw new Error("Recovery passphrase must contain between 16 and 1024 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const wrappingKey = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv(ALGORITHM, wrappingKey, nonce);
    cipher.setAAD(Buffer.from(AAD, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const kit: CredentialRecoveryKitV1 = {
      format: FORMAT,
      version: 1,
      generatedAt: generatedAt.toISOString(),
      keyFingerprint: credentialKeyFingerprint(masterKey),
      cipher: "AES-256-GCM",
      kdf: { name: "scrypt", n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: encoded(salt) },
      nonce: encoded(nonce),
      authTag: encoded(cipher.getAuthTag()),
      ciphertext: encoded(ciphertext),
    };
    const serialized = JSON.stringify(kit);
    return { kit, serialized, checksum: recoveryKitChecksum(serialized), keyFingerprint: kit.keyFingerprint };
  } finally {
    wrappingKey.fill(0);
  }
}

export async function verifyCredentialRecoveryKit(
  serialized: string,
  passphrase: string,
  expectedMasterKey: Uint8Array,
): Promise<CredentialRecoveryKitV1> {
  validateMasterKey(expectedMasterKey);
  if (passphrase.length < 16 || passphrase.length > 1_024) throw new Error("Recovery passphrase is invalid.");
  const kit = parseCredentialRecoveryKit(serialized);
  const salt = decoded(kit.kdf.salt, "salt");
  const nonce = decoded(kit.nonce, "nonce");
  const authTag = decoded(kit.authTag, "authentication tag");
  const ciphertext = decoded(kit.ciphertext, "ciphertext");
  if (salt.byteLength !== SALT_BYTES || nonce.byteLength !== NONCE_BYTES || authTag.byteLength !== 16) {
    throw new Error("Recovery kit cryptographic parameters are invalid.");
  }
  const wrappingKey = await deriveKey(passphrase, salt);
  let recovered: Buffer | undefined;
  try {
    const decipher = createDecipheriv(ALGORITHM, wrappingKey, nonce);
    decipher.setAAD(Buffer.from(AAD, "utf8"));
    decipher.setAuthTag(authTag);
    recovered = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (recovered.byteLength !== KEY_BYTES || credentialKeyFingerprint(recovered) !== kit.keyFingerprint) {
      throw new Error("Recovery kit did not yield a valid AIHub encryption key.");
    }
    if (credentialKeyFingerprint(expectedMasterKey) !== kit.keyFingerprint) {
      throw new Error("Recovery kit does not match the active AIHub encryption key.");
    }
    return kit;
  } catch {
    throw new Error("Recovery kit verification failed.");
  } finally {
    wrappingKey.fill(0);
    recovered?.fill(0);
  }
}

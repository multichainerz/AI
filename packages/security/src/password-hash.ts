import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const COST = 131_072;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MAX_MEMORY = 192 * 1024 * 1024;

export const LOCAL_PASSWORD_MIN_LENGTH = 12;
export const LOCAL_PASSWORD_MAX_LENGTH = 1_024;

// A syntactically valid digest used to keep unknown-user authentication on the
// same expensive code path as a real account lookup.
export const DUMMY_PASSWORD_DIGEST = [
  ALGORITHM,
  String(COST),
  String(BLOCK_SIZE),
  String(PARALLELIZATION),
  Buffer.alloc(SALT_BYTES, 0xa5).toString("base64url"),
  Buffer.alloc(HASH_BYTES, 0x5a).toString("base64url"),
].join("$");

interface ParsedPasswordDigest {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

function parsePasswordDigest(encoded: string): ParsedPasswordDigest | null {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, hashText, ...extra] = encoded.split("$");
  if (algorithm !== ALGORITHM || extra.length > 0 || !costText || !blockSizeText || !parallelizationText || !saltText || !hashText) {
    return null;
  }
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    !Number.isSafeInteger(cost) || cost < 2 || cost > 1_048_576
    || !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 32
    || !Number.isSafeInteger(parallelization) || parallelization < 1 || parallelization > 16
  ) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(saltText) || !/^[A-Za-z0-9_-]+$/.test(hashText)) return null;
    const salt = Buffer.from(saltText, "base64url");
    const hash = Buffer.from(hashText, "base64url");
    if (salt.byteLength < 16 || hash.byteLength !== HASH_BYTES) return null;
    return { cost, blockSize, parallelization, salt, hash };
  } catch {
    return null;
  }
}

async function derive(password: string, parameters: ParsedPasswordDigest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, parameters.salt, parameters.hash.byteLength, {
      N: parameters.cost,
      r: parameters.blockSize,
      p: parameters.parallelization,
      maxmem: MAX_MEMORY,
    }, (error, derived) => error ? reject(error) : resolve(Buffer.from(derived)));
  });
}

export function localPasswordIsValid(password: string): boolean {
  return password.length >= LOCAL_PASSWORD_MIN_LENGTH && password.length <= LOCAL_PASSWORD_MAX_LENGTH;
}

export async function hashLocalPassword(password: string, salt?: Uint8Array): Promise<string> {
  if (!localPasswordIsValid(password)) {
    throw new Error(`Local administrator passwords must be ${LOCAL_PASSWORD_MIN_LENGTH}-${LOCAL_PASSWORD_MAX_LENGTH} characters.`);
  }
  const selectedSalt = salt ? Buffer.from(salt) : randomBytes(SALT_BYTES);
  if (selectedSalt.byteLength < SALT_BYTES) throw new Error("Password salt is too short.");
  const parameters: ParsedPasswordDigest = {
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelization: PARALLELIZATION,
    salt: selectedSalt,
    hash: Buffer.alloc(HASH_BYTES),
  };
  const hash = await derive(password, parameters);
  return [ALGORITHM, COST, BLOCK_SIZE, PARALLELIZATION, selectedSalt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const parameters = parsePasswordDigest(encoded) ?? parsePasswordDigest(DUMMY_PASSWORD_DIGEST)!;
  const candidate = await derive(password, parameters);
  const matches = candidate.byteLength === parameters.hash.byteLength && timingSafeEqual(candidate, parameters.hash);
  return parsePasswordDigest(encoded) !== null && matches;
}

export function localPasswordNeedsRehash(encoded: string): boolean {
  const parameters = parsePasswordDigest(encoded);
  return !parameters
    || parameters.cost !== COST
    || parameters.blockSize !== BLOCK_SIZE
    || parameters.parallelization !== PARALLELIZATION
    || parameters.hash.byteLength !== HASH_BYTES;
}

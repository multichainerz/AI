import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const ALGORITHM = "aes-256-gcm";
const MAGIC = Buffer.from("ORCASYNAPSES01", "ascii");
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_BYTES = MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES;
const MAX_SCRATCH_READ_BYTES = 75 * 1024 * 1024;
export const DOCUMENT_SCRATCH_TTL_MS = 24 * 60 * 60 * 1_000;

function safeKey(key: string): string {
  const normalized = key.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    normalized.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error("Document scratch key is invalid.");
  }
  return normalized;
}

function scratchKey(masterKey: Uint8Array): Buffer {
  if (masterKey.byteLength !== 32) throw new Error("Document scratch encryption requires a 32-byte master key.");
  return createHmac("sha256", masterKey).update("orcasynapse:document-scratch:v1", "utf8").digest();
}

class EncryptScratchTransform extends Transform {
  private readonly nonce = randomBytes(NONCE_BYTES);
  private readonly cipher;
  private emittedHeader = false;

  constructor(key: Uint8Array, context: string) {
    super();
    this.cipher = createCipheriv(ALGORITHM, key, this.nonce);
    this.cipher.setAAD(Buffer.from(context, "utf8"));
  }

  private emitHeader(): void {
    if (this.emittedHeader) return;
    this.push(MAGIC);
    this.push(this.nonce);
    this.emittedHeader = true;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.emitHeader();
      this.push(this.cipher.update(chunk));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Document scratch encryption failed."));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.emitHeader();
      this.push(this.cipher.final());
      this.push(this.cipher.getAuthTag());
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Document scratch encryption failed."));
    }
  }
}

export interface DocumentScratchStore {
  putStream(key: string, source: Readable): Promise<void>;
  putFile(key: string, sourcePath: string): Promise<void>;
  putBuffer(key: string, value: Uint8Array): Promise<void>;
  getBuffer(key: string, maxBytes?: number): Promise<Uint8Array>;
  deletePrefix(prefix: string): Promise<void>;
}

export function documentScratchDirectory(): string {
  return process.env.ORCASYNAPSE_DOCUMENT_SCRATCH_DIR?.trim() || resolve(process.cwd(), ".local", "document-scratch");
}

export function documentScratchPrefix(documentId: string): string {
  return `documents/${documentId}`;
}

export function documentOriginalKey(documentId: string): string {
  return `${documentScratchPrefix(documentId)}/original/source.bin`;
}

export function documentGenerationPrefix(documentId: string, generation: number): string {
  return `${documentScratchPrefix(documentId)}/generation-${generation}`;
}

export function documentNormalizedKey(documentId: string, generation: number): string {
  return `${documentGenerationPrefix(documentId, generation)}/normalized/content.md`;
}

export class EncryptedFileSystemDocumentScratchStore implements DocumentScratchStore {
  private readonly root: string;
  private readonly encryptionKey: Buffer;

  constructor(root: string, masterKey: Uint8Array) {
    this.root = resolve(root);
    this.encryptionKey = scratchKey(masterKey);
  }

  async putStream(key: string, source: Readable): Promise<void> {
    await this.write(key, source);
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    await this.write(key, createReadStream(sourcePath));
  }

  async putBuffer(key: string, value: Uint8Array): Promise<void> {
    await this.write(key, Readable.from([Buffer.from(value)]));
  }

  async getBuffer(key: string, maxBytes = MAX_SCRATCH_READ_BYTES): Promise<Uint8Array> {
    const normalized = safeKey(key);
    const path = this.pathFor(normalized);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maxBytes + ENVELOPE_BYTES) {
      throw new Error("Transient document content exceeds the processing limit.");
    }
    const envelope = await readFile(path);
    if (envelope.byteLength < ENVELOPE_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Transient document content has an invalid encrypted envelope.");
    }
    const nonce = envelope.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
    const authTag = envelope.subarray(envelope.length - AUTH_TAG_BYTES);
    const ciphertext = envelope.subarray(MAGIC.length + NONCE_BYTES, envelope.length - AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, nonce);
    decipher.setAAD(Buffer.from(normalized, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > maxBytes) throw new Error("Transient document content exceeds the processing limit.");
    return plaintext;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(safeKey(prefix)), { recursive: true, force: true });
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, ...key.split("/"));
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("Document scratch key escapes the configured root.");
    }
    return path;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  private async write(key: string, source: Readable): Promise<void> {
    const normalized = safeKey(key);
    await this.ensureRoot();
    const target = this.pathFor(normalized);
    const parent = target.slice(0, target.lastIndexOf(sep));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        source,
        new EncryptScratchTransform(this.encryptionKey, normalized),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

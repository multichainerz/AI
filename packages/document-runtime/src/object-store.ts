import { createReadStream } from "node:fs";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_OBJECT_READ_BYTES = 75 * 1024 * 1024;
type S3Transport = Pick<S3Client, "send" | "destroy">;
export type S3ClientConfiguration = NonNullable<ConstructorParameters<typeof S3Client>[0]>;
export type S3ClientFactory = (configuration: S3ClientConfiguration) => S3Transport;

function stringSetting(connection: RuntimeConnection, name: string): string | undefined {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberSetting(connection: RuntimeConnection, name: string, fallback: number): number {
  const value = connection.configuration[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clientFor(
  connection: RuntimeConnection,
  clientFactory: S3ClientFactory,
): { client: S3Transport; bucket: string; timeoutMs: number } {
  const accessKeyId = connection.secrets.accessKeyId;
  const secretAccessKey = connection.secrets.secretAccessKey;
  const bucket = stringSetting(connection, "bucket");
  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("S3 bucket and credentials are required for document storage.");
  }
  return {
    bucket,
    timeoutMs: Math.min(600_000, Math.max(5_000, numberSetting(connection, "objectTimeoutMs", 120_000))),
    client: clientFactory({
      endpoint: connection.baseUrl,
      region: stringSetting(connection, "region") ?? "us-east-1",
      forcePathStyle: connection.configuration.forcePathStyle === true,
      maxAttempts: 3,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(connection.secrets.sessionToken ? { sessionToken: connection.secrets.sessionToken } : {}),
      },
    }),
  };
}

export interface DocumentObjectStore {
  putFile(key: string, path: string, mediaType: string, sizeBytes: number): Promise<void>;
  putBuffer(key: string, value: Uint8Array, mediaType: string): Promise<void>;
  getBuffer(key: string, maxBytes?: number): Promise<Uint8Array>;
  delete(keys: readonly string[]): Promise<void>;
}

export class S3DocumentStore implements DocumentObjectStore {
  constructor(
    private readonly resolver: PrismaRuntimeConnectionResolver,
    private readonly clientFactory: S3ClientFactory = (configuration) => new S3Client(configuration),
  ) {}

  async putFile(key: string, path: string, mediaType: string, sizeBytes: number): Promise<void> {
    const runtime = clientFor(await this.resolver.resolveOne("S3"), this.clientFactory);
    try {
      await runtime.client.send(new PutObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: sizeBytes,
        ContentType: mediaType,
        Metadata: { "aihub-managed": "true" },
      }), { abortSignal: AbortSignal.timeout(runtime.timeoutMs) });
    } finally {
      runtime.client.destroy();
    }
  }

  async putBuffer(key: string, value: Uint8Array, mediaType: string): Promise<void> {
    const runtime = clientFor(await this.resolver.resolveOne("S3"), this.clientFactory);
    try {
      await runtime.client.send(new PutObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
        Body: value,
        ContentLength: value.byteLength,
        ContentType: mediaType,
        Metadata: { "aihub-managed": "true" },
      }), { abortSignal: AbortSignal.timeout(runtime.timeoutMs) });
    } finally {
      runtime.client.destroy();
    }
  }

  async getBuffer(key: string, maxBytes = MAX_OBJECT_READ_BYTES): Promise<Uint8Array> {
    const runtime = clientFor(await this.resolver.resolveOne("S3"), this.clientFactory);
    try {
      const response = await runtime.client.send(new GetObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
      }), { abortSignal: AbortSignal.timeout(runtime.timeoutMs) });
      if ((response.ContentLength ?? 0) > maxBytes) throw new Error("Stored document object exceeds the processing limit.");
      if (!response.Body) throw new Error("Stored document object returned no body.");
      const value = await response.Body.transformToByteArray();
      if (value.byteLength > maxBytes) throw new Error("Stored document object exceeds the processing limit.");
      return value;
    } finally {
      runtime.client.destroy();
    }
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const runtime = clientFor(await this.resolver.resolveOne("S3"), this.clientFactory);
    try {
      for (let offset = 0; offset < keys.length; offset += 1_000) {
        const batch = keys.slice(offset, offset + 1_000);
        const response = await runtime.client.send(new DeleteObjectsCommand({
          Bucket: runtime.bucket,
          Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
        }), { abortSignal: AbortSignal.timeout(runtime.timeoutMs) });
        if (response.Errors && response.Errors.length > 0) {
          throw new Error("S3 could not delete every managed document object.");
        }
      }
    } finally {
      runtime.client.destroy();
    }
  }
}

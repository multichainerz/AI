import { createReadStream } from "node:fs";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_OBJECT_READ_BYTES = 75 * 1024 * 1024;

function stringSetting(connection: RuntimeConnection, name: string): string | undefined {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clientFor(connection: RuntimeConnection): { client: S3Client; bucket: string } {
  const accessKeyId = connection.secrets.accessKeyId;
  const secretAccessKey = connection.secrets.secretAccessKey;
  const bucket = stringSetting(connection, "bucket");
  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("SeaweedFS bucket and credentials are required for document storage.");
  }
  return {
    bucket,
    client: new S3Client({
      endpoint: connection.baseUrl,
      region: stringSetting(connection, "region") ?? "us-east-1",
      forcePathStyle: connection.configuration.forcePathStyle !== false,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

export class SeaweedDocumentStore {
  constructor(private readonly resolver: PrismaRuntimeConnectionResolver) {}

  async putFile(key: string, path: string, mediaType: string, sizeBytes: number): Promise<void> {
    const runtime = clientFor(await this.resolver.resolveOne("SEAWEEDFS"));
    try {
      await runtime.client.send(new PutObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: sizeBytes,
        ContentType: mediaType,
        Metadata: { "aihub-managed": "true" },
      }));
    } finally {
      runtime.client.destroy();
    }
  }

  async putBuffer(key: string, value: Uint8Array, mediaType: string): Promise<void> {
    const runtime = clientFor(await this.resolver.resolveOne("SEAWEEDFS"));
    try {
      await runtime.client.send(new PutObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
        Body: value,
        ContentLength: value.byteLength,
        ContentType: mediaType,
        Metadata: { "aihub-managed": "true" },
      }));
    } finally {
      runtime.client.destroy();
    }
  }

  async getBuffer(key: string, maxBytes = MAX_OBJECT_READ_BYTES): Promise<Uint8Array> {
    const runtime = clientFor(await this.resolver.resolveOne("SEAWEEDFS"));
    try {
      const response = await runtime.client.send(new GetObjectCommand({
        Bucket: runtime.bucket,
        Key: key,
      }));
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
    const runtime = clientFor(await this.resolver.resolveOne("SEAWEEDFS"));
    try {
      for (let offset = 0; offset < keys.length; offset += 1_000) {
        const batch = keys.slice(offset, offset + 1_000);
        const response = await runtime.client.send(new DeleteObjectsCommand({
          Bucket: runtime.bucket,
          Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
        }));
        if (response.Errors && response.Errors.length > 0) {
          throw new Error("SeaweedFS could not delete every managed document object.");
        }
      }
    } finally {
      runtime.client.destroy();
    }
  }
}

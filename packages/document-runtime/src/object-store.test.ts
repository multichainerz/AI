import { DeleteObjectsCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { PrismaRuntimeConnectionResolver } from "./connection-resolver.js";
import {
  S3DocumentStore,
  type S3ClientConfiguration,
  type S3ClientFactory,
} from "./object-store.js";

function resolver(configuration: Record<string, unknown> = {}): PrismaRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      kind: "S3",
      baseUrl: "https://s3.mpm.internal",
      configuration: { bucket: "aihub-documents", region: "ap-southeast-3", ...configuration },
      secrets: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "temporary-session",
      },
    })),
  } as unknown as PrismaRuntimeConnectionResolver;
}

describe("S3DocumentStore", () => {
  it("uses the generic S3 connection with virtual-hosted addressing by default", async () => {
    const sentCommands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      sentCommands.push(command);
      return {};
    });
    const destroy = vi.fn();
    let clientConfiguration: S3ClientConfiguration | undefined;
    const factory: S3ClientFactory = (configuration) => {
      clientConfiguration = configuration;
      return { send, destroy } as unknown as Pick<S3Client, "send" | "destroy">;
    };
    const connectionResolver = resolver();

    await new S3DocumentStore(connectionResolver, factory)
      .putBuffer("documents/example.txt", new TextEncoder().encode("hello"), "text/plain");

    expect(connectionResolver.resolveOne).toHaveBeenCalledWith("S3");
    expect(clientConfiguration).toMatchObject({
      endpoint: "https://s3.mpm.internal",
      region: "ap-southeast-3",
      forcePathStyle: false,
      maxAttempts: 3,
      credentials: { sessionToken: "temporary-session" },
    });
    expect(sentCommands[0]).toBeInstanceOf(PutObjectCommand);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("batches deletes to the S3 API maximum and honors explicit path style", async () => {
    const sentCommands: unknown[] = [];
    let clientConfiguration: S3ClientConfiguration | undefined;
    const send = vi.fn(async (command: unknown) => {
      sentCommands.push(command);
      return {};
    });
    const destroy = vi.fn();
    const factory: S3ClientFactory = (configuration) => {
      clientConfiguration = configuration;
      return { send, destroy } as unknown as Pick<S3Client, "send" | "destroy">;
    };
    const keys = Array.from({ length: 1_001 }, (_, index) => `documents/${index}`);

    await new S3DocumentStore(resolver({ forcePathStyle: true }), factory).delete(keys);

    const commands = sentCommands.filter(
      (command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand,
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.input.Delete?.Objects?.length)).toEqual([1_000, 1]);
    expect(clientConfiguration).toMatchObject({ forcePathStyle: true });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

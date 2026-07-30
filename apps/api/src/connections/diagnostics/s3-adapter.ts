import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { booleanConfiguration, stringConfiguration } from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

export class S3Adapter implements ConnectionDiagnosticAdapter {
  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    if (!connection.baseUrl) throw new Error("S3 endpoint URL is not configured.");
    const accessKeyId = connection.secrets.accessKeyId;
    const secretAccessKey = connection.secrets.secretAccessKey;
    const bucket = stringConfiguration(connection, "bucket");
    if (!accessKeyId || !secretAccessKey || !bucket) {
      return {
        status: "DEGRADED",
        message: "S3 bucket or credentials are incomplete.",
        details: { configuration: "incomplete" },
      };
    }

    const client = new S3Client({
      endpoint: connection.baseUrl,
      region: stringConfiguration(connection, "region") ?? "us-east-1",
      forcePathStyle: booleanConfiguration(connection, "forcePathStyle") ?? false,
      maxAttempts: 1,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(connection.secrets.sessionToken ? { sessionToken: connection.secrets.sessionToken } : {}),
      },
    });

    try {
      const response = await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal });
      return {
        status: "HEALTHY",
        message: `S3 bucket '${bucket}' is reachable.`,
        details: { httpStatus: response.$metadata.httpStatusCode ?? 200, bucket },
      };
    } finally {
      client.destroy();
    }
  }
}

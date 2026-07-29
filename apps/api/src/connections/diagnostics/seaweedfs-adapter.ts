import { HeadBucketCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { booleanConfiguration, stringConfiguration } from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

export class SeaweedFsAdapter implements ConnectionDiagnosticAdapter {
  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    if (!connection.baseUrl) throw new Error("SeaweedFS S3 endpoint URL is not configured.");
    const accessKeyId = connection.secrets.accessKeyId;
    const secretAccessKey = connection.secrets.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      return {
        status: "DEGRADED",
        message: "SeaweedFS credentials are incomplete.",
        details: { authentication: "missing" },
      };
    }

    const bucket = stringConfiguration(connection, "bucket");
    const client = new S3Client({
      endpoint: connection.baseUrl,
      region: stringConfiguration(connection, "region") ?? "us-east-1",
      forcePathStyle: booleanConfiguration(connection, "forcePathStyle") ?? true,
      credentials: { accessKeyId, secretAccessKey },
    });

    try {
      const response = bucket
        ? await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal })
        : await client.send(new ListBucketsCommand({}), { abortSignal: signal });
      return {
        status: "HEALTHY",
        message: bucket
          ? `SeaweedFS bucket '${bucket}' is reachable.`
          : "SeaweedFS S3 API is reachable and authenticated.",
        details: {
          httpStatus: response.$metadata.httpStatusCode ?? 200,
          ...(bucket ? { bucket } : {}),
        },
      };
    } finally {
      client.destroy();
    }
  }
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createPrismaClient, readBootstrapSecret } from "@aihub/database";
import { PgBossQueueService } from "@aihub/jobs";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@aihub/security";
import {
  PrismaRuntimeConnectionResolver,
  HermesClient,
  S3DocumentStore,
  SupermemoryClient,
  UnlimitedOcrClient,
} from "@aihub/document-runtime";
import { WorkerRuntime } from "./worker-runtime.js";
import { PrismaWorkerRegistry } from "./worker-registry.js";
import { PrismaDocumentProcessor } from "./document-processor.js";
import { PrismaMemoryProcessor } from "./memory-processor.js";
import { PrismaAgentProcessor, WorkerAgentKnowledgeRetriever } from "./agent-processor.js";
import { PrismaToolActionProcessor } from "./tool-action-processor.js";

const databaseUrl = readBootstrapSecret("aihub_database_url");
const prisma = createPrismaClient(databaseUrl);
const workerId = randomUUID();
const queue = new PgBossQueueService(databaseUrl, "worker", {
  error: (message, error) => console.error(message, error),
  warn: (message, details) => console.warn(message, details),
});
const masterKey = decodeMasterKey(readBootstrapSecret("aihub_master_key"));
const encryption = new EnvelopeEncryption({ masterKey });
const documentResolver = new PrismaRuntimeConnectionResolver(prisma, encryption);
const documentProcessor = new PrismaDocumentProcessor(
  prisma,
  new S3DocumentStore(documentResolver),
  new UnlimitedOcrClient(documentResolver),
  queue,
);
const runtime = new WorkerRuntime(
  queue,
  new PrismaWorkerRegistry(prisma),
  {
    id: workerId,
    name: hostname(),
    version: "0.1.0",
    queues: ["aihub.system.probe", "aihub.documents.convert", "aihub.documents.ocr", "aihub.memory.index", "aihub.agents.run"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
  15_000,
  documentProcessor,
  new PrismaMemoryProcessor(prisma, new SupermemoryClient(documentResolver)),
  new PrismaAgentProcessor(
    prisma,
    new HermesClient(documentResolver),
    new WorkerAgentKnowledgeRetriever(prisma, new SupermemoryClient(documentResolver)),
    new RunCapabilityIssuer(masterKey),
  ),
  new PrismaToolActionProcessor(prisma, queue),
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.stop();
  } catch (error) {
    console.error("AIHub worker shutdown was incomplete.", error);
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error("AIHub worker database disconnect failed.", error);
      process.exitCode = 1;
    }
  }
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

try {
  await runtime.start();
} catch (error) {
  console.error("AIHub worker failed to start.", error);
  await prisma.$disconnect().catch((disconnectError) =>
    console.error("AIHub worker database disconnect failed.", disconnectError),
  );
  process.exitCode = 1;
}

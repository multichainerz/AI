import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createPrismaClient, readBootstrapSecret } from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@orcasynapse/security";
import {
  PrismaRuntimeConnectionResolver,
  documentScratchDirectory,
  EncryptedFileSystemDocumentScratchStore,
  HermesClient,
  SupermemoryClient,
} from "@orcasynapse/document-runtime";
import { WorkerRuntime } from "./worker-runtime.js";
import { PrismaWorkerRegistry } from "./worker-registry.js";
import { PrismaDocumentProcessor } from "./document-processor.js";
import { PrismaMemoryProcessor } from "./memory-processor.js";
import { PrismaAgentProcessor, WorkerAgentKnowledgeRetriever } from "./agent-processor.js";
import { PrismaToolActionProcessor } from "./tool-action-processor.js";

const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
const prisma = createPrismaClient(databaseUrl);
const workerId = randomUUID();
const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
const encryption = new EnvelopeEncryption({ masterKey });
const documentResolver = new PrismaRuntimeConnectionResolver(prisma, encryption);
const documentStore = new EncryptedFileSystemDocumentScratchStore(documentScratchDirectory(), masterKey);
const documentProcessor = new PrismaDocumentProcessor(
  prisma,
  documentStore,
);
const runtime = new WorkerRuntime(
  prisma,
  new PrismaWorkerRegistry(prisma),
  {
    id: workerId,
    name: hostname(),
    version: "0.1.0",
    workloads: ["documents", "memory", "agents", "tool-actions"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
  15_000,
  documentProcessor,
  new PrismaMemoryProcessor(prisma, new SupermemoryClient(documentResolver), documentStore),
  new PrismaAgentProcessor(
    prisma,
    new HermesClient(documentResolver),
    new WorkerAgentKnowledgeRetriever(prisma, new SupermemoryClient(documentResolver)),
    new RunCapabilityIssuer(masterKey),
  ),
  new PrismaToolActionProcessor(prisma),
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.stop();
  } catch (error) {
    console.error("OrcaSynapse worker shutdown was incomplete.", error);
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch (error) {
      console.error("OrcaSynapse worker database disconnect failed.", error);
      process.exitCode = 1;
    }
  }
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

try {
  await runtime.start();
} catch (error) {
  console.error("OrcaSynapse worker failed to start.", error);
  await prisma.$disconnect().catch((disconnectError) =>
    console.error("OrcaSynapse worker database disconnect failed.", disconnectError),
  );
  process.exitCode = 1;
}

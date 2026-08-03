import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { createPrismaClient, readBootstrapSecret } from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@orcasynapse/security";
import {
  PrismaRuntimeConnectionResolver,
  HermesClient,
  SupermemoryClient,
} from "@orcasynapse/document-runtime";
import { WorkerRuntime } from "./worker-runtime.js";
import { PrismaWorkerRegistry } from "./worker-registry.js";
import { PrismaAgentProcessor, WorkerAgentKnowledgeRetriever } from "./agent-processor.js";

const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
const prisma = createPrismaClient(databaseUrl);
const workerId = randomUUID();
const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
const encryption = new EnvelopeEncryption({ masterKey });
const documentResolver = new PrismaRuntimeConnectionResolver(prisma, encryption);
const runtime = new WorkerRuntime(
  prisma,
  new PrismaWorkerRegistry(prisma),
  {
    id: workerId,
    name: hostname(),
    version: ORCASYNAPSE_VERSION,
    workloads: ["hermes-runs"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
  15_000,
  new PrismaAgentProcessor(
    prisma,
    new HermesClient(documentResolver),
    new WorkerAgentKnowledgeRetriever(prisma, new SupermemoryClient(documentResolver)),
    new RunCapabilityIssuer(masterKey),
  ),
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

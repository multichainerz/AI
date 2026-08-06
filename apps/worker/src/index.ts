import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { createDrizzleClient, readBootstrapSecret } from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@orcasynapse/security";
import { AgentMemoryStore, APPROVED_EMBEDDING_MODEL, DocumentVectorStore, LocalBgeM3Embedder } from "@orcasynapse/knowledge";
import { DrizzleRuntimeConnectionResolver, HermesClient } from "@orcasynapse/runtime-clients";
import { SessionMemoryDistiller } from "./session-distiller.js";
import { WorkerRuntime } from "./worker-runtime.js";
import { DocumentIngestor } from "./document-ingestor.js";
import { DrizzlePendingRunSource, DrizzleWorkerRegistry } from "./worker-registry.js";
import { DrizzleAgentProcessor, WorkerAgentKnowledgeRetriever, WorkerAgentMemory } from "./agent-processor.js";
import { MemoryDistiller } from "./memory-distiller.js";

const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
const { database, close: closeDatabase } = createDrizzleClient(databaseUrl);
const workerId = randomUUID();
const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
const encryption = new EnvelopeEncryption({ masterKey });
const connectionResolver = new DrizzleRuntimeConnectionResolver(database, encryption);
const embedder = new LocalBgeM3Embedder();
// Shared by the per-run path and the session sweep so both apply the same
// store, the same embedder, and the same policy.
const agentMemory = new WorkerAgentMemory(
  new AgentMemoryStore(database, APPROVED_EMBEDDING_MODEL),
  embedder,
);
const distiller = new MemoryDistiller(connectionResolver);

const runtime = new WorkerRuntime(
  new DrizzlePendingRunSource(database),
  new DrizzleWorkerRegistry(database),
  {
    id: workerId,
    name: hostname(),
    version: ORCASYNAPSE_VERSION,
    workloads: ["hermes-runs", "knowledge-ingestion", "session-memory"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
  15_000,
  new DrizzleAgentProcessor(
    database,
    new HermesClient(connectionResolver),
    new WorkerAgentKnowledgeRetriever(
      new DocumentVectorStore(database, APPROVED_EMBEDDING_MODEL),
      embedder,
    ),
    new RunCapabilityIssuer(masterKey),
    agentMemory,
    distiller,
  ),
  1_000,
  5,
  new DocumentIngestor(
    database,
    new DocumentVectorStore(database, APPROVED_EMBEDDING_MODEL),
    embedder,
  ),
  new SessionMemoryDistiller(database, agentMemory, distiller),
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
      await closeDatabase();
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
  await closeDatabase().catch((closeError) =>
    console.error("OrcaSynapse worker database pool close failed.", closeError),
  );
  process.exitCode = 1;
}

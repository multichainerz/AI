import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { createDrizzleClient, listenForAgentRunWake, readBootstrapSecret } from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@orcasynapse/security";
import { AgentMemoryStore, APPROVED_EMBEDDING_MODEL, DocumentVectorStore, LocalBgeM3Embedder } from "@orcasynapse/knowledge";
import { DrizzleRuntimeConnectionResolver, HermesClient } from "@orcasynapse/runtime-clients";
import { SessionMemoryDistiller } from "./session-distiller.js";
import { WorkerRuntime } from "./worker-runtime.js";
import { DocumentIngestor } from "./document-ingestor.js";
import { DrizzlePendingRunSource, DrizzleWorkerRegistry } from "./worker-registry.js";
import { DrizzleAgentProcessor, WorkerAgentKnowledgeRetriever, WorkerAgentMemory } from "./agent-processor.js";
import { MemoryDistiller } from "./memory-distiller.js";
import { BenchmarkRunner } from "./benchmark-runner.js";
import { LiveBenchmarkExecutor } from "./benchmark-executor.js";

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
// Shared with the benchmark executor so a retrieval suite searches through
// exactly the path a conversation searches through.
const knowledgeRetriever = new WorkerAgentKnowledgeRetriever(
  new DocumentVectorStore(database, APPROVED_EMBEDDING_MODEL),
  embedder,
);

const runtime = new WorkerRuntime(
  new DrizzlePendingRunSource(database),
  new DrizzleWorkerRegistry(database),
  {
    id: workerId,
    name: hostname(),
    version: ORCASYNAPSE_VERSION,
    workloads: ["hermes-runs", "knowledge-ingestion", "session-memory", "benchmarks"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
  15_000,
  new DrizzleAgentProcessor(
    database,
    new HermesClient(connectionResolver),
    knowledgeRetriever,
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
  60_000,
  new BenchmarkRunner(
    database,
    new LiveBenchmarkExecutor(database, knowledgeRetriever, agentMemory),
  ),
);

/*
 * Wakes the dispatcher the moment the API commits a run.
 *
 * The reconcile timer is unchanged and still guarantees pickup; this only
 * removes the wait. A message on an idle installation used to sit for up to a
 * full second before any work began, which was pure latency on every single
 * chat turn.
 *
 * Failure here is deliberately not fatal, and now actually is. The channel
 * connects in the background and retries on its own, including on its first
 * attempt -- which used to reject and leave the wake dead for the life of the
 * process, exactly the case this comment already claimed was survivable.
 */
const wake = listenForAgentRunWake(
  databaseUrl,
  () => void runtime.dispatchNow(),
  (error) => console.error("OrcaSynapse worker wake channel error.", error),
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await wake?.stop();
  } catch (error) {
    console.error("OrcaSynapse worker wake channel did not close cleanly.", error);
  }
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
  // Loads the embedding weights now rather than inside the first chat message.
  // The pipeline resolves lazily, so before this the first person to type
  // anything after a restart waited for ~2 GB of weights to load before their
  // question even reached Hermes.
  void embedder.embed(["orcasynapse embedder warmup"]).then(
    () => console.info("OrcaSynapse worker embedding model is warm."),
    (error: unknown) => console.error("OrcaSynapse worker could not warm the embedding model.", error),
  );
} catch (error) {
  console.error("OrcaSynapse worker failed to start.", error);
  await closeDatabase().catch((closeError) =>
    console.error("OrcaSynapse worker database pool close failed.", closeError),
  );
  process.exitCode = 1;
}

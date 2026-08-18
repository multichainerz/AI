import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { createDrizzleClient, listenForAgentRunWake, readBootstrapSecret } from "@orcasynapse/database";
import { decodeMasterKey, EnvelopeEncryption, RunCapabilityIssuer } from "@orcasynapse/security";
import { DrizzleRuntimeConnectionResolver, HermesClient } from "@orcasynapse/runtime-clients";
import { WorkerRuntime } from "./worker-runtime.js";
import { DrizzlePendingRunSource, DrizzleWorkerRegistry } from "./worker-registry.js";
import { DrizzleAgentProcessor } from "./agent-processor.js";
import { InferenceMemoryExtractor } from "./memory-extractor.js";

const databaseUrl = readBootstrapSecret("orcasynapse_database_url");
const { database, close: closeDatabase } = createDrizzleClient(databaseUrl);
const workerId = randomUUID();
const masterKey = decodeMasterKey(readBootstrapSecret("orcasynapse_master_key"));
const encryption = new EnvelopeEncryption({ masterKey });
const connectionResolver = new DrizzleRuntimeConnectionResolver(database, encryption);

const runtime = new WorkerRuntime(
  new DrizzlePendingRunSource(database),
  new DrizzleWorkerRegistry(database),
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
  new DrizzleAgentProcessor(
    database,
    new HermesClient(connectionResolver),
    new RunCapabilityIssuer(masterKey),
    new InferenceMemoryExtractor(database, connectionResolver),
  ),
  1_000,
  5,
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
} catch (error) {
  console.error("OrcaSynapse worker failed to start.", error);
  /*
   * The wake channel is stopped here as well as in `shutdown()`, because
   * `process.exitCode` is a request to exit and not an exit: node leaves when
   * nothing is left holding the event loop, and the channel holds a dedicated
   * client whose socket is ref'd. Closing only the pool left this process alive
   * indefinitely with no `WorkerNode` row and no heartbeat -- and because the
   * worker container has `restart: unless-stopped` and no healthcheck, Docker
   * reported it running while every chat turn stalled, and the restart that
   * would have cleared a transient fault never came.
   *
   * The API's entrypoint has always done the equivalent (`await app.close()`
   * before setting the code); this brings the worker in line with it.
   */
  await wake?.stop().catch((stopError) =>
    console.error("OrcaSynapse worker wake channel did not close cleanly.", stopError),
  );
  await closeDatabase().catch((closeError) =>
    console.error("OrcaSynapse worker database pool close failed.", closeError),
  );
  process.exitCode = 1;
}

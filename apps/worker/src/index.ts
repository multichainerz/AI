import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createPrismaClient, readBootstrapSecret } from "@aihub/database";
import { PgBossQueueService } from "@aihub/jobs";
import { WorkerRuntime } from "./worker-runtime.js";
import { PrismaWorkerRegistry } from "./worker-registry.js";

const databaseUrl = readBootstrapSecret("aihub_database_url");
const prisma = createPrismaClient(databaseUrl);
const workerId = randomUUID();
const queue = new PgBossQueueService(databaseUrl, "worker", {
  error: (message, error) => console.error(message, error),
  warn: (message, details) => console.warn(message, details),
});
const runtime = new WorkerRuntime(
  queue,
  new PrismaWorkerRegistry(prisma),
  {
    id: workerId,
    name: hostname(),
    version: "0.1.0",
    queues: ["aihub.system.probe"],
  },
  {
    info: (message) => console.info(message),
    error: (message, error) => console.error(message, error),
  },
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

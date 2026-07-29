import { readBootstrapSecret } from "@aihub/database";
import { PgBossQueueService } from "./queue-service.js";

const queueService = new PgBossQueueService(
  readBootstrapSecret("aihub_database_url"),
  "migration",
  {
    error: (message) => console.error(message),
    warn: (message) => console.warn(message),
  },
);

try {
  await queueService.start({ ensureQueues: true });
  console.info("AIHub pg-boss schema and queues are ready.");
} finally {
  await queueService.stop();
}

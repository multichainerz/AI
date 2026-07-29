import { createApp } from "./app.js";

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    app?.log.info({ signal }, "AIHub API shutdown started");
    await app?.close();
  } catch (error) {
    app?.log.error(error, "AIHub API shutdown was incomplete");
    process.exitCode = 1;
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  app = await createApp();
  await app.listen({ host: "0.0.0.0", port: 4000 });
} catch (error) {
  if (app) {
    app.log.error(error);
    await app.close().catch((closeError) => app?.log.error(closeError));
  } else {
    console.error("AIHub API failed to initialize.", error);
  }
  process.exitCode = 1;
}

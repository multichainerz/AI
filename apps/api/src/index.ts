import { createApp } from "./app.js";

let app: Awaited<ReturnType<typeof createApp>> | undefined;
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

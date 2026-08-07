import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const developmentApiTarget = process.env.VITE_DEV_API_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    // 5173 unless the environment assigns one. Nothing external depends on the
    // number - the OIDC callback is served by the API, not by this port - so a
    // supervisor is free to place the dev server wherever it has room.
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      "/api": developmentApiTarget,
      "/install": developmentApiTarget,
      "/healthz": developmentApiTarget,
      "/readyz": developmentApiTarget,
    },
  },
});

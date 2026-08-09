import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const developmentApiTarget = process.env.VITE_DEV_API_TARGET ?? "http://localhost:4000";

/**
 * In dev, read the contracts from source rather than from its build output.
 *
 * `@orcasynapse/contracts` resolves through its package `exports` to
 * `dist/index.js`, and every workspace build script starts by deleting `dist`
 * outright. So running `pnpm build` or `pnpm verify` beside a live dev server
 * removed the directory the server was serving from, and the page died with
 * `Failed to resolve import "./agents.js"` until someone reloaded — a failure
 * that looks like a broken contract and is really a race with the build.
 *
 * Pointing dev at `src` removes the shared file entirely: the build can delete
 * `dist` whenever it likes, and contract edits now hot-reload instead of
 * needing a rebuild. Serve only — `vite build` still consumes `dist`, so the
 * production bundle, the CSP closure gate and the dist-based checks all see
 * exactly what they saw before.
 */
const contractsSource = fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: command === "serve" ? { alias: { "@orcasynapse/contracts": contractsSource } } : {},
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
}));

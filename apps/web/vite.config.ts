import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const developmentApiTarget = process.env.VITE_DEV_API_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": developmentApiTarget,
      "/install": developmentApiTarget,
      "/healthz": developmentApiTarget,
      "/readyz": developmentApiTarget,
    },
  },
});

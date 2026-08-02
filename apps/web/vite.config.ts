import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/install": "http://localhost:4000",
      "/healthz": "http://localhost:4000",
      "/readyz": "http://localhost:4000",
    },
  },
});

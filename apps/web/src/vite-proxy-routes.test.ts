import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { developmentProxyRoutes } from "../vite.config.js";

const nginxConfiguration = readFileSync(
  new URL("../../../deploy/nginx/default.conf", import.meta.url),
  "utf8",
);

const requiredRoutes = [
  { request: "/api/v1/admin/session", nginxLocation: "location /api/ {" },
  { request: "/internal/v1/chat/completions", nginxLocation: "location /internal/v1/ {" },
  { request: "/install/agentic-node.sh", nginxLocation: "location /install/ {" },
  { request: "/healthz", nginxLocation: "location = /healthz {" },
  { request: "/readyz", nginxLocation: "location = /readyz {" },
] as const;

describe("development proxy route coverage", () => {
  it.each(requiredRoutes)("keeps $request reachable through Vite and production Nginx", ({ request, nginxLocation }) => {
    expect(Object.keys(developmentProxyRoutes).some((prefix) => request.startsWith(prefix))).toBe(true);
    expect(nginxConfiguration).toContain(nginxLocation);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdministratorSession, OidcStatus } from "@orcasynapse/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  ENTERPRISE_SESSION_COOKIE,
  OIDC_STATE_COOKIE,
  type EnterpriseIdentityManager,
  type IssuedEnterpriseSession,
  type OidcLoginStart,
} from "../identity/enterprise-session.js";
import {
  ADMIN_SESSION_COOKIE,
  type AdminSessionManager,
  type IssuedAdminSession,
} from "./admin-session.js";

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

const NGINX_CONFIG = repoFile("deploy/nginx/default.conf");
const DOCKERFILE_WEB = repoFile("Dockerfile.web");
const COMPOSE = repoFile("compose.yaml");

/**
 * The config with comments removed. The rejected alternatives are named in the
 * prose above the directives -- which is where they belong -- so a search of the
 * raw file for "must never appear" variables matches the explanation as well as
 * a real regression.
 */
const NGINX_DIRECTIVES = NGINX_CONFIG.replace(/#.*$/gm, "");

/** The nginx variable every proxying location must forward, and nothing else. */
const FORWARDED_PROTO_VARIABLE = "$orcasynapse_forwarded_proto";
/** The operator's declaration, substituted into the config by the image's envsubst pass. */
const PUBLIC_SCHEME_VARIABLE = "ORCASYNAPSE_PUBLIC_SCHEME";

function headerValues(name: string): string[] {
  return [...NGINX_CONFIG.matchAll(new RegExp(`proxy_set_header\\s+${name}\\s+([^;]+);`, "gi"))]
    .map(([, value]) => value!.trim());
}

/**
 * Reproduces the two steps between this config and the header the API receives:
 * the nginx image's envsubst pass substitutes ${ORCASYNAPSE_PUBLIC_SCHEME}, then
 * nginx evaluates the map. The arms are read out of the config rather than
 * restated here, so editing the map changes what this test predicts instead of
 * quietly disagreeing with it. Checked against nginx 1.29 in Docker for https,
 * HTTPS, http, a typo, an empty value and an unset variable.
 */
function forwardedProtoFor(declaredScheme: string): string {
  const block = new RegExp(
    `map\\s+"\\$\\{${PUBLIC_SCHEME_VARIABLE}\\}"\\s+\\${FORWARDED_PROTO_VARIABLE}\\s*\\{([^}]*)\\}`,
  ).exec(NGINX_CONFIG);
  if (!block?.[1]) {
    throw new Error(
      `deploy/nginx/default.conf has no map from \${${PUBLIC_SCHEME_VARIABLE}} to ${FORWARDED_PROTO_VARIABLE}`,
    );
  }
  const arms = block[1]
    .split("\n")
    .map((line) => line.trim().replace(/;$/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(/\s+/))
    .map(([key, value]) => ({ key: key ?? "", value: value ?? "" }));

  // nginx resolves exact keys before regular expressions, and falls to default.
  const exact = arms.find((arm) => arm.key === declaredScheme);
  if (exact) return exact.value;
  const matched = arms.find((arm) => {
    if (!arm.key.startsWith("~")) return false;
    const caseInsensitive = arm.key.startsWith("~*");
    return new RegExp(arm.key.slice(caseInsensitive ? 2 : 1), caseInsensitive ? "i" : "").test(declaredScheme);
  });
  if (matched) return matched.value;
  return arms.find((arm) => arm.key === "default")?.value ?? "";
}

/** What an operator gets with nothing configured: the scheme the image itself pins. */
function imageDefaultScheme(): string {
  const pinned = /^ENV\s+ORCASYNAPSE_PUBLIC_SCHEME=(\S+)/m.exec(DOCKERFILE_WEB)?.[1];
  if (!pinned) {
    throw new Error("Dockerfile.web does not pin ENV ORCASYNAPSE_PUBLIC_SCHEME");
  }
  return pinned;
}

const SESSION_TOKEN = "s".repeat(43);
const STATE_TOKEN = "t".repeat(43);
const ENTERPRISE_TOKEN = "e".repeat(43);
const principal: AdministratorSession = {
  id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
  subject: "local-admin:6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
  role: "PLATFORM_ADMIN",
  scopes: ["connections:read"],
  createdAt: "2026-08-07T00:00:00.000Z",
  idleExpiresAt: "2026-08-07T00:15:00.000Z",
  absoluteExpiresAt: "2026-08-07T08:00:00.000Z",
  authenticationMethod: "LOCAL_PASSWORD",
  passwordChangeRequired: false,
};

const sessionManager: AdminSessionManager = {
  async createInstallationKeySession(): Promise<IssuedAdminSession | null> {
    return null;
  },
  async createLocalPasswordSession(): Promise<IssuedAdminSession | null> {
    return { token: SESSION_TOKEN, principal };
  },
  async authenticate() {
    return null;
  },
  async revoke() {
    return false;
  },
};

const identityManager: EnterpriseIdentityManager = {
  async status(): Promise<OidcStatus> {
    return { configured: true, administratorSignIn: false, message: "Enterprise sign-in is configured." };
  },
  async startLogin(): Promise<OidcLoginStart> {
    return { authorizationUrl: "https://idp.example.internal/authorize", stateToken: STATE_TOKEN };
  },
  async signInWithPassword(): Promise<never> {
    throw new Error("Not used");
  },
  async completeLogin(): Promise<IssuedEnterpriseSession> {
    // The callback emits three cookies at once -- the expired OIDC state, the
    // enterprise session, and a federated administrator session -- and all three
    // take the same secure flag, so the group is worth asserting together.
    return {
      token: ENTERPRISE_TOKEN,
      returnTo: "/",
      principal: {
        id: "0f0a0a4e-0a3d-4a3c-9d3f-7d1b6f4e2c11",
        subject: "user:0f0a0a4e-0a3d-4a3c-9d3f-7d1b6f4e2c11",
        identityMode: "ENTERPRISE",
        displayName: "Enterprise user",
        email: null,
        scopes: ["chat:use", "agents:use"], divisionId: null,
        session: {
          id: "0f0a0a4e-0a3d-4a3c-9d3f-7d1b6f4e2c11",
          identityMode: "ENTERPRISE",
          user: { id: "0f0a0a4e-0a3d-4a3c-9d3f-7d1b6f4e2c11", displayName: "Enterprise user", email: null },
          scopes: ["chat:use", "agents:use"],
          createdAt: "2026-08-07T00:00:00.000Z",
          idleExpiresAt: "2026-08-07T08:00:00.000Z",
          absoluteExpiresAt: "2026-08-07T12:00:00.000Z",
        },
      },
      administratorSession: { token: SESSION_TOKEN, principal },
    };
  },
  async authenticate() {
    return null;
  },
  async revoke() {
    return false;
  },
};

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** The API as it actually runs, reached the way the bundled proxy reaches it. */
async function inject(url: string, forwardedProto: string) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager, identityManager },
  });
  apps.push(app);
  return app.inject({
    method: url.includes("oidc") ? "GET" : "POST",
    url,
    headers: { "x-forwarded-proto": forwardedProto },
    ...(url.includes("oidc") ? {} : { payload: { username: "admin", password: "temporary-password" } }),
  });
}

function cookies(setCookie: string | string[] | undefined): string[] {
  return typeof setCookie === "string" ? [setCookie] : setCookie ?? [];
}

function cookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf("="));
}

describe("bundled reverse proxy forwarding headers", () => {
  it("lets the forwarded header decide request.protocol, which is why the proxy must own it", async () => {
    // Not a defect, but the reason every assertion below matters: the API runs
    // with trustProxy, so whatever arrives as X-Forwarded-Proto becomes
    // request.protocol, and request.protocol is what auth/routes.ts and
    // identity/routes.ts read to decide whether a session cookie carries Secure.
    const app = Fastify({ logger: false, trustProxy: 1 });
    app.get("/protocol", async (request) => ({ protocol: request.protocol }));

    const response = await app.inject({
      method: "GET",
      url: "/protocol",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(response.json()).toEqual({ protocol: "https" });
    await app.close();
  });

  it("forwards an operator-declared scheme, never a value taken from the request", () => {
    const forwardedProto = headerValues("X-Forwarded-Proto");
    const forwardedFor = headerValues("X-Forwarded-For");

    expect(forwardedProto.length).toBeGreaterThan(0);
    expect(forwardedProto).toEqual(forwardedProto.map(() => FORWARDED_PROTO_VARIABLE));
    expect(forwardedFor).toEqual(forwardedFor.map(() => "$remote_addr"));
    // The map source has to be the envsubst placeholder. Any $http_ variable
    // would hand the Secure decision back to whoever sent the request.
    expect(NGINX_CONFIG).toMatch(
      new RegExp(`map\\s+"\\$\\{${PUBLIC_SCHEME_VARIABLE}\\}"\\s+\\${FORWARDED_PROTO_VARIABLE}`),
    );
    expect(NGINX_DIRECTIVES).not.toMatch(/\$http_x_forwarded_proto/i);
    expect(NGINX_DIRECTIVES).not.toMatch(/\$http_forwarded/i);
    expect(NGINX_DIRECTIVES).not.toMatch(/\$proxy_add_x_forwarded_for/i);
    // $scheme is this server's own listener, which is plain HTTP: reporting it
    // would deny Secure to every deployment that terminates TLS upstream.
    expect(forwardedProto).not.toContain("$scheme");
  });

  it("resolves to https only for a literal https declaration", () => {
    expect(forwardedProtoFor("https")).toBe("https");
    expect(forwardedProtoFor("HTTPS")).toBe("https");
    expect(forwardedProtoFor("http")).toBe("http");
    expect(forwardedProtoFor("")).toBe("http");
    expect(forwardedProtoFor("htps")).toBe("http");
    expect(forwardedProtoFor("https-terminated-upstream")).toBe("http");
  });

  it("pins the safe declaration in the image and in Compose", () => {
    // envsubst leaves ${ORCASYNAPSE_PUBLIC_SCHEME} in place when the variable is
    // unset, and nginx then refuses to start on an unknown variable -- verified
    // against nginx 1.29. The image default is what keeps that unreachable, so
    // the template has to be installed where the entrypoint renders it.
    expect(DOCKERFILE_WEB).toMatch(
      /COPY\s+deploy\/nginx\/default\.conf\s+\/etc\/nginx\/templates\/default\.conf\.template/,
    );
    expect(forwardedProtoFor(imageDefaultScheme())).toBe("http");
    // Without the filter, an environment variable named "host" or "uri" is
    // substituted into the template and $host stops being nginx's own variable.
    expect(DOCKERFILE_WEB).toMatch(/^ENV\s+NGINX_ENVSUBST_FILTER=\^ORCASYNAPSE_/m);
    expect(COMPOSE).toMatch(/ORCASYNAPSE_PUBLIC_SCHEME:\s*\$\{ORCASYNAPSE_PUBLIC_SCHEME:-http\}/);
  });

  it("marks the administrator session cookie Secure only when the operator declared https", async () => {
    const declared = await inject("/api/v1/admin/session/local", forwardedProtoFor("https"));
    expect(declared.statusCode).toBe(201);
    expect(cookies(declared.headers["set-cookie"]).join("\n")).toContain("Secure");

    const unconfigured = await inject("/api/v1/admin/session/local", forwardedProtoFor(imageDefaultScheme()));
    expect(unconfigured.statusCode).toBe(201);
    expect(cookies(unconfigured.headers["set-cookie"]).join("\n")).not.toContain("Secure");
  });

  it("gives every enterprise sign-in cookie the same decision", async () => {
    const started = await inject("/api/v1/auth/oidc/start?returnTo=/", forwardedProtoFor("https"));
    expect(started.statusCode).toBe(302);
    expect(cookies(started.headers["set-cookie"]).join("\n")).toContain("Secure");

    const startedPlain = await inject(
      "/api/v1/auth/oidc/start?returnTo=/",
      forwardedProtoFor(imageDefaultScheme()),
    );
    expect(startedPlain.statusCode).toBe(302);
    expect(cookies(startedPlain.headers["set-cookie"]).join("\n")).not.toContain("Secure");

    // The callback is where enterprise-session.ts issues the session cookies the
    // browser keeps, so each one is checked rather than the batch as a string.
    const callback = `/api/v1/auth/oidc/callback?code=authorization-code&state=${STATE_TOKEN}`;
    const expectedNames = [ENTERPRISE_SESSION_COOKIE, ADMIN_SESSION_COOKIE, OIDC_STATE_COOKIE];

    const completed = await inject(callback, forwardedProtoFor("https"));
    const completedCookies = cookies(completed.headers["set-cookie"]);
    expect(completed.statusCode).toBe(302);
    expect(completedCookies.map(cookieName)).toEqual(expect.arrayContaining(expectedNames));
    expect(completedCookies.filter((cookie) => cookie.includes("Secure"))).toEqual(completedCookies);

    const completedPlain = await inject(callback, forwardedProtoFor(imageDefaultScheme()));
    const plainCookies = cookies(completedPlain.headers["set-cookie"]);
    expect(completedPlain.statusCode).toBe(302);
    expect(plainCookies.map(cookieName)).toEqual(expect.arrayContaining(expectedNames));
    expect(plainCookies.filter((cookie) => cookie.includes("Secure"))).toEqual([]);
  });
});

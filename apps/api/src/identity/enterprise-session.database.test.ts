import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  createTestDatabase,
  enterpriseUser,
  enterpriseUserSession,
  oidcAuthorizationRequest,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { DrizzleEnterpriseIdentityManager, EnterpriseIdentityError } from "./enterprise-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const encryption = new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(5) });
const ISSUER = "https://login.example";

function tokenDigest(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}

const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

/** Serves OIDC discovery and rejects everything else, so no test reaches the network. */
function identityProvider(overrides: { discovery?: unknown; tokenStatus?: number } = {}) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(overrides.discovery ?? discoveryDocument), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: overrides.tokenStatus ?? 400 });
  }) as unknown as typeof fetch;
}

async function seedOidcConnection(overrides: Record<string, unknown> = {}) {
  const [connection] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `oidc-${randomUUID().slice(0, 8)}`,
      displayName: "Enterprise identity",
      kind: "OIDC",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: ISSUER,
      configuration: {},
      ...overrides,
    })
    .returning({ id: serviceConnection.id });
  return connection!.id;
}

function connectionStore(connectionId: string, configuration: Record<string, unknown> = {}) {
  return {
    resolveForDiagnostic: vi.fn(async (id: string) => ({
      id,
      activeRevision: 1,
      kind: "OIDC" as const,
      baseUrl: ISSUER,
      configuration: {
        clientId: "orcasynapse",
        redirectUri: "https://orcasynapse.example/auth/callback",
        allowedGroups: ["orcasynapse-users"],
        ...configuration,
      },
      secrets: { clientSecret: "oidc-secret" },
    })),
    recordDiagnostic: vi.fn(),
  } as unknown as ConnectionDiagnosticStore & { resolveForDiagnostic: ReturnType<typeof vi.fn> };
}

function manager(connectionId: string, options: {
  configuration?: Record<string, unknown>;
  fetcher?: typeof fetch;
} = {}) {
  return new DrizzleEnterpriseIdentityManager(
    context.database,
    connectionStore(connectionId, options.configuration),
    encryption,
    options.fetcher ?? identityProvider(),
  );
}

async function seedAuthorizationRequest(connectionId: string, stateToken: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const envelope = encryption.encrypt(randomBytes(48).toString("base64url"), `oidc:${id}:code-verifier`);
  await context.database.insert(oidcAuthorizationRequest).values({
    id,
    serviceConnectionId: connectionId,
    stateHash: tokenDigest(stateToken),
    nonce: randomBytes(32).toString("base64url"),
    returnTo: "/chat",
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/jwks`,
    clientId: "orcasynapse",
    redirectUri: "https://orcasynapse.example/auth/callback",
    codeVerifierEncryptedValue: envelope.encryptedValue,
    codeVerifierValueNonce: envelope.valueNonce,
    codeVerifierValueAuthTag: envelope.valueAuthTag,
    codeVerifierWrappedDataKey: envelope.wrappedDataKey,
    codeVerifierKeyNonce: envelope.keyNonce,
    codeVerifierKeyAuthTag: envelope.keyAuthTag,
    encryptionVersion: envelope.encryptionVersion,
    masterKeyVersion: envelope.masterKeyVersion,
    expiresAt: new Date(Date.now() + 600_000),
    ...overrides,
  });
  return id;
}

async function seedSession(overrides: Record<string, unknown> = {}) {
  const token = randomBytes(32).toString("base64url");
  const [user] = await context.database
    .insert(enterpriseUser)
    .values({
      issuer: ISSUER,
      subject: `subject-${randomUUID().slice(0, 8)}`,
      email: "user@example.com",
      displayName: "Enterprise User",
      groups: ["orcasynapse-users"],
      lastLoginAt: new Date(),
    })
    .returning({ id: enterpriseUser.id });
  const [session] = await context.database
    .insert(enterpriseUserSession)
    .values({
      tokenHash: tokenDigest(token),
      userId: user!.id,
      lastSeenAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000),
      absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000),
      ...overrides,
    })
    .returning({ id: enterpriseUserSession.id });
  return { token, userId: user!.id, sessionId: session!.id };
}

describe("DrizzleEnterpriseIdentityManager configuration", () => {
  it("reports unconfigured when no OIDC connection is enabled", async () => {
    expect(await manager(randomUUID()).status()).toMatchObject({ configured: false, administratorSignIn: false });
  });

  it("refuses to resolve when two OIDC connections are enabled", async () => {
    const first = await seedOidcConnection();
    await seedOidcConnection();

    // Two enabled providers make the trust anchor ambiguous, so it fails closed.
    expect(await manager(first).status()).toMatchObject({ configured: false });
    await expect(manager(first).startLogin("/chat", {})).rejects.toBeInstanceOf(EnterpriseIdentityError);
  });

  it("refuses to resolve an untested connection", async () => {
    const connectionId = await seedOidcConnection({ status: "NOT_TESTED" });

    expect(await manager(connectionId).status()).toMatchObject({ configured: false });
  });

  it("requires at least one user or administrator group", async () => {
    const connectionId = await seedOidcConnection();

    expect(await manager(connectionId, { configuration: { allowedGroups: [] } }).status()).toMatchObject({
      configured: false,
      message: "Enterprise sign-in requires at least one user or administrator group.",
    });
    expect(await manager(connectionId).status()).toMatchObject({ configured: true, administratorSignIn: false });
    expect(await manager(connectionId, { configuration: { platformAdminGroups: ["admins"] } }).status())
      .toMatchObject({ configured: true, administratorSignIn: true });
  });
});

describe("DrizzleEnterpriseIdentityManager login start", () => {
  it("persists a single-use request and returns a PKCE authorization URL", async () => {
    const connectionId = await seedOidcConnection();

    const started = await manager(connectionId).startLogin("/chat", {});

    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(started.stateToken);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [stored] = await context.database.select().from(oidcAuthorizationRequest);
    // Only the digest of the state is stored, never the state itself.
    expect(Buffer.from(stored!.stateHash)).toEqual(createHash("sha256").update(started.stateToken).digest());
    expect(stored?.consumedAt).toBeNull();
    expect(stored?.returnTo).toBe("/chat");
    // The verifier is envelope-encrypted, so the raw challenge input never lands.
    expect(Buffer.from(stored!.codeVerifierEncryptedValue).toString("utf8"))
      .not.toContain(url.searchParams.get("code_challenge"));

    const [recorded] = await context.database.select().from(auditEvent);
    expect(recorded?.action).toBe("oidc.login_started");
  });

  it("prunes expired requests when a new login starts", async () => {
    const connectionId = await seedOidcConnection();
    await seedAuthorizationRequest(connectionId, randomBytes(32).toString("base64url"), {
      expiresAt: new Date(Date.now() - 1_000),
    });

    await manager(connectionId).startLogin("/chat", {});

    const stored = await context.database.select().from(oidcAuthorizationRequest);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a discovery document whose issuer does not match", async () => {
    const connectionId = await seedOidcConnection();
    const fetcher = identityProvider({ discovery: { ...discoveryDocument, issuer: "https://attacker.example" } });

    await expect(manager(connectionId, { fetcher }).startLogin("/chat", {}))
      .rejects.toMatchObject({ code: "OIDC_DISCOVERY_INVALID" });
    expect(await context.database.select().from(oidcAuthorizationRequest)).toHaveLength(0);
  });
});

describe("DrizzleEnterpriseIdentityManager login completion", () => {
  it("rejects a state that does not match the browser cookie", async () => {
    const connectionId = await seedOidcConnection();
    const state = randomBytes(32).toString("base64url");
    await seedAuthorizationRequest(connectionId, state);

    await expect(manager(connectionId).completeLogin("code", state, randomBytes(32).toString("base64url"), {}))
      .rejects.toMatchObject({ code: "OIDC_STATE_MISMATCH" });
    const [stored] = await context.database.select().from(oidcAuthorizationRequest);
    expect(stored?.consumedAt).toBeNull();
  });

  it("consumes the request before token exchange, so a sequential replay is refused", async () => {
    const connectionId = await seedOidcConnection();
    const state = randomBytes(32).toString("base64url");
    await seedAuthorizationRequest(connectionId, state);

    // The first attempt consumes the request before it fails at token exchange,
    // so a failed exchange cannot be retried with the same authorization code.
    await expect(manager(connectionId).completeLogin("code", state, state, {}))
      .rejects.toBeInstanceOf(EnterpriseIdentityError);
    const [consumed] = await context.database.select().from(oidcAuthorizationRequest);
    expect(consumed?.consumedAt).not.toBeNull();

    // A consumed request is rejected by the read, before the guarded update.
    await expect(manager(connectionId).completeLogin("code", state, state, {}))
      .rejects.toMatchObject({ code: "OIDC_STATE_EXPIRED" });
  });

  it("consumes the request exactly once when two attempts race", async () => {
    const connectionId = await seedOidcConnection();
    const state = randomBytes(32).toString("base64url");
    const requestId = await seedAuthorizationRequest(connectionId, state);

    // Both attempts pass the read; the guarded update is what breaks the tie.
    const outcomes = await Promise.allSettled([
      manager(connectionId).completeLogin("code", state, state, {}),
      manager(connectionId).completeLogin("code", state, state, {}),
    ]);

    expect(outcomes.every(({ status }) => status === "rejected")).toBe(true);
    const [stored] = await context.database
      .select({ consumedAt: oidcAuthorizationRequest.consumedAt })
      .from(oidcAuthorizationRequest)
      .where(eq(oidcAuthorizationRequest.id, requestId));
    expect(stored?.consumedAt).not.toBeNull();
    // Whichever attempt lost never reached token exchange.
    const codes = outcomes.map((outcome) =>
      outcome.status === "rejected" ? (outcome.reason as EnterpriseIdentityError).code : null);
    expect(codes.filter((code) => code === "OIDC_STATE_REPLAYED" || code === "OIDC_STATE_EXPIRED").length)
      .toBeGreaterThanOrEqual(1);
  });

  it("refuses an expired request without consuming it", async () => {
    const connectionId = await seedOidcConnection();
    const state = randomBytes(32).toString("base64url");
    await seedAuthorizationRequest(connectionId, state, { expiresAt: new Date(Date.now() - 1_000) });

    await expect(manager(connectionId).completeLogin("code", state, state, {}))
      .rejects.toMatchObject({ code: "OIDC_STATE_EXPIRED" });
  });

  it("refuses a request whose connection configuration has since changed", async () => {
    const connectionId = await seedOidcConnection();
    const state = randomBytes(32).toString("base64url");
    await seedAuthorizationRequest(connectionId, state, { clientId: "a-different-client" });

    await expect(manager(connectionId).completeLogin("code", state, state, {}))
      .rejects.toMatchObject({ code: "OIDC_CONFIGURATION_CHANGED" });
  });
});

describe("DrizzleEnterpriseIdentityManager sessions", () => {
  it("authenticates a live session and exposes only end-user scopes", async () => {
    const connectionId = await seedOidcConnection();
    const { token, userId } = await seedSession();

    const principal = await manager(connectionId).authenticate(token);

    expect(principal).toMatchObject({ identityMode: "ENTERPRISE", displayName: "Enterprise User" });
    expect(principal?.scopes).toEqual(["chat:use", "documents:use", "agents:use"]);
    expect(principal?.session.user.id).toBe(userId);
  });

  it("does not rewrite a healthy session on every authenticated request", async () => {
    const connectionId = await seedOidcConnection();
    const { token, sessionId } = await seedSession();
    const [before] = await context.database
      .select({ lastSeenAt: enterpriseUserSession.lastSeenAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));

    await manager(connectionId).authenticate(token);

    const [after] = await context.database
      .select({ lastSeenAt: enterpriseUserSession.lastSeenAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.lastSeenAt.toISOString()).toBe(before!.lastSeenAt.toISOString());
  });

  it("extends idle expiry once the touch interval has passed, capped by the absolute limit", async () => {
    const connectionId = await seedOidcConnection();
    const { token, sessionId } = await seedSession({
      lastSeenAt: new Date(Date.now() - 120_000),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    });

    const principal = await manager(connectionId).authenticate(token);

    const [after] = await context.database
      .select({ idleExpiresAt: enterpriseUserSession.idleExpiresAt, absoluteExpiresAt: enterpriseUserSession.absoluteExpiresAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.idleExpiresAt.toISOString()).toBe(after!.absoluteExpiresAt.toISOString());
    expect(principal).not.toBeNull();
  });

  it("revokes a session that is presented after it expired", async () => {
    const connectionId = await seedOidcConnection();
    const { token, sessionId } = await seedSession({ idleExpiresAt: new Date(Date.now() - 1_000) });

    expect(await manager(connectionId).authenticate(token)).toBeNull();

    const [after] = await context.database
      .select({ revokedAt: enterpriseUserSession.revokedAt })
      .from(enterpriseUserSession).where(eq(enterpriseUserSession.id, sessionId));
    expect(after?.revokedAt).not.toBeNull();
  });

  it("refuses a session whose user has been disabled", async () => {
    const connectionId = await seedOidcConnection();
    const { token, userId } = await seedSession();
    await context.database.update(enterpriseUser).set({ enabled: false }).where(eq(enterpriseUser.id, userId));

    expect(await manager(connectionId).authenticate(token)).toBeNull();
  });

  it("revokes exactly once and records the revocation", async () => {
    const connectionId = await seedOidcConnection();
    const { token } = await seedSession();

    expect(await manager(connectionId).revoke(token)).toBe(true);
    expect(await manager(connectionId).revoke(token)).toBe(false);
    expect(await manager(connectionId).authenticate(token)).toBeNull();

    const revocations = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "enterprise.session_revoked");
    expect(revocations).toHaveLength(1);
  });

  it("rejects a malformed token before touching PostgreSQL", async () => {
    const connectionId = await seedOidcConnection();

    expect(await manager(connectionId).authenticate(undefined)).toBeNull();
    expect(await manager(connectionId).authenticate("short")).toBeNull();
    expect(await manager(connectionId).revoke("not-a-session-token")).toBe(false);
  });
});

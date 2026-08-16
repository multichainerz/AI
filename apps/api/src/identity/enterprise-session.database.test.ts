import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  auditEvent,
  createTestDatabase,
  enterpriseUser,
  localUser,
  enterpriseUserSession,
  oidcAuthorizationRequest,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { EnvelopeEncryption, hashLocalPassword } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDiagnosticStore } from "../connections/diagnostics/types.js";
import { DrizzleEnterpriseIdentityManager, EnterpriseIdentityError } from "./enterprise-session.js";
import { LOCAL_LOGIN_FAILURE_LIMIT } from "../auth/admin-session.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
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
function identityProvider(
  overrides: { discovery?: unknown; tokenStatus?: number; tokenBody?: unknown } = {},
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(overrides.discovery ?? discoveryDocument), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(overrides.tokenBody ?? { error: "invalid_grant" }),
      { status: overrides.tokenStatus ?? 400, headers: { "content-type": "application/json" } },
    );
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

type Transaction = Parameters<Parameters<TestDatabase["database"]["transaction"]>[0]>[0];

/**
 * Holds the session row locked until `concurrency` copies of `call` are queued
 * behind it, so their reads all land before any of their writes.
 *
 * The twin of the helper in auth/admin-session.test.ts, against this module's
 * own table; the note there explains why the interleaving is forced rather than
 * left to the scheduler.
 */
async function whileRowIsLocked<T>(
  sessionId: string,
  concurrency: number,
  call: () => Promise<T>,
  beforeRelease?: (transaction: Transaction) => Promise<void>,
): Promise<T[]> {
  let locked!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { locked = resolve; });
  const queued = new Promise<void>((resolve) => { release = resolve; });
  const holder = context.database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT 1 FROM ${enterpriseUserSession} WHERE ${enterpriseUserSession.id} = ${sessionId} FOR UPDATE`,
    );
    locked();
    await queued;
    if (beforeRelease) await beforeRelease(transaction);
  });
  await Promise.race([reached, holder]);
  const answers = Promise.all(Array.from({ length: concurrency }, () => call()));
  try {
    await vi.waitFor(async () => {
      const { rows } = await context.database.execute<{ waiting: number }>(
        sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      expect(rows[0]?.waiting).toBe(concurrency);
    }, { timeout: 15_000, interval: 25 });
  } finally {
    release();
    await holder;
  }
  return answers;
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

  /*
   * Whose fault the failed exchange was decides who can fix it.
   *
   * Every non-2xx from the token endpoint was reported as "the identity
   * provider rejected the authorization code" with the class default 401 --
   * including an IdP returning 503, and including `invalid_client`, which is
   * what an IdP says when OrcaSynapse's own client secret has been rotated out
   * from under it. Told 401 with that message, the operator sends the user to
   * sign in again, and every retry fails the same way because nothing about the
   * user's session was ever the problem. The neighbouring JWKS fetch, the same
   * `!response.ok` shape, already answered 502 for exactly this reason.
   *
   * RFC 6749 sets the shapes being told apart here: `invalid_grant` with 400 is
   * this code being refused, and `invalid_client` -- conventionally with 401 --
   * is the client credential being refused.
   */
  it("blames the authorization code only when the identity provider blamed it", async () => {
    const connectionId = await seedOidcConnection();
    const attempt = async (fetcher: typeof fetch) => {
      const state = randomBytes(32).toString("base64url");
      await seedAuthorizationRequest(connectionId, state);
      return manager(connectionId, { fetcher }).completeLogin("code", state, state, {})
        .then(() => null, (error: EnterpriseIdentityError) => ({ code: error.code, statusCode: error.statusCode }));
    };

    expect(await attempt(identityProvider({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } })))
      .toEqual({ code: "OIDC_TOKEN_REJECTED", statusCode: 401 });
    // A stale client secret. Nothing the person signing in can do about it.
    expect(await attempt(identityProvider({ tokenStatus: 401, tokenBody: { error: "invalid_client" } })))
      .toEqual({ code: "OIDC_CLIENT_REJECTED", statusCode: 502 });
    // Some IdPs answer invalid_client with 400 rather than 401.
    expect(await attempt(identityProvider({ tokenStatus: 400, tokenBody: { error: "invalid_client" } })))
      .toEqual({ code: "OIDC_CLIENT_REJECTED", statusCode: 502 });
    // The provider is simply broken; the code was never examined.
    expect(await attempt(identityProvider({ tokenStatus: 503, tokenBody: { error: "server_error" } })))
      .toEqual({ code: "OIDC_TOKEN_UNAVAILABLE", statusCode: 502 });
    // No parseable body at all is not evidence against the code either.
    expect(await attempt(identityProvider({ tokenStatus: 429, tokenBody: "slow down" })))
      .toEqual({ code: "OIDC_TOKEN_UNAVAILABLE", statusCode: 502 });
  });
});

describe("DrizzleEnterpriseIdentityManager sessions", () => {
  it("authenticates a live session and exposes only end-user scopes", async () => {
    const connectionId = await seedOidcConnection();
    const { token, userId } = await seedSession();

    const principal = await manager(connectionId).authenticate(token);

    expect(principal).toMatchObject({ identityMode: "ENTERPRISE", displayName: "Enterprise User" });
    expect(principal?.scopes).toEqual(["chat:use", "agents:use"]);
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

  /*
   * The same burst the dashboard produces, against the enterprise session.
   *
   * Concurrent touches serialise on the row lock, and every one but the winner
   * re-evaluates its predicate against a tuple whose lastSeenAt no longer
   * satisfies the write throttle. Only the throttle failed there; the session
   * did not, and a signed-in user must not be signed out by it. See the
   * matching test in auth/admin-session.test.ts for why the row is locked from
   * outside rather than left to whatever order the scheduler picks.
   */
  it("authenticates every request in a burst on a session past its touch interval", async () => {
    const connectionId = await seedOidcConnection();
    const { token, sessionId } = await seedSession({ lastSeenAt: new Date(Date.now() - 180_000) });

    const answers = await whileRowIsLocked(sessionId, 4, () => manager(connectionId).authenticate(token));

    expect(answers.filter((principal) => principal === null)).toEqual([]);
    for (const principal of answers) expect(principal?.identityMode).toBe("ENTERPRISE");
  });

  it("refuses a burst whose session is revoked between the read and the touch", async () => {
    const connectionId = await seedOidcConnection();
    const { token, sessionId } = await seedSession({ lastSeenAt: new Date(Date.now() - 180_000) });

    const answers = await whileRowIsLocked(sessionId, 4, () => manager(connectionId).authenticate(token), async (transaction) => {
      await transaction
        .update(enterpriseUserSession)
        .set({ revokedAt: new Date() })
        .where(eq(enterpriseUserSession.id, sessionId));
    });

    expect(answers).toEqual([null, null, null, null]);
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

describe("local sign-in", () => {
  const password = "correct-horse-battery";

  async function seedPerson(overrides: Record<string, unknown> = {}) {
    const [user] = await context.database.insert(enterpriseUser).values({
      issuer: "orcasynapse:local",
      subject: "ayu",
      displayName: "Ayu Pratama",
      lastLoginAt: null,
      ...overrides,
    }).returning();
    await context.database.insert(localUser).values({
      userId: user!.id,
      username: "ayu",
      passwordHash: await hashLocalPassword(password),
    });
    return user!;
  }

  /*
   * The point of the whole increment: a person an administrator created, who
   * has never seen an identity provider, can sign in and gets an ordinary
   * enterprise session -- so their division and `profileVisibleTo` work through
   * the federated path unchanged.
   */
  it("signs in a locally created person and stamps their first login", async () => {
    const user = await seedPerson();

    const issued = await manager(randomUUID()).signInWithPassword("ayu", password, {});

    expect(issued.token).toHaveLength(43);
    expect(issued.principal).toMatchObject({ identityMode: "ENTERPRISE", displayName: "Ayu Pratama" });
    expect(issued.principal.session.passwordChangeRequired).toBe(true);
    const [row] = await context.database.select().from(enterpriseUser).where(eq(enterpriseUser.id, user.id)).limit(1);
    expect(row?.lastLoginAt).not.toBeNull();
    // The session it minted authenticates like any other, and still carries
    // the flag — GET /session is what the front page polls while they type.
    await expect(manager(randomUUID()).authenticate(issued.token)).resolves.toMatchObject({
      displayName: "Ayu Pratama",
      session: { passwordChangeRequired: true },
    });
  });

  /*
   * Every rejection answers the same way. A different message for "no such
   * user" would turn this endpoint into a username oracle, which matters more
   * here than for administrators: these usernames are handed out by an
   * administrator and are likely to be guessable.
   */
  it("answers identically for a wrong password and an unknown username", async () => {
    await seedPerson();

    const wrongPassword = await manager(randomUUID()).signInWithPassword("ayu", "not-the-password-at-all", {})
      .catch((error: Error) => error.message);
    const unknownUser = await manager(randomUUID()).signInWithPassword("nobody", password, {})
      .catch((error: Error) => error.message);

    expect(wrongPassword).toBe(unknownUser);
  });

  it("refuses a disabled person", async () => {
    await seedPerson({ enabled: false });

    await expect(manager(randomUUID()).signInWithPassword("ayu", password, {}))
      .rejects.toBeInstanceOf(EnterpriseIdentityError);
  });

  /*
   * Lockout, at the same threshold the administrator path uses -- both read
   * LOCAL_LOGIN_FAILURE_LIMIT, so the two credential stores cannot drift into
   * different definitions of "locked out". The correct password is refused
   * while the lock holds, which is the property that makes a lockout worth
   * having.
   */
  it("locks the account after the shared failure limit, and then refuses even the right password", async () => {
    const user = await seedPerson();

    for (let attempt = 0; attempt < LOCAL_LOGIN_FAILURE_LIMIT; attempt += 1) {
      await manager(randomUUID()).signInWithPassword("ayu", "wrong-password-here", {}).catch(() => undefined);
    }

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.failedLoginCount).toBe(LOCAL_LOGIN_FAILURE_LIMIT);
    expect(credential?.lockedUntil).not.toBeNull();
    await expect(manager(randomUUID()).signInWithPassword("ayu", password, {}))
      .rejects.toBeInstanceOf(EnterpriseIdentityError);
  });

  /* A successful sign-in clears the count, so failures do not accumulate. */
  it("clears the failure count on success", async () => {
    const user = await seedPerson();
    await manager(randomUUID()).signInWithPassword("ayu", "wrong-password-here", {}).catch(() => undefined);

    await manager(randomUUID()).signInWithPassword("ayu", password, {});

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.failedLoginCount).toBe(0);
  });
});

describe("local password change", () => {
  const password = "correct-horse-battery";
  const replacement = "a-much-stronger-password";

  async function seedPerson() {
    const [user] = await context.database.insert(enterpriseUser).values({
      issuer: "orcasynapse:local",
      subject: "ayu",
      displayName: "Ayu Pratama",
      lastLoginAt: null,
    }).returning();
    await context.database.insert(localUser).values({
      userId: user!.id,
      username: "ayu",
      passwordHash: await hashLocalPassword(password),
    });
    return user!;
  }

  it("clears the flag, burns every other session, and authenticates the replacement", async () => {
    const user = await seedPerson();
    const first = await manager(randomUUID()).signInWithPassword("ayu", password, {});
    const second = await manager(randomUUID()).signInWithPassword("ayu", password, {});

    const issued = await manager(randomUUID())
      .changeLocalPassword(first.token, password, replacement, {});

    expect(issued.principal.session.passwordChangeRequired).toBeUndefined();
    expect(issued.token).not.toBe(first.token);
    expect(await manager(randomUUID()).authenticate(first.token)).toBeNull();
    expect(await manager(randomUUID()).authenticate(second.token)).toBeNull();
    await expect(manager(randomUUID()).authenticate(issued.token)).resolves.toMatchObject({
      displayName: "Ayu Pratama",
    });
    expect((await manager(randomUUID()).authenticate(issued.token))?.session.passwordChangeRequired)
      .toBeUndefined();

    const [credential] = await context.database.select().from(localUser)
      .where(eq(localUser.userId, user.id)).limit(1);
    expect(credential?.passwordChangeRequired).toBe(false);
    const changes = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "user.local_password_changed");
    expect(changes).toHaveLength(1);
  });

  it("refuses a wrong current password without burning the session", async () => {
    await seedPerson();
    const issued = await manager(randomUUID()).signInWithPassword("ayu", password, {});

    await expect(manager(randomUUID()).changeLocalPassword(issued.token, "not-the-password-at-all", replacement, {}))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", statusCode: 401 });
    await expect(manager(randomUUID()).authenticate(issued.token)).resolves.not.toBeNull();
  });

  it("refuses a password change that reuses the current password", async () => {
    await seedPerson();
    const issued = await manager(randomUUID()).signInWithPassword("ayu", password, {});

    await expect(manager(randomUUID()).changeLocalPassword(issued.token, password, password, {}))
      .rejects.toMatchObject({ code: "USER_PASSWORD_INVALID", statusCode: 400 });
  });

  it("blames an expired session rather than the password", async () => {
    await seedPerson();
    const issued = await manager(randomUUID()).signInWithPassword("ayu", password, {});
    await context.database.update(enterpriseUserSession).set({
      idleExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(manager(randomUUID()).changeLocalPassword(issued.token, password, replacement, {}))
      .rejects.toMatchObject({ code: "SESSION_EXPIRED", statusCode: 401 });
  });

  it("refuses a federated identity that has no local password", async () => {
    const { token } = await seedSession();

    await expect(manager(randomUUID()).changeLocalPassword(token, password, replacement, {}))
      .rejects.toMatchObject({ code: "USER_PASSWORD_UNSUPPORTED", statusCode: 400 });
  });
});

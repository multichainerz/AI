import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import type { AdminRole, EnterpriseSession, OidcStatus } from "@orcasynapse/contracts";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";
import type { AdminSessionManager, IssuedAdminSession } from "../auth/admin-session.js";

export const ENTERPRISE_SESSION_COOKIE = "orcasynapse_user_session";
export const OIDC_STATE_COOKIE = "orcasynapse_oidc_state";
const ENTERPRISE_SESSION_IDLE_MS = 8 * 60 * 60 * 1_000;
const ENTERPRISE_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1_000;
const ENTERPRISE_SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;
const ENTERPRISE_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const OIDC_REQUEST_TTL_MS = 10 * 60 * 1_000;
const OIDC_HTTP_TIMEOUT_MS = 10_000;
const MAX_OIDC_RESPONSE_BYTES = 1_000_000;

export interface IdentityRequestContext {
  sourceIp?: string | undefined;
  userAgent?: string | undefined;
}

export interface EnterprisePrincipal {
  id: string;
  subject: string;
  identityMode: "ENTERPRISE";
  displayName: string;
  email: string | null;
  scopes: ["chat:use", "documents:use", "agents:use"];
  session: EnterpriseSession;
}

export interface OidcLoginStart {
  authorizationUrl: string;
  stateToken: string;
}

export interface IssuedEnterpriseSession {
  token: string;
  returnTo: string;
  principal: EnterprisePrincipal;
  administratorSession?: IssuedAdminSession;
}

export interface EnterpriseIdentityManager {
  status(): Promise<OidcStatus>;
  startLogin(returnTo: string, context: IdentityRequestContext): Promise<OidcLoginStart>;
  completeLogin(
    code: string,
    returnedState: string,
    stateCookie: string | undefined,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession>;
  authenticate(token: string | undefined): Promise<EnterprisePrincipal | null>;
  revoke(token: string | undefined): Promise<boolean>;
}

export class EnterpriseIdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
    this.name = "EnterpriseIdentityError";
  }
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface OidcRuntime {
  connectionId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  groupsClaim: string;
  allowedGroups: string[];
  administratorGroups: Record<AdminRole, string[]>;
  emailClaim: string;
  nameClaim: string;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post";
  caseSensitiveGroups: boolean;
  timeoutMs: number;
}

function tokenDigest(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const copy = new Uint8Array(digest.length);
  copy.set(digest);
  return copy;
}

function byteCopy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy;
}

function userAgentDigest(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value, "utf8").digest("hex") : undefined;
}

function validOpaqueToken(token: string | undefined): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

function isSecureOidcUrl(value: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    return !url.username && !url.password && url.origin === expectedOrigin &&
      (url.protocol === "https:" || (loopback && url.protocol === "http:"));
  } catch {
    return false;
  }
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    return !url.username && !url.password &&
      (url.protocol === "https:" || (loopback && url.protocol === "http:"));
  } catch {
    return false;
  }
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function administratorRoleForGroups(
  groups: readonly string[],
  administratorGroups: Readonly<Record<AdminRole, readonly string[]>>,
  caseSensitive: boolean,
): AdminRole | null {
  const normalize = (group: string) => caseSensitive ? group : group.toLocaleLowerCase("en-US");
  const presented = new Set(groups.map(normalize));
  const rolePriority: AdminRole[] = ["PLATFORM_ADMIN", "SECURITY_ADMIN", "OPERATIONS_ADMIN", "AUDITOR"];
  return rolePriority.find((role) => administratorGroups[role].some((group) => presented.has(normalize(group)))) ?? null;
}

function formEncodedComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function claimAtPath(payload: JWTPayload, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function principalFromRecord(record: {
  id: string;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  user: { id: string; displayName: string; email: string | null };
}): EnterprisePrincipal {
  const session: EnterpriseSession = {
    id: record.id,
    identityMode: "ENTERPRISE",
    user: {
      id: record.user.id,
      displayName: record.user.displayName,
      email: record.user.email,
    },
    scopes: ["chat:use", "documents:use", "agents:use"],
    createdAt: record.createdAt.toISOString(),
    idleExpiresAt: record.idleExpiresAt.toISOString(),
    absoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
  };
  return {
    id: record.id,
    subject: `user:${record.user.id}`,
    identityMode: "ENTERPRISE",
    displayName: record.user.displayName,
    email: record.user.email,
    scopes: ["chat:use", "documents:use", "agents:use"],
    session,
  };
}

export async function boundedOidcJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OIDC_RESPONSE_BYTES) {
    throw new EnterpriseIdentityError("OIDC_RESPONSE_TOO_LARGE", "The identity provider response is too large.", 502);
  }
  if (!response.body) {
    throw new EnterpriseIdentityError("OIDC_INVALID_RESPONSE", "The identity provider returned invalid JSON.", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OIDC_RESPONSE_BYTES) {
        throw new EnterpriseIdentityError("OIDC_RESPONSE_TOO_LARGE", "The identity provider response is too large.", 502);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new EnterpriseIdentityError("OIDC_INVALID_RESPONSE", "The identity provider returned invalid JSON.", 502);
  }
}

export class PrismaEnterpriseIdentityManager implements EnterpriseIdentityManager {
  constructor(
    private readonly prisma: OrcaSynapsePrismaClient,
    private readonly connectionStore: ConnectionDiagnosticStore,
    private readonly encryption: EnvelopeEncryption,
    private readonly fetcher: typeof fetch = fetch,
    private readonly adminSessions?: AdminSessionManager,
  ) {}

  async status(): Promise<OidcStatus> {
    try {
      const runtime = await this.resolveRuntime();
      if (runtime.allowedGroups.length === 0 && Object.values(runtime.administratorGroups).every((groups) => groups.length === 0)) {
        return {
          configured: false,
          administratorSignIn: false,
          message: "Enterprise sign-in requires at least one user or administrator group.",
        };
      }
      return {
        configured: true,
        administratorSignIn: Object.values(runtime.administratorGroups).some((groups) => groups.length > 0),
        message: "Enterprise sign-in is configured.",
      };
    } catch {
      return {
        configured: false,
        administratorSignIn: false,
        message: "Enterprise sign-in has not been completely configured and tested.",
      };
    }
  }

  async startLogin(returnTo: string, _context: IdentityRequestContext): Promise<OidcLoginStart> {
    const runtime = await this.resolveRuntime();
    const discovery = await this.discover(runtime);
    const id = randomUUID();
    const stateToken = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const envelope = this.encryption.encrypt(verifier, `oidc:${id}:code-verifier`);
    const now = new Date();

    await this.prisma.$transaction(async (transaction) => {
      await transaction.oidcAuthorizationRequest.deleteMany({ where: { expiresAt: { lt: now } } });
      await transaction.oidcAuthorizationRequest.create({
        data: {
          id,
          serviceConnectionId: runtime.connectionId,
          stateHash: tokenDigest(stateToken),
          nonce,
          returnTo,
          issuer: discovery.issuer,
          tokenEndpoint: discovery.token_endpoint,
          jwksUri: discovery.jwks_uri,
          clientId: runtime.clientId,
          redirectUri: runtime.redirectUri,
          codeVerifierEncryptedValue: byteCopy(envelope.encryptedValue),
          codeVerifierValueNonce: byteCopy(envelope.valueNonce),
          codeVerifierValueAuthTag: byteCopy(envelope.valueAuthTag),
          codeVerifierWrappedDataKey: byteCopy(envelope.wrappedDataKey),
          codeVerifierKeyNonce: byteCopy(envelope.keyNonce),
          codeVerifierKeyAuthTag: byteCopy(envelope.keyAuthTag),
          encryptionVersion: envelope.encryptionVersion,
          masterKeyVersion: envelope.masterKeyVersion,
          expiresAt: new Date(now.getTime() + OIDC_REQUEST_TTL_MS),
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "oidc.login_started",
          resourceType: "OidcAuthorizationRequest",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: { connectionId: runtime.connectionId, returnTo },
        },
      });
    });

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", runtime.clientId);
    authorizationUrl.searchParams.set("redirect_uri", runtime.redirectUri);
    authorizationUrl.searchParams.set("scope", runtime.scopes.join(" "));
    authorizationUrl.searchParams.set("state", stateToken);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorizationUrl.toString(), stateToken };
  }

  async completeLogin(
    code: string,
    returnedState: string,
    stateCookie: string | undefined,
    context: IdentityRequestContext,
  ): Promise<IssuedEnterpriseSession> {
    if (!validOpaqueToken(returnedState) || !validOpaqueToken(stateCookie)) {
      throw new EnterpriseIdentityError("OIDC_STATE_INVALID", "The enterprise sign-in state is invalid.");
    }
    const returnedBytes = Buffer.from(returnedState, "utf8");
    const cookieBytes = Buffer.from(stateCookie, "utf8");
    if (returnedBytes.length !== cookieBytes.length || !timingSafeEqual(returnedBytes, cookieBytes)) {
      throw new EnterpriseIdentityError("OIDC_STATE_MISMATCH", "The enterprise sign-in state did not match this browser.");
    }
    const now = new Date();
    const authorization = await this.prisma.oidcAuthorizationRequest.findUnique({
      where: { stateHash: tokenDigest(returnedState) },
    });
    if (!authorization || authorization.consumedAt || authorization.expiresAt <= now) {
      throw new EnterpriseIdentityError("OIDC_STATE_EXPIRED", "The enterprise sign-in request has expired.");
    }
    const consumed = await this.prisma.oidcAuthorizationRequest.updateMany({
      where: { id: authorization.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new EnterpriseIdentityError("OIDC_STATE_REPLAYED", "The enterprise sign-in request was already used.");
    }

    const runtime = await this.resolveRuntime();
    if (
      runtime.connectionId !== authorization.serviceConnectionId ||
      runtime.clientId !== authorization.clientId ||
      runtime.redirectUri !== authorization.redirectUri
    ) {
      throw new EnterpriseIdentityError("OIDC_CONFIGURATION_CHANGED", "Enterprise sign-in configuration changed; start again.");
    }
    if (authorization.encryptionVersion !== 1) {
      throw new EnterpriseIdentityError(
        "OIDC_STATE_ENCRYPTION_UNSUPPORTED",
        "The enterprise sign-in state uses an unsupported encryption version.",
      );
    }
    const verifier = this.encryption.decrypt(
      {
        algorithm: "AES-256-GCM",
        encryptionVersion: 1,
        masterKeyVersion: authorization.masterKeyVersion,
        encryptedValue: authorization.codeVerifierEncryptedValue,
        valueNonce: authorization.codeVerifierValueNonce,
        valueAuthTag: authorization.codeVerifierValueAuthTag,
        wrappedDataKey: authorization.codeVerifierWrappedDataKey,
        keyNonce: authorization.codeVerifierKeyNonce,
        keyAuthTag: authorization.codeVerifierKeyAuthTag,
      },
      `oidc:${authorization.id}:code-verifier`,
    );

    const tokenResponse = await this.exchangeCode(runtime, authorization.tokenEndpoint, code, verifier);
    const idToken = tokenResponse.id_token;
    if (typeof idToken !== "string" || idToken.length > 20_000) {
      throw new EnterpriseIdentityError("OIDC_ID_TOKEN_MISSING", "The identity provider did not return a valid ID token.");
    }
    const jwks = await this.fetchJwks(runtime, authorization.jwksUri);
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: authorization.issuer,
        audience: authorization.clientId,
        algorithms: ["RS256", "PS256", "ES256"],
        clockTolerance: 30,
      });
      payload = verified.payload;
    } catch {
      throw new EnterpriseIdentityError("OIDC_ID_TOKEN_INVALID", "The identity provider ID token could not be verified.");
    }
    if (payload.nonce !== authorization.nonce) {
      throw new EnterpriseIdentityError("OIDC_NONCE_MISMATCH", "The identity provider nonce did not match the sign-in request.");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
      throw new EnterpriseIdentityError("OIDC_SUBJECT_INVALID", "The identity provider subject is invalid.");
    }

    const groups = stringArray(claimAtPath(payload, runtime.groupsClaim));
    const normalizeGroup = (group: string) => runtime.caseSensitiveGroups ? group : group.toLocaleLowerCase("en-US");
    const administratorRole = administratorRoleForGroups(groups, runtime.administratorGroups, runtime.caseSensitiveGroups);
    const allowed = new Set([
      ...runtime.allowedGroups,
      ...Object.values(runtime.administratorGroups).flat(),
    ].map(normalizeGroup));
    if (allowed.size === 0 || !groups.some((group) => allowed.has(normalizeGroup(group)))) {
      throw new EnterpriseIdentityError("OIDC_GROUP_DENIED", "Your enterprise account is not assigned to an OrcaSynapse access group.", 403);
    }
    const emailValue = claimAtPath(payload, runtime.emailClaim);
    const email = typeof emailValue === "string" && emailValue.length <= 320 && /^[^@\s]+@[^@\s]+$/.test(emailValue)
      ? emailValue
      : null;
    const nameValue = claimAtPath(payload, runtime.nameClaim);
    const displayName = typeof nameValue === "string" && nameValue.trim().length > 0
      ? nameValue.trim().slice(0, 200)
      : email ?? "OrcaSynapse user";
    const sessionToken = randomBytes(32).toString("base64url");
    const idleExpiresAt = new Date(now.getTime() + ENTERPRISE_SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ENTERPRISE_SESSION_ABSOLUTE_MS);
    const sourceIp = context.sourceIp && isIP(context.sourceIp) ? context.sourceIp : null;

    const session = await this.prisma.$transaction(async (transaction) => {
      await transaction.enterpriseUserSession.deleteMany({
        where: { absoluteExpiresAt: { lt: new Date(now.getTime() - ENTERPRISE_SESSION_RETENTION_MS) } },
      });
      const user = await transaction.enterpriseUser.upsert({
        where: { issuer_subject: { issuer: authorization.issuer, subject: payload.sub! } },
        create: {
          issuer: authorization.issuer,
          subject: payload.sub!,
          email,
          displayName,
          groups,
          lastLoginAt: now,
        },
        update: { email, displayName, groups, lastLoginAt: now },
      });
      if (!user.enabled) {
        throw new EnterpriseIdentityError("OIDC_USER_DISABLED", "This OrcaSynapse user has been disabled.", 403);
      }
      const created = await transaction.enterpriseUserSession.create({
        data: {
          tokenHash: tokenDigest(sessionToken),
          userId: user.id,
          lastSeenAt: now,
          idleExpiresAt,
          absoluteExpiresAt,
          sourceIp,
          userAgentHash: userAgentDigest(context.userAgent) ?? null,
        },
        include: { user: true },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: created.id,
          action: "enterprise.session_created",
          resourceType: "EnterpriseUserSession",
          resourceId: created.id,
          outcome: "SUCCESS",
          sourceIp,
          metadata: { userId: user.id, authenticationMethod: "oidc-pkce" },
        },
      });
      return created;
    });
    let administratorSession: IssuedAdminSession | undefined;
    if (administratorRole) {
      if (!this.adminSessions?.issueFederatedSession) {
        throw new EnterpriseIdentityError("OIDC_ADMIN_SESSION_UNAVAILABLE", "Federated administrator sessions are unavailable.", 503);
      }
      const federatedSubject = `oidc:${createHash("sha256").update(`${authorization.issuer}\u0000${payload.sub}`, "utf8").digest("hex")}`;
      administratorSession = await this.adminSessions.issueFederatedSession(federatedSubject, administratorRole, context);
    }
    return {
      token: sessionToken,
      returnTo: authorization.returnTo,
      principal: principalFromRecord(session),
      ...(administratorSession ? { administratorSession } : {}),
    };
  }

  async authenticate(token: string | undefined): Promise<EnterprisePrincipal | null> {
    if (!validOpaqueToken(token)) return null;
    const now = new Date();
    const session = await this.prisma.enterpriseUserSession.findUnique({
      where: { tokenHash: tokenDigest(token) },
      include: { user: true },
    });
    if (
      !session || session.revokedAt || !session.user.enabled ||
      session.idleExpiresAt <= now || session.absoluteExpiresAt <= now
    ) {
      if (session && !session.revokedAt) {
        await this.prisma.enterpriseUserSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() < ENTERPRISE_SESSION_TOUCH_INTERVAL_MS) {
      return principalFromRecord(session);
    }
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + ENTERPRISE_SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    const updated = await this.prisma.enterpriseUserSession.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        lastSeenAt: { lte: new Date(now.getTime() - ENTERPRISE_SESSION_TOUCH_INTERVAL_MS) },
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      data: { lastSeenAt: now, idleExpiresAt },
    });
    return updated.count === 1 ? principalFromRecord({ ...session, idleExpiresAt }) : null;
  }

  async revoke(token: string | undefined): Promise<boolean> {
    if (!validOpaqueToken(token)) return false;
    const session = await this.prisma.enterpriseUserSession.findUnique({
      where: { tokenHash: tokenDigest(token) },
      select: { id: true, revokedAt: true },
    });
    if (!session || session.revokedAt) return false;
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.enterpriseUserSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return false;
      await transaction.auditEvent.create({
        data: {
          actorType: "USER",
          actorId: session.id,
          action: "enterprise.session_revoked",
          resourceType: "EnterpriseUserSession",
          resourceId: session.id,
          outcome: "SUCCESS",
          metadata: {},
        },
      });
      return true;
    });
  }

  private async resolveRuntime(): Promise<OidcRuntime> {
    const candidates = await this.prisma.serviceConnection.findMany({
      where: { kind: "OIDC", enabled: true },
      select: { id: true, status: true },
      take: 2,
    });
    if (candidates.length !== 1 || candidates[0]?.status !== "HEALTHY") {
      throw new EnterpriseIdentityError(
        "OIDC_NOT_CONFIGURED",
        "Configure, enable, and successfully test exactly one OIDC connection.",
        503,
      );
    }
    const connection: ResolvedConnection = await this.connectionStore.resolveForDiagnostic(candidates[0].id);
    const clientId = connection.configuration.clientId;
    const redirectUri = connection.configuration.redirectUri;
    const allowedGroups = stringArray(connection.configuration.allowedGroups);
    const administratorGroups: Record<AdminRole, string[]> = {
      PLATFORM_ADMIN: stringArray(connection.configuration.platformAdminGroups),
      SECURITY_ADMIN: stringArray(connection.configuration.securityAdminGroups),
      OPERATIONS_ADMIN: stringArray(connection.configuration.operationsAdminGroups),
      AUDITOR: stringArray(connection.configuration.auditorGroups),
    };
    const configuredScopes = stringArray(connection.configuration.scopes);
    const scopes = configuredScopes.length > 0 ? [...new Set(configuredScopes)] : ["openid", "profile", "email", "groups"];
    if (
      !connection.baseUrl || typeof clientId !== "string" || typeof redirectUri !== "string" ||
      !connection.secrets.clientSecret || !scopes.includes("openid") ||
      !isSecureUrl(connection.baseUrl) || !isSecureUrl(redirectUri)
    ) {
      throw new EnterpriseIdentityError(
        "OIDC_CONFIGURATION_INCOMPLETE",
        "OIDC issuer, client ID, client secret, redirect URI, and the openid scope are required.",
        503,
      );
    }
    return {
      connectionId: connection.id,
      issuer: normalizeIssuer(connection.baseUrl),
      clientId,
      clientSecret: connection.secrets.clientSecret,
      redirectUri,
      scopes,
      groupsClaim: stringSetting(connection.configuration.groupsClaim, "groups"),
      allowedGroups,
      administratorGroups,
      emailClaim: stringSetting(connection.configuration.emailClaim, "email"),
      nameClaim: stringSetting(connection.configuration.nameClaim, "name"),
      tokenAuthMethod: connection.configuration.tokenAuthMethod === "client_secret_post"
        ? "client_secret_post"
        : "client_secret_basic",
      caseSensitiveGroups: connection.configuration.caseSensitiveGroups === true,
      timeoutMs: Math.min(30_000, Math.max(1_000,
        typeof connection.configuration.timeoutMs === "number" ? connection.configuration.timeoutMs : OIDC_HTTP_TIMEOUT_MS,
      )),
    };
  }

  private async discover(runtime: OidcRuntime): Promise<OidcDiscovery> {
    const issuerUrl = new URL(runtime.issuer);
    if (!isSecureOidcUrl(runtime.issuer, issuerUrl.origin)) {
      throw new EnterpriseIdentityError("OIDC_ISSUER_UNSAFE", "The OIDC issuer must use HTTPS.", 503);
    }
    const discoveryUrl = new URL(`${runtime.issuer}/.well-known/openid-configuration`);
    let response: Response;
    try {
      response = await this.fetcher(discoveryUrl, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(runtime.timeoutMs),
      });
    } catch {
      throw new EnterpriseIdentityError("OIDC_DISCOVERY_UNREACHABLE", "OIDC discovery could not be reached.", 502);
    }
    if (!response.ok) {
      throw new EnterpriseIdentityError("OIDC_DISCOVERY_REJECTED", `OIDC discovery returned status ${response.status}.`, 502);
    }
    const value = await boundedOidcJson(response);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new EnterpriseIdentityError("OIDC_DISCOVERY_INVALID", "OIDC discovery is incomplete.", 502);
    }
    const record = value as Record<string, unknown>;
    const discovery = {
      issuer: record.issuer,
      authorization_endpoint: record.authorization_endpoint,
      token_endpoint: record.token_endpoint,
      jwks_uri: record.jwks_uri,
    };
    if (
      typeof discovery.issuer !== "string" || normalizeIssuer(discovery.issuer) !== runtime.issuer ||
      typeof discovery.authorization_endpoint !== "string" ||
      typeof discovery.token_endpoint !== "string" || typeof discovery.jwks_uri !== "string" ||
      !isSecureOidcUrl(discovery.authorization_endpoint, issuerUrl.origin) ||
      !isSecureOidcUrl(discovery.token_endpoint, issuerUrl.origin) ||
      !isSecureOidcUrl(discovery.jwks_uri, issuerUrl.origin)
    ) {
      throw new EnterpriseIdentityError("OIDC_DISCOVERY_INVALID", "OIDC discovery failed issuer or endpoint validation.", 502);
    }
    return discovery as OidcDiscovery;
  }

  private async exchangeCode(
    runtime: OidcRuntime,
    tokenEndpoint: string,
    code: string,
    verifier: string,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: runtime.redirectUri,
      client_id: runtime.clientId,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (runtime.tokenAuthMethod === "client_secret_basic") {
      const credentials = `${formEncodedComponent(runtime.clientId)}:${formEncodedComponent(runtime.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      body.set("client_secret", runtime.clientSecret);
    }
    let response: Response;
    try {
      response = await this.fetcher(tokenEndpoint, {
        method: "POST",
        redirect: "error",
        headers,
        body,
        signal: AbortSignal.timeout(runtime.timeoutMs),
      });
    } catch {
      throw new EnterpriseIdentityError("OIDC_TOKEN_UNREACHABLE", "The identity provider token endpoint could not be reached.", 502);
    }
    if (!response.ok) {
      throw new EnterpriseIdentityError("OIDC_TOKEN_REJECTED", "The identity provider rejected the authorization code.");
    }
    const value = await boundedOidcJson(response);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new EnterpriseIdentityError("OIDC_TOKEN_INVALID", "The identity provider token response is invalid.", 502);
    }
    return value as Record<string, unknown>;
  }

  private async fetchJwks(runtime: OidcRuntime, jwksUri: string): Promise<JSONWebKeySet> {
    let response: Response;
    try {
      response = await this.fetcher(jwksUri, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(runtime.timeoutMs),
      });
    } catch {
      throw new EnterpriseIdentityError("OIDC_JWKS_UNREACHABLE", "The identity provider signing keys could not be reached.", 502);
    }
    if (!response.ok) {
      throw new EnterpriseIdentityError("OIDC_JWKS_REJECTED", "The identity provider signing keys were rejected.", 502);
    }
    const value = await boundedOidcJson(response);
    if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) {
      throw new EnterpriseIdentityError("OIDC_JWKS_INVALID", "The identity provider signing keys are invalid.", 502);
    }
    return value as JSONWebKeySet;
  }
}

export function enterpriseSessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieValue(cookieHeader, ENTERPRISE_SESSION_COOKIE);
}

export function oidcStateToken(cookieHeader: string | undefined): string | undefined {
  return cookieValue(cookieHeader, OIDC_STATE_COOKIE);
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookie(
  name: string,
  value: string,
  path: string,
  maxAge: number,
  secure: boolean,
): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function enterpriseSessionCookie(token: string, secure: boolean): string {
  return cookie(
    ENTERPRISE_SESSION_COOKIE,
    token,
    "/api/v1",
    Math.floor(ENTERPRISE_SESSION_ABSOLUTE_MS / 1_000),
    secure,
  );
}

export function expiredEnterpriseSessionCookie(secure: boolean): string {
  return cookie(ENTERPRISE_SESSION_COOKIE, "", "/api/v1", 0, secure);
}

export function oidcStateCookie(token: string, secure: boolean): string {
  return cookie(
    OIDC_STATE_COOKIE,
    token,
    "/api/v1/auth/oidc/callback",
    Math.floor(OIDC_REQUEST_TTL_MS / 1_000),
    secure,
  );
}

export function expiredOidcStateCookie(secure: boolean): string {
  return cookie(OIDC_STATE_COOKIE, "", "/api/v1/auth/oidc/callback", 0, secure);
}

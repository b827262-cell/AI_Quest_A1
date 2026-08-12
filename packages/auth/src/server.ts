import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { createDbHandle, createRepositories, runMigrations, type DbHandle } from "@ai-smartbook/db";
import type {
  StudentAuthMeResponse,
  StudentProfile,
  StudentSession,
  StudentUser
} from "./shared";

export const STUDENT_SESSION_COOKIE = "ai_student_session";
export const DEFAULT_STUDENT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_STUDENT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const DEFAULT_GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const DEFAULT_GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface StudentAuthConfig {
  production: boolean;
  enabled: boolean;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  googleRedirectUri: string | undefined;
  sessionSecret: string | undefined;
  sessionTtlMs: number;
  oauthStateTtlMs: number;
  sessionCookie: string;
  secureCookies: boolean;
  allowedOrigins: Set<string>;
  googleAuthorizationEndpoint: string;
  googleTokenEndpoint: string;
  googleUserinfoEndpoint: string;
}

export interface StudentAuthUserRecord {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  schoolName: string | null;
  gradeLevel: string | null;
  profileCompleted: boolean;
}

export interface StudentAuthSessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface StudentAuthRepositories {
  users: {
    findByGoogleSubject(subject: string): StudentAuthUserRecord | undefined;
    create(input: {
      googleSubject: string;
      email: string;
      displayName: string;
      avatarUrl?: string | null;
    }): StudentAuthUserRecord;
    updateGoogleLogin(id: string, input: { email: string; displayName: string; avatarUrl?: string | null }): StudentAuthUserRecord;
    updateProfile(id: string, input: { displayName: string; schoolName: string; gradeLevel: string }): StudentAuthUserRecord;
    findById(id: string): StudentAuthUserRecord | undefined;
  };
  sessions: {
    create(input: { tokenDigest: string; userId: string; expiresAt: string; ipAddress?: string | null; userAgent?: string | null }): StudentAuthSessionRecord;
    findActiveByTokenDigest(tokenDigest: string, now?: string): StudentAuthSessionRecord | undefined;
    revokeById(id: string, at?: string): boolean;
    revokeByTokenDigest(tokenDigest: string, at?: string): boolean;
    purgeExpired(now?: string): number;
  };
  oauthStates: {
    create(input: { stateDigest: string; verifierCiphertext: string; returnTo: string; expiresAt: string }): void;
    consume(stateDigest: string, now?: string): { verifierCiphertext: string; returnTo: string } | undefined;
    purgeExpired(now?: string): number;
  };
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface StudentAuthRuntime {
  auth: StudentAuthService;
  dbHandle: DbHandle;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function digestStudentSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resolveStudentAuthConfig(env: NodeJS.ProcessEnv = process.env): StudentAuthConfig {
  const configuredSessionTtl = Number(env.STUDENT_SESSION_TTL_MS);
  const configuredStateTtl = Number(env.STUDENT_OAUTH_STATE_TTL_MS);
  const allowedOrigins = new Set(
    (env.STUDENT_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  return {
    production: env.NODE_ENV === "production",
    enabled: env.STUDENT_GOOGLE_AUTH_ENABLED !== "false",
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI?.trim() || undefined,
    sessionSecret: env.STUDENT_SESSION_SECRET || env.SESSION_SECRET || undefined,
    sessionTtlMs: Number.isFinite(configuredSessionTtl) && configuredSessionTtl > 0
      ? Math.floor(configuredSessionTtl)
      : DEFAULT_STUDENT_SESSION_TTL_MS,
    oauthStateTtlMs: Number.isFinite(configuredStateTtl) && configuredStateTtl > 0
      ? Math.floor(configuredStateTtl)
      : DEFAULT_STUDENT_OAUTH_STATE_TTL_MS,
    sessionCookie: env.STUDENT_SESSION_COOKIE?.trim() || STUDENT_SESSION_COOKIE,
    // Secure is deliberately not configurable off. Local HTTP tests can still
    // inspect the Set-Cookie boundary; real browser deployments must use HTTPS.
    secureCookies: true,
    allowedOrigins,
    googleAuthorizationEndpoint: env.GOOGLE_AUTHORIZATION_ENDPOINT?.trim() || DEFAULT_GOOGLE_AUTHORIZATION_ENDPOINT,
    googleTokenEndpoint: env.GOOGLE_TOKEN_ENDPOINT?.trim() || DEFAULT_GOOGLE_TOKEN_ENDPOINT,
    googleUserinfoEndpoint: env.GOOGLE_USERINFO_ENDPOINT?.trim() || DEFAULT_GOOGLE_USERINFO_ENDPOINT
  };
}

export function assertStudentAuthConfig(config: StudentAuthConfig): void {
  if (!config.production) return;
  if (!config.enabled) throw new Error("production Student auth cannot disable Google auth");
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new Error("production Student auth requires Google client credentials and redirect URI");
  }
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error("production Student auth requires a 32-character session secret");
  }
  for (const endpoint of [config.googleAuthorizationEndpoint, config.googleTokenEndpoint, config.googleUserinfoEndpoint]) {
    if (!endpoint.startsWith("https://")) throw new Error("production Google auth endpoints must use HTTPS");
  }
}

export function createStudentSessionSecrets(): { sessionToken: string } {
  return { sessionToken: base64Url(randomBytes(32)) };
}

export function createPkceVerifier(): string {
  return base64Url(randomBytes(32));
}

export function createPkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function createOAuthState(): string {
  return base64Url(randomBytes(32));
}

function encryptShortLivedSecret(value: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [base64Url(iv), base64Url(ciphertext), base64Url(cipher.getAuthTag())].join(".");
}

function decryptShortLivedSecret(value: string, secret: string): string {
  const [ivEncoded, ciphertextEncoded, tagEncoded] = value.split(".");
  if (!ivEncoded || !ciphertextEncoded || !tagEncoded) throw new Error("invalid oauth state");
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function safeReturnTo(value: string | undefined): string {
  const candidate = value?.trim() || "/books";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/books";
  return candidate;
}

export function buildGoogleAuthorizationUrl(
  config: StudentAuthConfig,
  state: string,
  verifier: string,
  returnTo?: string
): string {
  if (!config.googleClientId || !config.googleRedirectUri) throw new Error("Google auth is not configured");
  const url = new URL(config.googleAuthorizationEndpoint);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", config.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createPkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // returnTo is stored server-side; it never travels to Google as an open
  // redirect target. Keeping this argument makes the call site explicit.
  void returnTo;
  return url.toString();
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => ({}));
  return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
}

async function exchangeGoogleCode(config: StudentAuthConfig, code: string, verifier: string): Promise<GoogleIdentity> {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new Error("Google auth is not configured");
  }
  const tokenResponse = await fetch(config.googleTokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier
    })
  });
  const tokenPayload = await readJsonObject(tokenResponse);
  const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
  if (!tokenResponse.ok || !accessToken) throw new Error("Google token exchange failed");

  const identityResponse = await fetch(config.googleUserinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const identityPayload = await readJsonObject(identityResponse);
  const subject = typeof identityPayload.sub === "string" ? identityPayload.sub.trim() : "";
  const email = typeof identityPayload.email === "string" ? identityPayload.email.trim().toLowerCase() : "";
  const displayName = typeof identityPayload.name === "string" ? identityPayload.name.trim() : "";
  const avatarUrl = typeof identityPayload.picture === "string" ? identityPayload.picture.trim() : null;
  if (!identityResponse.ok || !subject || !email || identityPayload.email_verified !== true) {
    throw new Error("Google identity verification failed");
  }
  return { subject, email, displayName: displayName || email, avatarUrl: avatarUrl || null };
}

function toStudentUser(row: StudentAuthUserRecord): StudentUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    profileCompleted: row.profileCompleted
  };
}

function toStudentProfile(row: StudentAuthUserRecord): StudentProfile {
  return { ...toStudentUser(row), schoolName: row.schoolName, gradeLevel: row.gradeLevel };
}

export class StudentAuthService {
  constructor(
    private readonly config: StudentAuthConfig,
    private readonly repositories: StudentAuthRepositories,
    private readonly now: () => number = Date.now,
    private readonly exchangeIdentity: (code: string, verifier: string) => Promise<GoogleIdentity> = (code, verifier) => exchangeGoogleCode(config, code, verifier)
  ) {}

  beginGoogleLogin(returnTo?: string): { authorizationUrl: string } {
    if (!this.config.enabled || !this.config.googleClientId || !this.config.googleRedirectUri || !this.config.sessionSecret) {
      throw new Error("Google auth is not configured");
    }
    const state = createOAuthState();
    const verifier = createPkceVerifier();
    const safeTarget = safeReturnTo(returnTo);
    this.repositories.oauthStates.create({
      stateDigest: digestStudentSecret(state),
      verifierCiphertext: encryptShortLivedSecret(verifier, this.config.sessionSecret),
      returnTo: safeTarget,
      expiresAt: new Date(this.now() + this.config.oauthStateTtlMs).toISOString()
    });
    return { authorizationUrl: buildGoogleAuthorizationUrl(this.config, state, verifier, safeTarget) };
  }

  async completeGoogleLogin(input: {
    state: string;
    code: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ sessionToken: string; session: StudentSession; user: StudentUser; profile: StudentProfile; returnTo: string }> {
    if (!input.state || !input.code || !this.config.sessionSecret) throw new Error("oauth state is invalid");
    const state = this.repositories.oauthStates.consume(digestStudentSecret(input.state), new Date(this.now()).toISOString());
    if (!state) throw new Error("oauth state is invalid");
    let verifier: string;
    try {
      verifier = decryptShortLivedSecret(state.verifierCiphertext, this.config.sessionSecret);
    } catch {
      throw new Error("oauth state is invalid");
    }
    const identity = await this.exchangeIdentity(input.code, verifier);
    const existing = this.repositories.users.findByGoogleSubject(identity.subject);
    const user = existing
      ? this.repositories.users.updateGoogleLogin(existing.id, identity)
      : this.repositories.users.create({
          googleSubject: identity.subject,
          email: identity.email,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl
        });
    this.repositories.sessions.purgeExpired(new Date(this.now()).toISOString());
    const { sessionToken } = createStudentSessionSecrets();
    const expiresAt = new Date(this.now() + this.config.sessionTtlMs).toISOString();
    const session = this.repositories.sessions.create({
      tokenDigest: digestStudentSecret(sessionToken),
      userId: user.id,
      expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    });
    return {
      sessionToken,
      session,
      user: toStudentUser(user),
      profile: toStudentProfile(user),
      returnTo: state.returnTo
    };
  }

  restoreSession(rawToken: string | undefined): { session: StudentSession; user: StudentUser; profile: StudentProfile } | undefined {
    if (!rawToken) return undefined;
    const session = this.repositories.sessions.findActiveByTokenDigest(
      digestStudentSecret(rawToken),
      new Date(this.now()).toISOString()
    );
    if (!session) return undefined;
    const user = this.repositories.users.findById(session.userId);
    if (!user) {
      this.repositories.sessions.revokeById(session.id);
      return undefined;
    }
    return { session, user: toStudentUser(user), profile: toStudentProfile(user) };
  }

  revokeSession(rawToken: string | undefined): boolean {
    return rawToken ? this.repositories.sessions.revokeByTokenDigest(digestStudentSecret(rawToken)) : false;
  }

  updateProfile(userId: string, input: { displayName: string; schoolName: string; gradeLevel: string }): StudentProfile {
    const displayName = input.displayName.trim();
    const schoolName = input.schoolName.trim();
    const gradeLevel = input.gradeLevel.trim();
    if (!displayName || !schoolName || !gradeLevel) throw new Error("profile is incomplete");
    return toStudentProfile(this.repositories.users.updateProfile(userId, { displayName, schoolName, gradeLevel }));
  }

  me(rawToken: string | undefined): StudentAuthMeResponse {
    const restored = this.restoreSession(rawToken);
    if (!restored) return { authenticated: false, user: null, profile: null };
    return { authenticated: true, user: restored.user, profile: restored.profile };
  }
}

export function createStudentAuthService(
  config: StudentAuthConfig = resolveStudentAuthConfig(),
  repositories: StudentAuthRepositories,
  now: () => number = Date.now
): StudentAuthService {
  return new StudentAuthService(config, repositories, now);
}

export function createStudentAuthRuntime(
  dbPath: string,
  config: StudentAuthConfig = resolveStudentAuthConfig(),
  now: () => number = Date.now
): StudentAuthRuntime {
  const dbHandle = createDbHandle(dbPath);
  runMigrations(dbHandle.sqlite);
  const repositories = createRepositories(dbHandle.db);
  return {
    dbHandle,
    auth: createStudentAuthService(config, {
      users: repositories.studentUsers,
      sessions: repositories.studentSessions,
      oauthStates: repositories.studentOAuthStates
    }, now)
  };
}

export function studentSessionCookieOptions(config: StudentAuthConfig): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
} {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "strict", path: "/", maxAge: config.sessionTtlMs };
}

export function clearStudentSessionCookieOptions(config: StudentAuthConfig) {
  const { maxAge: _maxAge, ...options } = studentSessionCookieOptions(config);
  return options;
}

export function readStudentCookie(cookieHeader: string | undefined, name = STUDENT_SESSION_COOKIE): string | undefined {
  for (const part of (cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function studentOriginAllowed(config: StudentAuthConfig, origin: string | undefined): boolean {
  return !origin || config.allowedOrigins.size === 0 || config.allowedOrigins.has(origin);
}

export function studentSessionTokenMatches(rawToken: string, digest: string): boolean {
  return sameSecret(digestStudentSecret(rawToken), digest);
}

export type {
  StudentAuthMeResponse,
  StudentProfile,
  StudentSession,
  StudentUser
} from "./shared";

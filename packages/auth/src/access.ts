import { createPublicKey, verify } from "node:crypto";

export class AccessUnavailableError extends Error {}
export class AccessInvalidTokenError extends Error {}
export class AccessEmailConflictError extends Error {}

export interface AccessConfig {
  accessTeamDomain?: string;
  accessAud?: string;
  /** Test fixture only; resolveStudentAuthConfig never accepts an override in production. */
  accessCertsUrl?: string;
}

const CLOCK_SKEW_SECONDS = 60;
const CERTS_TTL_MS = 5 * 60 * 1000;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30 * 1000;
type AccessJwk = JsonWebKey & { kid: string };
const certsCache = new Map<string, { expires: number; keys: AccessJwk[] }>();
const pendingCerts = new Map<string, Promise<AccessJwk[]>>();
const lastUnknownKidRefresh = new Map<string, number>();

function accessIssuer(domain: string): string {
  return `https://${domain}.cloudflareaccess.com`;
}

function validDomain(domain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(domain);
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePart(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AccessInvalidTokenError("invalid JWT encoding");
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (jsonObject(decoded)) return decoded;
  } catch { /* invalid JSON */ }
  throw new AccessInvalidTokenError("invalid JWT JSON");
}

async function certificates(url: string, force = false): Promise<AccessJwk[]> {
  const cached = certsCache.get(url);
  if (!force && cached && cached.expires > Date.now()) return cached.keys;
  const existing = pendingCerts.get(url);
  if (existing) return existing;
  if (force) {
    const now = Date.now();
    const last = lastUnknownKidRefresh.get(url);
    if (last !== undefined && now - last < UNKNOWN_KID_REFRESH_COOLDOWN_MS && cached && cached.expires > now) return cached.keys;
    lastUnknownKidRefresh.set(url, now);
  }
  const request = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("certs request failed");
      const payload: unknown = await response.json();
      if (!jsonObject(payload) || !Array.isArray(payload.keys) || payload.keys.length === 0) throw new Error("invalid certs");
      const keys = payload.keys.filter((key): key is AccessJwk => jsonObject(key) && key.kty === "RSA" && typeof key.kid === "string");
      if (keys.length === 0) throw new Error("no RSA certs");
      certsCache.set(url, { expires: Date.now() + CERTS_TTL_MS, keys });
      return keys;
    } catch {
      // A failed forced refresh is unavailable for this request. Keep only a still-valid
      // cache entry so unknown kids cannot trigger repeated fetches during cooldown.
      if (!force || !cached || cached.expires <= Date.now()) certsCache.delete(url);
      throw new AccessUnavailableError("Cloudflare Access certificates unavailable");
    } finally {
      pendingCerts.delete(url);
    }
  })();
  pendingCerts.set(url, request);
  return request;
}

export async function verifyAccessAssertion(token: string | undefined, config: AccessConfig, nowMs = Date.now()): Promise<string> {
  if (!config.accessTeamDomain || !validDomain(config.accessTeamDomain) || !config.accessAud) {
    throw new AccessUnavailableError("Cloudflare Access is not configured");
  }
  if (!token) throw new AccessInvalidTokenError("missing assertion");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(Boolean)) throw new AccessInvalidTokenError("malformed assertion");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new AccessInvalidTokenError("invalid algorithm or kid");
  const issuer = accessIssuer(config.accessTeamDomain);
  const url = config.accessCertsUrl ?? `${issuer}/cdn-cgi/access/certs`;
  const hadFreshCache = (certsCache.get(url)?.expires ?? 0) > Date.now();
  const keys = await certificates(url);
  let key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key && hadFreshCache) {
    const refreshed = await certificates(url, true);
    key = refreshed.find((candidate) => candidate.kid === header.kid);
  }
  if (!key) throw new AccessInvalidTokenError("unknown kid");
  let signatureValid = false;
  try {
    signatureValid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch { /* malformed key or signature */ }
  if (!signatureValid) throw new AccessInvalidTokenError("invalid signature");
  const now = Math.floor(nowMs / 1000);
  const audience = claims.aud;
  const audValid = typeof audience === "string" ? audience === config.accessAud : Array.isArray(audience) && audience.includes(config.accessAud);
  if (claims.iss !== issuer || !audValid || typeof claims.exp !== "number" || typeof claims.nbf !== "number" || typeof claims.iat !== "number"
    || claims.exp <= now - CLOCK_SKEW_SECONDS || claims.nbf > now + CLOCK_SKEW_SECONDS || claims.iat > now + CLOCK_SKEW_SECONDS
    || claims.iat > claims.exp || claims.nbf > claims.exp) throw new AccessInvalidTokenError("invalid claims");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) throw new AccessInvalidTokenError("invalid email");
  return email;
}

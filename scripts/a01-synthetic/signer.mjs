/**
 * Canonical A-01 relay signer for the synthetic traffic driver.
 *
 * Mirrors `site/lib/relay-signature.ts` (canonical form `a01-relay-v1`,
 * HMAC-SHA256, base64url) so the driver can produce genuinely signed requests
 * that the primary site verifies as `result=valid`. The mirror is kept honest
 * by a cross-check test that signs with both implementations and compares.
 *
 * The signing key is supplied by the caller at runtime and is never logged.
 */

import { createHash, createHmac } from "node:crypto";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function canonicalPath(pathname) {
  const folded = String(pathname).replace(/\/{2,}/g, "/");
  return folded.length > 1 ? folded.replace(/\/+$/, "") : folded;
}

function digestHex(input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return createHash("sha256").update(bytes).digest("hex");
}

function missingAsDash(value) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function canonicalEmail(value) {
  if (value === undefined || value === null || String(value).trim() === "-") return "-";
  return String(value).trim().toLowerCase() || "-";
}

function bodyBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new TypeError("invalid body");
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Build the canonical signing string; returns null when the input is invalid. */
export function buildCanonicalString(input) {
  if (!input || typeof input.method !== "string" || typeof input.pathname !== "string" || typeof input.ts !== "string" || typeof input.nonce !== "string") {
    return null;
  }
  const method = input.method.toUpperCase();
  const site = missingAsDash(input.site);
  const role = missingAsDash(input.role);
  if (site !== "student" && site !== "admin") return null;
  if (role !== "student" && role !== "admin" && role !== "-") return null;
  if (!/^[0-9]+$/.test(input.ts) || !NONCE_PATTERN.test(input.nonce)) return null;

  const search = input.search === undefined ? "" : String(input.search);
  const queryDigest = search === "" ? "-" : digestHex(search);
  const bodyDigest = method === "GET" || method === "HEAD" ? "-" : digestHex(bodyBytes(input.body));

  return [
    "a01-relay-v1",
    method,
    canonicalPath(input.pathname),
    queryDigest,
    bodyDigest,
    site,
    missingAsDash(input.userId),
    canonicalEmail(input.email),
    role,
    input.ts,
    input.nonce,
  ].join("\n");
}

/** Sign a relay request; returns the base64url signature or null when invalid. */
export function signRelay(input, key) {
  if (typeof key !== "string" || key.length === 0) return null;
  const canonical = buildCanonicalString(input);
  if (canonical === null) return null;
  return base64Url(createHmac("sha256", Buffer.from(key, "utf8")).update(Buffer.from(canonical, "utf8")).digest());
}

/**
 * Assemble the `x-a01-relay-*` header set for a request. Returns null when the
 * input or key is invalid so callers fail closed.
 */
export function buildRelayHeaders(input, key) {
  const signature = signRelay(input, key);
  if (signature === null) return null;
  return {
    "x-a01-relay-site": missingAsDash(input.site),
    "x-a01-relay-ts": String(input.ts),
    "x-a01-relay-nonce": String(input.nonce),
    "x-a01-relay-user-id": missingAsDash(input.userId),
    "x-a01-relay-user-email": canonicalEmail(input.email),
    "x-a01-relay-user-role": missingAsDash(input.role),
    "x-a01-relay-sig": signature,
  };
}

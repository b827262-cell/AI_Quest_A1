/**
 * Relay request signing for the A-01 synthetic traffic injector.
 *
 * This mirrors the canonical form defined in `site/lib/relay-signature.ts`
 * (`buildCanonical` / `signRelay`). It is intentionally dependency-free and
 * pure so it can be unit-tested without building or importing the Worker.
 *
 * Canonical string (fields joined by "\n"):
 *   a01-relay-v1
 *   <METHOD upper>
 *   <canonical path>
 *   <query digest: "-" when no query, else sha256-hex of the raw query string>
 *   <body digest: "-" for GET/HEAD, else sha256-hex of the exact body bytes>
 *   <site>
 *   <userId or "-">
 *   <canonical email or "-">
 *   <role or "-">
 *   <ts>
 *   <nonce>
 *
 * Signature = base64url(HMAC-SHA256(key, canonical)).
 *
 * SECURITY: the signing key and the edge secret are read from the process
 * environment by the caller and are never logged, echoed, or written to any
 * manifest. Only the derived signature (which is not a secret) is transmitted.
 */

const encoder = new TextEncoder();

export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** "-" is the missing-value sentinel; an empty value collapses to "-". */
function missingAsDash(value) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

/** Shared with the verifier: trim, lowercase, empty/"-" -> "-". */
export function canonicalEmail(value) {
  if (value === undefined || value === null || String(value).trim() === "-") return "-";
  return String(value).trim().toLowerCase() || "-";
}

/** Collapse repeated slashes and strip a single trailing slash (keep root "/"). */
export function canonicalPath(pathname) {
  const folded = String(pathname).replace(/\/{2,}/g, "/");
  return folded.length > 1 ? folded.replace(/\/+$/, "") : folded;
}

async function digestHex(bytes) {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  throw new TypeError("unsupported body type");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(keyValue, message) {
  const rawKey = encoder.encode(keyValue);
  const rawMessage = encoder.encode(message);
  const keySource = new ArrayBuffer(rawKey.byteLength);
  const messageSource = new ArrayBuffer(rawMessage.byteLength);
  new Uint8Array(keySource).set(rawKey);
  new Uint8Array(messageSource).set(rawMessage);
  const key = await crypto.subtle.importKey(
    "raw",
    keySource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageSource));
}

/**
 * Build the exact canonical string the primary recomputes.
 * @param {object} input
 * @returns {Promise<string>}
 */
export async function buildCanonical(input) {
  const {
    method,
    pathname,
    search = "",
    body,
    site,
    userId,
    email,
    role = "-",
    ts,
    nonce,
  } = input;
  const upperMethod = String(method).toUpperCase();
  const queryDigest = search === "" ? "-" : await digestHex(encoder.encode(String(search)));
  const bodyDigest =
    upperMethod === "GET" || upperMethod === "HEAD" ? "-" : await digestHex(bodyBytes(body));
  return [
    "a01-relay-v1",
    upperMethod,
    canonicalPath(pathname),
    queryDigest,
    bodyDigest,
    missingAsDash(site),
    missingAsDash(userId),
    canonicalEmail(email),
    missingAsDash(role),
    String(ts),
    String(nonce),
  ].join("\n");
}

/**
 * Sign a relay request. Returns the base64url signature.
 * @param {object} input same shape as {@link buildCanonical}
 * @param {string} key the relay signing key (>= 32 chars, not trimmed)
 * @returns {Promise<string>}
 */
export async function signRelay(input, key) {
  if (typeof key !== "string" || key.length < 32) {
    throw new Error("relay signing key must be a string of length >= 32");
  }
  const canonical = await buildCanonical(input);
  return base64Url(await hmacSha256(key, canonical));
}

/** Generate a URL-safe nonce that satisfies the verifier's NONCE_PATTERN. */
export function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return base64Url(bytes);
}

/**
 * Build the full set of relay headers for a signed request.
 * The edge secret is only added when supplied; its value is never returned in
 * any diagnostic form other than being placed on the header itself.
 */
export async function buildRelayHeaders({
  method,
  pathname,
  search = "",
  body,
  site,
  userId,
  email,
  role = "-",
  key,
  edgeSecret,
  nowMs = Date.now(),
}) {
  const ts = String(Math.floor(nowMs / 1000));
  const nonce = generateNonce();
  const signature = await signRelay(
    { method, pathname, search, body, site, userId, email, role, ts, nonce },
    key,
  );
  const headers = {
    "x-a01-relay-site": String(site),
    "x-a01-relay-ts": ts,
    "x-a01-relay-nonce": nonce,
    "x-a01-relay-user-id": userId || "-",
    "x-a01-relay-user-email": email || "-",
    "x-a01-relay-user-role": role || "-",
    "x-a01-relay-sig": signature,
  };
  if (typeof edgeSecret === "string" && edgeSecret.length > 0) {
    headers["x-a01-relay-edge-secret"] = edgeSecret;
  }
  return { headers, ts, nonce, signature };
}

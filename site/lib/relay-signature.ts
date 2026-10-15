/**
 * Relay request signing core (A-01 identity signing, PR-A).
 *
 * Canonical form notes:
 * - The canonical path preserves letter case; it only collapses repeated
 *   slashes and strips a single trailing slash. Data IDs may be
 *   case-sensitive, so lowercasing here would let a signature issued for
 *   "BookA" also verify for "booka". Route-policy matching that folds case
 *   belongs to classifyApiPath, not to this file.
 * - "-" is the missing-value sentinel: a legal userId, email, or role must
 *   never be the literal "-".
 * - Canonical fields and header values reject C0/C1 control characters
 *   (U+0000-U+001F, U+007F-U+009F) and U+2028/U+2029, and must be
 *   well-formed UTF-16 (no unpaired surrogates), so distinct strings cannot
 *   collapse to the same bytes during UTF-8 encoding.
 */

export type RelayInput = {
  method: string;
  pathname: string;
  search?: string;
  body?: string | Uint8Array | ArrayBuffer;
  site?: string | null;
  userId?: string | null;
  email?: string | null;
  role?: string | null;
  ts: string;
  nonce: string;
};

export type RelayInvalid = { ok: false };
export type RelayHeaderResult =
  | {
      ok: true;
      site: "student" | "admin";
      ts: string;
      nonce: string;
      userId: string;
      email: string;
      role: "student" | "admin" | "-";
      signature: string;
    }
  | RelayInvalid;

export type RelayHeaderSource =
  | Headers
  | Record<string, string | readonly string[] | null | undefined>;

const INVALID: RelayInvalid = Object.freeze({ ok: false });
const encoder = new TextEncoder();
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TIMESTAMP_PATTERN = /^[0-9]+$/;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// Reject C0/C1 control characters (U+0000-U+001F, U+007F-U+009F) plus the
// U+2028/U+2029 line separators. This covers "\r", VT, FF, NEL (U+0085), and
// "\n" itself.
const FORBIDDEN_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

function hasForbiddenChar(value: string): boolean {
  return FORBIDDEN_CHAR_PATTERN.test(value);
}

// Reject unpaired UTF-16 surrogates. Two distinct strings can otherwise
// encode to the same UTF-8 bytes (each lone surrogate becoming U+FFFD),
// which would let different inputs share one signature.
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCleanString(value: string): boolean {
  return isWellFormed(value) && !hasForbiddenChar(value);
}

function missingAsDash(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "-" : value;
}

// Shared by the canonical builder and the header parser so both sides agree
// on the exact email form that is covered by the signature.
function canonicalEmail(value: string | null | undefined): string {
  if (value === undefined || value === null || value.trim() === "-") return "-";
  return value.trim().toLowerCase() || "-";
}

function canonicalPath(pathname: string): string {
  const folded = pathname.replace(/\/{2,}/g, "/");
  return folded.length > 1 ? folded.replace(/\/+$/, "") : folded;
}

function bodyBytes(body: RelayInput["body"]): Uint8Array {
  if (body === undefined) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (body instanceof Uint8Array) return new Uint8Array(body);
  throw new TypeError("invalid body");
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const source = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function validDecimalTimestamp(value: string): boolean {
  if (!TIMESTAMP_PATTERN.test(value)) return false;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0;
}

async function buildCanonical(input: RelayInput): Promise<string | RelayInvalid> {
  if (
    !input ||
    !isString(input.method) ||
    !isString(input.pathname) ||
    !isString(input.ts) ||
    !isString(input.nonce)
  ) return INVALID;

  const search = input.search === undefined ? "" : input.search;
  if (!isString(search)) return INVALID;

  const rawValues = [
    input.method,
    input.pathname,
    search,
    input.site,
    input.userId,
    input.email,
    input.role,
    input.ts,
    input.nonce,
  ];
  if (rawValues.some((value) => value !== undefined && value !== null && (!isString(value) || !isCleanString(value)))) return INVALID;

  if (!input.method || !input.pathname || !validDecimalTimestamp(input.ts) || !NONCE_PATTERN.test(input.nonce)) return INVALID;

  const site = missingAsDash(input.site);
  const userId = missingAsDash(input.userId);
  const email = canonicalEmail(input.email);
  const role = missingAsDash(input.role);

  if (site !== "student" && site !== "admin") return INVALID;
  if (role !== "student" && role !== "admin" && role !== "-") return INVALID;

  const method = input.method.toUpperCase();
  const path = canonicalPath(input.pathname);
  const queryDigest = search === "" ? "-" : await digestHex(encoder.encode(search));
  const bodyDigest = method === "GET" || method === "HEAD"
    ? "-"
    : await digestHex(bodyBytes(input.body));
  const fields = [
    "a01-relay-v1",
    method,
    path,
    queryDigest,
    bodyDigest,
    site,
    userId,
    email,
    role,
    input.ts,
    input.nonce,
  ];

  if (fields.some((field) => !isCleanString(field))) return INVALID;
  return fields.join("\n");
}

export async function buildCanonicalString(input: RelayInput): Promise<string | RelayInvalid> {
  try {
    return await buildCanonical(input);
  } catch {
    return INVALID;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256(keyValue: string, message: string): Promise<Uint8Array> {
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

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function signRelay(input: RelayInput, key: string): Promise<string | RelayInvalid> {
  if (!isString(key)) return INVALID;
  const canonical = await buildCanonicalString(input);
  if (!isString(canonical)) return INVALID;
  try {
    return base64Url(await hmacSha256(key, canonical));
  } catch {
    return INVALID;
  }
}

export async function verifyRelay(input: RelayInput, signature: string, keys: string[]): Promise<boolean> {
  if (!isString(signature) || !Array.isArray(keys)) return false;
  const canonical = await buildCanonicalString(input);
  if (!isString(canonical)) return false;

  const provided = encoder.encode(signature);
  let accepted = false;
  for (const candidate of keys) {
    try {
      const expected = base64Url(await hmacSha256(isString(candidate) ? candidate : "", canonical));
      const equal = constantTimeEqual(encoder.encode(expected), provided);
      if (isString(candidate) && equal) accepted = true;
    } catch {
      // Keep trying every key; failures disclose no diagnostic category.
    }
  }
  return accepted;
}

export function checkTimestamp(ts: string, nowSec: number, skewSec = 300): boolean {
  if (
    !isString(ts) ||
    !isCleanString(ts) ||
    !validDecimalTimestamp(ts) ||
    !Number.isSafeInteger(nowSec) ||
    nowSec < 0 ||
    !Number.isSafeInteger(skewSec) ||
    skewSec < 0
  ) return false;
  return Math.abs(nowSec - Number(ts)) <= skewSec;
}

function readHeader(headers: RelayHeaderSource, target: string): { ok: true; value?: string } | RelayInvalid {
  let value: string | undefined;
  if (headers instanceof Headers) {
    const found = headers.get(target);
    value = found === null ? undefined : found;
  } else {
    if (!headers || typeof headers !== "object") return INVALID;
    const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === target);
    if (matches.length > 1) return INVALID;
    const raw = matches[0]?.[1];
    if (raw === null || raw === undefined) {
      value = undefined;
    } else if (typeof raw === "string") {
      value = raw;
    } else {
      if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== "string") return INVALID;
      value = raw[0];
    }
  }
  if (value !== undefined && (value.includes(",") || !isCleanString(value))) return INVALID;
  return { ok: true, value };
}

export function parseRelayHeaders(headers: RelayHeaderSource): RelayHeaderResult {
  try {
    return parseRelayHeadersChecked(headers);
  } catch {
    // Any unexpected shape (hostile plain object, throwing getter, ...) fails
    // closed rather than surfacing a diagnostic.
    return INVALID;
  }
}

function parseRelayHeadersChecked(headers: RelayHeaderSource): RelayHeaderResult {
  const names = {
    site: "x-a01-relay-site",
    ts: "x-a01-relay-ts",
    nonce: "x-a01-relay-nonce",
    userId: "x-a01-relay-user-id",
    email: "x-a01-relay-user-email",
    role: "x-a01-relay-user-role",
    signature: "x-a01-relay-sig",
  } as const;
  const values: Partial<Record<keyof typeof names, string>> = {};
  for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) {
    const header = readHeader(headers, name);
    if (!header.ok) return INVALID;
    if (header.value !== undefined) values[key] = header.value;
  }

  const site = values.site;
  const ts = values.ts;
  const nonce = values.nonce;
  const signature = values.signature;
  const userId = missingAsDash(values.userId);
  const email = canonicalEmail(values.email);
  const role = missingAsDash(values.role);

  if (
    !site || (site !== "student" && site !== "admin") ||
    !ts || !validDecimalTimestamp(ts) ||
    !nonce || !NONCE_PATTERN.test(nonce) ||
    !signature ||
    (role !== "student" && role !== "admin" && role !== "-")
  ) return INVALID;

  return {
    ok: true,
    site,
    ts,
    nonce,
    userId,
    email,
    role,
    signature,
  };
}

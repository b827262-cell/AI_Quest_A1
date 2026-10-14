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

function hasNewline(value: string): boolean {
  return value.includes("\n");
}

function missingAsDash(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "-" : value;
}

function canonicalPath(pathname: string): string {
  const folded = pathname.replace(/\/{2,}/g, "/").toLowerCase();
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
  if (rawValues.some((value) => value !== undefined && value !== null && (!isString(value) || hasNewline(value)))) return INVALID;

  if (!input.method || !input.pathname || !validDecimalTimestamp(input.ts) || !NONCE_PATTERN.test(input.nonce)) return INVALID;

  const site = missingAsDash(input.site);
  const userId = missingAsDash(input.userId);
  const email = input.email === undefined || input.email === null || input.email.trim() === "-"
    ? "-"
    : input.email.trim().toLowerCase() || "-";
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

  if (fields.some(hasNewline)) return INVALID;
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
    hasNewline(ts) ||
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
      if (raw.length !== 1) return INVALID;
      value = raw[0];
    }
  }
  if (value !== undefined && (value.includes(",") || hasNewline(value))) return INVALID;
  return { ok: true, value };
}

export function parseRelayHeaders(headers: RelayHeaderSource): RelayHeaderResult {
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
  const email = values.email ?? "-";
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

import { lt } from "drizzle-orm";
import { getDb } from "../db";
import { relayNonces } from "../db/schema";
import { checkTimestamp, parseRelayHeaders, verifyRelay } from "./relay-signature";

export type RelayMode = "off" | "transitional" | "strict";
export type RelayVerification =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "valid"; userId: string; email: string };

const MAX_SIGNED_BODY_BYTES = 8 * 1024 * 1024;
// Existing uploads allow a 15 MiB PDF; base64 JSON needs about 20 MiB.
const MAX_SIGNED_UPLOAD_BYTES = 21 * 1024 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;

type Runtime = Record<string, unknown> & { __env__?: Record<string, unknown> };
function binding(name: string): unknown {
  const runtime = globalThis as unknown as Runtime;
  return runtime[name] ?? runtime.__env__?.[name];
}

/** An unset mode preserves existing deployments; a typo fails closed. */
export function readRelayMode(): RelayMode {
  const value = binding("A01_RELAY_MODE");
  if (value === undefined || value === null) return "off";
  if (typeof value !== "string") return "strict";
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "off") return "off";
  return normalized === "transitional" ? "transitional" : "strict";
}

function configuredKeys(site: "student" | "admin"): string[] {
  const prefix = site === "student" ? "A01_RELAY_KEY_STUDENT" : "A01_RELAY_KEY_ADMIN";
  return [binding(prefix), binding(`${prefix}_PREV`)]
    .filter((key): key is string => typeof key === "string" && key.length >= 32);
}

function siteKeys(site: "student" | "admin"): string[] {
  const own = configuredKeys(site);
  const other = configuredKeys(site === "student" ? "admin" : "student");
  // If any two sites share a key, refuse both sites until the binding is fixed.
  return own.some((key) => other.includes(key)) ? [] : own;
}

/** Count valid active and previous keys without exposing names or bytes. */
export function relayKeyCount(): number {
  return siteKeys("student").length + siteKeys("admin").length;
}

export function hasRelayHeaders(headers: Headers): boolean {
  return [...headers.keys()].some((name) => name.toLowerCase().startsWith("x-a01-relay-"));
}

async function boundedUploadBody(request: Request): Promise<ArrayBuffer | null> {
  const reader = request.clone().body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SIGNED_UPLOAD_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function signedBody(request: Request, pathname: string): Promise<ArrayBuffer | null> {
  if (request.method === "GET" || request.method === "HEAD") return new ArrayBuffer(0);
  const declaredLength = request.headers.get("content-length");
  const upload = pathname === "/api/admin/books/upload";
  const limit = upload ? MAX_SIGNED_UPLOAD_BYTES : MAX_SIGNED_BODY_BYTES;
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) return null;
  // The upload endpoint is frequently large. Stream its clone with a hard cap
  // so an omitted or false Content-Length cannot force an unbounded allocation.
  if (upload) return boundedUploadBody(request);
  const body = await request.clone().arrayBuffer();
  return body.byteLength <= MAX_SIGNED_BODY_BYTES ? body : null;
}

/** Validate only relay headers; every failure has the same caller-visible result. */
export async function verifyIncomingRelay(request: Request): Promise<RelayVerification> {
  if (!hasRelayHeaders(request.headers)) return { status: "none" };
  try {
    const parsed = parseRelayHeaders(request.headers);
    if (!parsed.ok) return { status: "invalid" };
    const nowSec = Math.floor(Date.now() / 1000);
    if (!checkTimestamp(parsed.ts, nowSec, MAX_CLOCK_SKEW_SECONDS)) return { status: "invalid" };
    const keys = siteKeys(parsed.site);
    if (keys.length === 0) return { status: "invalid" };
    if ((parsed.userId === "-") !== (parsed.email === "-")) return { status: "invalid" };
    if (parsed.email !== "-" && (!parsed.email.includes("@") || parsed.email.includes(" ") || parsed.email.length < 3)) {
      return { status: "invalid" };
    }
    const url = new URL(request.url);
    const policyPath = url.pathname.replace(/\/{2,}/g, "/").toLowerCase();
    const prefix = `/api/${parsed.site}`;
    if (policyPath !== "/api/health" && policyPath !== prefix && !policyPath.startsWith(`${prefix}/`)) {
      return { status: "invalid" };
    }
    const body = await signedBody(request, url.pathname);
    if (body === null) return { status: "invalid" };
    const accepted = await verifyRelay({
      method: request.method, pathname: url.pathname, search: url.search, body,
      site: parsed.site, userId: parsed.userId, email: parsed.email,
      role: parsed.role, ts: parsed.ts, nonce: parsed.nonce,
    }, parsed.signature, keys);
    if (!accepted) return { status: "invalid" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      const db = await getDb();
      await db.delete(relayNonces).where(lt(relayNonces.expiresAt, nowSec));
      const inserted = await db.insert(relayNonces)
        .values({ nonce: parsed.nonce, expiresAt: Number(parsed.ts) + MAX_CLOCK_SKEW_SECONDS })
        .onConflictDoNothing().returning({ nonce: relayNonces.nonce });
      if (inserted.length !== 1) return { status: "invalid" };
    }
    return { status: "valid", userId: parsed.userId, email: parsed.email };
  } catch {
    return { status: "invalid" };
  }
}

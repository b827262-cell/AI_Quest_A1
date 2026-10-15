/** Primary-edge check for relay credentials before any API route sees them. */
import { classifyApiPath, gateApiRequest, readSiteDeclaration, type SiteDeclaration } from "../app/api/backend-client";
export type EdgeGateMode = "accept" | "require";
export type EdgeSecrets = {
  A01_RELAY_EDGE_SECRET_STUDENT?: string;
  A01_RELAY_EDGE_SECRET_STUDENT_PREV?: string;
  A01_RELAY_EDGE_SECRET_ADMIN?: string;
  A01_RELAY_EDGE_SECRET_ADMIN_PREV?: string;
  A01_RELAY_EDGE_MODE?: string;
};

const EDGE_HEADER = "x-a01-relay-edge-secret";

export function readEdgeGateMode(value: unknown): EdgeGateMode {
  if (value === undefined || value === null) return "accept";
  if (typeof value !== "string") return "require";
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "accept" ? "accept" : "require";
}

function validSecrets(site: "student" | "admin", bindings: EdgeSecrets): string[] {
  const own = site === "student"
    ? [bindings.A01_RELAY_EDGE_SECRET_STUDENT, bindings.A01_RELAY_EDGE_SECRET_STUDENT_PREV]
    : [bindings.A01_RELAY_EDGE_SECRET_ADMIN, bindings.A01_RELAY_EDGE_SECRET_ADMIN_PREV];
  const other = site === "student"
    ? [bindings.A01_RELAY_EDGE_SECRET_ADMIN, bindings.A01_RELAY_EDGE_SECRET_ADMIN_PREV]
    : [bindings.A01_RELAY_EDGE_SECRET_STUDENT, bindings.A01_RELAY_EDGE_SECRET_STUDENT_PREV];
  const usable = (value: unknown): value is string => typeof value === "string" && value.length >= 32 && value.length <= 512;
  const ownKeys = own.filter(usable);
  const otherKeys = other.filter(usable);
  // Cross-site reuse invalidates both sites, including overlap keys.
  return ownKeys.some((key) => otherKeys.includes(key)) ? [] : ownKeys;
}

function equalSecret(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

function stripUntrusted(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-a01-relay-") || name.startsWith("oai-")) headers.delete(name);
  }
  return new Request(request, { headers });
}

function withoutEdgeSecret(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(EDGE_HEADER);
  return new Request(request, { headers });
}

function logProbe(mode: EdgeGateMode, site: string | null): void {
  try {
    console.log(JSON.stringify({
      evt: "relay.probe", mode,
      site: site === "student" || site === "admin" ? site : "unknown",
    }));
  } catch {
    // Logging must not affect access control or expose header values.
  }
}

/** Called only after the existing API path/topology gate and never for health. */
export function gateRelayEdgeRequest(request: Request, bindings: EdgeSecrets): Request {
  const mode = readEdgeGateMode(bindings.A01_RELAY_EDGE_MODE);
  const headers = request.headers;
  const hasRelay = [...headers.keys()].some((name) => name.startsWith("x-a01-relay-"));
  const hasIdentity = [...headers.keys()].some((name) => name.startsWith("oai-"));
  if (!hasRelay && !hasIdentity) return request;

  const site = headers.get("x-a01-relay-site");
  const presented = headers.get(EDGE_HEADER);
  const matched = presented !== null && presented.length <= 512 &&
    (site === "student" || site === "admin") &&
    validSecrets(site, bindings).some((key) => equalSecret(presented, key));
  if (matched) return withoutEdgeSecret(request);

  logProbe(mode, site);
  return mode === "require" ? stripUntrusted(request) : withoutEdgeSecret(request);
}

/** Preserve the existing path/topology errors before considering edge credentials. */
export function gatePrimaryApiRequest(
  request: Request, bindings: EdgeSecrets, declared: SiteDeclaration = readSiteDeclaration()
): Request | Response {
  const pathname = new URL(request.url).pathname;
  const gate = gateApiRequest(pathname, declared);
  if (gate) return gate;
  const decision = classifyApiPath(pathname);
  if (declared.role !== "primary" || decision.kind !== "api" || decision.pathname === "/api/health") return request;
  return gateRelayEdgeRequest(request, bindings);
}

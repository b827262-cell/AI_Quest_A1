/**
 * A-01 synthetic traffic driver — pure core.
 *
 * Everything in this file is side-effect free: no network, no filesystem, and
 * no direct `process.env` access (the caller passes an `env` object in). This
 * keeps the safety-critical decisions (staging-only target guard, redaction,
 * stop conditions, coverage expansion) unit-testable without touching a live
 * site or any real credential.
 *
 * Safety invariants enforced here:
 * - A target is refused unless its host is explicitly allow-listed as staging
 *   AND does not match a production suffix. Unset/blank config refuses.
 * - Redaction helpers never emit a credential value, raw request content, or an
 *   unmasked client IP.
 */

import { createHash } from "node:crypto";

/** Raised for any refused configuration; messages never contain secret values. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Production host suffixes that must never be targeted by this driver. */
export const DEFAULT_PRODUCTION_SUFFIXES = [".chatgpt.site"];

/** Every non-GET verb the relay logger can distinguish (see auth-helper.ts). */
export const LOGGED_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"];

/** Default per-target request count. Owner floor is >= 30. */
export const DEFAULT_PER_TARGET = 30;

function splitList(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Normalize a host for comparison: lowercase, no trailing dot, no port. */
export function normalizeHost(host) {
  if (typeof host !== "string") return "";
  const bare = host.trim().toLowerCase().replace(/\.+$/, "");
  return bare.replace(/:\d+$/, "");
}

/**
 * True when `host` equals an allow-listed entry or is a subdomain of one.
 * Deliberately strict: an empty allow-list matches nothing.
 */
export function isHostAllowListed(host, allowedHosts) {
  const normalized = normalizeHost(host);
  if (normalized === "") return false;
  return allowedHosts.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

/** True when `host` equals a production suffix root or is a subdomain of one. */
export function isProductionHost(host, productionSuffixes = DEFAULT_PRODUCTION_SUFFIXES) {
  const normalized = normalizeHost(host);
  if (normalized === "") return false;
  return productionSuffixes.some((suffix) => {
    const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    return normalized === bare || normalized.endsWith(`.${bare}`);
  });
}

/**
 * Resolve and validate the run configuration from an environment object.
 *
 * Throws `ConfigError` when the target is missing, non-https, not explicitly
 * allow-listed as staging, or matches a production suffix. The returned object
 * contains only non-secret values.
 */
export function resolveTargetConfig(env = {}) {
  const rawBaseUrl = env.A01_SYNTHETIC_BASE_URL;
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
    throw new ConfigError("A01_SYNTHETIC_BASE_URL is not set; refusing to run");
  }

  let url;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    throw new ConfigError("A01_SYNTHETIC_BASE_URL is not a valid URL; refusing to run");
  }

  if (url.protocol !== "https:") {
    throw new ConfigError("A01_SYNTHETIC_BASE_URL must use https; refusing to run");
  }

  const host = normalizeHost(url.host);
  const allowedHosts = splitList(env.A01_SYNTHETIC_ALLOWED_HOSTS);
  const productionSuffixes = splitList(env.A01_SYNTHETIC_PRODUCTION_SUFFIXES);
  const effectiveSuffixes = productionSuffixes.length > 0 ? productionSuffixes : DEFAULT_PRODUCTION_SUFFIXES;

  if (allowedHosts.length === 0) {
    throw new ConfigError("A01_SYNTHETIC_ALLOWED_HOSTS is not set; refusing to run without an explicit staging allow-list");
  }
  if (isProductionHost(host, effectiveSuffixes)) {
    throw new ConfigError(`target host "${host}" matches a production suffix; refusing to run`);
  }
  if (!isHostAllowListed(host, allowedHosts)) {
    throw new ConfigError(`target host "${host}" is not in A01_SYNTHETIC_ALLOWED_HOSTS; refusing to run`);
  }

  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host,
    origin: url.origin,
    allowedHosts,
    productionSuffixes: effectiveSuffixes,
  };
}

/**
 * Collect every runtime secret value so callers can prove none of it leaked
 * into an output artifact. Names are fixed and documented; a blank value is
 * treated as "unset" and skipped.
 */
export function collectSecretValues(env = {}) {
  const names = [
    "A01_SYNTHETIC_STUDENT_TOKEN",
    "A01_SYNTHETIC_ADMIN_TOKEN",
    "A01_SYNTHETIC_RELAY_SIGNING_KEY",
    "A01_SYNTHETIC_STUDENT_RELAY_KEY",
    "A01_SYNTHETIC_ADMIN_RELAY_KEY",
    "A01_SYNTHETIC_EDGE_SECRET",
  ];
  const values = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) values.push(value);
  }
  return values;
}

/** Replace every occurrence of each secret with a fixed marker. */
export function redactText(text, secrets = []) {
  let output = typeof text === "string" ? text : String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

/**
 * Throw when any secret value is present in a serialized artifact. Used as a
 * final gate before writing evidence output.
 */
export function assertNoSecrets(serialized, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0 && serialized.includes(secret)) {
      throw new ConfigError("refusing to write output that contains a credential value");
    }
  }
}

/** Mask a client IP: IPv4 keeps /16, IPv6 keeps /48. Never returns the raw IP. */
export function maskIp(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ip = value.trim();
  if (ip.includes(":")) {
    const hextets = ip.split(":").filter((part) => part.length > 0);
    return `${hextets.slice(0, 3).join(":")}::/48`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return null;
  return `${octets[0]}.${octets[1]}.0.0/16`;
}

/** Hash an identifier with a per-run salt; the raw value is never emitted. */
export function hashId(value, salt) {
  if (value === undefined || value === null || String(value) === "") return null;
  return createHash("sha256").update(`${salt}\u0000${String(value)}`).digest("hex").slice(0, 16);
}

/** Expand the target matrix into concrete, per-target run counts. */
export function expandTargets(targets, perTarget = DEFAULT_PER_TARGET) {
  const count = Number.isSafeInteger(perTarget) && perTarget > 0 ? perTarget : DEFAULT_PER_TARGET;
  return targets.map((target) => ({ ...target, count }));
}

/** Requests-per-second limiter expressed as a minimum gap between requests. */
export function minGapMs(ratePerSecond) {
  const rate = Number(ratePerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.ceil(1000 / rate);
}

/**
 * Decide whether the run must stop.
 *
 * `stopFileExists` is the manual kill switch (e.g. a `.stop` file). Thresholds
 * are ratios in [0, 1]; a zero/blank threshold disables that check.
 */
export function evaluateStop(state) {
  const { attempted = 0, failures = 0, serverErrors = 0, errorRateLimit = 0, serverErrorLimit = 0, stopFileExists = false, stopFileReason = "stop file present" } = state ?? {};
  const reasons = [];
  if (stopFileExists) reasons.push(stopFileReason);
  if (attempted > 0) {
    if (errorRateLimit > 0 && failures / attempted > errorRateLimit) reasons.push(`error rate ${(failures / attempted).toFixed(4)} > ${errorRateLimit}`);
    if (serverErrorLimit > 0 && serverErrors / attempted > serverErrorLimit) reasons.push(`5xx rate ${(serverErrors / attempted).toFixed(4)} > ${serverErrorLimit}`);
  }
  return { stop: reasons.length > 0, reasons };
}

/** Round a ratio to a stable 4-decimal number for evidence output. */
export function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

/**
 * Build the redacted summary written to `docs/evidence/`. Callers pass only
 * already-aggregated, non-identifying counters; nothing here touches raw
 * request/response content.
 */
export function buildSummary({ runId, target, startedAt, finishedAt, dryRun, totals, byTarget, stop, cleanup, clientIpHashes }) {
  return {
    kind: "a01-synthetic-summary",
    runId,
    dryRun: Boolean(dryRun),
    startedAt,
    finishedAt,
    target: { host: target?.host ?? null, origin: target?.origin ?? null },
    totals,
    byTarget: byTarget ?? [],
    stop: stop ?? { stop: false, reasons: [] },
    cleanup: cleanup ?? null,
    clientIpHashes: clientIpHashes ?? [],
    notes: [
      "synthetic traffic only fills the per-path >=30 floor; it never counts toward Student >=300 / Admin >=100",
      "no raw request/response content, credential, or unmasked IP is stored",
    ],
  };
}

/** Build the run manifest: what was sent, how much, and how it can be undone. */
export function buildManifest({ runId, target, startedAt, finishedAt, dryRun, targets, credentials, cleanup }) {
  return {
    kind: "a01-synthetic-manifest",
    runId,
    dryRun: Boolean(dryRun),
    startedAt,
    finishedAt,
    target: { host: target?.host ?? null, origin: target?.origin ?? null },
    targets: targets ?? [],
    credentials: credentials ?? [],
    cleanup: cleanup ?? null,
  };
}

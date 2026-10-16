/**
 * Safety guards for the A-01 synthetic traffic injector.
 *
 * The injector must only ever run against a staging / synthetic target. These
 * helpers fail closed: an unset, non-https, or production-looking target is
 * rejected before any request is built or sent.
 */

/**
 * Production hosts that must never be targeted. `*.b827262.chatgpt.site` covers
 * the primary/backend, student and admin Sites deployments.
 */
export const DEFAULT_DENY_HOSTS = Object.freeze([
  "ai-quest-a1-backend.b827262.chatgpt.site",
  "ai-quest-a1-student.b827262.chatgpt.site",
  "ai-quest-a1-admin.b827262.chatgpt.site",
]);

/** A production-looking suffix that is denied even if not listed verbatim. */
export const DEFAULT_DENY_SUFFIXES = Object.freeze([".b827262.chatgpt.site"]);

export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafetyError";
  }
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Validate the injection target. Returns a normalized `{ origin, host }`.
 * Throws {@link SafetyError} for anything unsafe.
 *
 * @param {string|undefined} rawBaseUrl value of A01_SYNTHETIC_BASE_URL
 * @param {{denyHosts?: string[], denySuffixes?: string[]}} [options]
 */
export function assertStagingTarget(rawBaseUrl, options = {}) {
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
    throw new SafetyError(
      "A01_SYNTHETIC_BASE_URL is not set; refusing to run (staging target required)",
    );
  }
  let url;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    throw new SafetyError("A01_SYNTHETIC_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new SafetyError("A01_SYNTHETIC_BASE_URL must be an https origin");
  }
  if (url.username || url.password) {
    throw new SafetyError("A01_SYNTHETIC_BASE_URL must not embed credentials");
  }
  const host = url.host.toLowerCase();
  const denyHosts = (options.denyHosts ?? DEFAULT_DENY_HOSTS).map((h) => h.toLowerCase());
  const denySuffixes = (options.denySuffixes ?? DEFAULT_DENY_SUFFIXES).map((s) => s.toLowerCase());
  if (denyHosts.includes(host) || denySuffixes.some((suffix) => host.endsWith(suffix))) {
    throw new SafetyError(
      `A01_SYNTHETIC_BASE_URL host "${host}" matches a production deny-list entry; refusing to run`,
    );
  }
  return { origin: url.origin, host };
}

/**
 * Resolve the deny-list from the environment, merging defaults with any extra
 * entries supplied via A01_SYNTHETIC_DENY_HOSTS / A01_SYNTHETIC_DENY_SUFFIXES.
 */
export function denyListFromEnv(env = process.env) {
  return {
    denyHosts: [...DEFAULT_DENY_HOSTS, ...parseList(env.A01_SYNTHETIC_DENY_HOSTS)],
    denySuffixes: [...DEFAULT_DENY_SUFFIXES, ...parseList(env.A01_SYNTHETIC_DENY_SUFFIXES)],
  };
}

/**
 * True when the environment variable holds a non-empty value. Used to report
 * readiness (boolean) without ever returning or printing the value itself.
 */
export function isConfigured(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Return a copy of an env-like object with every value replaced by a redaction
 * marker, so nothing sensitive can leak into logs, manifests or error text.
 * Keys are preserved so the caller can report which variables are present.
 */
export function redactEnv(env = process.env) {
  const redacted = {};
  for (const key of Object.keys(env)) {
    redacted[key] = "<redacted>";
  }
  return redacted;
}

/**
 * Redact anything that looks like a secret-bearing value in an arbitrary
 * string (defensive; e.g. an unexpected error message). Long base64/hex runs
 * and known key prefixes are masked.
 */
export function redactString(value) {
  return String(value)
    .replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>")
    .replace(/(key|secret|token|sig|signature)=[^\s&]+/gi, "$1=<redacted>");
}

/** Mask an IPv4/IPv6 literal so evidence never stores a raw address. */
export function maskIp(value) {
  const text = String(value ?? "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".");
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  if (text.includes(":")) {
    const head = text.split(":").slice(0, 2).join(":");
    return `${head}::x`;
  }
  return "<masked>";
}

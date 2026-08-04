import { z } from "zod";

/**
 * QM runtime settings DTOs.
 *
 * The QM runtime config stores ONLY references — the provider config id, the
 * credential id, the model, and an optional Base URL override. It never stores,
 * copies, or carries an API key. The full key is decrypted transiently inside
 * the server process at execute time and discarded immediately; the browser
 * only ever sees {@link QmRuntimeConfigPublicView} (masked key + safe status).
 *
 * All schemas here are pure Zod so they are safe to import from the browser
 * bundle. The browser boundary script forbids `process.env`, server-only
 * modules, and `@yc-software/qm` in browser entry points; these data types do
 * not pull any of those in.
 */

const idSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata.internal"]);

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const parts = match.slice(1, 5).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918 private
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 private
  if (a === 192 && b === 168) return true; // RFC1918 private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "::1") return true; // loopback
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local fc00::/7
  if (host.startsWith("fe80")) return true; // link-local fe80::/10
  if (host.startsWith("::ffff:")) {
    // IPv4-mapped IPv6. Node's URL parser may keep this dotted ("::ffff:127.0.0.1")
    // or normalize it to two hex groups ("::ffff:7f00:1") — handle both.
    const mapped = host.slice("::ffff:".length);
    if (isPrivateIpv4(mapped)) return true;
    const hexGroups = mapped.split(":");
    if (hexGroups.length === 2) {
      const bytes = hexGroups.flatMap((group) => {
        const value = Number.parseInt(group || "0", 16);
        return [(value >> 8) & 0xff, value & 0xff];
      });
      return isPrivateIpv4(bytes.join("."));
    }
  }
  return false;
}

/**
 * Minimal scheme://[userinfo@]host[:port] parser. Deliberately avoids the
 * global `URL` constructor so this module has zero ambient-lib/runtime
 * dependency (no DOM lib, no `@types/node`) and stays trivially bundlable for
 * the browser.
 */
function parseUrlParts(value: string): { protocol: string; hostname: string } | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(value);
  if (!match) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  let authority = match[2];
  const atIndex = authority.lastIndexOf("@");
  if (atIndex !== -1) authority = authority.slice(atIndex + 1);
  let hostname: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    hostname = end === -1 ? authority.slice(1) : authority.slice(1, end);
  } else {
    const colonIndex = authority.indexOf(":");
    hostname = colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  }
  return { protocol, hostname: hostname.toLowerCase() };
}

/**
 * Blocks SSRF vectors on a QM base URL override: only http(s) is allowed, and
 * loopback, RFC1918/CGNAT private ranges, link-local (incl. the 169.254.169.254
 * cloud metadata endpoint), and well-known metadata hostnames are rejected.
 * This is an IP/hostname-literal allowlist, not DNS-rebinding-safe — any future
 * caller that actually dereferences this URL must re-validate at connect time.
 */
export function isSafeQmBaseUrl(value: string): boolean {
  const parsed = parseUrlParts(value.trim());
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname;
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (isPrivateIpv4(hostname)) return false;
  if (isPrivateIpv6(hostname)) return false;
  return true;
}

/**
 * The persisted QM runtime selection. By design there is no api key field: the
 * key lives encrypted on the referenced credential and is resolved at runtime.
 */
export const qmRuntimeConfigSchema = z.object({
  providerConfigId: idSchema,
  credentialId: idSchema,
  model: idSchema,
  baseUrlOverride: z.string().trim().url()
    .refine(isSafeQmBaseUrl, { message: "baseUrlOverride must not target a private, loopback, or metadata endpoint" })
    .nullable().default(null)
});
export type QmRuntimeConfig = z.infer<typeof qmRuntimeConfigSchema>;

/**
 * Exact, stable safe error codes for fail-closed resolution. The first failed
 * precondition wins; the browser and tests assert on these literal strings.
 */
export const QM_RUNTIME_CONFIG_ERROR_CODES = [
  "QM_RUNTIME_CONFIG_NOT_FOUND",
  "QM_PROVIDER_NOT_FOUND",
  "QM_PROVIDER_DISABLED",
  "QM_CREDENTIAL_NOT_FOUND",
  "QM_CREDENTIAL_MISMATCH",
  "QM_CREDENTIAL_DISABLED",
  "QM_CREDENTIAL_COOLDOWN",
  "QM_MODEL_NOT_CONFIGURED",
  "QM_RUNTIME_ENVIRONMENT_BLOCKED"
] as const;
export type QmRuntimeConfigErrorCode = (typeof QM_RUNTIME_CONFIG_ERROR_CODES)[number];

export const qmRuntimeConfigErrorCodeSchema = z.enum(QM_RUNTIME_CONFIG_ERROR_CODES);

/**
 * Result of re-validating the runtime config on every read/test/execute. `ok`
 * carries the resolved, usable selection; `blocked` carries the exact reason.
 * Resolution is intentionally re-run on each operation so that a provider or
 * credential disabled *after* the config was saved can never serve a stale
 * selection.
 */
export const qmRuntimeConfigResolutionSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    config: qmRuntimeConfigSchema,
    // Effective Base URL after credential → provider fallback. Pure metadata.
    effectiveBaseUrl: z.string().nullable(),
    credentialInCooldown: z.literal(false)
  }),
  z.object({
    ok: z.literal(false),
    reason: qmRuntimeConfigErrorCodeSchema
  })
]);
export type QmRuntimeConfigResolution = z.infer<typeof qmRuntimeConfigResolutionSchema>;

/**
 * Browser-safe view of the runtime config. Carries only the masked key and
 * non-sensitive status metadata. The full key is never present in this shape,
 * in the HTTP body, or in any persisted JSON.
 */
export const qmRuntimeConfigPublicViewSchema = z.object({
  config: qmRuntimeConfigSchema.nullable(),
  providerDisplayName: z.string().nullable(),
  providerSlug: z.string().nullable(),
  providerEnabled: z.boolean().nullable(),
  credentialName: z.string().nullable(),
  maskedApiKey: z.string().nullable(),
  credentialStatus: z.enum(["active", "standby", "disabled"]).nullable(),
  credentialInCooldown: z.boolean(),
  effectiveBaseUrl: z.string().nullable(),
  updatedAt: timestampSchema.nullable()
});
export type QmRuntimeConfigPublicView = z.infer<typeof qmRuntimeConfigPublicViewSchema>;

/** Result of the bounded runtime-config connectivity test. */
export const qmRuntimeConfigTestResultSchema = z.object({
  status: z.enum(["success", "failed"]),
  reason: z.string(),
  latencyMs: z.number().int().nonnegative(),
  upstreamRequestSent: z.boolean(),
  model: z.string()
});
export type QmRuntimeConfigTestResult = z.infer<typeof qmRuntimeConfigTestResultSchema>;

/** GET /api/admin/qm/runtime-config success body — validated in the browser before use. */
export const qmRuntimeConfigViewResponseSchema = z.object({
  view: qmRuntimeConfigPublicViewSchema,
  resolution: qmRuntimeConfigResolutionSchema
});
export type QmRuntimeConfigViewResponse = z.infer<typeof qmRuntimeConfigViewResponseSchema>;

/** PUT /api/admin/qm/runtime-config success body (200 only; blocked saves are a non-2xx error). */
export const qmRuntimeConfigSaveResponseSchema = z.object({
  config: qmRuntimeConfigSchema,
  resolution: qmRuntimeConfigResolutionSchema
});
export type QmRuntimeConfigSaveResponse = z.infer<typeof qmRuntimeConfigSaveResponseSchema>;

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

/**
 * The persisted QM runtime selection. By design there is no api key field: the
 * key lives encrypted on the referenced credential and is resolved at runtime.
 */
export const qmRuntimeConfigSchema = z.object({
  providerConfigId: idSchema,
  credentialId: idSchema,
  model: idSchema,
  baseUrlOverride: z.string().trim().url().nullable().default(null)
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

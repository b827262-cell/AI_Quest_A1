import { randomUUID } from "node:crypto";
import {
  qmRuntimeConfigSchema,
  type QmRuntimeConfig,
  type QmRuntimeConfigErrorCode,
  type QmRuntimeConfigPublicView,
  type QmRuntimeConfigResolution
} from "@ai-smartbook/contracts";
import type { SettingsRepo } from "@ai-smartbook/db";

/**
 * The single global QM runtime selection is persisted as JSON in `app_settings`
 * under this key. It stores ONLY references (provider/credential/model/baseUrl
 * override). The API key is never duplicated here — it lives encrypted on the
 * referenced credential and is resolved transiently at execute time.
 */
export const QM_RUNTIME_CONFIG_KEY = "qm_runtime_config_v1";

/** HTTP(S) only — rejects ftp/file/etc. schemes even though they are valid URLs. */
const HTTP_URL = /^https?:\/\//i;

/**
 * Read-only row shapes the resolution needs. Kept structural (no db import) so
 * the pure {@link resolveQmRuntimeConfig} function is unit-testable without a
 * database, by supplying a stub reader.
 */
export type QmRuntimeProviderRow = {
  id: string;
  provider: string;
  slug: string;
  displayName: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
};

export type QmRuntimeCredentialRow = {
  id: string;
  providerConfigId: string;
  name: string;
  maskedApiKey: string;
  baseUrl: string | null;
  model: string | null;
  status: "active" | "standby" | "disabled";
  cooldownUntil: string | null;
};

/**
 * Injectable read boundary. Production wires this to {@link Repositories}; tests
 * supply stubs to drive each fail-closed branch deterministically. `findConfig`
 * and `findCredential` already exclude soft-deleted rows, so a missing result
 * covers both "not found" and "soft-deleted" → the matching NOT_FOUND code.
 */
export type QmRuntimeConfigReader = {
  getConfig(): QmRuntimeConfig | null;
  findProvider(id: string): QmRuntimeProviderRow | null;
  findCredential(id: string): QmRuntimeCredentialRow | null;
  /** Lower-cased enabled model names configured for the credential. */
  enabledModelsForCredential(credentialId: string): string[];
  now(): string;
};

function blocked(reason: QmRuntimeConfigErrorCode): QmRuntimeConfigResolution {
  return { ok: false, reason };
}

/**
 * Fail-closed resolution. Re-run on EVERY read, test, and execute — not only on
 * save — so a provider or credential disabled *after* the config was persisted
 * can never serve a stale selection. The first failed precondition wins and
 * returns its exact safe error code.
 *
 * Order mirrors the contract: config → provider exists → provider enabled →
 * credential exists → credential belongs to provider → credential active →
 * credential not in cooldown → model configured → baseUrl override legal.
 */
export function resolveQmRuntimeConfig(reader: QmRuntimeConfigReader): QmRuntimeConfigResolution {
  const config = reader.getConfig();
  if (!config) return blocked("QM_RUNTIME_CONFIG_NOT_FOUND");

  const provider = reader.findProvider(config.providerConfigId);
  if (!provider) return blocked("QM_PROVIDER_NOT_FOUND");
  if (!provider.enabled) return blocked("QM_PROVIDER_DISABLED");

  const credential = reader.findCredential(config.credentialId);
  if (!credential) return blocked("QM_CREDENTIAL_NOT_FOUND");
  if (credential.providerConfigId !== provider.id) return blocked("QM_CREDENTIAL_MISMATCH");
  if (credential.status !== "active") return blocked("QM_CREDENTIAL_DISABLED");

  const now = reader.now();
  if (credential.cooldownUntil && credential.cooldownUntil > now) {
    return blocked("QM_CREDENTIAL_COOLDOWN");
  }

  const model = config.model.trim();
  if (!model) return blocked("QM_MODEL_NOT_CONFIGURED");
  const credentialModel = credential.model?.trim();
  const allowed = reader.enabledModelsForCredential(credential.id);
  const modelAllowed = (credentialModel && credentialModel.toLocaleLowerCase() === model.toLocaleLowerCase())
    || allowed.some((entry) => entry.toLocaleLowerCase() === model.toLocaleLowerCase());
  if (!modelAllowed) return blocked("QM_MODEL_NOT_CONFIGURED");

  if (config.baseUrlOverride !== null) {
    if (!HTTP_URL.test(config.baseUrlOverride.trim())) {
      return blocked("QM_RUNTIME_ENVIRONMENT_BLOCKED");
    }
  }
  const effectiveBaseUrl = config.baseUrlOverride ?? credential.baseUrl ?? provider.baseUrl;
  return { ok: true, config, effectiveBaseUrl, credentialInCooldown: false };
}

/**
 * Map a resolution's safe error code to an HTTP status. NOT_FOUND-shaped codes
 * are 404; the rest are 422 (fail-closed validation). 200 is implicit on `ok`.
 */
export function httpStatusForQmRuntimeBlock(reason: QmRuntimeConfigErrorCode): number {
  return reason === "QM_RUNTIME_CONFIG_NOT_FOUND" || reason === "QM_PROVIDER_NOT_FOUND" || reason === "QM_CREDENTIAL_NOT_FOUND"
    ? 404
    : 422;
}

/**
 * Decrypt a credential's API key for a single bounded operation and discard it
 * immediately. The plaintext is never assigned to process.env, never placed in
 * a shared variable outside this closure, and never returned. Callers receive
 * only the per-run secret map they merge into a fresh isolated env (see
 * `buildQmRunEnv` in qm-runner.ts) to spawn an isolated subprocess.
 *
 * `buildSecretEnv` is injectable so tests can supply a deterministic decryptor
 * and assert the plaintext never escapes into a shared/global location.
 */
export function buildIsolatedRunSecretEnv(
  secretKey: string,
  decrypt: (encrypted: string) => string,
  encryptedValue: string,
  buildSecretEnv?: (secretEnv: Record<string, string>) => NodeJS.ProcessEnv
): { env: NodeJS.ProcessEnv; requestId: string; secretEnv: Record<string, string> } {
  const requestId = `qmrun_${randomUUID().replaceAll("-", "")}`;
  // Decrypt transiently inside this closure; the plaintext lives only in this
  // stack frame and the fresh secretEnv object below — nowhere shared/global.
  const plaintext = decrypt(encryptedValue);
  if (!plaintext) throw new Error("qm_secret_unavailable");
  const secretEnv: Record<string, string> = { [secretKey]: plaintext };
  const env = buildSecretEnv ? buildSecretEnv(secretEnv) : { ...secretEnv };
  return { env, requestId, secretEnv };
}

export type QmRuntimeConfigService = {
  resolve(): QmRuntimeConfigResolution;
  save(input: QmRuntimeConfig): QmRuntimeConfig;
  getPublicView(): QmRuntimeConfigPublicView;
};

/**
 * Build the runtime-config service bound to a settings repo and a reader that
 * reads live provider/credential state. `resolve()` always re-reads live state,
 * so saving a config then disabling the provider makes the very next read fail
 * closed.
 */
export function createQmRuntimeConfigService(
  settings: SettingsRepo,
  reader: Omit<QmRuntimeConfigReader, "getConfig" | "now"> & { now?: () => string }
): QmRuntimeConfigService {
  const now = reader.now ?? (() => new Date().toISOString());

  function readConfig(): QmRuntimeConfig | null {
    const raw = settings.get(QM_RUNTIME_CONFIG_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = qmRuntimeConfigSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  function fullReader(): QmRuntimeConfigReader {
    return {
      getConfig: readConfig,
      findProvider: reader.findProvider,
      findCredential: reader.findCredential,
      enabledModelsForCredential: reader.enabledModelsForCredential,
      now
    };
  }

  function resolve(): QmRuntimeConfigResolution {
    return resolveQmRuntimeConfig(fullReader());
  }

  function save(input: QmRuntimeConfig): QmRuntimeConfig {
    const parsed = qmRuntimeConfigSchema.parse(input);
    settings.set(QM_RUNTIME_CONFIG_KEY, JSON.stringify(parsed));
    return parsed;
  }

  function getPublicView(): QmRuntimeConfigPublicView {
    const config = readConfig();
    if (!config) {
      return {
        config: null, providerDisplayName: null, providerSlug: null, providerEnabled: null,
        credentialName: null, maskedApiKey: null, credentialStatus: null, credentialInCooldown: false,
        effectiveBaseUrl: null, updatedAt: null
      };
    }
    const provider = reader.findProvider(config.providerConfigId);
    const credential = reader.findCredential(config.credentialId);
    const resolution = resolve();
    return {
      config,
      providerDisplayName: provider?.displayName ?? null,
      providerSlug: provider?.slug ?? null,
      providerEnabled: provider?.enabled ?? null,
      credentialName: credential?.name ?? null,
      maskedApiKey: credential?.maskedApiKey ?? null,
      credentialStatus: credential?.status ?? null,
      credentialInCooldown: Boolean(credential?.cooldownUntil && credential.cooldownUntil > now()),
      effectiveBaseUrl: resolution.ok ? resolution.effectiveBaseUrl : null,
      updatedAt: null
    };
  }

  return { resolve, save, getPublicView };
}

/**
 * Probe contract for {@link runQmRuntimeConfigTest}. The route wires this to the
 * existing `CredentialBackedProvider` bounded generation path (the same one the
 * credential-test route uses); tests inject a stub to assert the safe result
 * shape without any network. The probe MUST NOT return upstream bodies — only
 * whether a request was sent and whether it succeeded.
 */
export type QmRuntimeConfigProbe = (signal: AbortSignal) => Promise<{ upstreamRequestSent: boolean }>;

/**
 * Run the bounded runtime-config connectivity test against an already-resolved
 * (fail-closed) selection. A 5-second timeout aborts the probe; the result is a
 * safe shape carrying only status/reason/latency/upstream flag + the model. No
 * upstream response body, key, or prompt content is ever returned or logged.
 */
export async function runQmRuntimeConfigTest(
  model: string,
  probe: QmRuntimeConfigProbe,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<{ status: "success" | "failed"; reason: string; latencyMs: number; upstreamRequestSent: boolean; model: string }> {
  const started = options.now?.() ?? Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  let upstreamRequestSent = false;
  try {
    const result = await probe(controller.signal);
    upstreamRequestSent = result.upstreamRequestSent;
    return {
      status: "success",
      reason: "valid",
      latencyMs: (options.now?.() ?? Date.now()) - started,
      upstreamRequestSent,
      model
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const reason = aborted ? "provider_timeout" : !upstreamRequestSent ? "local_validation_failed" : "upstream_error";
    return {
      status: "failed",
      reason,
      latencyMs: (options.now?.() ?? Date.now()) - started,
      upstreamRequestSent,
      model
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Durable browser cache for local ONNX model artifacts (D-07 P0).
 *
 * This is deliberately separate from the in-memory Transformers.js session:
 * Cache Storage survives a same-origin browser restart / new tab, whereas
 * WebGPU/WASM sessions do not.  Keys include the model id and revision so
 * deploying a new application build never evicts an already downloaded model.
 *
 * The public surface is intentionally free of any global side effects: every
 * browser capability (`caches`, `navigator.storage`, `fetch`, `crypto`) is
 * probed lazily and can be injected via {@link CacheEnvOverrides} so the
 * integrity logic is unit-testable headlessly with real `Response` bytes.
 */
export const LOCAL_MODEL_CACHE_NAME = "ai-smartbook-local-model-v1";

/** Bumping this invalidates prior probes so a build can re-verify cached bytes. */
export const LOCAL_MODEL_CACHE_SCHEMA_VERSION = 2;

const META_PREFIX = "https://local-cache.invalid/meta/";
const ASSET_PREFIX = "https://local-cache.invalid/asset/";

export type ModelCacheIdentity = { modelId: string; revision: string };

/**
 * A single cached artifact. `expectedBytes` is the authoritative size used for
 * real-byte integrity checks (0 = size unknown, only presence + digest checked).
 * `digest` is an optional lowercase hex SHA-256 for content-level verification.
 */
export type CacheAsset = { url: string; expectedBytes: number; digest?: string };

export type AssetIntegrityState = "ok" | "missing" | "corrupt";

export type LocalModelCacheState = {
  supported: boolean;
  complete: boolean;
  stale: boolean;
  artifactCount: number;
  presentCount: number;
  missingCount: number;
  corruptCount: number;
  totalBytes: number;
  revisionMatches: boolean;
  usage?: number;
  quota?: number;
  persisted?: boolean;
};

/** Injection point for browser APIs; every field is optional for headless use. */
export type CacheLike = {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
};

export type StorageEstimateLike = { usage?: number; quota?: number };

export type StorageLike = {
  estimate?(): Promise<StorageEstimateLike>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
};

export type CacheEnvOverrides = {
  cache?: CacheLike | null;
  storage?: StorageLike | null;
  fetch?: typeof fetch;
};

export type ResolvedCacheEnv = {
  cache: CacheLike | null;
  storage: StorageLike | null;
  fetch: typeof fetch | undefined;
};

type ManifestRecord = {
  schemaVersion: number;
  modelId: string;
  revision: string;
  updatedAt: string;
  assets: CacheAsset[];
};

function identityKey(identity: ModelCacheIdentity) {
  return encodeURIComponent(`${identity.modelId}@${identity.revision}`);
}

/** A synthetic Cache API key; it keeps distinct revisions from sharing bytes. */
export function cacheKey(identity: ModelCacheIdentity, assetUrl: string) {
  return `${ASSET_PREFIX}${identityKey(identity)}/${encodeURIComponent(assetUrl)}`;
}

function manifestKey(identity: ModelCacheIdentity) {
  return `${META_PREFIX}${identityKey(identity)}.json`;
}

/** Lazily resolve the Cache Storage handle (null when unsupported). */
async function openDefaultCache(): Promise<CacheLike | null> {
  if (typeof caches === "undefined" || !caches?.open) return null;
  return (await caches.open(LOCAL_MODEL_CACHE_NAME)) as unknown as CacheLike;
}

function defaultStorage(): StorageLike | null {
  if (typeof navigator === "undefined") return null;
  const storage = (navigator as unknown as { storage?: StorageLike }).storage;
  return storage ?? null;
}

/** Resolve an execution environment, preferring explicit overrides. */
export async function resolveCacheEnv(overrides: CacheEnvOverrides = {}): Promise<ResolvedCacheEnv> {
  const cache =
    overrides.cache !== undefined ? overrides.cache : await openDefaultCache();
  const storage =
    overrides.storage !== undefined ? overrides.storage : defaultStorage();
  const fetchImpl =
    overrides.fetch ??
    (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
      ? (globalThis.fetch as typeof fetch)
      : undefined);
  return { cache: cache ?? null, storage: storage ?? null, fetch: fetchImpl };
}

function normalizeAsset(raw: unknown): CacheAsset | null {
  if (typeof raw === "string" && raw.length > 0) {
    return { url: raw, expectedBytes: 0 };
  }
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (typeof value.url === "string" && value.url.length > 0) {
      const expectedBytes =
        typeof value.expectedBytes === "number" && Number.isFinite(value.expectedBytes)
          ? Math.max(0, Math.floor(value.expectedBytes))
          : 0;
      const digest =
        typeof value.digest === "string" && value.digest.length > 0
          ? value.digest.toLowerCase()
          : undefined;
      return { url: value.url, expectedBytes, digest };
    }
  }
  return null;
}

/** Coerce a raw manifest payload (legacy `string[]` or v2 records) to assets. */
export function normalizeManifestAssets(raw: unknown): CacheAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: CacheAsset[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const asset = normalizeAsset(entry);
    if (asset && !seen.has(asset.url)) {
      seen.add(asset.url);
      out.push(asset);
    }
  }
  return out;
}

/**
 * Read the manifest for a specific identity. Returns `null` when absent or
 * structurally invalid so callers treat that as "nothing trustworthy cached".
 * A legacy manifest (no revision / lower schema) is surfaced via `revision`
 * and `schemaVersion` so callers can detect version drift and re-provision.
 */
export async function readManifest(
  identity: ModelCacheIdentity,
  overrides: CacheEnvOverrides = {},
): Promise<ManifestRecord | null> {
  const { cache } = await resolveCacheEnv(overrides);
  if (!cache) return null;
  const response = await cache.match(manifestKey(identity));
  if (!response) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  return {
    schemaVersion:
      typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    modelId: typeof value.modelId === "string" ? value.modelId : identity.modelId,
    revision: typeof value.revision === "string" ? value.revision : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    assets: normalizeManifestAssets(value.assets),
  };
}

async function writeManifest(
  identity: ModelCacheIdentity,
  record: ManifestRecord,
  cache: CacheLike,
): Promise<void> {
  await cache.put(
    manifestKey(identity),
    new Response(JSON.stringify(record), {
      headers: { "content-type": "application/json" },
    }),
  );
}

function freshRecord(
  identity: ModelCacheIdentity,
  assets: CacheAsset[],
): ManifestRecord {
  return {
    schemaVersion: LOCAL_MODEL_CACHE_SCHEMA_VERSION,
    modelId: identity.modelId,
    revision: identity.revision,
    updatedAt: new Date().toISOString(),
    assets,
  };
}

/**
 * Headers for a Cache Storage entry rebuilt from *decoded* bytes.
 *
 * `arrayBuffer()` yields the transport-decoded body, so carrying the original
 * `content-encoding` / `content-length` / `transfer-encoding` would make the
 * warm replay claim a compressed length it no longer has and get decoded a
 * second time on read - delivering corrupt model bytes that still pass a
 * presence-only check. Those three are exactly what the byte-size and digest
 * verification below re-derives, so they must not be copied verbatim.
 */
function storableHeaders(source: Headers | undefined): Headers {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}

async function digestHex(buffer: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) return null;
  const hash = await subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify one asset against the Cache API using *real bytes*: presence, then
 * byte length vs `expectedBytes`, then SHA-256 vs `digest` when supplied.
 */
export async function verifyAsset(
  identity: ModelCacheIdentity,
  asset: CacheAsset,
  overrides: CacheEnvOverrides = {},
): Promise<{ state: AssetIntegrityState; bytes: number }> {
  const { cache } = await resolveCacheEnv(overrides);
  if (!cache) return { state: "missing", bytes: 0 };
  const response = await cache.match(cacheKey(identity, asset.url));
  if (!response) return { state: "missing", bytes: 0 };
  let buffer: ArrayBuffer;
  try {
    buffer = await response.clone().arrayBuffer();
  } catch {
    return { state: "corrupt", bytes: 0 };
  }
  const bytes = buffer.byteLength;
  if (asset.expectedBytes > 0 && bytes !== asset.expectedBytes) {
    return { state: "corrupt", bytes };
  }
  if (asset.digest) {
    const actual = await digestHex(buffer);
    if (actual && actual !== asset.digest) return { state: "corrupt", bytes };
  }
  return { state: "ok", bytes };
}

/**
 * Page-open integrity probe (D-07 "開頁即驗"). Walks the recorded artifacts and
 * verifies their bytes; reports missing / corrupt / version-drift without ever
 * triggering a network request. Safe to call on every boot (F5 / new tab)
 * because the manifest + bytes live in persistent Cache Storage.
 */
export async function probeLocalModelCache(
  identity: ModelCacheIdentity,
  overrides: CacheEnvOverrides = {},
): Promise<LocalModelCacheState> {
  const env = await resolveCacheEnv(overrides);
  if (!env.cache) {
    return {
      supported: false,
      complete: false,
      stale: false,
      artifactCount: 0,
      presentCount: 0,
      missingCount: 0,
      corruptCount: 0,
      totalBytes: 0,
      revisionMatches: false,
    };
  }
  const manifest = await readManifest(identity, { cache: env.cache, storage: env.storage });
  const estimate = await env.storage?.estimate?.().catch(() => undefined);
  const persisted = await env.storage?.persisted?.().catch(() => undefined);

  if (!manifest || manifest.assets.length === 0) {
    return {
      supported: true,
      complete: false,
      stale: false,
      artifactCount: 0,
      presentCount: 0,
      missingCount: 0,
      corruptCount: 0,
      totalBytes: 0,
      revisionMatches: false,
      usage: estimate?.usage,
      quota: estimate?.quota,
      persisted,
    };
  }

  const revisionMatches =
    manifest.revision === identity.revision &&
    manifest.schemaVersion === LOCAL_MODEL_CACHE_SCHEMA_VERSION;

  const results = await Promise.all(
    manifest.assets.map((asset) =>
      verifyAsset(identity, asset, { cache: env.cache, storage: env.storage }),
    ),
  );

  let presentCount = 0;
  let missingCount = 0;
  let corruptCount = 0;
  let totalBytes = 0;
  for (const result of results) {
    if (result.state === "ok") presentCount += 1;
    else if (result.state === "missing") missingCount += 1;
    else corruptCount += 1;
    totalBytes += result.bytes;
  }

  return {
    supported: true,
    complete: revisionMatches && missingCount === 0 && corruptCount === 0,
    stale: !revisionMatches,
    artifactCount: manifest.assets.length,
    presentCount,
    missingCount,
    corruptCount,
    totalBytes,
    revisionMatches,
    usage: estimate?.usage,
    quota: estimate?.quota,
    persisted,
  };
}

/**
 * Fetch adapter for Transformers.js. A verified warm entry is returned straight
 * from Cache Storage with *no network GET*; a corrupt / missing entry falls
 * through to the network and is repaired with its measured byte length.
 *
 * `onAssetStored` lets callers (e.g. the D-07 UI) learn the exact cached byte
 * size of each newly stored artifact so the manifest can be kept authoritative.
 */
export function createModelCacheFetch(
  identity: ModelCacheIdentity,
  networkFetch: typeof fetch = fetch,
  overrides: CacheEnvOverrides = {},
  onAssetStored?: (asset: CacheAsset) => void | Promise<void>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const env = await resolveCacheEnv({ ...overrides, fetch: networkFetch });
    const cache = env.cache;
    const key = cacheKey(identity, url);

    // A warm hit must never be able to fail the load: an unreadable entry is
    // treated as cold and repaired from the network below.
    const cached = cache ? await cache.match(key).catch(() => undefined) : undefined;
    if (cached) return cached;

    const response = await (env.fetch as typeof fetch)(input, init);
    const isGet = (init?.method ?? "GET").toUpperCase() === "GET";
    // Durability gate: only a whole-resource 200 may be written. A Range read is
    // answered 206 with a slice of the artifact; storing that under the
    // full-artifact key would later verify as "warm" with a matching byte length
    // while the model file stayed truncated. A 200 answers a Range request with
    // the full representation, so the request headers need no inspection.
    if (cache && isGet && response.status === 200) {
      try {
        const buffer = await response.clone().arrayBuffer();
        const expectedBytes = buffer.byteLength;
        const replay = new Response(buffer.slice(0), {
          status: response.status,
          statusText: response.statusText,
          headers: storableHeaders(response.headers),
        });
        await cache.put(key, replay);
        const digest =
          response.headers?.get?.("x-artifact-sha256")?.toLowerCase() || undefined;
        const asset: CacheAsset = { url, expectedBytes, digest };
        await onAssetStored?.(asset);
      } catch {
        // Quota or a non-cloneable response must not make model loading fail:
        // the caller still receives the live response below.
      }
    }
    return response;
  }) as typeof fetch;
}

export function isQuotaError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: number; message?: string } | null;
  if (!candidate) return false;
  return (
    candidate.name === "QuotaExceededError" ||
    candidate.name === "NotAllowedError" ||
    candidate.code === 20 ||
    /quota|storage/i.test(candidate.message ?? "")
  );
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: string } | null;
  return candidate?.name === "AbortError";
}

function waitForRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(1000 * 2 ** attempt, 8000);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type EnsureProgress = {
  url: string;
  index: number;
  total: number;
  downloadedBytes: number;
  totalBytes: number;
  status: "downloading" | "stored" | "skipped" | "failed" | "quota" | "aborted";
  message?: string;
};

export type EnsureResult = {
  status: "warm" | "downloaded" | "partial" | "aborted" | "quota" | "failed";
  verifiedCount: number;
  downloadedCount: number;
  failedCount: number;
  totalBytes: number;
  message?: string;
};

export type EnsureLocalModelCacheOptions = {
  identity: ModelCacheIdentity;
  assets: CacheAsset[];
  signal?: AbortSignal;
  maxRetries?: number;
  onProgress?: (progress: EnsureProgress) => void | Promise<void>;
  env?: CacheEnvOverrides;
};

/**
 * The non-blocking D-07 background loader. It is deliberately idempotent and
 * resumable so it can be re-invoked after F5 / a new tab without re-downloading
 * verified bytes:
 *
 *  1. Verify the requested assets against Cache Storage (real bytes / digest).
 *  2. Persist the target manifest first, so a crash mid-download is detected as
 *     incomplete on next boot and only the *missing / corrupt / stale* subset is
 *     fetched (warm entries short-circuit, never a re-GET).
 *  3. Fetch pending assets with `signal`-driven abort, bounded exponential
 *     backoff retry, and quota detection that halts without breaking the UI.
 *
 * All work is asynchronous and surfaces progress via `onProgress`; it never
 * blocks the caller's render path.
 */
export async function ensureLocalModelCache(
  options: EnsureLocalModelCacheOptions,
): Promise<EnsureResult> {
  const { identity, signal, maxRetries = 2, onProgress } = options;
  const env = await resolveCacheEnv(options.env ?? {});
  const desired = normalizeManifestAssets(options.assets);

  if (!env.cache) {
    return {
      status: "failed",
      verifiedCount: 0,
      downloadedCount: 0,
      failedCount: desired.length,
      totalBytes: 0,
      message: "Cache Storage is unavailable in this browser",
    };
  }
  const cache = env.cache;

  // Record the target set/revision up front so version drift + partial progress
  // are visible to the next probe even if this call is aborted.
  await writeManifest(identity, freshRecord(identity, desired), cache);

  const results = await Promise.all(
    desired.map(async (asset) => ({
      asset,
      integrity: await verifyAsset(identity, asset, { cache, storage: env.storage }),
    })),
  );

  const alreadyOk = results.filter((entry) => entry.integrity.state === "ok");
  for (const entry of alreadyOk) {
    await onProgress?.({
      url: entry.asset.url,
      index: desired.indexOf(entry.asset),
      total: desired.length,
      downloadedBytes: entry.integrity.bytes,
      totalBytes: entry.asset.expectedBytes || entry.integrity.bytes,
      status: "skipped",
    });
  }

  let totalBytes = alreadyOk.reduce((sum, entry) => sum + entry.integrity.bytes, 0);
  let downloadedCount = 0;
  let failedCount = 0;
  let quotaHit = false;

  if (signal?.aborted) {
    return {
      status: "aborted",
      verifiedCount: alreadyOk.length,
      downloadedCount,
      failedCount,
      totalBytes,
      message: "cancelled",
    };
  }

  for (const { asset } of results.filter((entry) => entry.integrity.state !== "ok")) {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        return {
          status: "aborted",
          verifiedCount: alreadyOk.length,
          downloadedCount,
          failedCount,
          totalBytes,
          message: "cancelled",
        };
      }
      try {
        const response = await (env.fetch as typeof fetch)(asset.url, {
          signal,
          method: "GET",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // A 206 here would be a truncated artifact; it must fail closed so the
        // asset is retried rather than persisted as a short warm entry.
        if (response.status !== 200) {
          throw new Error(`unexpected partial response (HTTP ${response.status})`);
        }
        const buffer = await response.arrayBuffer();
        const bytes = buffer.byteLength;
        if (asset.expectedBytes > 0 && bytes !== asset.expectedBytes) {
          throw new Error(`byte-length ${bytes} != expected ${asset.expectedBytes}`);
        }
        if (asset.digest) {
          const actual = await digestHex(buffer);
          if (actual && actual !== asset.digest) throw new Error("digest mismatch");
        }
        await cache.put(
          cacheKey(identity, asset.url),
          new Response(buffer.slice(0), { headers: storableHeaders(response.headers) }),
        );
        downloadedCount += 1;
        totalBytes += bytes;
        await onProgress?.({
          url: asset.url,
          index: desired.indexOf(asset),
          total: desired.length,
          downloadedBytes: bytes,
          totalBytes: asset.expectedBytes || bytes,
          status: "stored",
        });
        break;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          return {
            status: "aborted",
            verifiedCount: alreadyOk.length,
            downloadedCount,
            failedCount,
            totalBytes,
            message: "cancelled",
          };
        }
        if (isQuotaError(error)) {
          quotaHit = true;
          await onProgress?.({
            url: asset.url,
            index: desired.indexOf(asset),
            total: desired.length,
            downloadedBytes: 0,
            totalBytes: asset.expectedBytes,
            status: "quota",
            message: (error as Error)?.message,
          });
          break;
        }
        if (attempt >= maxRetries) {
          failedCount += 1;
          await onProgress?.({
            url: asset.url,
            index: desired.indexOf(asset),
            total: desired.length,
            downloadedBytes: 0,
            totalBytes: asset.expectedBytes,
            status: "failed",
            message: (error as Error)?.message,
          });
          break;
        }
        attempt += 1;
        await onProgress?.({
          url: asset.url,
          index: desired.indexOf(asset),
          total: desired.length,
          downloadedBytes: 0,
          totalBytes: asset.expectedBytes,
          status: "downloading",
          message: `retry ${attempt}/${maxRetries}`,
        });
        await waitForRetry(attempt - 1, signal);
      }
    }
  }

  if (quotaHit) {
    return {
      status: "quota",
      verifiedCount: alreadyOk.length,
      downloadedCount,
      failedCount,
      totalBytes,
      message: "Storage quota exceeded",
    };
  }

  const verifiedTotal = alreadyOk.length + downloadedCount;
  if (failedCount > 0) {
    return {
      status: "failed",
      verifiedCount: verifiedTotal,
      downloadedCount,
      failedCount,
      totalBytes,
    };
  }
  return {
    status: alreadyOk.length === desired.length ? "warm" : "downloaded",
    verifiedCount: verifiedTotal,
    downloadedCount,
    failedCount,
    totalBytes,
  };
}

/** Ask for persistent storage only from a user gesture; result is never assumed. */
export async function requestLocalModelPersistence(
  overrides: CacheEnvOverrides = {},
): Promise<boolean | null> {
  const env = await resolveCacheEnv(overrides);
  if (!env.storage?.persist) return null;
  try {
    return await env.storage.persist();
  } catch {
    return false;
  }
}

/** User-initiated deletion is revision-scoped and cannot touch other models/builds. */
export async function deleteLocalModelCache(
  identity: ModelCacheIdentity,
  overrides: CacheEnvOverrides = {},
): Promise<number> {
  const env = await resolveCacheEnv(overrides);
  if (!env.cache) return 0;
  const cache = env.cache;
  const manifest = await readManifest(identity, { cache, storage: env.storage });
  const assets = manifest?.assets ?? [];
  await Promise.all([
    ...assets.map((asset) => cache.delete(cacheKey(identity, asset.url))),
    cache.delete(manifestKey(identity)),
  ]);
  return assets.length;
}

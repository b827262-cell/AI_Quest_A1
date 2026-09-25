/**
 * Durable browser cache for local ONNX model artifacts.
 *
 * Cache Storage is scoped to the current origin and browser profile. It survives
 * reloads and restarts, but it does not keep a WebGPU/WASM session resident.
 * Cache keys include the model ID and immutable revision, never the app build.
 */
export const LOCAL_MODEL_CACHE_NAME = "ai-smartbook-local-model-v1";
const META_PREFIX = "https://local-cache.invalid/meta/";
const ASSET_PREFIX = "https://local-cache.invalid/asset/";

export type ModelCacheIssue = "corrupt" | "quota" | "incomplete";
export type LocalModelCacheState = {
  supported: boolean;
  complete: boolean;
  artifactCount: number;
  usage?: number;
  quota?: number;
  persisted?: boolean;
  issue?: ModelCacheIssue;
};

export type ModelCacheIdentity = { modelId: string; revision: string };
type CacheStore = Pick<CacheStorage, "open">;
export type ModelCacheOptions = { storage?: CacheStore; signal?: AbortSignal };
type AssetRecord = { url: string; byteLength: number | null; stored: boolean };
type CacheManifest = {
  version: 1;
  modelId: string;
  revision: string;
  ready: boolean;
  assets: AssetRecord[];
  issue?: ModelCacheIssue;
};

const manifestQueues = new Map<string, Promise<void>>();
const transientIssues = new Map<string, ModelCacheIssue>();
const pendingCacheWrites = new Map<string, Set<Promise<void>>>();

function trackCacheWrite(identityKeyText: string, write: Promise<void>) {
  let writes = pendingCacheWrites.get(identityKeyText);
  if (!writes) {
    writes = new Set();
    pendingCacheWrites.set(identityKeyText, writes);
  }
  writes.add(write);
  const finish = () => {
    writes?.delete(write);
    if (writes?.size === 0) pendingCacheWrites.delete(identityKeyText);
  };
  void write.then(finish, finish);
}

async function waitForCacheWrites(identity: ModelCacheIdentity) {
  const key = identityKey(identity);
  while (pendingCacheWrites.get(key)?.size) {
    await Promise.allSettled([...(pendingCacheWrites.get(key) ?? [])]);
  }
}

function identityKey(identity: ModelCacheIdentity) {
  return encodeURIComponent(`${identity.modelId}@${identity.revision}`);
}

/** A synthetic Cache API key; revisions and source URLs remain unambiguous. */
export function cacheKey(identity: ModelCacheIdentity, assetUrl: string) {
  return `${ASSET_PREFIX}${identityKey(identity)}/${encodeURIComponent(assetUrl)}`;
}

function assetPrefix(identity: ModelCacheIdentity) {
  return `${ASSET_PREFIX}${identityKey(identity)}/`;
}

function manifestKey(identity: ModelCacheIdentity) {
  return `${META_PREFIX}${identityKey(identity)}.json`;
}

async function openCache(storage?: CacheStore) {
  const cacheStorage = storage ?? (typeof caches === "undefined" ? undefined : caches);
  return cacheStorage ? cacheStorage.open(LOCAL_MODEL_CACHE_NAME) : null;
}

function emptyManifest(identity: ModelCacheIdentity, issue?: ModelCacheIssue): CacheManifest {
  return { version: 1, modelId: identity.modelId, revision: identity.revision, ready: false, assets: [], ...(issue ? { issue } : {}) };
}

function isIssue(value: unknown): value is ModelCacheIssue {
  return value === "corrupt" || value === "quota" || value === "incomplete";
}

async function readManifest(cache: Cache, identity: ModelCacheIdentity): Promise<{ manifest: CacheManifest | null; corrupt: boolean }> {
  const response = await cache.match(manifestKey(identity));
  if (!response) return { manifest: null, corrupt: false };
  try {
    const value = await response.json() as Partial<CacheManifest>;
    const validAssets = Array.isArray(value.assets) && value.assets.every((asset) =>
      Boolean(asset) && typeof asset.url === "string" && typeof asset.stored === "boolean" &&
      (asset.byteLength === null || (Number.isSafeInteger(asset.byteLength) && asset.byteLength >= 0)));
    if (value.version !== 1 || value.modelId !== identity.modelId || value.revision !== identity.revision ||
      typeof value.ready !== "boolean" || !validAssets) return { manifest: null, corrupt: true };
    return {
      manifest: {
        version: 1,
        modelId: identity.modelId,
        revision: identity.revision,
        ready: value.ready,
        assets: value.assets as AssetRecord[],
        ...(isIssue(value.issue) ? { issue: value.issue } : {}),
      },
      corrupt: false,
    };
  } catch {
    return { manifest: null, corrupt: true };
  }
}

async function writeManifest(cache: Cache, manifest: CacheManifest) {
  await cache.put(manifestKey(manifest), new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/json" },
  }));
}

/** Serialize manifest updates so parallel tokenizer/config/ONNX fetches do not lose entries. */
async function updateManifest(cache: Cache, identity: ModelCacheIdentity, update: (manifest: CacheManifest) => CacheManifest) {
  const key = manifestKey(identity);
  const previous = manifestQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const read = await readManifest(cache, identity);
    const initial = read.manifest ?? emptyManifest(identity, read.corrupt ? "corrupt" : undefined);
    await writeManifest(cache, update(initial));
  });
  manifestQueues.set(key, current);
  try {
    await current;
    transientIssues.delete(identityKey(identity));
  } finally {
    if (manifestQueues.get(key) === current) manifestQueues.delete(key);
  }
}

function abortError() {
  if (typeof DOMException !== "undefined") return new DOMException("The model request was aborted.", "AbortError");
  const error = new Error("The model request was aborted.");
  error.name = "AbortError";
  return error;
}

function mergeSignals(signals: Array<AbortSignal | null | undefined>) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!active.length) return { signal: undefined, dispose() {} };
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const listeners = active.map((signal) => {
    if (signal.aborted) abort(signal);
    const listener = () => abort(signal);
    if (!signal.aborted) signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    dispose() { for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener); },
  };
}

function requestSignal(input: RequestInfo | URL) {
  return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
}

/** Keep the merged abort signal alive while a returned network/cache body streams. */
function responseWithAbort(
  response: Response,
  signal: AbortSignal | undefined,
  onSettled: () => void,
): Response {
  if (!signal || !response.body || response.status === 0) {
    onSettled();
    return response;
  }

  const reader = response.body.getReader();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", cancelOnAbort);
    onSettled();
  };
  const cancelOnAbort = () => {
    void reader.cancel(abortError()).catch(() => undefined).finally(finish);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  if (signal.aborted) cancelOnAbort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        controller.error(abortError());
        finish();
        return;
      }
      try {
        const next = await reader.read();
        if (signal.aborted) {
          controller.error(abortError());
          finish();
        } else if (next.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(); }
    },
  }, { highWaterMark: 0 });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function pinModelRevision(urlText: string, identity: ModelCacheIdentity) {
  try {
    const url = new URL(urlText);
    const modelPath = `/${identity.modelId}/resolve/main/`;
    if (url.origin === "https://huggingface.co" && url.pathname.startsWith(modelPath)) {
      url.pathname = url.pathname.replace("/resolve/main/", `/resolve/${encodeURIComponent(identity.revision)}/`);
      return url.toString();
    }
  } catch {
    // Let fetch report malformed URLs in the normal way.
  }
  return urlText;
}

function responseLength(response: Response) {
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") return null;
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function plausibleCachedResponse(response: Response, record?: AssetRecord) {
  if (!response.ok || response.status !== 200) return false;
  const actualHeaderLength = responseLength(response);
  return record?.byteLength == null || actualHeaderLength == null || record.byteLength === actualHeaderLength;
}

function withAsset(manifest: CacheManifest, record: AssetRecord, issue?: ModelCacheIssue): CacheManifest {
  const assets = manifest.assets.filter((asset) => asset.url !== record.url);
  assets.push(record);
  return { ...manifest, ready: false, assets, ...(issue ? { issue } : { issue: undefined }) };
}

/**
 * Fetch adapter for Transformers.js. Successful full GETs are stored in the
 * origin's Cache API. Invalid entries are evicted and retried from the pinned
 * model revision; cache/quota errors never hide the live network response.
 */
export function createModelCacheFetch(
  identity: ModelCacheIdentity,
  networkFetch: typeof fetch = fetch,
  options: ModelCacheOptions = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const originalUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const pinnedUrl = pinModelRevision(originalUrl, identity);
    const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    const merged = mergeSignals([requestSignal(input), init?.signal, options.signal]);
    const signal = merged.signal;
    const cacheable = method === "GET";
    let cache: Cache | null = null;
    const key = cacheKey(identity, originalUrl);
    let record: AssetRecord | undefined;
  const identityKeyText = identityKey(identity);
  let signalTransferred = false;
  const returnResponse = (response: Response) => {
    signalTransferred = true;
    return responseWithAbort(response, signal, merged.dispose);
  };

    try {
      if (signal?.aborted) throw abortError();
      if (cacheable) {
        try { cache = await openCache(options.storage); } catch { transientIssues.set(identityKeyText, "quota"); }
        if (signal?.aborted) throw abortError();
        if (cache) {
          const read = await readManifest(cache, identity);
          record = read.manifest?.assets.find((asset) => asset.url === originalUrl);
          if (read.corrupt) transientIssues.set(identityKeyText, "corrupt");
          let cached: Response | undefined;
          try { cached = await cache.match(key) ?? undefined; } catch { transientIssues.set(identityKeyText, "corrupt"); }
          if (signal?.aborted) throw abortError();
          const cachedLength = record?.byteLength ?? (cached ? responseLength(cached) : null);
          const cachedByteLength = cached && plausibleCachedResponse(cached, record)
            ? await fullFileByteLength(cached, cachedLength, signal)
            : null;
          if (cached && cachedByteLength !== null) {
            if (!record?.stored) {
              try {
                await updateManifest(cache, identity, (manifest) => withAsset(manifest, {
                  url: originalUrl,
                  byteLength: cachedByteLength,
                  stored: true,
                }));
              } catch { transientIssues.set(identityKeyText, "quota"); }
            }
            if (signal?.aborted) throw abortError();
            let verified: Response | undefined;
            try { verified = await cache.match(key) ?? undefined; } catch { transientIssues.set(identityKeyText, "corrupt"); }
            if (signal?.aborted) throw abortError();
            if (verified && plausibleCachedResponse(verified, record)) return returnResponse(verified);
          }
          if (cached) {
            await cache.delete(key).catch(() => false);
            try {
              await updateManifest(cache, identity, (manifest) => ({
                ...manifest,
                ready: false,
                issue: "corrupt",
                assets: manifest.assets.filter((asset) => asset.url !== originalUrl),
              }));
            } catch { transientIssues.set(identityKeyText, "quota"); }
            transientIssues.set(identityKeyText, "corrupt");
          }
          try {
            await updateManifest(cache, identity, (manifest) => withAsset(manifest, {
              url: originalUrl,
              byteLength: null,
              stored: false,
            }, transientIssues.get(identityKeyText)));
          } catch { transientIssues.set(identityKeyText, "quota"); }
        }
      }

      if (signal?.aborted) throw abortError();
      let fetchInput: RequestInfo | URL = input;
      let fetchInit: RequestInit | undefined = { ...init, ...(signal ? { signal } : {}) };
      if (pinnedUrl !== originalUrl) {
        const sourceRequest = new Request(input, fetchInit);
        fetchInput = new Request(pinnedUrl, sourceRequest);
        fetchInit = undefined;
      }
      const response = await networkFetch(fetchInput, fetchInit);
      if (signal?.aborted) throw abortError();

      if (cache && cacheable) {
        const length = responseLength(response);
        const fullResponse = response.ok && response.status === 200;
        if (fullResponse && response.body) {
          const activeCache = cache;
          const [modelBody, cacheBody] = response.body.tee();
          let downloadedBytes = 0;
          const countedCacheBody = cacheBody.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              downloadedBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }));
          const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
          const modelResponse = new Response(modelBody, responseInit);
          const cacheResponse = new Response(countedCacheBody, responseInit);
          const cacheWrite = (async () => {
            try {
              await activeCache.put(key, cacheResponse);
            } catch {
              const issue = signal?.aborted ? "incomplete" : "quota";
              transientIssues.set(identityKeyText, issue);
              await cacheResponse.body?.cancel().catch(() => undefined);
              await activeCache.delete(key).catch(() => false);
              try {
                await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                  url: originalUrl,
                  byteLength: downloadedBytes || length,
                  stored: false,
                }, issue));
              } catch { /* The model still receives and consumes its live response branch. */ }
              return;
            }

            if (signal?.aborted) {
              transientIssues.set(identityKeyText, "incomplete");
              await activeCache.delete(key).catch(() => false);
              await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                url: originalUrl,
                byteLength: downloadedBytes || length,
                stored: false,
              }, "incomplete")).catch(() => undefined);
              return;
            }

            if (downloadedBytes <= 0 || (length !== null && downloadedBytes !== length)) {
              transientIssues.set(identityKeyText, "corrupt");
              await activeCache.delete(key).catch(() => false);
              await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                url: originalUrl,
                byteLength: downloadedBytes || length,
                stored: false,
              }, "corrupt")).catch(() => undefined);
              return;
            }

            try {
              await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                url: originalUrl,
                byteLength: downloadedBytes,
                stored: true,
              }));
            } catch {
              transientIssues.set(identityKeyText, "quota");
              try {
                await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                  url: originalUrl,
                  byteLength: downloadedBytes,
                  stored: false,
                }, "quota"));
              } catch { /* Model inference succeeds even when its cache manifest cannot be saved. */ }
            }

            if (signal?.aborted) {
              transientIssues.set(identityKeyText, "incomplete");
              await activeCache.delete(key).catch(() => false);
              await updateManifest(activeCache, identity, (manifest) => withAsset(manifest, {
                url: originalUrl,
                byteLength: downloadedBytes,
                stored: false,
              }, "incomplete")).catch(() => undefined);
            }
          })();
          trackCacheWrite(identityKeyText, cacheWrite);
          if (signal?.aborted) throw abortError();
          return returnResponse(modelResponse);
        } else {
          const issue: ModelCacheIssue = "incomplete";
          transientIssues.set(identityKeyText, issue);
          try {
            await updateManifest(cache, identity, (manifest) => withAsset(manifest, {
              url: originalUrl,
              byteLength: length,
              stored: false,
            }, issue));
          } catch { /* The model loader receives the HTTP error unchanged. */ }
        }
      }
      if (signal?.aborted) throw abortError();
      return returnResponse(response);
    } finally {
      if (!signalTransferred) merged.dispose();
    }
  }) as typeof fetch;
}

async function fullFileByteLength(response: Response, expectedLength: number | null, signal?: AbortSignal) {
  if (!response.ok || response.status !== 200 || !response.body) return null;
  const reader = response.body.getReader();
  let bytes = 0;
  const cancelOnAbort = () => { void reader.cancel(abortError()).catch(() => undefined); };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) throw abortError();
      if (next.done) break;
      bytes += next.value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    return null;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  return bytes > 0 && (expectedLength === null || bytes === expectedLength) ? bytes : null;
}

/** Probe every recorded artifact end-to-end; never trusts a downloaded=true flag. */
export async function probeLocalModelCache(identity: ModelCacheIdentity, options: ModelCacheOptions = {}): Promise<LocalModelCacheState> {
  let cache: Cache | null;
  try { cache = await openCache(options.storage); } catch {
    return { supported: true, complete: false, artifactCount: 0, issue: "quota" };
  }
  if (!cache) return { supported: false, complete: false, artifactCount: 0 };

  const read = await readManifest(cache, identity);
  const manifest = read.manifest;
  let issue = read.corrupt ? "corrupt" as const : manifest?.issue;
  let allFilesMatch = Boolean(manifest?.assets.length);
  if (manifest) {
    for (const asset of manifest.assets) {
      if (!asset.stored) {
        allFilesMatch = false;
        issue ??= "quota";
        continue;
      }
      let response: Response | undefined;
      try { response = await cache.match(cacheKey(identity, asset.url)) ?? undefined; } catch { issue = "corrupt"; }
      if (!response || !plausibleCachedResponse(response, asset) || await fullFileByteLength(response, asset.byteLength, options.signal) === null) {
        allFilesMatch = false;
        issue = "corrupt";
      }
    }
  }
  const storageManager = typeof navigator !== "undefined" ? navigator.storage : undefined;
  let estimate: StorageEstimate | undefined;
  let persisted: boolean | undefined;
  try { estimate = await storageManager?.estimate?.(); } catch { /* Report storage estimates as unknown. */ }
  try { persisted = await storageManager?.persisted?.(); } catch { /* Persistence state is unknown. */ }
  const complete = Boolean(manifest?.ready && allFilesMatch);
  if (!complete) issue ??= transientIssues.get(identityKey(identity)) ?? "incomplete";
  return {
    supported: true,
    complete,
    artifactCount: manifest?.assets.length ?? 0,
    usage: estimate?.usage,
    quota: estimate?.quota,
    persisted,
    ...(issue ? { issue } : {}),
  };
}

/** Mark ready only after model creation succeeded and each observed artifact was stored. */
export async function markLocalModelCacheReady(identity: ModelCacheIdentity, options: ModelCacheOptions = {}) {
  await waitForCacheWrites(identity);
  const cache = await openCache(options.storage);
  if (!cache) return false;
  let ready = false;
  await updateManifest(cache, identity, (manifest) => {
    ready = manifest.assets.length > 0 && manifest.assets.every((asset) => asset.stored);
    return { ...manifest, ready, ...(ready ? { issue: undefined } : { issue: manifest.issue ?? "incomplete" }) };
  });
  return ready;
}

/** Ask for persistent storage only from a user gesture; never assume it was granted. */
export async function requestLocalModelPersistence(storageManager?: Pick<StorageManager, "persist">): Promise<boolean | null> {
  const manager = storageManager ?? (typeof navigator !== "undefined" ? navigator.storage : undefined);
  if (!manager?.persist) return null;
  try { return await manager.persist(); } catch { return false; }
}

/** User-initiated deletion is scoped to this model revision and cache namespace. */
export async function deleteLocalModelCache(identity: ModelCacheIdentity, options: ModelCacheOptions = {}) {
  const cache = await openCache(options.storage);
  if (!cache) return 0;
  const prefix = assetPrefix(identity);
  const metaKey = manifestKey(identity);
  const keys = typeof cache.keys === "function" ? await cache.keys() : [];
  const assets = keys.filter((request) => request.url.startsWith(prefix));
  await Promise.all([...assets.map((request) => cache.delete(request)), cache.delete(metaKey)]);
  transientIssues.delete(identityKey(identity));
  return assets.length;
}

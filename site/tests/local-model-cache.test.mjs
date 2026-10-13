import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheKey,
  cleanupIncompleteLocalModelCache,
  createModelCacheFetch,
  deleteLocalModelCache,
  markLocalModelCacheReady,
  probeLocalModelCache,
  requestLocalModelPersistence,
} from "../app/local-model-cache.ts";

const identity = { modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "da1453100cf3ff33ef56d17983fc7a8648706db6" };
const artifact = `https://huggingface.co/${identity.modelId}/resolve/main/onnx/model_q4f16.onnx`;
const manifestKey = `https://local-cache.invalid/meta/${encodeURIComponent(`${identity.modelId}@${identity.revision}`)}.json`;

class MemoryCache {
  entries = new Map();
  failAssetPuts = false;

  async match(key) {
    const entry = this.entries.get(typeof key === "string" ? key : key.url);
    return entry?.clone();
  }

  async put(key, response) {
    const url = typeof key === "string" ? key : key.url;
    if (this.failAssetPuts && url.includes("/asset/")) {
      throw Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
    }
    const body = await response.arrayBuffer();
    this.entries.set(url, new Response(body, { status: response.status, headers: response.headers }));
  }

  async delete(key) {
    return this.entries.delete(typeof key === "string" ? key : key.url);
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

function storageFor(cache = new MemoryCache()) {
  return { cache, storage: { open: async () => cache } };
}

function modelResponse(body = "model-bytes") {
  return new Response(body, { headers: { "content-length": String(new TextEncoder().encode(body).length) } });
}

test("model Cache API key is revision-qualified and keeps the original artifact URL opaque", () => {
  const key = cacheKey(identity, artifact);
  assert.match(key, /^https:\/\/local-cache\.invalid\/asset\//);
  assert.match(key, /onnx-community%2FQwen3-0\.6B-ONNX%40da1453100cf3ff33ef56d17983fc7a8648706db6/);
  assert.match(key, /model_q4f16\.onnx/);
  assert.notEqual(key, cacheKey({ ...identity, revision: "next" }, artifact));
});

test("a warm reload serves the cached full artifact without another network GET", async () => {
  const { storage } = storageFor();
  const requests = [];
  const network = async (input) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return modelResponse();
  };
  const firstLoad = createModelCacheFetch(identity, network, { storage });
  assert.equal(await (await firstLoad(artifact)).text(), "model-bytes");
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

  const reloadedPage = createModelCacheFetch(identity, network, { storage });
  assert.equal(await (await reloadedPage(artifact)).text(), "model-bytes");
  assert.equal(requests.length, 1);
  assert.match(requests[0], new RegExp(`/resolve/${identity.revision}/`));
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
});

test("a Range probe never enters the manifest, while later full artifacts make the cache ready", async () => {
  const { cache, storage } = storageFor();
  const tokenizer = artifact.replace("model_q4f16.onnx", "tokenizer.json");
  const requests = [];
  const network = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    requests.push({ url: request.url, range: request.headers.get("range") });
    if (request.headers.has("range")) {
      return new Response("x", { status: 206, headers: { "content-length": "1", "content-range": "bytes 0-0/11" } });
    }
    return modelResponse(request.url.includes("tokenizer") ? "tokenizer-bytes" : "model-bytes");
  };
  const fetcher = createModelCacheFetch(identity, network, { storage });

  assert.equal(await (await fetcher(new Request(artifact, { headers: { range: "bytes=0-0" } }))).text(), "x");
  assert.equal((await cache.match(manifestKey)), undefined, "a Request Range probe creates no manifest or incomplete issue");
  assert.equal(cache.entries.size, 0, "a partial response is never stored as a full artifact");
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);

  await (await fetcher(artifact)).arrayBuffer();
  await (await fetcher(tokenizer)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  const manifest = JSON.parse(await (await cache.match(`https://local-cache.invalid/meta/${encodeURIComponent(`${identity.modelId}@${identity.revision}`)}.json`)).text());
  assert.deepEqual(manifest.assets.map((entry) => entry.url).sort(), [artifact, tokenizer].sort());
  assert.ok(manifest.assets.every((entry) => entry.stored));
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
  assert.equal(requests[0].range, "bytes=0-0");
});

test("Range supplied through init.headers is forwarded but bypasses model storage", async () => {
  const { cache, storage } = storageFor();
  let forwarded;
  const fetcher = createModelCacheFetch(identity, async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    forwarded = { url: request.url, range: request.headers.get("range") };
    return new Response("x", {
      status: 206,
      headers: { "content-length": "1", "content-range": "bytes 0-0/11" },
    });
  }, { storage });

  const response = await fetcher(artifact, { headers: { range: "bytes=0-0" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-0/11");
  assert.equal(await response.text(), "x");
  assert.equal(forwarded.range, "bytes=0-0");
  assert.match(forwarded.url, new RegExp(`/resolve/${identity.revision}/`));
  assert.equal(await cache.match(manifestKey), undefined);
  assert.equal(cache.entries.size, 0, "init.headers Range responses never enter Cache Storage");
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
});

test("cache:no-store full GET is forwarded without creating a local artifact", async () => {
  const { cache, storage } = storageFor();
  let requests = 0;
  const fetcher = createModelCacheFetch(identity, async () => {
    requests += 1;
    return modelResponse();
  }, { storage });

  assert.equal(await (await fetcher(new Request(artifact, { cache: "no-store" }))).text(), "model-bytes");
  assert.equal(requests, 1);
  assert.equal(await cache.match(manifestKey), undefined);
});

test("cold model response streams to inference while Cache.put writes concurrently", async () => {
  const { storage } = storageFor();
  let releaseBody;
  let bodyReleased = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    pull(controller) {
      return new Promise((resolve) => {
        releaseBody = () => {
          if (bodyReleased) return;
          bodyReleased = true;
          controller.enqueue(new Uint8Array([2]));
          controller.close();
          resolve();
        };
      });
    },
  });
  const fetcher = createModelCacheFetch(identity, async () => new Response(body, {
    headers: { "content-length": "2" },
  }), { storage });

  const pendingResponse = fetcher(artifact);
  let timer;
  const response = await Promise.race([
    pendingResponse,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 100); }),
  ]);
  clearTimeout(timer);
  try {
    assert.ok(response, "model inference receives its response without waiting for Cache.put");
    releaseBody?.();
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);
    assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  } finally {
    releaseBody?.();
  }
});

test("download progress reports bytes read from the real response body and keeps an unknown total indeterminate", async () => {
  const { storage } = storageFor();
  const updates = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1_048_576));
      controller.enqueue(new Uint8Array(512));
      controller.close();
    },
  });
  const fetcher = createModelCacheFetch(identity, async () => new Response(body), {
    storage,
    onDownloadProgress: (progress) => updates.push(progress),
  });
  await (await fetcher(artifact)).arrayBuffer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(updates.some((update) => update.loaded === 1_049_088 && update.total === null));
  assert.ok(updates.every((update) => update.total === null || update.total >= update.loaded));
});

test("an aborted stale request reaches fetch and is not cached", async () => {
  const { cache, storage } = storageFor();
  const controller = new AbortController();
  const network = (input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal ?? input.signal;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const fetcher = createModelCacheFetch(identity, network, { storage, signal: controller.signal });
  const pending = fetcher(artifact);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
});

test("an abort after response headers cancels the model body and leaves no ready cache", async () => {
  const { storage } = storageFor();
  const controller = new AbortController();
  const network = async (input, init) => {
    const signal = init?.signal ?? input.signal;
    let bodyController;
    const body = new ReadableStream({
      start(streamController) {
        bodyController = streamController;
        streamController.enqueue(new Uint8Array([1]));
      },
      pull() { return new Promise(() => {}); },
    });
    signal.addEventListener("abort", () => bodyController.error(new DOMException("aborted", "AbortError")), { once: true });
    return new Response(body, { headers: { "content-length": "11" } });
  };
  const fetcher = createModelCacheFetch(identity, network, { storage, signal: controller.signal });
  const response = await fetcher(artifact);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value[0], 1);
  const staleRead = assert.rejects(reader.read(), { name: "AbortError" });
  controller.abort();
  await staleRead;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0, "cancel removes partial cache artifacts and metadata");
});

test("parent-side cold cancel cleanup removes the incomplete pinned revision before retry", async () => {
  const { cache, storage } = storageFor();
  cache.failAssetPuts = true;
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 1);

  cache.failAssetPuts = false;
  assert.equal(await cleanupIncompleteLocalModelCache(identity, { storage }), 0, "the stale entry is manifest-only when the asset write failed");
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
});

test("an incomplete full artifact and a missing manifest cannot be marked ready", async () => {
  const { cache, storage } = storageFor();
  const fetcher = createModelCacheFetch(identity, async () => new Response("x", {
    headers: { "content-length": "11" },
  }), { storage });
  assert.equal(await (await fetcher(artifact)).text(), "x");
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  const incomplete = JSON.parse(await (await cache.match(manifestKey)).text());
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.issue, "corrupt");
  assert.equal(incomplete.assets.length, 1);
  assert.equal(incomplete.assets[0].stored, false);

  await cleanupIncompleteLocalModelCache(identity, { storage });
  assert.equal(await cache.match(manifestKey), undefined);
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  assert.equal(await cache.match(manifestKey), undefined, "marking after cleanup must not recreate a manifest");
});

test("parent-side cancel cleanup preserves a previously ready pinned revision", async () => {
  const { cache, storage } = storageFor();
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

  assert.equal(await cleanupIncompleteLocalModelCache(identity, { storage }), 0);
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), true);
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
});

test("retry after parent-side cancel cleanup has no stale records and finishes ready", async () => {
  const { cache, storage } = storageFor();
  cache.failAssetPuts = true;
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await cleanupIncompleteLocalModelCache(identity, { storage }), 0, "the stale entry is manifest-only when the asset write failed");

  cache.failAssetPuts = false;
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  const manifest = JSON.parse(await (await cache.match(`https://local-cache.invalid/meta/${encodeURIComponent(`${identity.modelId}@${identity.revision}`)}.json`)).text());
  assert.equal(manifest.ready, true);
  assert.equal("issue" in manifest, false);
  assert.ok(manifest.assets.length > 0 && manifest.assets.every((asset) => asset.stored));
});

test("an aborted warm-cache verification stops scanning a stale response", async () => {
  const { cache, storage } = storageFor();
  await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact);
  const cacheReady = await markLocalModelCacheReady(identity, { storage });
  assert.equal(cacheReady, true);
  const stalledBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    pull() { return new Promise(() => {}); },
  });
  cache.entries.set(cacheKey(identity, artifact), new Response(stalledBody, {
    headers: { "content-length": "11" },
  }));

  const controller = new AbortController();
  const fetcher = createModelCacheFetch(identity, async () => {
    throw new Error("a warm cache entry should not start a network request");
  }, { storage, signal: controller.signal });
  const pending = fetcher(artifact);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
});

test("a truncated cache entry is rejected, fetched again, and can become ready", async () => {
  const { cache, storage } = storageFor();
  let requestCount = 0;
  const network = async () => { requestCount += 1; return modelResponse(); };
  const firstLoad = createModelCacheFetch(identity, network, { storage });
  await firstLoad(artifact);
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  // Preserve the old Content-Length header to model a truncated entry whose
  // metadata still looks plausible; checking headers alone must not accept it.
  cache.entries.set(cacheKey(identity, artifact), new Response("bad", { headers: { "content-length": "11" } }));

  const retry = createModelCacheFetch(identity, network, { storage });
  assert.equal(await (await retry(artifact)).text(), "model-bytes");
  assert.equal(requestCount, 2);
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
});

test("quota failures preserve the live model response and never mark the cache complete", async () => {
  const { cache, storage } = storageFor();
  cache.failAssetPuts = true;
  const fetcher = createModelCacheFetch(identity, async () => modelResponse(), { storage });
  assert.equal(await (await fetcher(artifact)).text(), "model-bytes");
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  const state = await probeLocalModelCache(identity, { storage });
  assert.equal(state.complete, false);
  assert.equal(state.issue, "quota");
});

test("model deletion removes only the selected revision's cache entries", async () => {
  const { cache, storage } = storageFor();
  const otherIdentity = { modelId: identity.modelId, revision: "another-revision" };
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  await markLocalModelCacheReady(identity, { storage });
  const otherUrl = artifact.replace("resolve/main", "resolve/another-revision");
  await (await createModelCacheFetch(otherIdentity, async () => modelResponse(), { storage })(otherUrl)).arrayBuffer();
  await markLocalModelCacheReady(otherIdentity, { storage });
  const removed = await deleteLocalModelCache(identity, { storage });
  assert.equal(removed, 1);
  assert.equal(cache.entries.has(cacheKey(otherIdentity, otherUrl)), true);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
});

test("storage persistence reports the browser's actual decision", async () => {
  assert.equal(await requestLocalModelPersistence({ persist: async () => true }), true);
  assert.equal(await requestLocalModelPersistence({ persist: async () => false }), false);
});

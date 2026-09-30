import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheKey,
  createModelCacheFetch,
  deleteLocalModelCache,
  LOCAL_MODEL_CACHE_CAP,
  markLocalModelCacheReady,
  probeLocalModelCache,
  requestLocalModelPersistence,
} from "../app/local-model-cache.ts";

const identity = { modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "da1453100cf3ff33ef56d17983fc7a8648706db6" };
const artifact = `https://huggingface.co/${identity.modelId}/resolve/main/onnx/model_q4f16.onnx`;

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

const roomyStorage = { estimate: async () => ({ usage: 11, quota: 1024 * 1024 }) };

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

test("a newly-ready model keeps the cache at one model revision and removes the replaced artifacts", async () => {
  const { cache, storage } = storageFor();
  const replacement = { ...identity, revision: "replacement-revision" };
  const replacementArtifact = artifact.replace("/resolve/main/", "/resolve/main/tokenizer.json");
  const network = async () => modelResponse();

  await createModelCacheFetch(identity, network, { storage })(artifact);
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  await createModelCacheFetch(replacement, network, { storage, storageManager: roomyStorage })(replacementArtifact);
  assert.equal(await markLocalModelCacheReady(replacement, { storage }), true);

  assert.equal(LOCAL_MODEL_CACHE_CAP, 1);
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
  assert.equal((await probeLocalModelCache(replacement, { storage })).complete, true);

  const warmReplacement = createModelCacheFetch(replacement, async () => {
    throw new Error("the retained model must not refetch its artifact");
  }, { storage });
  assert.equal(await (await warmReplacement(replacementArtifact)).text(), "model-bytes");
});

test("selected-revision deletion leaves another revision's entries untouched", async () => {
  const { cache, storage } = storageFor();
  const otherIdentity = { ...identity, revision: "selected-delete-isolation" };
  const otherArtifact = artifact.replace("model_q4f16.onnx", "tokenizer.json");
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);
  cache.entries.set(cacheKey(otherIdentity, otherArtifact), modelResponse("other-model"));

  assert.equal(await deleteLocalModelCache(identity, { storage }), 1);
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
  assert.equal(cache.entries.has(cacheKey(otherIdentity, otherArtifact)), true);
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
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
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

test("orphan artifacts without a manifest are swept before a new model is cached", async () => {
  const { cache, storage } = storageFor();
  const orphanIdentity = { ...identity, revision: "orphan-without-manifest" };
  const replacement = { ...identity, revision: "replacement-after-orphan" };
  const replacementArtifact = artifact.replace("model_q4f16.onnx", "tokenizer.json");
  cache.entries.set(cacheKey(orphanIdentity, artifact), modelResponse("orphan-model"));

  assert.equal(await (await createModelCacheFetch(replacement, async () => modelResponse("replacement-model"), {
    storage,
    storageManager: roomyStorage,
  })(replacementArtifact)).text(), "replacement-model");
  assert.equal(await markLocalModelCacheReady(replacement, { storage }), true);
  assert.equal(cache.entries.has(cacheKey(orphanIdentity, artifact)), false);
  assert.equal((await probeLocalModelCache(replacement, { storage })).complete, true);
});

test("cross-identity quota preflight failure preserves the complete old model", async () => {
  const { cache, storage } = storageFor();
  const replacement = { ...identity, revision: "quota-replacement" };
  const replacementArtifact = artifact.replace("model_q4f16.onnx", "tokenizer.json");
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

  const fetcher = createModelCacheFetch(replacement, async () => modelResponse(), {
    storage,
    storageManager: { estimate: async () => ({ usage: 11, quota: 10 }) },
  });
  assert.equal(await (await fetcher(replacementArtifact)).text(), "model-bytes");
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
  assert.equal(await (await createModelCacheFetch(identity, async () => {
    throw new Error("preserved model must be readable without network");
  }, { storage })(artifact)).text(), "model-bytes");
  assert.equal((await probeLocalModelCache(replacement, { storage })).complete, false);
  assert.equal((await probeLocalModelCache(replacement, { storage })).issue, "quota");
  const identities = new Set([...cache.entries.keys()].filter((key) => key.includes("/asset/")).map((key) => key.split("/asset/")[1].split("/")[0]));
  assert.ok(identities.size <= 1);
});

test("an unknown replacement size preserves the complete old model", async () => {
  const { cache, storage } = storageFor();
  const replacement = { ...identity, revision: "unknown-size-replacement" };
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

  const replacementResponse = await createModelCacheFetch(replacement, async () => new Response("new-model"), {
    storage,
    storageManager: roomyStorage,
  })(artifact);
  assert.equal(await replacementResponse.text(), "new-model");
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
  assert.equal([...cache.entries.keys()].some((key) => key.includes(encodeURIComponent("unknown-size-replacement"))), false);
});

test("a non-200 replacement preserves the complete old model", async () => {
  const { cache, storage } = storageFor();
  const replacement = { ...identity, revision: "failed-replacement" };
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  assert.equal(await markLocalModelCacheReady(identity, { storage }), true);

  const replacementResponse = await createModelCacheFetch(replacement, async () => new Response("unavailable", { status: 503 }), {
    storage,
    storageManager: roomyStorage,
  })(artifact);
  assert.equal(replacementResponse.status, 503);
  assert.equal((await probeLocalModelCache(identity, { storage })).complete, true);
  assert.equal([...cache.entries.keys()].some((key) => key.includes(encodeURIComponent("failed-replacement"))), false);
});

test("two identities downloading concurrently leave one complete model and no orphan artifacts", async () => {
  const { cache, storage } = storageFor();
  const otherIdentity = { ...identity, revision: "concurrent-revision" };
  const otherArtifact = artifact.replace("model_q4f16.onnx", "tokenizer.json");
  const firstFetch = createModelCacheFetch(identity, async () => modelResponse("first"), { storage });
  const secondFetch = createModelCacheFetch(otherIdentity, async () => modelResponse("second"), {
    storage,
    storageManager: roomyStorage,
  });

  const firstResponse = await firstFetch(artifact);
  const pendingSecond = secondFetch(otherArtifact);
  assert.equal(await firstResponse.text(), "first");
  const secondResponse = await pendingSecond;
  assert.equal(await secondResponse.text(), "second");
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  assert.equal(await markLocalModelCacheReady(otherIdentity, { storage }), true);

  const localEntries = [...cache.entries.keys()].filter((key) => key.includes("local-cache.invalid"));
  const artifactIdentities = new Set(localEntries.filter((key) => key.includes("/asset/")).map((key) => key.split("/asset/")[1].split("/")[0]));
  assert.equal(artifactIdentities.size, 1);
  assert.ok(localEntries.every((key) => !key.includes(encodeURIComponent(identity.revision))));
});

test("a new model revision evicts the prior identity so only one local model remains", async () => {
  const { cache, storage } = storageFor();
  const otherIdentity = { modelId: identity.modelId, revision: "another-revision" };
  await (await createModelCacheFetch(identity, async () => modelResponse(), { storage })(artifact)).arrayBuffer();
  await markLocalModelCacheReady(identity, { storage });
  const otherUrl = artifact.replace("resolve/main", "resolve/another-revision");
  await (await createModelCacheFetch(otherIdentity, async () => modelResponse(), { storage, storageManager: roomyStorage })(otherUrl)).arrayBuffer();
  await markLocalModelCacheReady(otherIdentity, { storage });
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
  assert.equal(cache.entries.has(cacheKey(otherIdentity, otherUrl)), true);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
  assert.equal((await probeLocalModelCache(otherIdentity, { storage })).complete, true);
  const removed = await deleteLocalModelCache(otherIdentity, { storage });
  assert.equal(removed, 1);
  assert.equal([...cache.entries.keys()].filter((key) => key.includes("local-cache.invalid")).length, 0);
});

test("cache progress and model limit use streamed artifact bytes, not origin storage quota", async () => {
  const { storage } = storageFor();
  const progress = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4, 5]));
      controller.close();
    },
  });
  const fetcher = createModelCacheFetch(identity, async () => new Response(body, {
    headers: { "content-length": "5" },
  }), { storage, onDownloadProgress: (value) => progress.push(value) });
  await (await fetcher(artifact)).arrayBuffer();
  await markLocalModelCacheReady(identity, { storage });
  assert.deepEqual(progress.at(-1), { loaded: 5, total: 5 });
  const state = await probeLocalModelCache(identity, { storage });
  assert.equal(state.cachedBytes, 5);
  assert.equal(state.safeLimit, 700 * 1024 * 1024);
});

test("an interrupted incomplete download removes its artifact and manifest", async () => {
  const { cache, storage } = storageFor();
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([1])); },
    pull() { return new Promise(() => {}); },
  });
  const fetcher = createModelCacheFetch(identity, async () => new Response(body, {
    headers: { "content-length": "2" },
  }), { storage, signal: controller.signal });
  const response = await fetcher(artifact);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
  // Wait for the adapter's background Cache.put branch to settle its cleanup.
  assert.equal(await markLocalModelCacheReady(identity, { storage }), false);
  assert.equal(cache.entries.has(cacheKey(identity, artifact)), false);
  assert.equal((await probeLocalModelCache(identity, { storage })).artifactCount, 0);
});

test("storage persistence reports the browser's actual decision", async () => {
  assert.equal(await requestLocalModelPersistence({ persist: async () => true }), true);
  assert.equal(await requestLocalModelPersistence({ persist: async () => false }), false);
});

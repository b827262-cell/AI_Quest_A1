import assert from "node:assert/strict";
import test from "node:test";
import { QWEN3_TEST_MODEL_ID } from "../app/chrome-built-in-ai.ts";
import {
  LOCAL_MODEL_ID,
  LOCAL_MODEL_IDENTITY,
  createLocalModelFetchAdapter,
  decideStartupAction,
  runLocalModelBootstrap,
} from "../app/local-model-bootstrap.ts";
import {
  LOCAL_MODEL_CACHE_SCHEMA_VERSION,
  cacheKey,
  probeLocalModelCache,
  readManifest,
} from "../app/local-model-cache.ts";

const IDENTITY = { modelId: "onnx-community/Qwen3-0.6B-ONNX", revision: "revA" };
const URL_A = "https://hf.example/model_q4f16.onnx";
const URL_B = "https://hf.example/tokenizer.json";

function manifestKeyOf(identity) {
  return `https://local-cache.invalid/meta/${encodeURIComponent(`${identity.modelId}@${identity.revision}`)}.json`;
}
function bytesFor(url, size) {
  return new Uint8Array(size).fill(url === URL_A ? 7 : 13);
}
function makeCache() {
  const store = new Map();
  const cache = {
    store,
    async match(request) {
      const entry = store.get(request);
      if (!entry) return undefined;
      return new Response(entry.bytes.slice(), { status: entry.status, headers: entry.headers });
    },
    async put(request, response) {
      const buffer = await response.arrayBuffer();
      store.set(request, { bytes: new Uint8Array(buffer), status: response.status, headers: Object.fromEntries(response.headers.entries()) });
    },
    async delete(request) { return store.delete(request); },
  };
  return cache;
}
async function seedAsset(cache, identity, url, size) {
  await cache.put(cacheKey(identity, url), new Response(bytesFor(url, size)));
}
async function seedManifest(cache, identity, assets, revision = identity.revision, schema = LOCAL_MODEL_CACHE_SCHEMA_VERSION) {
  await cache.put(manifestKeyOf(identity), new Response(JSON.stringify({
    schemaVersion: schema, modelId: identity.modelId, revision, updatedAt: new Date().toISOString(), assets,
  }), { headers: { "content-type": "application/json" } }));
}
function makeFetch(handler) {
  const calls = [];
  const fn = async (input) => { const url = typeof input === "string" ? input : input.url; calls.push(url); return handler(url); };
  fn.calls = calls;
  return fn;
}

test("bootstrap identity is the Auto core's model id, not a copy", () => {
  assert.equal(LOCAL_MODEL_ID, QWEN3_TEST_MODEL_ID);
  assert.equal(LOCAL_MODEL_IDENTITY.modelId, "onnx-community/Qwen3-0.6B-ONNX");
});

test("decideStartupAction never blocks the UI for any cache state", () => {
  const states = [
    { supported: false, complete: false, stale: false, artifactCount: 0, presentCount: 0, missingCount: 0, corruptCount: 0, totalBytes: 0, revisionMatches: false },
    { supported: true, complete: true, stale: false, artifactCount: 2, presentCount: 2, missingCount: 0, corruptCount: 0, totalBytes: 500, revisionMatches: true },
    { supported: true, complete: false, stale: false, artifactCount: 2, presentCount: 1, missingCount: 1, corruptCount: 0, totalBytes: 300, revisionMatches: true },
    { supported: true, complete: false, stale: false, artifactCount: 0, presentCount: 0, missingCount: 0, corruptCount: 0, totalBytes: 0, revisionMatches: false },
  ];
  for (const state of states) {
    const decision = decideStartupAction(state);
    assert.equal(decision.blocksUi, false);
    assert.ok(["warm", "repair", "pristine", "unsupported"].includes(decision.action));
  }
});

test("pristine cache waits for a user gesture instead of auto-downloading", () => {
  const decision = decideStartupAction({
    supported: true, complete: false, stale: false, artifactCount: 0, presentCount: 0, missingCount: 0, corruptCount: 0, totalBytes: 0, revisionMatches: false,
  });
  assert.equal(decision.action, "pristine");
  assert.equal(decision.needsUserGesture, true);
});

test("runLocalModelBootstrap probes warm cache with ZERO network and schedules no repair", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  await seedManifest(cache, IDENTITY, [{ url: URL_A, expectedBytes: 300 }]);
  const network = makeFetch(() => { throw new Error("probe must not hit the network"); });
  const seen = [];
  const handle = await runLocalModelBootstrap({ identity: IDENTITY, env: { cache, fetch: network }, onStatus: (d) => seen.push(d.action) });
  assert.equal(handle.decision.action, "warm");
  assert.equal(handle.decision.needsUserGesture, false);
  assert.deepEqual(seen, ["warm"]);
  assert.equal(await handle.ensure, null);
  assert.equal(network.calls.length, 0);
});

test("runLocalModelBootstrap repairs a same-revision gap by fetching only the missing artifact", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300); // warm
  await seedManifest(cache, IDENTITY, [
    { url: URL_A, expectedBytes: 300 },
    { url: URL_B, expectedBytes: 200 }, // declared but never downloaded
  ]);
  const network = makeFetch((url) => new Response(bytesFor(url, 200)));
  const handle = await runLocalModelBootstrap({ identity: IDENTITY, env: { cache, fetch: network } });
  assert.equal(handle.decision.action, "repair");
  assert.equal(handle.decision.missingCount, 1);
  const result = await handle.ensure;
  assert.equal(result.status, "downloaded");
  assert.equal(result.downloadedCount, 1);
  assert.deepEqual(network.calls, [URL_B], "the warm artifact must not be re-fetched");
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true);
});

test("version drift re-stamps the manifest with ZERO re-download when bytes are present", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300); // bytes present, but manifest is OLD-REV + wrong size
  await seedManifest(cache, IDENTITY, [{ url: URL_A, expectedBytes: 999 }], "OLD-REV");
  const network = makeFetch(() => { throw new Error("drift repair must not re-download present bytes"); });
  const handle = await runLocalModelBootstrap({ identity: IDENTITY, env: { cache, fetch: network } });
  assert.equal(handle.decision.action, "repair");
  assert.equal(handle.decision.stale, true);
  const result = await handle.ensure;
  // The drift zeroes the untrustworthy expectedBytes, so the present artifact
  // verifies warm and is kept: no network GET is issued for the re-stamp.
  assert.equal(result.status, "warm");
  assert.equal(network.calls.length, 0);
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true, "manifest re-stamped to the current revision");
  assert.equal(state.revisionMatches, true);
});

test("version drift with a missing artifact downloads only the gap after re-stamping", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300); // only A present
  await seedManifest(cache, IDENTITY, [
    { url: URL_A, expectedBytes: 999 }, // stale size, drift
    { url: URL_B, expectedBytes: 200 }, // never downloaded
  ], "OLD-REV");
  const network = makeFetch((url) => new Response(bytesFor(url, 200)));
  const handle = await runLocalModelBootstrap({ identity: IDENTITY, env: { cache, fetch: network } });
  assert.equal(handle.decision.action, "repair");
  const result = await handle.ensure;
  assert.equal(result.status, "downloaded");
  assert.equal(result.downloadedCount, 1);
  assert.deepEqual(network.calls, [URL_B], "present bytes are kept; only the gap is fetched");
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true);
  assert.equal(state.revisionMatches, true);
});

test("createLocalModelFetchAdapter serves a warm artifact with zero GET", async () => {
  const cache = makeCache();
  await seedAsset(cache, IDENTITY, URL_A, 300);
  const network = makeFetch(() => { throw new Error("warm artifact must not hit the network"); });
  const adapter = createLocalModelFetchAdapter({ identity: IDENTITY, env: { cache }, networkFetch: network });
  const response = await adapter.fetch(URL_A);
  const buffer = await response.arrayBuffer();
  assert.equal(buffer.byteLength, 300);
  assert.equal(network.calls.length, 0);
  // A pure warm hit collects nothing, so persistManifest is a no-op.
  assert.equal(adapter.assets().length, 0);
  assert.equal(await adapter.persistManifest(), null);
});

test("createLocalModelFetchAdapter records cold artifacts and persistManifest warms the manifest with zero re-GET", async () => {
  const cache = makeCache();
  const network = makeFetch((url) => new Response(bytesFor(url, url === URL_A ? 300 : 200)));
  const adapter = createLocalModelFetchAdapter({ identity: IDENTITY, env: { cache }, networkFetch: network });
  await adapter.fetch(URL_A);
  await adapter.fetch(URL_B);
  assert.deepEqual(adapter.assets().map((a) => a.expectedBytes).sort(), [200, 300]);
  assert.equal(network.calls.length, 2, "each cold artifact fetched exactly once");

  const result = await adapter.persistManifest();
  assert.ok(result);
  assert.equal(result.status, "warm", "already-stored bytes are verified, never re-downloaded");
  assert.equal(network.calls.length, 2, "persistManifest must not trigger any new network GET");

  const manifest = await readManifest(IDENTITY, { cache });
  assert.equal(manifest.assets.length, 2);
  const state = await probeLocalModelCache(IDENTITY, { cache });
  assert.equal(state.complete, true, "the next page open starts warm");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GET as healthRoute } from "../app/api/health/route.ts";
import { probe, refreshed } from "../scripts/capture-environment-source-of-truth.mjs";

const CONTENT = Buffer.from("%PDF-1.4\nsynthetic test content\n");
const SHA = createHash("sha256").update(CONTENT).digest("hex");

function manifest() {
  return {
    environment: "production",
    sites: {
      shared_backend: { project_id: "backend-id", url: "https://ai-quest-a1-backend.example.test" },
      student: { project_id: "student-id", url: "https://student.example.test" },
      admin: { project_id: "admin-id", url: "https://admin.example.test" },
    },
    worker: {
      project_id: "backend-id", health_endpoint: "https://ai-quest-a1-backend.example.test/api/health",
      version: "unavailable", deployed_git_sha: "a".repeat(40),
      bindings: { DB: { readable: false }, BOOKS_BUCKET: { list_readable: false, get_readable: false } },
    },
  };
}

function mockHttp(changeHealth = (body) => body) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push({ method: "GET", url });
    const target = new URL(url);
    if (target.pathname === "/api/health") {
      const hadEnv = Object.hasOwn(globalThis, "__env__");
      const previous = globalThis.__env__;
      try {
        globalThis.__env__ = target.hostname.includes("ai-quest-a1-backend") ? { DB: {}, BOOKS_BUCKET: {} } : {};
        const response = await healthRoute(new Request(url));
        return { status: response.status, body: changeHealth(await response.json(), target) };
      } finally {
        if (hadEnv) globalThis.__env__ = previous;
        else delete globalThis.__env__;
      }
    }
    assert.equal(target.pathname, "/api/student/books");
    return { status: 200, body: { books: [{ id: "book-1", sha256: SHA }] } };
  };
  const getContent = async (url) => {
    calls.push({ method: "GET", url });
    return new Response(CONTENT, { headers: { "x-sha256": SHA } });
  };
  return { calls, fetchJson, getContent };
}

test("capture accepts the actual health route contract with standalone frontends unbound", async () => {
  const mock = mockHttp();
  const result = await probe(manifest(), mock.fetchJson, mock.getContent);
  assert.deepEqual(result.failures, []);
  assert.equal(result.observed.health.shared_backend.role, "backend");
  assert.equal(result.observed.health.student.role, "standalone");
  assert.equal(result.observed.health.student.d1, "unbound");
  assert.equal(result.observed.health.admin.backendTarget, "disabled-or-staging-only");
  assert.equal(mock.calls.length, 5);
});

test("capture rejects mismatched worker declarations before making any HTTP request", async () => {
  for (const mutate of [
    (m) => { m.worker.project_id = "wrong-project"; },
    (m) => { m.worker.health_endpoint = "https://other.example.test/api/health"; },
    (m) => { m.worker.health_endpoint += "?other=target"; },
    (m) => { m.environment = "staging"; },
    (m) => { m.sites.student.url = "http://student.example.test"; },
    (m) => { delete m.sites.admin; },
  ]) {
    const m = manifest();
    mutate(m);
    const mock = mockHttp();
    assert.ok((await probe(m, mock.fetchJson, mock.getContent)).failures.length > 0);
    assert.equal(mock.calls.length, 0);
  }
});

test("capture fails closed for stale health roles, wrong edge, target, binding or server time", async () => {
  for (const change of [
    (body) => ({ ...body, role: "shared-backend" }),
    (body) => ({ ...body, edge: "other" }),
    (body) => ({ ...body, backendTarget: manifest().sites.shared_backend.url }),
    (body) => ({ ...body, d1: "unbound" }),
    (body) => ({ ...body, status: "error" }),
    (body) => ({ ...body, time: "not-a-time" }),
  ]) {
    const mock = mockHttp(change);
    assert.ok((await probe(manifest(), mock.fetchJson, mock.getContent)).failures.length > 0);
  }
});

test("refresh labels unobservable deployment and resource identities as carried forward", async () => {
  const m = manifest();
  const mock = mockHttp();
  const { observed, failures } = await probe(m, mock.fetchJson, mock.getContent);
  assert.deepEqual(failures, []);
  const next = refreshed(m, observed);
  assert.equal(next.worker.deployed_git_sha, m.worker.deployed_git_sha);
  assert.equal(next.worker.version, m.worker.version);
  assert.match(next.capture_evidence.carried_forward["worker.bindings.*.resource_id"], /not observable/);
  assert.equal(m.worker.bindings.DB.readable, false);
});

test("R2 capture rejects corrupted bytes even when the metadata header claims a match", async () => {
  const mock = mockHttp();
  const result = await probe(manifest(), mock.fetchJson,
    async () => new Response("corrupted", { headers: { "x-sha256": SHA } }));
  assert.equal(result.observed.r2_object.sha256_match, false);
  assert.ok(result.failures.some((failure) => failure.includes("content SHA-256 mismatch")));
});

test("R2 capture verifies bytes independently of headers and explicitly requests GET without redirects", async () => {
  const mock = mockHttp();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/student/books/book-1/content");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    return new Response(CONTENT, { headers: { "x-sha256": "incorrect-metadata" } });
  };
  try {
    const { observed, failures } = await probe(manifest(), mock.fetchJson);
    assert.deepEqual(failures, []);
    assert.equal(observed.r2_object.sha256, SHA);
    assert.equal(observed.r2_object.bytes, CONTENT.byteLength);
    assert.equal(observed.r2_object.method, "GET");
  } finally {
    globalThis.fetch = original;
  }
});

test("R2 capture rejects non-200 content and propagates incomplete body reads", async () => {
  const mock = mockHttp();
  const result = await probe(manifest(), mock.fetchJson, async () => new Response("missing", { status: 404 }));
  assert.equal(result.observed.r2_object.sha256, null);
  assert.ok(result.failures.length > 0);
  const brokenBody = new ReadableStream({ start(controller) { controller.error(new Error("truncated response")); } });
  await assert.rejects(probe(manifest(), mock.fetchJson, async () => new Response(brokenBody)), /truncated response/);
});

test("refresh never infers R2 list readability from a D1 catalogue", async () => {
  for (const previous of [false, true, undefined]) {
    const m = manifest();
    if (previous === undefined) delete m.worker.bindings.BOOKS_BUCKET.list_readable;
    else m.worker.bindings.BOOKS_BUCKET.list_readable = previous;
    const mock = mockHttp();
    const { observed, failures } = await probe(m, mock.fetchJson, mock.getContent);
    assert.deepEqual(failures, []);
    const next = refreshed(m, observed);
    assert.equal(next.worker.bindings.BOOKS_BUCKET.list_readable, previous);
    assert.equal(Object.hasOwn(next.worker.bindings.BOOKS_BUCKET, "list_readable"), previous !== undefined);
    assert.equal(next.worker.bindings.BOOKS_BUCKET.get_readable, true);
    assert.equal(next.capture_evidence.r2_list.status, "not_probed");
    assert.match(next.capture_evidence.carried_forward["worker.bindings.BOOKS_BUCKET.list_readable"], /not re-attested/);
  }
});

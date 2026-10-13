import assert from "node:assert/strict";
import test from "node:test";
import { GET as healthRoute } from "../app/api/health/route.ts";
import { probe, refreshed } from "../scripts/capture-environment-source-of-truth.mjs";

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
    return { status: 200, body: { books: [{ id: "book-1", sha256: "a".repeat(64) }] } };
  };
  const head = async (url) => {
    calls.push({ method: "HEAD", url });
    return new Response(null, { headers: { "x-sha256": "a".repeat(64) } });
  };
  return { calls, fetchJson, head };
}

test("capture accepts the actual health route contract with standalone frontends unbound", async () => {
  const mock = mockHttp();
  const result = await probe(manifest(), mock.fetchJson, mock.head);
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
    assert.ok((await probe(m, mock.fetchJson, mock.head)).failures.length > 0);
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
    assert.ok((await probe(manifest(), mock.fetchJson, mock.head)).failures.length > 0);
  }
});

test("refresh labels unobservable deployment and resource identities as carried forward", async () => {
  const m = manifest();
  const mock = mockHttp();
  const { observed, failures } = await probe(m, mock.fetchJson, mock.head);
  assert.deepEqual(failures, []);
  const next = refreshed(m, observed);
  assert.equal(next.worker.deployed_git_sha, m.worker.deployed_git_sha);
  assert.equal(next.worker.version, m.worker.version);
  assert.match(next.capture_evidence.carried_forward["worker.bindings.*.resource_id"], /not observable/);
  assert.equal(m.worker.bindings.DB.readable, false);
});

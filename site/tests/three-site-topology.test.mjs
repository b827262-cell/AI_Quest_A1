import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Three sites in one process. Every request carries the runtime declaration its
// site would receive from Sites (SITE_ROLE, SITE_NAME, PRIMARY_ORIGIN, GIT_SHA).
// A secondary's outbound fetch to the primary origin is routed into the primary
// worker. This exercises the real worker entry, the API gate, the proxy and the
// health route together, without any network access.
const PRIMARY_ORIGIN = "https://ai-quest-a1-backend.example.test";
const GIT_SHA = "5f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a";
const HOSTS = {
  primary: "ai-quest-a1-backend.example.test",
  student: "ai-quest-a1-student.example.test",
  admin: "ai-quest-a1-admin.example.test",
};
const DECLARATIONS = {
  primary: { SITE_ROLE: "primary", SITE_NAME: "backend" },
  student: { SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN },
  admin: { SITE_ROLE: "secondary", SITE_NAME: "admin", PRIMARY_ORIGIN },
};
const ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };
const ctx = { waitUntil() {}, passThroughOnException() {} };

const { default: worker } = await import(new URL("../dist/server/index.js?three-site-topology=1", import.meta.url).href);

/** The env a site receives per request. Only the primary carries the D1/R2 bindings. */
function siteEnv(site, overrides = {}) {
  const bindings = site === "primary" ? { DB: {}, BOOKS_BUCKET: {} } : {};
  return { ASSETS, GIT_SHA, ...bindings, ...DECLARATIONS[site], ...overrides };
}

function siteRequest(site, pathname, { env = {}, headers = {}, method = "GET" } = {}) {
  return worker.fetch(
    new Request(`https://${HOSTS[site]}${pathname}`, {
      method,
      headers: { accept: "application/json", ...headers },
    }),
    siteEnv(site, env),
    ctx,
  );
}

let frameworkFetchWarmed = false;

/**
 * The framework replaces globalThis.fetch with its own wrapper on the first request it
 * handles. Warm it up first, so the outbound stub installed below is what the proxy calls.
 */
async function warmFrameworkFetch() {
  if (frameworkFetchWarmed) return;
  frameworkFetchWarmed = true;
  await siteRequest("primary", "/api/health");
}

/** Runs fn with outbound fetch routed into the primary worker. Resolves with what arrived there. */
async function withPrimaryRouting(fn) {
  await warmFrameworkFetch();
  const arrived = [];
  const originalFetch = globalThis.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== PRIMARY_ORIGIN) throw new Error(`unexpected outbound request to ${url.origin}`);
    const headers = new Headers(init.headers);
    arrived.push({ url, headers });
    return siteRequest("primary", `${url.pathname}${url.search}`, {
      headers: Object.fromEntries(headers),
      method: init.method,
    });
  };
  // Delegation is production-only by design, so the secondaries must run as production.
  process.env.NODE_ENV = "production";
  try {
    return await fn(arrived);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

test("a student secondary proxies its own /api/student prefix and labels the answer as primary data", async () => {
  await withPrimaryRouting(async (arrived) => {
    const res = await siteRequest("student", "/api/student/me", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-data-plane"), "primary");
    assert.equal((await res.json()).guest, true);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].url.pathname, "/api/student/me");
    assert.equal(arrived[0].headers.get("x-forwarded-for"), "203.0.113.7", "the client chain must reach the primary");
    assert.equal(arrived[0].headers.get("x-forwarded-host"), HOSTS.student);
  });
});

test("an admin secondary proxies /api/admin and passes the primary's own auth decision through", async () => {
  await withPrimaryRouting(async (arrived) => {
    const res = await siteRequest("admin", "/api/admin/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-data-plane"), "primary");
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].url.pathname, "/api/admin/auth/me");
  });
});

test("a secondary never proxies a foreign prefix or internal sync and answers 404 without an outbound call", async () => {
  await withPrimaryRouting(async (arrived) => {
    for (const [site, pathname] of [
      ["student", "/api/admin/auth/me"],
      ["student", "/api/internal/sync/runs"],
      ["admin", "/api/student/me"],
      ["admin", "/api/internal/sync/conflicts"],
    ]) {
      const res = await siteRequest(site, pathname);
      assert.equal(res.status, 404, `${site} ${pathname}`);
      assert.equal((await res.json()).error, "not_found");
    }
    assert.equal(arrived.length, 0);
  });
});

test("a secondary fails closed with 503 unless PRIMARY_ORIGIN is a bare https origin", async () => {
  await withPrimaryRouting(async (arrived) => {
    for (const primaryOrigin of [
      undefined,
      "http://ai-quest-a1-backend.example.test",
      "https://ai-quest-a1-backend.example.test/api",
      "https://user:credential@ai-quest-a1-backend.example.test",
      "not a url",
    ]) {
      const res = await siteRequest("student", "/api/student/me", { env: { PRIMARY_ORIGIN: primaryOrigin } });
      assert.equal(res.status, 503, String(primaryOrigin));
      assert.equal((await res.json()).error, "backend_disabled");
    }
    assert.equal(arrived.length, 0, "a misconfigured secondary never calls out");
  });
});

test("PRIMARY_ORIGIN may carry a single trailing slash", async () => {
  await withPrimaryRouting(async (arrived) => {
    const res = await siteRequest("student", "/api/student/me", { env: { PRIMARY_ORIGIN: `${PRIMARY_ORIGIN}/` } });
    assert.equal(res.status, 200);
    assert.equal(arrived.length, 1);
  });
});

test("the primary serves its own APIs locally and never calls out", async () => {
  await withPrimaryRouting(async (arrived) => {
    const res = await siteRequest("primary", "/api/student/me");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-data-plane"), null);
    assert.equal(arrived.length, 0);
  });
});

test("an undeclared site keeps the legacy standalone behaviour and is never proxied", async () => {
  await withPrimaryRouting(async (arrived) => {
    const env = { SITE_ROLE: undefined, SITE_NAME: undefined };
    const res = await siteRequest("student", "/api/student/me", { env });
    assert.equal(res.status, 200);
    assert.equal(arrived.length, 0);
    const health = await (await siteRequest("student", "/api/health", { env })).json();
    assert.equal(health.role, "standalone");
    assert.equal(health.backendTarget, "disabled-or-staging-only");
  });
});

test("a misconfigured declaration fails API requests closed while health stays observable", async () => {
  for (const env of [
    { SITE_ROLE: "secondary", SITE_NAME: "backend" },
    { SITE_ROLE: "primary", SITE_NAME: "student" },
    { SITE_ROLE: "secondary", SITE_NAME: undefined },
    { SITE_ROLE: "owner", SITE_NAME: "student" },
  ]) {
    const api = await siteRequest("student", "/api/student/me", { env });
    assert.equal(api.status, 503, JSON.stringify(env));
    assert.equal((await api.json()).error, "site_misconfigured");

    const health = await siteRequest("student", "/api/health", { env });
    assert.equal(health.status, 200, JSON.stringify(env));
    const body = await health.json();
    assert.equal(body.role, "misconfigured");
    assert.equal(body.site, null);
  }
});

test("health publishes the declared contract, and all three sites report the same commit", async () => {
  const primary = await (await siteRequest("primary", "/api/health")).json();
  const student = await (await siteRequest("student", "/api/health")).json();
  const admin = await (await siteRequest("admin", "/api/health")).json();

  assert.deepEqual(
    { status: primary.status, role: primary.role, site: primary.site, primaryOrigin: primary.primaryOrigin, d1: primary.d1, r2: primary.r2 },
    { status: "ok", role: "primary", site: "backend", primaryOrigin: null, d1: "bound", r2: "bound" },
  );
  for (const [body, site] of [[student, "student"], [admin, "admin"]]) {
    assert.deepEqual(
      { status: body.status, role: body.role, site: body.site, primaryOrigin: body.primaryOrigin, d1: body.d1, r2: body.r2 },
      { status: "ok", role: "secondary", site, primaryOrigin: PRIMARY_ORIGIN, d1: "unbound", r2: "unbound" },
    );
  }
  assert.deepEqual([primary.gitSha, student.gitSha, admin.gitSha], [GIT_SHA, GIT_SHA, GIT_SHA]);
});

test("deploy targets agree with the production manifest, the hosting declaration and the topology", () => {
  const targets = JSON.parse(fs.readFileSync(new URL("../deploy/targets.json", import.meta.url), "utf8")).targets;
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../docs/phase4a/environment-source-of-truth.json", import.meta.url), "utf8"),
  );
  const hosting = JSON.parse(fs.readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8"));
  const manifestKey = { backend: "shared_backend", student: "student", admin: "admin" };
  const primaryOrigin = new URL(manifest.sites.shared_backend.url).origin;

  assert.deepEqual(Object.keys(targets).sort(), ["admin", "backend", "student"]);
  for (const [name, target] of Object.entries(targets)) {
    const declared = manifest.sites[manifestKey[name]];
    assert.equal(target.site, name);
    assert.equal(target.project_id, declared.project_id, `${name}: project_id must match the manifest`);
    assert.equal(target.url, declared.url, `${name}: url must match the manifest`);
    if (name === "backend") {
      assert.equal(target.role, "primary");
      assert.equal(target.primary_origin, null);
      assert.deepEqual(target.bindings, { d1: "DB", r2: "BOOKS_BUCKET" });
    } else {
      assert.equal(target.role, "secondary");
      assert.equal(target.primary_origin, primaryOrigin, `${name}: must name the primary origin`);
      assert.deepEqual(target.bindings, {}, `${name}: only the primary may bind D1/R2`);
    }
  }
  assert.equal(new Set(Object.values(targets).map((target) => target.project_id)).size, 3);
  assert.equal(targets.backend.project_id, hosting.project_id, "backend target must match site/.openai/hosting.json");
  assert.equal(targets.backend.bindings.d1, hosting.d1);
  assert.equal(targets.backend.bindings.r2, hosting.r2);
  assert.equal(
    fs.existsSync(new URL("../../.openai/hosting.json", import.meta.url)),
    false,
    "the legacy repo-root hosting manifest must stay removed",
  );
});

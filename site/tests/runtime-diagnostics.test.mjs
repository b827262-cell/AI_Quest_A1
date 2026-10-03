import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APP_VERSION,
  OFFLINE_COPY,
  classifyRuntimeError,
  compareBuildIdentity,
  frontendBuildIdentity,
  normalizeGitSha,
  readBrowserConnectivity,
  resolveBuildIdentity,
  resolveConnectivityState,
} from "../app/runtime-diagnostics.ts";
import { AUTO_ROUTE_WITHHELD_COPY } from "../app/auto-route.ts";

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: options.accept ?? "application/json" },
      method: options.method ?? "GET",
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const CJK = /[一-鿿]/;

function learnerFacingErrorCopy() {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const statements = source.match(/setError\([^;]*\);/g) ?? [];
  const copy = new Set();
  for (const statement of statements) {
    for (const literal of statement.match(/"([^"]*)"/g) ?? []) {
      const value = literal.slice(1, -1);
      // Keys such as "no-decision" name a withhold reason; only localised
      // sentences are what a learner is shown, and every one must classify.
      if (CJK.test(value)) copy.add(value);
    }
  }
  return [...copy];
}

test("C1: every learner-facing failure copy maps to a stable diagnostic code", () => {
  const copy = learnerFacingErrorCopy();
  assert.ok(copy.length >= 6, `expected the student home to surface several failure copies, found ${copy.length}`);
  for (const text of copy) {
    const diagnostic = classifyRuntimeError(text);
    assert.notEqual(diagnostic.code, "unknown", `unclassified learner copy: ${text}`);
  }
  for (const [withhold, text] of Object.entries(AUTO_ROUTE_WITHHELD_COPY)) {
    const diagnostic = classifyRuntimeError(text);
    assert.notEqual(diagnostic.code, "unknown", `unclassified withheld copy for ${withhold}: ${text}`);
  }
});

test("C2: the classifier is total and never reports an unforeseen fault as a dead end", () => {
  for (const input of [undefined, null, "", {}, 0, [], new Error(""), new TypeError("Failed to fetch")]) {
    const diagnostic = classifyRuntimeError(input);
    assert.ok(diagnostic.code, "every input must yield a code");
    assert.equal(typeof diagnostic.retryable, "boolean");
    assert.ok(diagnostic.recovery);
  }
  // An unrecognised cause must stay retryable so the learner is never told to stop.
  assert.deepEqual(classifyRuntimeError("something nobody predicted"), { code: "unknown", retryable: true, recovery: "retry" });
});

test("C3: connectivity dominates the message so an offline learner is told the truth", () => {
  const offline = classifyRuntimeError("本機 AI 模型無法完成回答", { online: false });
  assert.deepEqual(offline, { code: "offline", retryable: true, recovery: "reconnect" });
  assert.equal(classifyRuntimeError(OFFLINE_COPY).code, "offline");
  assert.equal(resolveConnectivityState(true), "online");
  assert.equal(resolveConnectivityState(false), "offline");
  assert.equal(resolveConnectivityState(null), "unknown");
  // A server render has no browser signal and must not claim the learner is offline.
  assert.equal(readBrowserConnectivity(), null);
});

test("C4: retry policy distinguishes recoverable faults from dead ends", () => {
  const cases = [
    { text: "此瀏覽器不支援 Cache Storage，請改用支援的瀏覽器。", code: "cache-storage-unsupported", retryable: false, recovery: "switch-browser" },
    { text: "下載停滯（連續 90 秒無新資料）", code: "download-stalled", retryable: true, recovery: "re-download" },
    { text: "快取空間不足，模型仍可重試下載", code: "cache-quota", retryable: true, recovery: "re-download" },
    { text: "已取消本機 AI 回答，可直接重新出題。", code: "generation-cancelled", retryable: true, recovery: "retry" },
    { text: "本機 AI 模型無法完成回答", code: "generation-failed", retryable: true, recovery: "handoff" },
    { text: "目前請輸入資訊或會計的學習主題，才能產生練習題。", code: "subject-out-of-scope", retryable: true, recovery: "retry-with-scope" },
    { text: "公開體驗目前僅支援 Auto 與 Qwen3-0.6B（本機測試選項）回答。", code: "model-scope-unsupported", retryable: false, recovery: "none" },
  ];
  for (const { text, code, retryable, recovery } of cases) {
    assert.deepEqual(classifyRuntimeError(text), { code, retryable, recovery }, `misclassified: ${text}`);
  }
});

test("C5: build identity resolves environment over injection over fallback and never fabricates a SHA", () => {
  const real = resolveBuildIdentity({ env: { GIT_SHA: "7991E560BEF59BD9A7C55008CDDF921A5E0A31DA", BUILD_ID: "build-77", VERSION: "1.2.3" } });
  assert.deepEqual(real, { version: "1.2.3", buildId: "build-77", gitSha: "7991e560bef59bd9a7c55008cddf921a5e0a31da", source: "environment" });

  const injected = resolveBuildIdentity({ injected: { gitSha: "c0952e8c09452312efd3855ac80eff944fea9e8f", buildId: "deploy-3" } });
  assert.equal(injected.source, "injected");
  assert.equal(injected.gitSha, "c0952e8c09452312efd3855ac80eff944fea9e8f");
  assert.equal(injected.buildId, "deploy-3");
  assert.equal(injected.version, APP_VERSION, "an unstored version field must fall back to the declared app version");

  const fallback = resolveBuildIdentity({ injected: {} });
  assert.deepEqual(fallback, { version: APP_VERSION, buildId: "dev", gitSha: "unknown", source: "fallback" });

  for (const bogus of ["not-a-sha", "7991e560bef59bd9a7c55008cddf921a5e0a31dg", "z".repeat(40), "", null, 42, "  "]) {
    assert.equal(normalizeGitSha(bogus), null, `must reject a non-SHA value: ${String(bogus)}`);
  }
  assert.equal(normalizeGitSha("c0952e8"), "c0952e8", "an abbreviated but real SHA is kept, never padded or invented");
});

test("C6: a comparison only reports skew when both sides published a value", () => {
  const real = { version: "0.1.0", buildId: "build-77", gitSha: "c0952e8c09452312efd3855ac80eff944fea9e8f", source: "environment" };
  assert.deepEqual(compareBuildIdentity(real, { ...real }), { consistent: true, undetermined: [], mismatched: [] });

  const undetermined = compareBuildIdentity(real, { ...real, buildId: "dev", gitSha: "unknown" });
  assert.equal(undetermined.consistent, true, "a dev build is undetermined, not a version mismatch");
  assert.deepEqual(undetermined.undetermined.sort(), ["buildId", "gitSha"]);

  const skewed = compareBuildIdentity(real, { ...real, gitSha: "7991e560bef59bd9a7c55008cddf921a5e0a31da" });
  assert.equal(skewed.consistent, false);
  assert.deepEqual(skewed.mismatched, ["gitSha"]);
});

test("C7: /api/health keeps its vNext contract and publishes the resolved identity", async () => {
  const res = await requestWorker("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.edge, "cloudflare-worker");
  assert.equal(data.d1, "unbound");
  assert.equal(data.r2, "unbound");
  assert.equal(data.storage, "none");
  assert.equal(data.phase, 2);
  assert.equal(data.role, "standalone");
  assert.equal(data.backendTarget, "disabled-or-staging-only");
  assert.ok(Date.parse(data.time) > 0, "health must report a parseable time");

  const sitePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(data.version, sitePackage.version, "declared app version must equal the package version");
  assert.equal(data.version, APP_VERSION);
  assert.equal(data.buildId, "dev");
  assert.equal(data.gitSha, "unknown");
  assert.equal(data.identitySource, "fallback");
});

test("C8: the served homepage and the runtime report the same identity", async () => {
  const [page, health] = await Promise.all([
    requestWorker("/", { accept: "text/html" }),
    requestWorker("/api/health"),
  ]);
  assert.equal(page.status, 200);
  const html = await page.text();

  const frontend = {
    version: /data-a01-version="([^"]*)"/.exec(html)?.[1] ?? "",
    buildId: /data-a01-build-id="([^"]*)"/.exec(html)?.[1] ?? "",
    gitSha: /data-a01-git-sha="([^"]*)"/.exec(html)?.[1] ?? "",
    source: "fallback",
  };
  assert.ok(frontend.version, "the homepage must publish its frontend identity for E2E assertions");
  const remote = await health.json();
  const comparison = compareBuildIdentity(
    { version: frontend.version, buildId: frontend.buildId, gitSha: frontend.gitSha, source: frontend.source },
    { version: remote.version, buildId: remote.buildId, gitSha: remote.gitSha, source: remote.identitySource },
  );
  assert.equal(comparison.consistent, true, `frontend/runtime identity skew: ${JSON.stringify(comparison)}`);
  assert.deepEqual(comparison.mismatched, []);

  assert.match(html, /class="v2-diagnostics"/);
  assert.match(html, /data-a01-connectivity="online"/, "a server render must not claim the learner is offline");
  assert.equal(frontendBuildIdentity().version, APP_VERSION);
});

test("C9: the app version literal exists in exactly one runtime module", () => {
  const sources = ["app/page.tsx", "app/layout.tsx", "app/api/health/route.ts", "app/auto-route.ts", "app/chrome-built-in-ai.ts"];
  for (const file of sources) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      !text.includes(`"${APP_VERSION}"`),
      `${file} hardcodes version "${APP_VERSION}"; it must read runtime-diagnostics instead`,
    );
  }
});

test("C10: every A-01 route stays routed and never 5xx-es in the test runtime", async () => {
  // Statuses below were captured from this build (dist/server/index.js) under
  // NODE_ENV=test, which is what `npm test` sets. NODE_ENV matters: db/index.ts
  // serves synthetic fixtures in test mode, so /api/student/books answers 200
  // here and legitimately 503s (`d1_unavailable`) against a real unbound worker.
  const expectations = [
    { path: "/", accept: "text/html", status: 200 },
    { path: "/admin", accept: "text/html", status: 200 },
    { path: "/signin-with-chatgpt", accept: "text/html", status: 200 },
    { path: "/api/health", accept: "application/json", status: 200 },
    { path: "/api/student/me", accept: "application/json", status: 200 },
    { path: "/api/student/progress", accept: "application/json", status: 200 },
    { path: "/api/student/books", accept: "application/json", status: 200 },
    { path: "/api/student/books/missing-book", accept: "application/json", status: 404 },
    { path: "/api/admin/auth/me", accept: "application/json", status: 401 },
    { path: "/api/admin/overview", accept: "application/json", status: 401 },
    { path: "/api/admin/books", accept: "application/json", status: 401 },
    { path: "/api/internal/sync/runs", accept: "application/json", status: 405 },
    { path: "/api/internal/sync/conflicts", accept: "application/json", status: 401 },
    { path: "/a01/definitely-not-a-route", accept: "text/html", status: 404 },
  ];
  for (const { path, accept, status } of expectations) {
    const res = await requestWorker(path, { accept });
    assert.equal(res.status, status, `unexpected status for ${path} (${accept})`);
    assert.ok(res.status < 500, `${path} returned an unhandled ${res.status}`);
  }
});

test("C11: the student books route serves synthetic data, never production rows", async () => {
  const res = await requestWorker("/api/student/books");
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.ok(Array.isArray(payload.books) && payload.books.length > 0, "expected synthetic fixtures in test mode");
  for (const book of payload.books) {
    assert.match(`${book.id}:${book.title}`, /synth/i, `non-synthetic book surfaced in the test runtime: ${book.id}`);
  }
});

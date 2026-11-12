import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const workerEnv = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const workerCtx = { waitUntil() {}, passThroughOnException() {} };

async function render() {
  const worker = await loadWorker();

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    workerEnv,
    workerCtx,
  );
}

test("renders the AI-SmartBook learning homepage", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /AI-SmartBook/);
  assert.match(html, /把閱讀、提問與/);
  assert.match(html, /智慧書庫/);
  assert.match(html, /閱讀輔助/);
  assert.match(html, /學習進度/);
  assert.match(html, /管理工作台/);
  assert.match(html, /Chrome Built-in AI/);
  assert.match(html, /id="auto-answer"/);
  assert.match(html, /auto-question/);
  assert.match(html, /跳頁 Google AI 解答/);
  assert.match(html, /AI 助手出題/);
  assert.match(html, /練習題主要提供學員練題；詳解答案請使用 Google AI/);
  assert.match(html, /快速題型/);
  assert.match(html, /class="v2-hero-art v2-reveal v2-delay-1" role="img" aria-label="AI-SmartBook 學習介面示意"/);
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /\/signin-with-chatgpt/);
  assert.match(html, /\/admin/);
  assert.doesNotMatch(html, /\/login\b/);
  assert.doesNotMatch(html, /\/guest-answer\b/);
  assert.doesNotMatch(html, /\/admin\/login\b/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview|react-loading-skeleton/);

  // A1: Auto label, old consent checkbox and manual subject routes remain removed.
  assert.match(html, /<option value="Auto"[^>]*>Auto<\/option>/);
  assert.doesNotMatch(html, /Auto \(Qwen3-0\.6B\)/);
  assert.doesNotMatch(html, /模型只在 IT／會計題目啟用/);
  assert.doesNotMatch(html, /我同意將原題送往 Google AI/);
  assert.doesNotMatch(html, /開啟 Google AI 完整解題/);
  assert.doesNotMatch(html, /先同意後提供備援連結/);
  assert.doesNotMatch(html, /改以資訊科試解/);
  assert.doesNotMatch(html, /改以會計科試解/);
  assert.doesNotMatch(html, /完整解題（Google）/);
});

// vinext 1.4 serves "/" and "/admin" with `s-maxage=31536000` and a cache key
// that ignores the query string. That is only safe while those pages render the
// same server-side HTML for every visitor: personalising them without an
// explicit `force-dynamic` would hand one user's data to the next visitor.
const SYNTHETIC_IDENTITY_A = "test-a@example.invalid";
const SYNTHETIC_IDENTITY_B = "test-b@example.invalid";
const SYNTHETIC_COOKIE_A = "n-r476-cookie-a";
const SYNTHETIC_COOKIE_B = "n-r476-cookie-b";

// Dynamic responses can echo the request query in RSC metadata, so strip the
// random probe before comparing two otherwise identical documents.
function stripProbe(html, probe) {
  if (!probe) return html;
  return html.split(probe).join("").replace(/[?&]probe=/g, "");
}

// The page cache is process-wide and keyed by pathname only, so an earlier test
// in this file can already have warmed it. Run the probe in a fresh child
// process instead: NODE_ENV=production matches the deployment mode, the cache
// starts cold, and the first request must MISS while every later one must HIT.
const CACHE_PROBE_SCRIPT = `
const { default: worker } = await import(process.env.N_R476_DIST);
const variants = JSON.parse(process.env.N_R476_VARIANTS);
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const fetchPage = (url, headers) =>
  worker.fetch(new Request(url, { headers: { accept: "text/html", ...headers } }), env, ctx);
const headersOf = (response) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  cache: response.headers.get("x-vinext-cache"),
  cacheControl: response.headers.get("cache-control"),
  setCookie: response.headers.get("set-cookie"),
});
const pages = [];
for (const path of ["/", "/admin"]) {
  const warmup = await fetchPage("http://localhost" + path, {});
  const warmupHeaders = headersOf(warmup);
  await warmup.text();
  const rows = [];
  for (const variant of variants) {
    const url = "http://localhost" + path + (variant.probe ? "?probe=" + variant.probe : "");
    const response = await fetchPage(url, variant.headers);
    const html = await response.text();
    rows.push({ label: variant.label, probe: variant.probe, ...headersOf(response), html });
  }
  pages.push({ path, warmup: warmupHeaders, rows });
}
process.stdout.write(JSON.stringify(pages));
`;

test("cached public pages never embed per-user identity", () => {
  const variants = [
    ["anonymous", {}, null],
    ["synthetic identity A", { "oai-authenticated-user-email": SYNTHETIC_IDENTITY_A }, null],
    ["synthetic identity B", { "oai-authenticated-user-email": SYNTHETIC_IDENTITY_B }, null],
    ["cookie A", { cookie: `session=${SYNTHETIC_COOKIE_A}` }, null],
    ["cookie B", { cookie: `session=${SYNTHETIC_COOKIE_B}` }, null],
    [
      "synthetic identity A + cookie A",
      { "oai-authenticated-user-email": SYNTHETIC_IDENTITY_A, cookie: `session=${SYNTHETIC_COOKIE_A}` },
      null,
    ],
    ["random query", {}, Math.random().toString(36).slice(2)],
  ].map(([label, headers, probe]) => ({ label, headers, probe }));

  const output = execFileSync(process.execPath, ["--import", new URL("./support/cloudflare-workers-shim.mjs", import.meta.url).href, "--input-type=module", "-e", CACHE_PROBE_SCRIPT], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      N_R476_DIST: new URL("../dist/server/index.js", import.meta.url).href,
      N_R476_VARIANTS: JSON.stringify(variants),
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const pages = JSON.parse(output);

  for (const { path, warmup, rows } of pages) {
    assert.equal(warmup.status, 200, `${path}: warmup status`);
    assert.equal(warmup.cache, "MISS", `${path}: the first request must fill the cache, not read it`);

    const bodies = [];
    for (const row of rows) {
      assert.equal(row.status, 200, `${path} ${row.label}: status`);
      assert.match(row.contentType ?? "", /^text\/html\b/i, `${path} ${row.label}: content type`);
      assert.equal(row.cache, "HIT", `${path} ${row.label}: expected the shared page cache to serve this request`);
      assert.match(row.cacheControl ?? "", /s-maxage=31536000/, `${path} ${row.label}: cached page must advertise the shared TTL`);
      // No route in this app emits Set-Cookie today (no cookies()/set-cookie in
      // app/, lib/ or worker/), so there is no cookie-setting page to exercise.
      // A cached public page must never set one; if such a route is added, this
      // assertion keeps it out of the shared cache.
      assert.equal(row.setCookie, null, `${path} ${row.label}: cached page must not set cookies`);

      for (const value of [SYNTHETIC_IDENTITY_A, SYNTHETIC_IDENTITY_B, SYNTHETIC_COOKIE_A, SYNTHETIC_COOKIE_B]) {
        assert.ok(!row.html.includes(value), `${path} ${row.label}: HTML leaked ${value}`);
      }
      bodies.push([row.label, stripProbe(row.html, row.probe)]);
    }

    for (const [label, html] of bodies.slice(1)) {
      assert.equal(html, bodies[0][1], `${path}: ${label} received different HTML than anonymous`);
    }
  }
});

test("per-user API responses are never shared-cacheable", async () => {
  const worker = await loadWorker();
  for (const path of ["/api/health", "/api/student/me"]) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "application/json" } }),
      workerEnv,
      workerCtx,
    );
    const cacheControl = response.headers.get("cache-control") ?? "";
    assert.match(cacheControl, /no-store/i, `${path}: cache-control must include no-store (got "${cacheControl}")`);
    assert.notEqual(response.headers.get("x-vinext-cache"), "HIT", `${path}: must not be served as a shared-cache HIT`);
  }
});

// H3 accessibility remediation: normal text must clear WCAG 2.1 AA (>=4.5:1)
// against the background it actually renders on. The stylesheet keeps the
// original foreground tokens and corrects them with a later rule, so the
// effective color is the last winning declaration for each selector.
const wcagCases = [
  { selector: ".v2-note", background: "#f9fbff", label: "hero note" },
  { selector: ".v2-trust", background: "#f9fbff", label: "trust bar" },
  { selector: ".v2-eyebrow", background: "#f9fbff", label: "eyebrow on page" },
  { selector: ".v2-eyebrow", background: "#edf3ff", label: "eyebrow on workflow band" },
  { selector: ".v2-feature-card p", background: "#ffffff", label: "feature card copy" },
  { selector: ".v2-feature-card>span", background: "#ffffff", label: "feature card number" },
  { selector: ".v2-architecture small", background: "#ffffff", label: "architecture card label" },
  { selector: ".v2-architecture article>span", background: "#f2f5ff", label: "backend architecture service label" },
  { selector: ".v2-steps li>span", background: "#edf3ff", label: "workflow step number" },
  { selector: ".v2-steps p", background: "#edf3ff", label: "workflow copy" },
  { selector: ".v2-architecture p", background: "#ffffff", label: "architecture card copy" },
  { selector: ".v2-architecture p", background: "#f2f5ff", label: "backend architecture card copy" },
  { selector: ".v2-nav nav a:hover,.v2-nav-login:hover", background: "#f9fbff", label: "navigation hover text" },
  { selector: ".v2-button-primary", background: "#4569e0", label: "primary CTA text at gradient start" },
  { selector: ".v2-architecture small", background: "#f2f5ff", label: "backend architecture card label" },
];

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    let v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function effectiveColor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  let winner = null;
  for (const block of blocks) {
    const color = /(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{6})/.exec(block[1]);
    if (color) winner = color[1];
  }
  assert.ok(winner, `no color declaration found for ${selector}`);
  return winner;
}

test("homepage normal text meets WCAG AA contrast against its rendered background", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const { selector, background, label } of wcagCases) {
    const color = effectiveColor(css, selector);
    const ratio = contrastRatio(color, background);
    assert.ok(ratio >= 4.5, `${label}: ${selector} ${color} vs ${background} = ${ratio.toFixed(2)}:1 (<4.5:1 AA)`);
  }
});

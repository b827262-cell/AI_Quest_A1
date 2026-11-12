import assert from "node:assert/strict";
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

test("cached public pages never embed per-user identity", async () => {
  const worker = await loadWorker();
  const fetchPage = (path, headers = {}) =>
    worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html", ...headers } }),
      workerEnv,
      workerCtx,
    );

  const variants = [
    ["anonymous", {}],
    ["synthetic identity A", { "oai-authenticated-user-email": SYNTHETIC_IDENTITY_A }],
    ["synthetic identity B", { "oai-authenticated-user-email": SYNTHETIC_IDENTITY_B }],
    ["random query", {}],
  ];

  for (const path of ["/", "/admin"]) {
    // Fill the shared page cache first, so every measured request reads the copy
    // that a real visitor would receive.
    await (await fetchPage(path)).text();

    const bodies = [];
    for (const [label, headers] of variants) {
      const target = label === "random query" ? `${path}?probe=${Math.random().toString(36).slice(2)}` : path;
      const response = await fetchPage(target, headers);
      assert.equal(response.status, 200, `${path} ${label}: status`);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i, `${path} ${label}: content type`);
      if (response.headers.has("set-cookie")) {
        assert.notEqual(
          response.headers.get("x-vinext-cache"),
          "HIT",
          `${path} ${label}: a response that sets cookies must not come from the shared page cache`,
        );
      }

      const html = await response.text();
      assert.ok(!html.includes(SYNTHETIC_IDENTITY_A), `${path} ${label}: HTML leaked synthetic identity A`);
      assert.ok(!html.includes(SYNTHETIC_IDENTITY_B), `${path} ${label}: HTML leaked synthetic identity B`);
      bodies.push([label, html]);
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

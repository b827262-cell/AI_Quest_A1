#!/usr/bin/env node
// Re-capture the production environment source-of-truth manifest from live,
// read-only HTTP probes, so verify-environment-alignment.mjs can be refreshed
// without hand-editing timestamps.
//
//   node scripts/capture-environment-source-of-truth.mjs [--manifest <path>] [--write]
//
// Without --write it only prints what it observed and what would change.
// It refuses to write unless every probe agrees with the manifest's declared
// identities; it never changes project IDs, URLs, or bindings — it only
// re-attests them. Fields that cannot be observed over HTTP (the deployed
// git SHA) are carried forward and labelled as such in `capture_evidence`.
// Only `environment: "production"` manifests are supported.
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "../..");
const defaultManifest = path.join(repoDir, "docs/phase4a/environment-source-of-truth.json");

function parseArgs(argv) {
  const options = { manifest: defaultManifest, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--manifest") options.manifest = path.resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual" });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* recorded as non-JSON below */ }
  return { url, status: response.status, body };
}

/** Probes the live sites and returns { observed, failures }. Exported for tests. */
export async function probe(manifest, fetchJson = getJson, getContent = (url) => fetch(url, { method: "GET", redirect: "manual" })) {
  const failures = [];
  const expect = (ok, message) => { if (!ok) failures.push(message); };
  const backend = manifest.sites?.shared_backend;
  const backendProject = backend?.project_id;
  const observed = { health: {} };

  // Validate declarations before any request. Health does not expose project
  // or physical resource IDs, so those can only be cross-checked locally.
  expect(manifest.environment === "production", "only production manifests are supported");
  expect(typeof backendProject === "string" && backendProject.length > 0, "shared_backend project_id is required");
  expect(manifest.worker?.project_id === backendProject, "worker.project_id must match shared_backend.project_id");
  for (const name of ["shared_backend", "student", "admin"]) {
    expect(Boolean(manifest.sites?.[name]?.url), `${name}: site URL is required`);
  }
  for (const [name, site] of Object.entries(manifest.sites ?? {})) {
    try {
      const url = new URL(site.url);
      expect(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
        `${name}: site URL must be a credential-free HTTPS origin`);
    } catch {
      expect(false, `${name}: invalid site URL`);
    }
  }
  try {
    expect(new URL(manifest.worker?.health_endpoint).href === new URL("/api/health", backend?.url).href,
      "worker.health_endpoint must match shared_backend /api/health");
  } catch {
    expect(false, "worker.health_endpoint or shared_backend URL is invalid");
  }
  if (failures.length > 0) return { observed, failures };

  for (const [name, site] of Object.entries(manifest.sites ?? {})) {
    const result = await fetchJson(new URL("/api/health", site.url).href);
    const health = result.body ?? {};
    observed.health[name] = {
      status: result.status, role: health.role ?? null, time: health.time ?? null,
      d1: health.d1 ?? null, r2: health.r2 ?? null, backendTarget: health.backendTarget ?? null,
    };
    expect(result.status === 200 && health.status === "ok", `${name}: /api/health not ok (HTTP ${result.status})`);
    expect(health.edge === "cloudflare-worker", `${name}: edge is ${health.edge}`);
    // Current route reports backend / standalone; production frontends do not
    // attest shared bindings. Only the backend's storage is tested below.
    expect(health.backendTarget === "disabled-or-staging-only", `${name}: backendTarget ${health.backendTarget}`);
    expect(health.role === (name === "shared_backend" ? "backend" : "standalone"), `${name}: role ${health.role}`);
    if (name === "shared_backend") {
      expect(health.d1 === "bound" && health.r2 === "bound", `${name}: d1=${health.d1} r2=${health.r2}`);
    }
  }

  // D1 readable: the student catalogue is served from D1.
  const books = await fetchJson(new URL("/api/student/books", backend.url).href);
  const list = Array.isArray(books.body?.books) ? books.body.books : null;
  observed.d1_books = { status: books.status, count: list ? list.length : null };
  expect(books.status === 200 && list && list.length > 0, `D1: /api/student/books HTTP ${books.status}, ${list ? list.length : "no"} books`);

  // R2 readable: one object's bytes are served with the sha256 recorded in D1.
  const sample = list?.find((book) => typeof book.id === "string" && /^[a-f0-9]{64}$/i.test(book.sha256 ?? "")) ?? null;
  if (sample) {
    const response = await getContent(new URL(`/api/student/books/${encodeURIComponent(sample.id)}/content`, backend.url).href);
    const bytes = response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null;
    const sha = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
    const matches = sha !== null && sha === sample.sha256.toLowerCase();
    // x-sha256 is echoed D1 metadata, not proof of the R2 object's bytes.
    observed.r2_object = { id: sample.id, method: "GET", status: response.status, bytes: bytes?.byteLength ?? null, sha256: sha, sha256_match: matches };
    expect(response.status === 200 && matches, `R2: ${sample.id} HTTP ${response.status}, content SHA-256 ${matches ? "matches" : "mismatch"}`);
  } else {
    expect(false, "R2: no book with sha256 to probe");
  }

  observed.captured_at = observed.health.shared_backend?.time ?? null;
  expect(typeof observed.captured_at === "string" && !Number.isNaN(Date.parse(observed.captured_at)), "backend health returned no server time");
  return { observed, failures };
}

/** Returns the refreshed manifest (pure). Exported for tests. */
export function refreshed(manifest, observed) {
  const next = structuredClone(manifest);
  next.captured_at = observed.captured_at;
  next.worker.health_status = observed.health.shared_backend.status;
  next.worker.bindings.DB.readable = true;
  next.worker.bindings.BOOKS_BUCKET.list_readable = true;
  next.worker.bindings.BOOKS_BUCKET.get_readable = true;
  next.capture_evidence = {
    method: "site/scripts/capture-environment-source-of-truth.mjs (read-only HTTP)",
    captured_at_source: "shared_backend /api/health server time",
    health: observed.health,
    d1_books: observed.d1_books,
    r2_object: observed.r2_object,
    carried_forward: {
      "worker.deployed_git_sha": "not observable over HTTP; carried from the previous capture",
      "worker.version": "not observable over HTTP; carried from the previous capture",
      "worker.project_id": "configuration cross-check only; not observable over HTTP",
      "sites.*.project_id": "not observable over HTTP; carried from the previous capture",
      "worker.bindings.*.resource_id": "physical resource IDs are not observable over HTTP; carried from the previous capture",
    },
  };
  return next;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(options.manifest, "utf8"));
  if (manifest.environment !== "production") throw new Error(`only production manifests are supported (got ${manifest.environment})`);

  const { observed, failures } = await probe(manifest);
  console.log(JSON.stringify({ manifest: options.manifest, observed, failures }, null, 2));
  if (failures.length > 0) {
    console.error(`CAPTURE=FAIL (${failures.length} mismatch${failures.length === 1 ? "" : "es"}); manifest not written`);
    process.exit(1);
  }
  if (!options.write) {
    console.error(`CAPTURE=PASS (dry run); captured_at would become ${observed.captured_at}. Re-run with --write to update.`);
    return;
  }
  fs.writeFileSync(options.manifest, `${JSON.stringify(refreshed(manifest, observed), null, 2)}\n`);
  console.error(`CAPTURE=PASS; wrote ${options.manifest} (captured_at=${observed.captured_at})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`CAPTURE=FAIL\nERROR=${error.message}`); process.exit(1); });
}

/**
 * Sanitized evidence output for the A-01 synthetic traffic injector.
 *
 * Only aggregate counts and route templates are stored. No raw request or
 * response bodies, query strings, headers, cookies, IPs or ids are written.
 * Any identifier (e.g. a created resource id) is hashed before storage.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maskIp, redactString } from "./safety.mjs";

/** SHA-256 hex (truncated) so ids can be correlated without being exposed. */
export async function hashId(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex.slice(0, 16)}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Create a manifest skeleton for one run.
 * @param {object} options
 */
export function createManifest(options) {
  const {
    runId,
    site,
    targetHost,
    executor = "unknown",
    authorizationRef = "unspecified",
    targetPerPath = 30,
    rateLimit = null,
    dryRun = true,
  } = options;
  return {
    run_id: runId,
    kind: "a01-synthetic-injection",
    site,
    dry_run: dryRun,
    target_host: targetHost,
    executor,
    authorization_ref: authorizationRef,
    target_per_path: targetPerPath,
    rate_limit_per_sec: rateLimit,
    started_at: nowIso(),
    ended_at: null,
    stop_reason: null,
    totals: { attempted: 0, success: 0, error: 0 },
    rows: {},
  };
}

function rowKey(routeTemplate, method) {
  return `${method} ${routeTemplate}`;
}

/**
 * Record the outcome of a single attempt. Only status codes and counts are kept.
 */
export function recordResult(manifest, { routeTemplate, method, status, success }) {
  const key = rowKey(routeTemplate, method);
  const row = (manifest.rows[key] ??= {
    route_template: routeTemplate,
    method,
    target: manifest.target_per_path,
    attempted: 0,
    success: 0,
    error: 0,
    statuses: {},
  });
  row.attempted += 1;
  row.statuses[String(status)] = (row.statuses[String(status)] ?? 0) + 1;
  if (success) {
    row.success += 1;
    manifest.totals.success += 1;
  } else {
    row.error += 1;
    manifest.totals.error += 1;
  }
  manifest.totals.attempted += 1;
}

/** Record an opaque created-resource id in hashed form (never the raw id). */
export async function recordCreatedId(manifest, rawId) {
  (manifest.created_ids_hashed ??= []).push(await hashId(rawId));
}

/** Attach an optional source IP in masked form only. */
export function recordSourceIp(manifest, ip) {
  (manifest.source_ips_masked ??= []).push(maskIp(ip));
}

/** Close the manifest with an end timestamp and stop reason. */
export function finalizeManifest(manifest, { stopReason = "completed" } = {}) {
  manifest.ended_at = nowIso();
  manifest.stop_reason = stopReason;
  return manifest;
}

/**
 * Build a sanitized summary from a finalized manifest. Contains only counts.
 */
export function summarize(manifest) {
  const rows = Object.values(manifest.rows).map((row) => ({
    route_template: row.route_template,
    method: row.method,
    target: row.target,
    attempted: row.attempted,
    success: row.success,
    error: row.error,
    statuses: { ...row.statuses },
    met_target: row.success >= row.target,
  }));
  const nonGet = rows.filter((row) => row.method !== "GET" && row.method !== "HEAD");
  return {
    run_id: manifest.run_id,
    kind: manifest.kind,
    site: manifest.site,
    dry_run: manifest.dry_run,
    target_host: manifest.target_host,
    started_at: manifest.started_at,
    ended_at: manifest.ended_at,
    stop_reason: manifest.stop_reason,
    totals: { ...manifest.totals },
    rows,
    non_get_rows: nonGet,
    all_targets_met: rows.every((row) => row.met_target),
    note:
      "Synthetic samples are tagged server-side (relay.verify synthetic=true) and " +
      "must be counted separately from natural traffic; they do not count toward " +
      "Student 300 / Admin 100.",
  };
}

/**
 * Write the manifest and summary into an evidence directory. The directory is
 * created if missing. Filenames are derived from the run id (sanitized).
 */
export async function writeEvidence(evidenceDir, manifest, summary = summarize(manifest)) {
  await mkdir(evidenceDir, { recursive: true });
  const safeRunId = redactString(manifest.run_id).replace(/[^A-Za-z0-9._-]/g, "_");
  const manifestPath = join(evidenceDir, `${safeRunId}.manifest.json`);
  const summaryPath = join(evidenceDir, `${safeRunId}.summary.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { manifestPath, summaryPath };
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SNAPSHOT_PATH = "data/b1-ibrain-public/raw-snapshot.json";
export const MANIFEST_PATH = "data/b1-ibrain-public/crawl-manifest.json";
export const DATA_FRESHNESS = "UNVERIFIED";

function fail(message) {
  throw new Error(`B1 snapshot validation failed: ${message}`);
}

function expectedHash(row) {
  return createHash("sha256")
    .update([row.exam_year, row.category, row.course_code, row.course_name, row.course_content, row.source_url].join("\u0001"), "utf8")
    .digest("hex");
}

function sourceHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    fail(`invalid source_url: ${value}`);
  }
}

/** Validates the only two B2 data inputs and returns safe import metadata. */
export async function loadValidatedB1Snapshot({ snapshotPath = SNAPSHOT_PATH, manifestPath = MANIFEST_PATH } = {}) {
  const [snapshotText, manifestText] = await Promise.all([readFile(snapshotPath, "utf8"), readFile(manifestPath, "utf8")]);
  const rows = JSON.parse(snapshotText);
  const manifest = JSON.parse(manifestText);

  if (!Array.isArray(rows) || rows.length !== 16) fail(`expected rows=16, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  if (manifest.rows !== 16) fail(`manifest rows must be 16, got ${manifest.rows}`);
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object") fail(`row ${index} is not an object`);
    if (![115, 116].includes(row.exam_year)) fail(`row ${index} has invalid exam_year`);
    if (row.category !== "高普考") fail(`row ${index} has invalid category`);
    if (sourceHost(row.source_url) !== "ec.ibrain.com.tw") fail(`row ${index} has unapproved source host`);
    if (!/^[a-f0-9]{64}$/.test(row.content_hash ?? "")) fail(`row ${index} content_hash is not SHA-256`);
    if (row.content_hash !== expectedHash(row)) fail(`row ${index} content_hash does not match canonical fields`);
  }

  const acquisition = manifest.acquisition ?? {};
  return {
    rows,
    manifest,
    directFetchClaimed: acquisition.direct_fetch_status?.includes("PASS") === true,
    // Owner checkpoint supersedes the uncorroborated manifest claim: no B2 live request is made.
    dataFreshness: DATA_FRESHNESS
  };
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The two files B2 is allowed to read. Everything else about the crawl — the
 * page HTML, the operator's notes, secondary mirrors — stays outside the ingest
 * path so the database has exactly one upstream.
 */
export const EXAM_SNAPSHOT_DIRECTORY_RELATIVE = "data/b1-ibrain-public";
export const EXAM_SNAPSHOT_RAW_RELATIVE = `${EXAM_SNAPSHOT_DIRECTORY_RELATIVE}/raw-snapshot.json`;
export const EXAM_SNAPSHOT_MANIFEST_RELATIVE = `${EXAM_SNAPSHOT_DIRECTORY_RELATIVE}/crawl-manifest.json`;

export interface LoadedExamSnapshotFiles {
  snapshotPath: string;
  manifestPath: string;
  rows: unknown[];
  manifest: unknown;
}

function readRequired(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`);
  }
  return readFileSync(path, "utf8");
}

export function parseExamSnapshotRows(source: string, path: string): unknown[] {
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of course rows`);
  }
  return parsed;
}

export function loadExamSnapshotFiles(
  options: { directory?: string; snapshotPath?: string; manifestPath?: string } = {}
): LoadedExamSnapshotFiles {
  const base = options.directory ?? process.cwd();
  const snapshotPath = options.snapshotPath ?? resolve(base, EXAM_SNAPSHOT_RAW_RELATIVE);
  const manifestPath = options.manifestPath ?? resolve(base, EXAM_SNAPSHOT_MANIFEST_RELATIVE);

  return {
    snapshotPath,
    manifestPath,
    rows: parseExamSnapshotRows(readRequired(snapshotPath, "raw snapshot"), snapshotPath),
    manifest: JSON.parse(readRequired(manifestPath, "crawl manifest")) as unknown
  };
}

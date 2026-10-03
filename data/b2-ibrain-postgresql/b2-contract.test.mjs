import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DATA_FRESHNESS, loadValidatedB1Snapshot } from "./validate-snapshot.mjs";

test("B1 input fulfills the required 高普考-only contract", async () => {
  const { rows } = await loadValidatedB1Snapshot();
  assert.equal(rows.length, 16);
  assert.ok(rows.every((row) => row.category === "高普考"));
  assert.equal(DATA_FRESHNESS, "UNVERIFIED");
});

test("B1 input fails closed when a row violates the required 高普考-only contract", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "b2-contract-"));
  try {
    const { rows, manifest } = await loadValidatedB1Snapshot();
    const invalidRows = structuredClone(rows);
    invalidRows[1].category = "普考";
    const snapshotPath = join(fixtureDir, "raw-snapshot.json");
    const manifestPath = join(fixtureDir, "crawl-manifest.json");
    await Promise.all([
      writeFile(snapshotPath, JSON.stringify(invalidRows)),
      writeFile(manifestPath, JSON.stringify(manifest))
    ]);
    await assert.rejects(loadValidatedB1Snapshot({ snapshotPath, manifestPath }), /row 1 has invalid category/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("migration encodes uniqueness, hash-aware upsert target, and permitted indexes only", async () => {
  const [migration, importer, queries] = await Promise.all([
    readFile("data/b2-ibrain-postgresql/001_exam_courses.sql", "utf8"),
    readFile("data/b2-ibrain-postgresql/import-b1-snapshot.mjs", "utf8"),
    readFile("data/b2-ibrain-postgresql/query-contract.sql", "utf8")
  ]);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_courses_year_code/);
  assert.match(importer, /ON CONFLICT \(exam_year, lower\(course_code\)\)/);
  assert.match(importer, /content_hash IS DISTINCT FROM EXCLUDED\.content_hash/);
  assert.match(migration, /idx_exam_courses_course_code/);
  assert.match(migration, /course_name gin_trgm_ops/);
  assert.match(migration, /course_content gin_trgm_ops/);
  assert.match(queries, /lower\(course_code\) = lower\(\$1\)/);
  assert.match(queries, /websearch_to_tsquery/);
  assert.match(queries, /ILIKE/);
});

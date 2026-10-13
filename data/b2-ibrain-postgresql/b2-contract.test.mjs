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

test("migration and importer share the canonical uppercase natural key", async () => {
  const [migration, importer, queries] = await Promise.all([
    readFile("data/b2-ibrain-postgresql/001_exam_courses.sql", "utf8"),
    readFile("data/b2-ibrain-postgresql/import-b1-snapshot.mjs", "utf8"),
    readFile("data/b2-ibrain-postgresql/query-contract.sql", "utf8")
  ]);
  assert.match(migration, /PRIMARY KEY \(exam_year, course_code\)/);
  assert.match(migration, /course_code ~ '\^\[A-Z0-9\]\[A-Z0-9\._-\]\{0,127\}\$'/);
  assert.doesNotMatch(migration, /lower\(course_code\)/);
  assert.match(importer, /ON CONFLICT \(exam_year, course_code\)/);
  assert.doesNotMatch(importer, /ON CONFLICT \(exam_year, lower\(course_code\)\)/);
  assert.match(importer, /content_hash IS DISTINCT FROM EXCLUDED\.content_hash/);
  assert.match(migration, /idx_exam_courses_course_code/);
  assert.match(migration, /course_name gin_trgm_ops/);
  assert.match(migration, /course_content gin_trgm_ops/);
  assert.match(queries, /lower\(course_code\) = lower\(\$1\)/);
  assert.match(queries, /websearch_to_tsquery/);
  assert.match(queries, /ILIKE/);
});

test("source URL constraint permits mixed-case paths on the approved HTTP host only", async () => {
  const migration = await readFile("data/b2-ibrain-postgresql/001_exam_courses.sql", "utf8");
  const hostCheck = /^https?:\/\/ec\.ibrain\.com\.tw([/?#]|$)/;

  assert.ok(migration.includes("source_url ~ '^https?://ec\\.ibrain\\.com\\.tw([/?#]|$)'"));
  assert.equal(hostCheck.test("http://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18064"), true);
  for (const sourceUrl of [
    "http://foreign.example/Publish/WWW/Book.asp",
    "http://ec.ibrain.com.tw.evil.example/Publish/WWW/Book.asp",
    "http://evil@ec.ibrain.com.tw/Publish/WWW/Book.asp"
  ]) {
    assert.equal(hostCheck.test(sourceUrl), false, `${sourceUrl} must be rejected`);
  }
});

test("16-row B1 dry-run projects absent teacher and scope as NULL", async () => {
  const [{ rows }, importer] = await Promise.all([
    loadValidatedB1Snapshot(),
    readFile("data/b2-ibrain-postgresql/import-b1-snapshot.mjs", "utf8")
  ]);
  assert.equal(rows.length, 16);
  assert.ok(rows.every((row) => !("teacher" in row) && !("applicable_scope" in row)));
  assert.match(importer, /NULL::text, NULL::text, source_url/);
  assert.match(importer, /teacher = EXCLUDED\.teacher/);
  assert.match(importer, /applicable_scope = EXCLUDED\.applicable_scope/);
  assert.doesNotMatch(importer, /teacher text|applicable_scope text/);
});

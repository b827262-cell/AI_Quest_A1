#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadValidatedB1Snapshot } from "./validate-snapshot.mjs";

const args = new Set(process.argv.slice(2));
if (![...args].every((arg) => arg === "--dry-run")) {
  throw new Error("usage: node data/b2-ibrain-postgresql/import-b1-snapshot.mjs [--dry-run]");
}

const { rows, dataFreshness } = await loadValidatedB1Snapshot();
const payload = JSON.stringify(rows);
const sql = `
INSERT INTO public.exam_courses
  (exam_year, category, course_code, course_name, course_content, teacher, applicable_scope, source_url, fetched_at, content_hash)
SELECT exam_year, category, course_code, course_name, course_content, NULL::text, NULL::text, source_url, fetched_at, content_hash
FROM jsonb_to_recordset($b2payload$${payload}$b2payload$::jsonb) AS input(
  exam_year smallint, category text, course_code text, course_name text,
  course_content text, source_url text, fetched_at timestamptz, content_hash char(64)
)
ON CONFLICT (exam_year, course_code) DO UPDATE SET
  category = EXCLUDED.category,
  course_name = EXCLUDED.course_name,
  course_content = EXCLUDED.course_content,
  teacher = EXCLUDED.teacher,
  applicable_scope = EXCLUDED.applicable_scope,
  source_url = EXCLUDED.source_url,
  fetched_at = EXCLUDED.fetched_at,
  content_hash = EXCLUDED.content_hash,
  updated_at = now()
WHERE public.exam_courses.content_hash IS DISTINCT FROM EXCLUDED.content_hash;
`;

console.error(`B2 validated ${rows.length} rows; DATA_FRESHNESS=${dataFreshness}`);
if (args.has("--dry-run")) {
  process.stdout.write(sql);
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (PostgreSQL is the only import target)");
const result = spawnSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);

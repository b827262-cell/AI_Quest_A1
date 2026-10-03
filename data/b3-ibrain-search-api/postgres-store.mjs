// B3 read-only B2 store.
//
// This module is the ONLY place that touches the B2 database. It issues
// read-only SELECTs against `public.exam_courses` and shells out to `psql`,
// matching how the B2 importer (`data/b2-ibrain-postgresql/import-b1-snapshot.mjs`)
// reaches PostgreSQL — no new runtime dependency is introduced.
//
// Safety properties:
//   - Every statement is a single SELECT over `public.exam_courses`; there is
//     no INSERT/UPDATE/DELETE/DDL and no dynamic SQL construction.
//   - Caller values are passed as psql variables and rendered with `:'name'`
//     (psql quotes them as SQL string literals), so values cannot break out of
//     their literal. `limit`/`exam_year` are additionally validated upstream.
//   - The result set is serialized to JSON by PostgreSQL itself, so course
//     content with tabs/newlines/commas cannot corrupt parsing.

import { spawnSync } from "node:child_process";

const SELECT_COLUMNS = "exam_year, course_code, course_name, course_content, source_url";

// Mirrors the B2 query contract `course_code exact (case-insensitive)`.
export const EXACT_SQL = `
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT ${SELECT_COLUMNS}
  FROM public.exam_courses
  WHERE lower(course_code) = lower(:'course_code')
    AND (NULLIF(:'exam_year', '')::smallint IS NULL OR exam_year = NULLIF(:'exam_year', '')::smallint)
  ORDER BY exam_year DESC, course_name
  LIMIT :'limit'::int
) t;
`;

// Mirrors the B2 query contract `course_name/course_content keyword match`.
export const KEYWORD_SQL = `
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT ${SELECT_COLUMNS}
  FROM public.exam_courses
  WHERE (NULLIF(:'exam_year', '')::smallint IS NULL OR exam_year = NULLIF(:'exam_year', '')::smallint)
    AND (
      course_name ILIKE '%' || :'keyword' || '%'
      OR course_content ILIKE '%' || :'keyword' || '%'
      OR to_tsvector('simple', course_name || ' ' || course_content)
         @@ websearch_to_tsquery('simple', :'keyword')
    )
  ORDER BY exam_year DESC, course_name
  LIMIT :'limit'::int
) t;
`;

/** Parses the JSON text emitted by psql (`-t -A`) into an array of rows. */
export function parsePsqlJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`B2 store returned non-JSON output: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("B2 store returned a non-array JSON payload");
  }
  return parsed;
}

function psqlArgs(connectionString, vars, sql) {
  const args = [connectionString, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(vars)) {
    args.push("-v", `${name}=${value ?? ""}`);
  }
  args.push("-c", sql);
  return args;
}

/**
 * Builds a read-only B2 store backed by `psql`.
 * @param {{ connectionString?: string, psqlPath?: string, timeoutMs?: number, spawn?: Function }} options
 */
export function createPostgresStore(options = {}) {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("B2 store requires a PostgreSQL connection string (DATABASE_URL)");
  }
  const psqlPath = options.psqlPath ?? process.env.B3_PSQL_PATH ?? "psql";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const spawner = options.spawn ?? spawnSync;

  function run(sql, vars) {
    const result = spawner(psqlPath, psqlArgs(connectionString, vars, sql), {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result?.error) {
      throw new Error(`B2 store unavailable: ${result.error.message}`);
    }
    if (result?.status !== 0) {
      const detail = String(result?.stderr ?? "").trim().split("\n").slice(-3).join(" ");
      throw new Error(`B2 store query failed (exit ${result?.status}): ${detail}`);
    }
    return parsePsqlJson(result.stdout);
  }

  return {
    kind: "postgres",
    async exact({ examYear = null, courseCode, limit }) {
      return run(EXACT_SQL, { exam_year: examYear ?? "", course_code: courseCode, limit });
    },
    async keyword({ examYear = null, keyword, limit }) {
      return run(KEYWORD_SQL, { exam_year: examYear ?? "", keyword, limit });
    },
  };
}

// B3 read-only store backed by the validated B1 JSON snapshot.
//
// A drop-in alternative to `postgres-store.mjs` for deployments without a B2
// PostgreSQL database. Rows are loaded once through the same validator the B2
// importer uses (`loadValidatedB1Snapshot`), so the store serves exactly what
// a live import would have written: the importer stores `teacher` and
// `applicable_scope` as NULL, and so does this store.
//
// Matching mirrors the SQL in postgres-store.mjs:
//   exact   -> lower(course_code) = lower(:course_code)
//   keyword -> course_name/course_content ILIKE %kw%, or every whitespace term
//              of the keyword appears in name+content (the substring analogue
//              of websearch_to_tsquery('simple', kw) over the same text)
//   teacher -> teacher ILIKE %kw%
//   scope   -> applicable_scope ILIKE %kw%
// All filter by optional exam_year, order by exam_year DESC then course_name,
// and apply limit.

import { loadValidatedB1Snapshot } from "../b2-ibrain-postgresql/validate-snapshot.mjs";
import { SearchInputError } from "./search-core.mjs";

const COLUMNS = ["exam_year", "course_code", "course_name", "course_content", "teacher", "applicable_scope", "source_url"];

function project(row) {
  const out = {};
  for (const column of COLUMNS) out[column] = row[column] ?? null;
  return out;
}

function contains(haystack, needle) {
  return typeof haystack === "string" && haystack.toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Builds a store over in-memory rows (already validated).
 * @param {{ rows: Array<Record<string, unknown>> }} options
 */
export function createSnapshotStore({ rows }) {
  if (!Array.isArray(rows)) throw new Error("snapshot store requires an array of rows");
  const table = rows.map(project);

  function select(examYear, predicate, limit) {
    const year = examYear == null || examYear === "" ? null : Number(examYear);
    return table
      .filter((row) => (year === null || row.exam_year === year) && predicate(row))
      .sort((a, b) => b.exam_year - a.exam_year || (a.course_name < b.course_name ? -1 : a.course_name > b.course_name ? 1 : 0))
      .slice(0, Number(limit))
      .map((row) => ({ ...row }));
  }

  return {
    kind: "snapshot",
    async exact({ examYear = null, courseCode, limit }) {
      const code = String(courseCode).toLowerCase();
      return select(examYear, (row) => String(row.course_code).toLowerCase() === code, limit);
    },
    async keyword({ examYear = null, keyword, limit }) {
      // Option (b): fail explicitly rather than silently treating websearch
      // operators as literal AND terms. PostgreSQL mode still supports them.
      if (/"|(?:^|\s)OR(?:\s|$)|(?:^|\s)-/i.test(String(keyword))) {
        throw new SearchInputError(
          "unsupported_snapshot_query",
          "Snapshot keyword search supports plain words only; OR, quoted phrases, and negation (-term) are unsupported. Use PostgreSQL mode for websearch syntax.",
        );
      }
      const terms = String(keyword).trim().split(/\s+/).filter(Boolean);
      return select(examYear, (row) => {
        if (contains(row.course_name, keyword) || contains(row.course_content, keyword)) return true;
        const text = `${row.course_name ?? ""} ${row.course_content ?? ""}`;
        return terms.length > 0 && terms.every((term) => contains(text, term));
      }, limit);
    },
    async teacher({ examYear = null, keyword, limit }) {
      return select(examYear, (row) => contains(row.teacher, keyword), limit);
    },
    async scope({ examYear = null, keyword, limit }) {
      return select(examYear, (row) => contains(row.applicable_scope, keyword), limit);
    },
  };
}

/**
 * Loads and validates the B1 snapshot, then builds the store. Paths default to
 * the repository-relative ones used by the B2 importer.
 */
export async function loadSnapshotStore({ snapshotPath, manifestPath } = {}) {
  const options = {};
  if (snapshotPath) options.snapshotPath = snapshotPath;
  if (manifestPath) options.manifestPath = manifestPath;
  const { rows } = await loadValidatedB1Snapshot(options);
  return createSnapshotStore({ rows });
}

// B3 Search API core: transport-agnostic query validation, mode selection,
// and result shaping over the B2 read-only store.
//
// The core never touches the network and never crawls: it only reads whatever
// rows the injected B2 store returns (PostgreSQL `public.exam_courses`). It is
// the single place that enforces the B3 output contract:
//   - exactly the five public fields are returned;
//   - `source_url` may only point at the approved host `ec.ibrain.com.tw`.

export const ALLOWED_EXAM_YEARS = Object.freeze([115, 116]);
export const ALLOWED_SOURCE_HOSTS = Object.freeze(["ec.ibrain.com.tw"]);
export const ALLOWED_SOURCE_PROTOCOLS = Object.freeze(["http:", "https:"]);
export const RESULT_FIELDS = Object.freeze([
  "exam_year",
  "course_code",
  "course_name",
  "course_content",
  "source_url",
]);
export const SEARCH_MODES = Object.freeze(["course_code", "keyword"]);
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_TERM_LENGTH = 200;

/** Rejects malformed caller input. Maps to HTTP 400. */
export class SearchInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SearchInputError";
    this.code = code;
    this.status = 400;
  }
}

/** Rejects rows that violate the B2 output contract. Maps to HTTP 502. */
export class SearchDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SearchDataError";
    this.code = code;
    this.status = 502;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeTerm(raw, field) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new SearchInputError("invalid_request", `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_TERM_LENGTH) {
    throw new SearchInputError("invalid_request", `${field} exceeds ${MAX_TERM_LENGTH} characters`);
  }
  return trimmed;
}

function normalizeExamYear(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const text = String(raw).trim();
  const year = Number(text);
  if (!Number.isInteger(year) || !ALLOWED_EXAM_YEARS.includes(year)) {
    throw new SearchInputError(
      "invalid_exam_year",
      `exam_year must be one of ${ALLOWED_EXAM_YEARS.join(", ")}`,
    );
  }
  return year;
}

function normalizeLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new SearchInputError("invalid_limit", "limit must be a positive integer");
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new SearchInputError("invalid_limit", `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Validates raw caller input and resolves it into exactly one search mode.
 * Accepts a plain record of raw string values (e.g. URL query params).
 */
export function parseSearchParams(input = {}) {
  const examYear = normalizeExamYear(input.exam_year);
  const courseCode = normalizeTerm(input.course_code, "course_code");
  const keyword = normalizeTerm(firstDefined(input.keyword, input.q), "keyword");
  const limit = normalizeLimit(input.limit);

  if (courseCode && keyword) {
    throw new SearchInputError(
      "ambiguous_query",
      "provide either course_code (exact) or keyword (name/content), not both",
    );
  }
  if (!courseCode && !keyword) {
    throw new SearchInputError("missing_query", "provide course_code or keyword");
  }

  const mode = courseCode ? "course_code" : "keyword";
  return { mode, examYear, courseCode, keyword, limit };
}

function assertSourceUrl(sourceUrl, index) {
  if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} is missing source_url`);
  }
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} has an unparseable source_url`);
  }
  if (!ALLOWED_SOURCE_PROTOCOLS.includes(parsed.protocol)) {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} has a non-http source_url`);
  }
  if (!ALLOWED_SOURCE_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new SearchDataError(
      "b2_data_integrity_error",
      `row ${index} source_url host is not in the approved allowlist`,
    );
  }
}

/** Maps one B2 row to the five public fields, enforcing the host allowlist. */
export function buildResultRow(row, index = 0) {
  if (!row || typeof row !== "object") {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} is not an object`);
  }
  if (!ALLOWED_EXAM_YEARS.includes(row.exam_year)) {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} has an invalid exam_year`);
  }
  for (const field of ["course_code", "course_name", "course_content"]) {
    if (typeof row[field] !== "string") {
      throw new SearchDataError("b2_data_integrity_error", `row ${index} has a non-string ${field}`);
    }
  }
  if (row.course_code.trim() === "" || row.course_name.trim() === "") {
    throw new SearchDataError("b2_data_integrity_error", `row ${index} has an empty course identifier`);
  }
  assertSourceUrl(row.source_url, index);

  // Explicit allowlist: never leak id/content_hash/fetched_at/category/etc.
  return {
    exam_year: row.exam_year,
    course_code: row.course_code,
    course_name: row.course_name,
    course_content: row.course_content,
    source_url: row.source_url,
  };
}

/**
 * Runs a validated search against a B2 store.
 * @param {{ exact: Function, keyword: Function }} store
 * @param {object} input raw query values
 */
export async function searchCourses(store, input = {}) {
  if (!store || typeof store.exact !== "function" || typeof store.keyword !== "function") {
    throw new TypeError("a B2 store with exact() and keyword() is required");
  }
  const params = parseSearchParams(input);

  const rows =
    params.mode === "course_code"
      ? await store.exact({ examYear: params.examYear, courseCode: params.courseCode, limit: params.limit })
      : await store.keyword({ examYear: params.examYear, keyword: params.keyword, limit: params.limit });

  if (!Array.isArray(rows)) {
    throw new SearchDataError("b2_data_integrity_error", "store did not return an array of rows");
  }

  const results = rows.map((row, index) => buildResultRow(row, index));
  return {
    mode: params.mode,
    query: {
      exam_year: params.examYear,
      course_code: params.courseCode,
      keyword: params.keyword,
      limit: params.limit,
    },
    count: results.length,
    results,
  };
}

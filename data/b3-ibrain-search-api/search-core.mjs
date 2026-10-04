// B3 Search API core: transport-agnostic query validation, mode selection,
// and result shaping over the B2 read-only store.
//
// The core never touches the network and never crawls: it only reads whatever
// rows the injected B2 store returns (PostgreSQL `public.exam_courses`). It is
// the single place that enforces the B3 output contract:
//   - exactly the five public fields are returned;
//   - `source_url` may only point at the approved host `ec.ibrain.com.tw`.

import { resolvePublicSourceUrl } from "./public-source-url.mjs";

export const ALLOWED_EXAM_YEARS = Object.freeze([115, 116]);
export const ALLOWED_SOURCE_HOSTS = Object.freeze(["ec.ibrain.com.tw"]);
export const ALLOWED_SOURCE_PROTOCOLS = Object.freeze(["http:", "https:"]);
export const RESULT_FIELDS = Object.freeze([
  "exam_year",
  "course_code",
  "course_name",
  "course_content",
  "source_url",
  "teacher",
  "applicable_scope",
  "source_search_mode",
  "matched_field",
]);
export const SEARCH_MODES = Object.freeze([
  "product_name",
  "product_code",
  "teacher",
  "scope",
  "course_code",
  "keyword",
]);
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
  const limit = normalizeLimit(input.limit);

  const requestedMode = normalizeTerm(input.search_mode ?? input.mode, "search_mode");
  const courseCode = normalizeTerm(input.course_code, "course_code");
  const teacher = normalizeTerm(firstDefined(input.teacher, input.instructor), "teacher");
  const scope = normalizeTerm(firstDefined(input.scope, input.applicable_scope), "scope");
  const genericKeyword = normalizeTerm(firstDefined(input.keyword, input.q), "keyword");

  let mode = requestedMode;
  let term = genericKeyword;

  if (mode) {
    if (!SEARCH_MODES.includes(mode)) {
      throw new SearchInputError(
        "invalid_search_mode",
        `search_mode must be one of ${SEARCH_MODES.join(", ")}`,
      );
    }

    if (mode === "course_code" || mode === "product_code") {
      term = firstDefined(courseCode, genericKeyword);
    } else if (mode === "teacher") {
      term = firstDefined(teacher, genericKeyword);
    } else if (mode === "scope") {
      term = firstDefined(scope, genericKeyword);
    } else {
      term = genericKeyword;
    }

    if (!term) {
      throw new SearchInputError("missing_query", `provide keyword for search_mode ${mode}`);
    }
  } else {
    // Legacy dual-mode inference
    if (courseCode && genericKeyword) {
      throw new SearchInputError(
        "ambiguous_query",
        "provide either course_code (exact) or keyword (name/content), not both",
      );
    }
    if (!courseCode && !genericKeyword && !teacher && !scope) {
      throw new SearchInputError("missing_query", "provide course_code or keyword");
    }

    if (courseCode) {
      mode = "course_code";
      term = courseCode;
    } else if (teacher) {
      mode = "teacher";
      term = teacher;
    } else if (scope) {
      mode = "scope";
      term = scope;
    } else {
      mode = "keyword";
      term = genericKeyword;
    }
  }

  const isCodeMode = mode === "course_code" || mode === "product_code";
  const parsed = {
    mode,
    examYear,
    courseCode: isCodeMode ? term : null,
    keyword: isCodeMode ? null : term,
    limit,
  };
  if (mode === "teacher") parsed.teacher = term;
  if (mode === "scope") parsed.scope = term;
  return parsed;
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
  if (parsed.pathname === "" || parsed.pathname === "/") {
    throw new SearchDataError(
      "b2_data_integrity_error",
      `row ${index} source_url is a bare homepage`,
    );
  }
}

/** Maps one B2 row to the five public fields, enforcing the host allowlist. */
export function buildResultRow(row, index = 0, source = {}) {
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
  const sourceUrl = resolvePublicSourceUrl({
    exactUrl: row.source_url,
    mode: source.mode,
    keyword: source.keyword,
  });

  // Explicit allowlist: never leak id/content_hash/fetched_at/category/etc.
  const result = {
    exam_year: row.exam_year,
    course_code: row.course_code,
    course_name: row.course_name,
    course_content: row.course_content,
    // null explicitly means the source has no trustworthy exact/deep URL.
    source_url: sourceUrl,
    source_search_mode: source.mode,
    matched_field: source.matchedField,
  };
  result.teacher = row.teacher ?? row.instructor ?? null;
  result.applicable_scope = row.applicable_scope ?? null;
  return result;
}

/**
 * Runs a validated search against a B2 store.
 * @param {{ exact: Function, keyword: Function, prefix?: Function, teacher?: Function, scope?: Function }} store
 * @param {object} input raw query values
 */
export async function searchCourses(store, input = {}) {
  if (!store || typeof store.exact !== "function" || typeof store.keyword !== "function") {
    throw new TypeError("a B2 store with exact() and keyword() is required");
  }
  const params = parseSearchParams(input);

  let rows;
  if (params.mode === "course_code" || params.mode === "product_code") {
    rows = await store.exact({ examYear: params.examYear, courseCode: params.courseCode, limit: params.limit });
    if ((!rows || rows.length === 0) && typeof store.prefix === "function") {
      rows = await store.prefix({ examYear: params.examYear, courseCode: params.courseCode, limit: params.limit });
    }
  } else if (params.mode === "teacher") {
    if (typeof store.teacher !== "function") {
      throw new TypeError("store.teacher is required for teacher mode");
    }
    rows = await store.teacher({ examYear: params.examYear, keyword: params.keyword, limit: params.limit });
  } else if (params.mode === "scope") {
    if (typeof store.scope !== "function") {
      throw new TypeError("store.scope is required for scope mode");
    }
    rows = await store.scope({ examYear: params.examYear, keyword: params.keyword, limit: params.limit });
  } else {
    rows = await store.keyword({ examYear: params.examYear, keyword: params.keyword, limit: params.limit });
  }

  if (!Array.isArray(rows)) {
    throw new SearchDataError("b2_data_integrity_error", "store did not return an array of rows");
  }

  const matchedField = params.mode === "teacher" ? "師資"
    : params.mode === "scope" ? "適用範圍"
      : params.mode === "course_code" || params.mode === "product_code" ? "品號"
        : "品名";
  const sourceMode = params.mode === "course_code" ? "product_code"
    : params.mode === "keyword" ? "product_name" : params.mode;
  const sourceKeyword = params.courseCode ?? params.keyword;
  const results = rows.map((row, index) => buildResultRow(row, index, {
    mode: sourceMode,
    keyword: sourceKeyword,
    matchedField,
  }));
  const query = {
    exam_year: params.examYear,
    course_code: params.courseCode,
    keyword: params.keyword,
    limit: params.limit,
  };
  if (params.teacher) query.teacher = params.teacher;
  if (params.scope) query.scope = params.scope;

  return {
    mode: params.mode,
    query,
    count: results.length,
    results,
  };
}

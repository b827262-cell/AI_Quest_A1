import { chunkExamCourseRows, escapeIlikePattern, type ExamSqlStatement, type SqlExecutor } from "./sql";

/**
 * Column order mirrors the `record_contract` of the B1 crawl manifest verbatim,
 * and `snapshot-validation.test.ts` asserts it against the manifest itself, so
 * the snapshot, this repository and the PostgreSQL table cannot drift into three
 * different vocabularies for one course row.
 */
export const EXAM_COURSE_RECORD_COLUMNS = [
  "exam_year",
  "category",
  "course_code",
  "course_name",
  "course_content",
  "source_url",
  "fetched_at",
  "content_hash"
] as const;

export const EXAM_COURSE_SEARCH_COLUMNS = [
  "exam_year",
  "course_code",
  "course_name",
  "course_content",
  "source_url"
] as const;

/**
 * Kept as a constant so the migration's functional GIN expression and the query
 * expression are asserted to be identical (a mismatch silently degrades the
 * search to a sequential scan).
 */
export const EXAM_COURSE_FULL_TEXT_EXPRESSION =
  "to_tsvector('simple', course_name || ' ' || course_content)";

export const EXAM_COURSE_SEARCH_DEFAULT_LIMIT = 20;
export const EXAM_COURSE_SEARCH_MAX_LIMIT = 100;
export const EXAM_COURSE_UPSERT_CHUNK_SIZE = 200;
export const EXAM_COURSE_YEARS = [115, 116] as const;

export interface ExamCourseRecord {
  exam_year: number;
  category: string;
  course_code: string;
  course_name: string;
  course_content: string;
  source_url: string;
  /** ISO-8601 string; cast to timestamptz in SQL rather than relying on driver date coercion. */
  fetched_at: string;
  content_hash: string;
}

export interface ExamCourseSearchQuery {
  exam_year?: number;
  category?: string;
  course_code?: string;
  keyword?: string;
  limit?: number;
}

export interface ExamCourseSearchResult {
  exam_year: number;
  course_code: string;
  course_name: string;
  course_content: string;
  source_url: string;
}

/** The natural key of the table: same course code, same exam year is one row. */
export function examCourseKey(row: { exam_year: unknown; course_code: unknown }): string {
  return `${String(row.exam_year)}:${String(row.course_code)}`;
}

export interface UpsertExamCourseOutcomeRow {
  exam_year: unknown;
  course_code: unknown;
  is_insert: unknown;
}

export interface ExamCourseUpsertResult {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  inserted_keys: string[];
  updated_keys: string[];
  unchanged_keys: string[];
}

function assertExamCourseRecord(record: ExamCourseRecord, index: number): void {
  if (!Number.isInteger(record.exam_year)) {
    throw new Error(`exam_course row ${index}: exam_year must be an integer`);
  }
  for (const column of EXAM_COURSE_RECORD_COLUMNS) {
    if (column === "exam_year") continue;
    if (typeof record[column] !== "string" || record[column].length === 0) {
      throw new Error(`exam_course row ${index}: ${column} must be a non-empty string`);
    }
  }
}

/**
 * One multi-row statement per chunk.
 *
 * `xmax = 0` is the standard PostgreSQL discriminator for "this RETURNING row
 * came from the INSERT branch rather than the DO UPDATE branch"; it is only
 * meaningful under the default READ COMMITTED isolation level, which is what the
 * importer runs with.
 *
 * Rows whose content_hash already matches are excluded by the DO UPDATE WHERE
 * clause, so they are *not returned at all* — that absence is what
 * `classifyExamCourseUpsert` reports as `unchanged`, and it is why a re-run of
 * an identical snapshot performs no writes.
 */
export function buildExamCourseUpsert(records: readonly ExamCourseRecord[]): ExamSqlStatement {
  if (records.length === 0) {
    throw new Error("buildExamCourseUpsert requires at least one record");
  }
  const params: unknown[] = [];
  const valueTuples = records.map((record, index) => {
    assertExamCourseRecord(record, index);
    const base = params.length;
    params.push(
      record.exam_year,
      record.category,
      record.course_code,
      record.course_name,
      record.course_content,
      record.source_url,
      record.fetched_at,
      record.content_hash
    );
    return `($${base + 1}::smallint, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::timestamptz, $${base + 8})`;
  });

  const text = [
    `INSERT INTO exam_courses (${EXAM_COURSE_RECORD_COLUMNS.join(", ")})`,
    `VALUES ${valueTuples.join(",\n       ")}`,
    "ON CONFLICT (exam_year, course_code) DO UPDATE SET",
    "  category = EXCLUDED.category,",
    "  course_name = EXCLUDED.course_name,",
    "  course_content = EXCLUDED.course_content,",
    "  source_url = EXCLUDED.source_url,",
    "  content_hash = EXCLUDED.content_hash,",
    "  fetched_at = EXCLUDED.fetched_at,",
    "  revision = exam_courses.revision + 1,",
    "  updated_at = now()",
    "WHERE exam_courses.content_hash IS DISTINCT FROM EXCLUDED.content_hash",
    "RETURNING exam_courses.exam_year, exam_courses.course_code, (xmax = 0) AS is_insert"
  ].join("\n");

  return { text, params };
}

export function classifyExamCourseUpsert(
  records: readonly ExamCourseRecord[],
  outcomeRows: readonly UpsertExamCourseOutcomeRow[]
): ExamCourseUpsertResult {
  const written = new Map<string, boolean>();
  for (const row of outcomeRows) {
    written.set(examCourseKey(row), row.is_insert === true);
  }

  const result: ExamCourseUpsertResult = {
    total: records.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    inserted_keys: [],
    updated_keys: [],
    unchanged_keys: []
  };

  for (const record of records) {
    const key = examCourseKey(record);
    if (!written.has(key)) {
      result.unchanged += 1;
      result.unchanged_keys.push(key);
    } else if (written.get(key)) {
      result.inserted += 1;
      result.inserted_keys.push(key);
    } else {
      result.updated += 1;
      result.updated_keys.push(key);
    }
  }

  return result;
}

export async function upsertExamCourses(
  executor: SqlExecutor,
  records: readonly ExamCourseRecord[],
  options: { chunkSize?: number } = {}
): Promise<ExamCourseUpsertResult> {
  const chunkSize = options.chunkSize ?? EXAM_COURSE_UPSERT_CHUNK_SIZE;
  const aggregate: ExamCourseUpsertResult = {
    total: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    inserted_keys: [],
    updated_keys: [],
    unchanged_keys: []
  };

  for (const chunk of chunkExamCourseRows(records, chunkSize)) {
    const statement = buildExamCourseUpsert(chunk);
    const result = await executor.query(statement.text, statement.params);
    const classified = classifyExamCourseUpsert(
      chunk,
      result.rows.map(({ exam_year, course_code, is_insert }) => ({
        exam_year,
        course_code,
        is_insert
      }))
    );
    aggregate.total += classified.total;
    aggregate.inserted += classified.inserted;
    aggregate.updated += classified.updated;
    aggregate.unchanged += classified.unchanged;
    aggregate.inserted_keys.push(...classified.inserted_keys);
    aggregate.updated_keys.push(...classified.updated_keys);
    aggregate.unchanged_keys.push(...classified.unchanged_keys);
  }

  return aggregate;
}

function resolveExamCourseLimit(limit: number | undefined): number {
  if (limit === undefined) return EXAM_COURSE_SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > EXAM_COURSE_SEARCH_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${EXAM_COURSE_SEARCH_MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Predicate shared by the search and count builders so the reported total can
 * never describe a different row set from the returned page.
 */
function buildExamCourseSearchPredicate(query: ExamCourseSearchQuery): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.exam_year !== undefined) {
    params.push(query.exam_year);
    clauses.push(`exam_year = $${params.length}::smallint`);
  }
  if (query.category !== undefined) {
    params.push(query.category.trim());
    clauses.push(`category = $${params.length}`);
  }
  if (query.course_code !== undefined) {
    // `upper()` wraps the parameter, never the column, so the equality stays
    // directly comparable against the (exam_year, course_code) primary key while
    // still matching the contract's case-insensitive identifier semantics. The
    // table CHECK keeps stored codes uppercase for this to hold.
    params.push(query.course_code.trim().toUpperCase());
    clauses.push(`course_code = $${params.length}`);
  }
  if (query.keyword !== undefined && query.keyword.trim().length > 0) {
    const keyword = query.keyword.trim();
    params.push(`%${escapeIlikePattern(keyword)}%`);
    const patternIndex = params.length;
    params.push(keyword);
    const termIndex = params.length;
    clauses.push(
      `(course_name ILIKE $${patternIndex} OR course_content ILIKE $${patternIndex} OR ` +
        `${EXAM_COURSE_FULL_TEXT_EXPRESSION} @@ plainto_tsquery('simple', $${termIndex}))`
    );
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join("\n  AND ")}` : "",
    params
  };
}

export function buildExamCourseSearch(query: ExamCourseSearchQuery): ExamSqlStatement {
  const predicate = buildExamCourseSearchPredicate(query);
  const params = [...predicate.params, resolveExamCourseLimit(query.limit)];
  const text = [
    `SELECT ${EXAM_COURSE_SEARCH_COLUMNS.join(", ")}`,
    "FROM exam_courses",
    predicate.whereSql,
    // Deterministic ordering: paging must not reshuffle between requests.
    "ORDER BY exam_year DESC, course_code ASC",
    `LIMIT $${params.length}::int`
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  return { text, params };
}

export function buildExamCourseSearchCount(query: ExamCourseSearchQuery): ExamSqlStatement {
  const predicate = buildExamCourseSearchPredicate(query);
  const text = ["SELECT count(*) AS total", "FROM exam_courses", predicate.whereSql]
    .filter((line) => line.length > 0)
    .join("\n");
  return { text, params: predicate.params };
}

export function mapExamCourseSearchRow(row: Record<string, unknown>): ExamCourseSearchResult {
  return {
    // count(*)/bigint arrives as a string over the wire; smallint arrives as a number.
    exam_year: Number(row.exam_year),
    course_code: String(row.course_code),
    course_name: String(row.course_name),
    course_content: String(row.course_content),
    source_url: String(row.source_url)
  };
}

export async function searchExamCourses(
  executor: SqlExecutor,
  query: ExamCourseSearchQuery
): Promise<ExamCourseSearchResult[]> {
  const statement = buildExamCourseSearch(query);
  const result = await executor.query(statement.text, statement.params);
  return result.rows.map(mapExamCourseSearchRow);
}

export async function countExamCourses(
  executor: SqlExecutor,
  query: ExamCourseSearchQuery
): Promise<number> {
  const statement = buildExamCourseSearchCount(query);
  const result = await executor.query(statement.text, statement.params);
  const first = result.rows[0]?.total;
  return first === undefined ? 0 : Number(first);
}

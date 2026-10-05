import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ALLOWED_SOURCE_HOSTS,
  MAX_LIMIT,
  RESULT_FIELDS,
  SearchDataError,
  SearchInputError,
  buildResultRow,
  parseSearchParams,
  searchCourses,
} from "./search-core.mjs";
import {
  EXACT_SQL,
  KEYWORD_SQL,
  SCOPE_SQL,
  TEACHER_SQL,
  createPostgresStore,
  parsePsqlJson,
} from "./postgres-store.mjs";
import { createSearchServer } from "./search-server.mjs";
import {
  buildStableSearchUrl,
  encodeBig5Percent,
  normalizeExactProductUrl,
  resolvePublicSourceUrl,
} from "./public-source-url.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const ALLOWED_URL_HTTP = "http://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18064";
const ALLOWED_URL_HTTPS = "https://ec.ibrain.com.tw/publish/www/book.asp?bkid=18142";

function b2Row(overrides = {}) {
  return {
    exam_year: 116,
    course_code: "IPPP3727011",
    course_name: "116高上 普考 一般民政 全修課程",
    course_content: "適用116與117年高普考及一般民政類考試。",
    source_url: ALLOWED_URL_HTTPS,
    // Fields that must never leak into the response:
    id: 1,
    category: "高普考",
    content_hash: "a".repeat(64),
    fetched_at: "2026-10-03T14:42:59Z",
    ...overrides,
  };
}

function fakeStore(rows = [b2Row()], capture = {}) {
  return {
    kind: "fake",
    async exact(params) {
      capture.exact = params;
      return rows;
    },
    async keyword(params) {
      capture.keyword = params;
      return rows;
    },
  };
}

async function withServer(store, fn) {
  const server = createSearchServer({ store });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((res) => server.close(res));
  }
}

// ---------------------------------------------------------------------------
// core: mode selection & input validation
// ---------------------------------------------------------------------------

test("course_code exact mode is selected and normalized", () => {
  const params = parseSearchParams({ course_code: "  IPKKW126262 ", exam_year: "115", limit: "5" });
  assert.deepEqual(params, {
    mode: "course_code",
    examYear: 115,
    courseCode: "IPKKW126262",
    keyword: null,
    limit: 5,
  });
});

test("keyword mode accepts both `keyword` and `q`", () => {
  assert.equal(parseSearchParams({ keyword: "統計" }).mode, "keyword");
  assert.equal(parseSearchParams({ q: "統計" }).mode, "keyword");
  assert.equal(parseSearchParams({ q: "統計" }).keyword, "統計");
});

test("exam_year is limited to 115/116", () => {
  assert.equal(parseSearchParams({ course_code: "X", exam_year: "116" }).examYear, 116);
  assert.equal(parseSearchParams({ course_code: "X" }).examYear, null);
  for (const bad of ["114", "117", "0", "abc", "1.5"]) {
    assert.throws(
      () => parseSearchParams({ course_code: "X", exam_year: bad }),
      (error) => error instanceof SearchInputError && error.code === "invalid_exam_year",
      `exam_year=${bad} must be rejected`,
    );
  }
});

test("ambiguous and missing queries fail closed", () => {
  assert.throws(
    () => parseSearchParams({ course_code: "X", keyword: "Y" }),
    (error) => error instanceof SearchInputError && error.code === "ambiguous_query",
  );
  assert.throws(
    () => parseSearchParams({}),
    (error) => error instanceof SearchInputError && error.code === "missing_query",
  );
});

test("limit defaults to 20 and is bounded to 1..100", () => {
  assert.equal(parseSearchParams({ course_code: "X" }).limit, 20);
  assert.equal(parseSearchParams({ course_code: "X", limit: String(MAX_LIMIT) }).limit, MAX_LIMIT);
  for (const bad of ["0", "101", "-3", "abc", "1.5"]) {
    assert.throws(
      () => parseSearchParams({ course_code: "X", limit: bad }),
      (error) => error instanceof SearchInputError && error.code === "invalid_limit",
    );
  }
});

// ---------------------------------------------------------------------------
// core: result shaping, field allowlist, source host allowlist
// ---------------------------------------------------------------------------

test("only the five public fields are returned", () => {
  const row = buildResultRow(b2Row(), 0);
  assert.deepEqual(Object.keys(row).sort(), [...RESULT_FIELDS].sort());
  assert.equal("id" in row, false);
  assert.equal("content_hash" in row, false);
  assert.equal("category" in row, false);
});

test("source host allowlist accepts http and https on ec.ibrain.com.tw", () => {
  assert.ok(ALLOWED_SOURCE_HOSTS.includes("ec.ibrain.com.tw"));
  assert.doesNotThrow(() => buildResultRow(b2Row({ source_url: ALLOWED_URL_HTTP }), 0));
  assert.doesNotThrow(() => buildResultRow(b2Row({ source_url: ALLOWED_URL_HTTPS }), 0));
  assert.doesNotThrow(() =>
    buildResultRow(b2Row({ source_url: "https://EC.IBRAIN.COM.TW/x" }), 0),
  );
});

test("source host allowlist rejects any other host or scheme", () => {
  for (const bad of [
    "https://evil.example.com/x",
    "https://ec.ibrain.com.tw.evil.com/x",
    "ftp://ec.ibrain.com.tw/x",
    "not-a-url",
    "",
  ]) {
    assert.throws(
      () => buildResultRow(b2Row({ source_url: bad }), 0),
      (error) => error instanceof SearchDataError && error.code === "b2_data_integrity_error",
      `source_url=${bad} must be rejected`,
    );
  }
});

test("rows with an invalid exam_year are rejected fail-closed", () => {
  assert.throws(
    () => buildResultRow(b2Row({ exam_year: 117 }), 0),
    (error) => error instanceof SearchDataError,
  );
});

test("searchCourses returns shaped rows and records the query", async () => {
  const capture = {};
  const result = await searchCourses(fakeStore([b2Row()], capture), {
    course_code: "IPPP3727011",
    exam_year: "116",
  });
  assert.equal(result.mode, "course_code");
  assert.equal(result.count, 1);
  assert.deepEqual(result.query, {
    exam_year: 116,
    course_code: "IPPP3727011",
    keyword: null,
    limit: 20,
  });
  assert.deepEqual(capture.exact, { examYear: 116, courseCode: "IPPP3727011", limit: 20 });
  assert.deepEqual(Object.keys(result.results[0]).sort(), [...RESULT_FIELDS].sort());
});

test("searchCourses routes keyword queries to the keyword store method", async () => {
  const capture = {};
  await searchCourses(fakeStore([b2Row()], capture), { q: "民政" });
  assert.deepEqual(capture.keyword, { examYear: null, keyword: "民政", limit: 20 });
  assert.equal(capture.exact, undefined);
});

test("searchCourses fails closed when the store leaks a disallowed host", async () => {
  await assert.rejects(
    searchCourses(fakeStore([b2Row({ source_url: "https://evil.example.com/x" })]), { q: "x" }),
    (error) => error instanceof SearchDataError,
  );
});

test("searchCourses fails closed when the store leaks a bare homepage URL", async () => {
  await assert.rejects(
    searchCourses(fakeStore([b2Row({ source_url: "https://ec.ibrain.com.tw/" })]), { q: "x" }),
    (error) => error instanceof SearchDataError && /bare homepage/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// postgres store: read-only SQL and psql wiring
// ---------------------------------------------------------------------------

test("B3 SQL is read-only and uses psql literal quoting for text values", () => {
  for (const sql of [EXACT_SQL, KEYWORD_SQL, TEACHER_SQL, SCOPE_SQL]) {
    assert.match(sql, /^\s*SELECT /);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|CREATE)\b/i);
    assert.doesNotMatch(sql, /\$[0-9]/); // never raw $1 placeholders
    assert.match(sql, /FROM public\.exam_courses/);
    assert.match(sql, /json_agg/);
  }
  assert.match(EXACT_SQL, /lower\(course_code\) = lower\(:'course_code'\)/);
  assert.match(KEYWORD_SQL, /course_name ILIKE '%' \|\| :'keyword' \|\| '%'/);
  assert.match(KEYWORD_SQL, /course_content ILIKE '%' \|\| :'keyword' \|\| '%'/);
  assert.match(KEYWORD_SQL, /websearch_to_tsquery\('simple', :'keyword'\)/);
  assert.match(TEACHER_SQL, /teacher ILIKE '%' \|\| :'keyword' \|\| '%'/);
  assert.match(SCOPE_SQL, /applicable_scope ILIKE '%' \|\| :'keyword' \|\| '%'/);
  assert.match(EXACT_SQL, /NULLIF\(:'exam_year', ''\)::smallint/);
});

test("createPostgresStore dispatches all modes through stdin to their real B2 SQL", async () => {
  const calls = [];
  const store = createPostgresStore({
    connectionString: "postgres://b2.example/db",
    spawn(_cmd, args, options) {
      calls.push({ args, options });
      return { status: 0, stdout: JSON.stringify([b2Row()]), stderr: "" };
    },
  });

  const exactRows = await store.exact({ examYear: 115, courseCode: "IPKKW126262", limit: 6 });
  const keywordRows = await store.keyword({ examYear: 116, keyword: "民政", limit: 9 });
  const teacherRows = await store.teacher({ examYear: 115, keyword: "宗台大", limit: 7 });
  const scopeRows = await store.scope({ examYear: 116, keyword: "法研所", limit: 8 });

  assert.equal(exactRows.length, 1);
  assert.equal(keywordRows.length, 1);
  assert.equal(teacherRows.length, 1);
  assert.equal(scopeRows.length, 1);
  assert.deepEqual(calls.map(({ options }) => options.input), [EXACT_SQL, KEYWORD_SQL, TEACHER_SQL, SCOPE_SQL]);
  assert.ok(calls[0].args.includes("course_code=IPKKW126262"));
  assert.ok(calls[1].args.includes("keyword=民政"));
  assert.ok(calls[2].args.includes("keyword=宗台大"));
  assert.ok(calls[3].args.includes("keyword=法研所"));
  for (const { args } of calls) {
    assert.equal(args.includes("-c"), false);
    assert.equal(args.some((arg) => [EXACT_SQL, KEYWORD_SQL, TEACHER_SQL, SCOPE_SQL].includes(arg)), false);
  }
});

test("searchCourses with real createPostgresStore dispatches 4 modes and cannot silently fall back to keyword", async () => {
  const calls = [];
  const store = createPostgresStore({
    connectionString: "postgres://b2.example/db",
    spawn(_cmd, args, options) {
      calls.push({ args, options });
      return { status: 0, stdout: JSON.stringify([b2Row({ teacher: "宗台大", applicable_scope: "法研所" })]), stderr: "" };
    },
  });

  // Mode: teacher
  const teacherResult = await searchCourses(store, { search_mode: "teacher", keyword: "宗台大" });
  assert.equal(teacherResult.mode, "teacher");
  assert.equal(teacherResult.results[0].source_search_mode, "teacher");
  assert.equal(teacherResult.results[0].matched_field, "師資");
  assert.equal(calls.at(-1).options.input, TEACHER_SQL);

  // Mode: scope
  const scopeResult = await searchCourses(store, { search_mode: "scope", keyword: "法研所" });
  assert.equal(scopeResult.mode, "scope");
  assert.equal(scopeResult.results[0].source_search_mode, "scope");
  assert.equal(scopeResult.results[0].matched_field, "適用範圍");
  assert.equal(calls.at(-1).options.input, SCOPE_SQL);

  // When store lacks teacher or scope, it fails closed with TypeError and cannot silently fall back to keyword
  const keywordOnlyStore = {
    exact: async () => [],
    keyword: async () => [b2Row()],
  };
  await assert.rejects(
    searchCourses(keywordOnlyStore, { search_mode: "teacher", keyword: "宗台大" }),
    /store\.teacher is required/
  );
  await assert.rejects(
    searchCourses(keywordOnlyStore, { search_mode: "scope", keyword: "法研所" }),
    /store\.scope is required/
  );
});

test("createPostgresStore requires a connection string", () => {
  assert.throws(() => createPostgresStore({ connectionString: "" }), /DATABASE_URL/);
});

test("createPostgresStore passes values as psql variables and parses JSON rows", async () => {
  const calls = [];
  const store = createPostgresStore({
    connectionString: "postgres://b2.example/db",
    psqlPath: "psql",
    spawn(cmd, args, options) {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: JSON.stringify([b2Row()]), stderr: "" };
    },
  });
  const rows = await store.exact({ examYear: 115, courseCode: "IPKKW126262", limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].course_code, "IPPP3727011");

  assert.equal(calls.length, 1);
  const { cmd, args, options } = calls[0];
  assert.equal(cmd, "psql");
  assert.equal(args[0], "postgres://b2.example/db");
  assert.ok(args.includes("-v"));
  assert.ok(args.includes("exam_year=115"));
  assert.ok(args.includes("course_code=IPKKW126262"));
  assert.ok(args.includes("limit=5"));
  assert.equal(args.includes("-c"), false);
  assert.equal(options.input, EXACT_SQL);
  assert.equal(options.timeout, 10_000);
  assert.equal(options.maxBuffer, 8 * 1024 * 1024);
});

test("createPostgresStore fails closed on a non-zero psql exit", async () => {
  const store = createPostgresStore({
    connectionString: "postgres://b2.example/db",
    spawn: () => ({ status: 1, stdout: "", stderr: "ERROR: permission denied for relation exam_courses" }),
  });
  await assert.rejects(
    store.keyword({ keyword: "統計", limit: 20 }),
    /B2 store query failed \(exit 1\).*permission denied/s,
  );
});

test("parsePsqlJson tolerates empty output and rejects non-JSON", () => {
  assert.deepEqual(parsePsqlJson(""), []);
  assert.deepEqual(parsePsqlJson("  \n "), []);
  assert.throws(() => parsePsqlJson("not json"), /non-JSON/);
  assert.throws(() => parsePsqlJson('{"a":1}'), /non-array/);
});

// ---------------------------------------------------------------------------
// HTTP sidecar routing
// ---------------------------------------------------------------------------

test("GET /api/public/exam-courses/search returns the shared public contract", async () => {
  await withServer(fakeStore([b2Row()]), async (base) => {
    const res = await fetch(`${base}/api/public/exam-courses/search?search_mode=product_code&course_code=IPPP3727011&exam_year=116`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.contractVersion, 1);
    assert.equal(body.mode, "postgres");
    assert.equal(body.total, 1);
    assert.equal(body.query.search_mode, "product_code");
    assert.deepEqual(Object.keys(body.results[0]).sort(), [...RESULT_FIELDS].sort());
    assert.match(res.headers.get("access-control-allow-origin"), /\*/);
  });
});

test("GET search maps input errors to 400 and data errors to 502", async () => {
  await withServer(fakeStore([b2Row()]), async (base) => {
    const missing = await fetch(`${base}/api/public/exam-courses/search`);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "missing_query");
  });
  await withServer(fakeStore([b2Row({ source_url: "https://evil.example.com/x" })]), async (base) => {
    const res = await fetch(`${base}/api/public/exam-courses/search?q=%E7%B5%B1%E8%A8%88`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "b2_data_integrity_error");
  });
});

test("health is 200 and unknown routes are 404", async () => {
  await withServer(fakeStore(), async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "b3-ibrain-search-api",
      store: "fake",
      readOnly: true,
    });
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

// ---------------------------------------------------------------------------
// parity with the B2 query contract (skips if B2 inputs are not checked out)
// ---------------------------------------------------------------------------

function resolveB2ContractPath() {
  const candidates = [
    process.env.B2_DIR && join(process.env.B2_DIR, "query-contract.sql"),
    join(HERE, "..", "b2-ibrain-postgresql", "query-contract.sql"),
    // From a linked worktree, the main checkout's B2 inputs live four levels up.
    resolve(HERE, "..", "..", "..", "..", "data", "b2-ibrain-postgresql", "query-contract.sql"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const b2ContractPath = resolveB2ContractPath();

test("B3 SQL preserves the B2 query contract predicates", { skip: b2ContractPath ? false : "B2 query-contract.sql not checked out" }, async () => {
  const contract = await readFile(b2ContractPath, "utf8");
  assert.match(contract, /lower\(course_code\) = lower\(\$1\)/);
  assert.match(contract, /course_name ILIKE '%' \|\| \$2 \|\| '%'/);
  assert.match(contract, /websearch_to_tsquery\('simple', \$2\)/);
  assert.match(contract, /exam_year/);

  // B3 must not have drifted from the B2 column/index surface.
  for (const sql of [EXACT_SQL, KEYWORD_SQL]) {
    assert.match(sql, /FROM public\.exam_courses/);
    assert.match(sql, /exam_year/);
    assert.match(sql, /LIMIT :'limit'::int/);
  }
  assert.match(EXACT_SQL, /lower\(course_code\) = lower\(:'course_code'\)/);
  assert.match(KEYWORD_SQL, /course_name ILIKE/);
  assert.match(KEYWORD_SQL, /course_content ILIKE/);
  assert.match(KEYWORD_SQL, /websearch_to_tsquery\('simple'/);
  assert.match(contract, /public\.exam_courses/);
});

test("B2 migration still pins the ec.ibrain.com.tw-only source host", { skip: b2ContractPath ? false : "B2 migration not checked out" }, () => {
  const migrationPath = join(dirname(b2ContractPath), "001_exam_courses.sql");
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /source_url ~ '\^https\?:\/\/ec\\\.ibrain\\\.com\\\.tw\(\[\/\?#\]\|\$\)'/);
});

test("4-mode search: resolves product_name, product_code, teacher, scope", () => {
  const pName = parseSearchParams({ search_mode: "product_name", keyword: "憲法" });
  assert.equal(pName.mode, "product_name");
  assert.equal(pName.keyword, "憲法");

  const pCode = parseSearchParams({ search_mode: "product_code", keyword: "GA-CON-002" });
  assert.equal(pCode.mode, "product_code");
  assert.equal(pCode.courseCode, "GA-CON-002");

  const pTeacher = parseSearchParams({ search_mode: "teacher", keyword: "宗台大" });
  assert.equal(pTeacher.mode, "teacher");
  assert.equal(pTeacher.teacher, "宗台大");

  const pScope = parseSearchParams({ search_mode: "scope", keyword: "法研所" });
  assert.equal(pScope.mode, "scope");
  assert.equal(pScope.scope, "法研所");
});

test("server-side Big5 deep links use verified form semantics and escape spaces/special characters", () => {
  assert.equal(encodeBig5Percent("憲法"), "%BE%CB%AAk");
  assert.equal(encodeBig5Percent("測試"), "%B4%FA%B8%D5");
  assert.equal(encodeBig5Percent("憲法？"), "%BE%CB%AAk%A1H");
  assert.equal(encodeBig5Percent("行政法"), "%A6%E6%ACF%AAk");
  assert.equal(encodeBig5Percent("憲法 宗台大"), "%BE%CB%AAk%20%A9v%A5x%A4j");
  assert.notEqual(encodeBig5Percent("憲法"), encodeURIComponent("憲法"));
  assert.equal(encodeBig5Percent("憲法 & A/B"), "%BE%CB%AAk%20%26%20A%2FB");
  assert.equal(encodeBig5Percent("😀"), null); // unmappable fails closed
  assert.equal(
    buildStableSearchUrl({ mode: "scope", keyword: "高普考" }),
    "https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=7&keyword=%B0%AA%B4%B6%A6%D2&PG=0",
  );
});

test("source policy returns exact product pages, never homepage or foreign/open-redirect URLs", () => {
  // Mandatory exact probes
  assert.equal(
    normalizeExactProductUrl("http://ec.ibrain.com.tw/Publish/WWW/Book.asp?BKID=18757"),
    "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757",
  );
  assert.equal(normalizeExactProductUrl("https://ec.ibrain.com.tw/"), null); // homepage => REJECT_AS_EXACT
  assert.equal(normalizeExactProductUrl("https://evil.example/Publish/www/book.asp?bkid=18757"), null); // evil.example => REJECT
  assert.equal(normalizeExactProductUrl("https://evil.example@ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757"), null); // evil.example@ec.ibrain.com.tw => REJECT
  assert.equal(normalizeExactProductUrl("https://ec.ibrain.com.tw.evil.example/Publish/www/book.asp?bkid=18757"), null); // ec.ibrain.com.tw.evil.example => REJECT
  assert.equal(normalizeExactProductUrl("https://ec.ibrain.com.tw/redirect?next=https://evil.example/"), null); // /redirect?next=... => REJECT_AS_EXACT
  assert.equal(
    resolvePublicSourceUrl({ exactUrl: "https://ec.ibrain.com.tw/", mode: "product_name", keyword: "憲法" }),
    "https://ec.ibrain.com.tw/Publish/www/search.asp?PS=30&Col=1&keyword=%BE%CB%AAk&PG=0",
  );
});

test("searchCourses routes 4 modes to store methods and includes teacher/scope when available", async () => {
  const store = {
    exact: async ({ courseCode }) => [b2Row({ course_code: courseCode, teacher: "宗台大", applicable_scope: "法研所" })],
    keyword: async ({ keyword }) => [b2Row({ course_name: keyword, teacher: "宗台大", applicable_scope: "法研所" })],
    teacher: async ({ keyword }) => [b2Row({ teacher: keyword, applicable_scope: "法研所" })],
    scope: async ({ keyword }) => [b2Row({ teacher: "宗台大", applicable_scope: keyword })],
  };

  const resName = await searchCourses(store, { search_mode: "product_name", keyword: "憲法" });
  assert.equal(resName.mode, "product_name");
  assert.equal(resName.results[0].teacher, "宗台大");
  assert.equal(resName.results[0].applicable_scope, "法研所");

  const resTeacher = await searchCourses(store, { search_mode: "teacher", keyword: "宗台大" });
  assert.equal(resTeacher.mode, "teacher");
  assert.equal(resTeacher.results[0].teacher, "宗台大");

  const resScope = await searchCourses(store, { search_mode: "scope", keyword: "法研所" });
  assert.equal(resScope.mode, "scope");
  assert.equal(resScope.results[0].applicable_scope, "法研所");
});

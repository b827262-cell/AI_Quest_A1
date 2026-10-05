// B3 Search API HTTP sidecar.
//
// A read-only `node:http` service over the B2 store, following the existing
// `apps/AI-Stu-R1/server/flow-sidecar.mjs` pattern (no framework dependency).
//
// Routes:
//   GET /api/public/exam-courses/search → validated search over B2 exam_courses
//   GET /api/health                → liveness (does not touch the database)
//   OPTIONS *                      → CORS preflight
//
// Query parameters for /api/exam-courses/search:
//   exam_year    optional, 115 | 116
//   course_code  exact, case-insensitive   (mutually exclusive with keyword)
//   keyword | q  course_name/course_content substring / websearch
//   limit        optional, 1..100 (default 20)
//
// This service only reads; it never writes and never crawls.

import http from "node:http";
import { pathToFileURL } from "node:url";
import { searchCourses, SearchDataError, SearchInputError } from "./search-core.mjs";
import { createPostgresStore } from "./postgres-store.mjs";

const SEARCH_PATH = "/api/public/exam-courses/search";
const LEGACY_SEARCH_PATH = "/api/exam-courses/search";
const HEALTH_PATH = "/api/health";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(body);
}

function errorStatus(error) {
  if (error instanceof SearchInputError) return 400;
  if (error instanceof SearchDataError) return 502;
  return 503;
}

function errorPayload(error) {
  return {
    error: error?.code ?? "service_unavailable",
    message: error?.message ?? "search failed",
  };
}

export function publicContractResponse(result) {
  const query = { limit: result.query.limit };
  if (result.query.exam_year !== null && result.query.exam_year !== undefined) query.exam_year = result.query.exam_year;
  if (result.mode === "course_code" || result.mode === "product_code") query.course_code = result.query.course_code;
  else if (result.mode === "teacher") query.teacher = result.query.teacher;
  else if (result.mode === "scope") query.applicable_scope = result.query.scope;
  else query.keyword = result.query.keyword;
  query.search_mode = result.mode === "course_code" ? "product_code" : result.mode === "keyword" ? "product_name" : result.mode;
  return { contractVersion: 1, mode: "postgres", query, total: result.count, results: result.results };
}

/** Builds the HTTP server around an injected B2 store. */
export function createSearchServer({ store }) {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, {
        status: "ok",
        service: "b3-ibrain-search-api",
        store: store?.kind ?? "unknown",
        readOnly: true,
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === SEARCH_PATH || url.pathname === LEGACY_SEARCH_PATH)) {
      try {
        const result = await searchCourses(store, {
          exam_year: url.searchParams.get("exam_year") ?? undefined,
          course_code: url.searchParams.get("course_code") ?? undefined,
          search_mode: url.searchParams.get("search_mode") ?? url.searchParams.get("mode") ?? undefined,
          teacher: url.searchParams.get("teacher") ?? undefined,
          scope: url.searchParams.get("scope") ?? url.searchParams.get("applicable_scope") ?? undefined,
          keyword: url.searchParams.get("keyword") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
        });
        sendJson(res, 200, publicContractResponse(result));
      } catch (error) {
        sendJson(res, errorStatus(error), errorPayload(error));
      }
      return;
    }

    sendJson(res, 404, { error: "not_found", message: `no route for ${req.method} ${url.pathname}` });
  });
}

/** Starts the sidecar using a live PostgreSQL-backed B2 store. */
export function startSearchServer({
  port = Number(process.env.B3_SEARCH_PORT ?? 4360),
  host = process.env.B3_SEARCH_HOST ?? "127.0.0.1",
  connectionString = process.env.DATABASE_URL,
} = {}) {
  const store = createPostgresStore({ connectionString });
  const server = createSearchServer({ store });
  server.listen(port, host, () => {
    process.stdout.write(`b3-ibrain-search-api listening on http://${host}:${port}${SEARCH_PATH}\n`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) {
    process.stderr.write("B3 requires DATABASE_URL (read-only B2 PostgreSQL); refusing to start.\n");
    process.exit(1);
  }
  startSearchServer();
}

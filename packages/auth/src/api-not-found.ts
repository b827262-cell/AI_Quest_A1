import type { RequestHandler } from "express";

/** Express routes are case-insensitive and non-strict by default, so the API
 * prefix test has to be too; otherwise `/API/unknown` would fall through to the
 * HTML 404 page while `/api/unknown` answers JSON. */
const API_PATH = /^\/api(?:\/|$)/i;

/**
 * Answers an unmatched `/api/*` request with a stable JSON 404.
 *
 * Express' default 404 page is HTML and prints a stack trace in development,
 * which breaks API clients that always parse JSON and leaks internals. This
 * handler only claims paths under `/api`, so static files and page fallbacks
 * keep whatever behaviour each app already had.
 *
 * Register it after every route (and after the static/SPA middleware) but
 * before the error boundaries.
 */
export function apiNotFoundHandler(): RequestHandler {
  return (req, res, next) => {
    if (res.headersSent) return next();
    const path = (req.originalUrl || req.url || "").split("?")[0];
    if (!API_PATH.test(path)) return next();
    res.status(404).json({ error: "NOT_FOUND" });
  };
}

import type { NextFunction, Request, RequestHandler, Response } from "express";

export const LOCAL_ADMIN_ORIGINS = [
  "http://127.0.0.1:5174",
  "http://localhost:5174"
] as const;

export function resolveAdminAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const configured = (env.ADMIN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  if (env.NODE_ENV !== "production") return new Set(LOCAL_ADMIN_ORIGINS);
  return new Set();
}

/** CORS/origin boundary for Admin API. It never authenticates a request. */
export function createAdminOriginMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const allowedOrigins = resolveAdminAllowedOrigins(env);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "admin origin is not allowed" });
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  };
}

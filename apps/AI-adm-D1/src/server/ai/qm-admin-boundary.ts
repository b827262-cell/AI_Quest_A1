import type { Express } from "express";
import { createAdminAuthMiddleware } from "./admin-auth";
import { createAdminOriginMiddleware } from "./admin-origin";
import { registerQmStatusRoutes } from "./qm-status-api";

/**
 * The production QM routes are mounted behind origin validation first and
 * token authentication second. Keeping this composition in one function lets
 * the HTTP tests exercise the same middleware order used by the server.
 */
export function registerQmAdminBoundary(
  app: Express,
  env: NodeJS.ProcessEnv = process.env
): void {
  app.use("/api/admin", createAdminOriginMiddleware(env));
  app.use("/api/admin", createAdminAuthMiddleware(env));
  registerQmStatusRoutes(app);
}

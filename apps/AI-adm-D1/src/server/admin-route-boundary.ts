import type { Express, Request, RequestHandler } from "express";
import type { Repositories } from "@ai-smartbook/db";
import { createAdminAuthMiddleware, createAdminCsrfMiddleware } from "./ai/admin-auth";

/** Stable non-secret actor identifier for audit/preflight binding. */
export function adminActorId(req: Request): string {
  if (req.adminAuth?.kind === "session") return `admin:session:${req.adminAuth.id}`;
  if (req.adminAuth?.kind === "token") return "admin:token";
  return "admin:unknown";
}

/** Keep auth, CSRF and mutation audit in one ordered Admin route boundary. */
export function createAdminRouteBoundary(env: NodeJS.ProcessEnv, repos: Repositories): {
  authenticate: RequestHandler;
  csrf: RequestHandler;
  protectRoutes: (app: Express) => void;
} {
  const authenticate = createAdminAuthMiddleware(env, repos.adminSessions);
  const csrf = createAdminCsrfMiddleware(env, repos.adminSessions);
  return {
    authenticate,
    csrf,
    protectRoutes(app) {
      // Login, me and logout are registered before this boundary by the caller.
      app.use("/api/admin", authenticate);
      app.use("/api/admin", csrf);
      app.use("/api/admin", (req, res, next) => {
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase())) {
          return next();
        }
        res.once("finish", () => {
          repos.aiProviders.audit("admin.request.mutation", "admin_route", req.path.slice(0, 200), {
            actorId: adminActorId(req),
            method: req.method,
            path: req.path.slice(0, 200),
            statusCode: res.statusCode
          });
        });
        return next();
      });
    }
  };
}

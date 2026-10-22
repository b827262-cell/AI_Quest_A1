import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import {
  clearStudentSessionCookieOptions,
  readStudentCookie,
  resolveStudentAuthConfig,
  studentOriginAllowed,
  studentSessionCookieOptions,
  type StudentAuthConfig,
  type StudentAuthService
} from "./server";
import type { StudentAuthMeResponse } from "./index";
import { AccessEmailConflictError, AccessInvalidTokenError, AccessUnavailableError } from "./access";
export {
  createStudentLearningHistoryRouter,
  safeLearningSourceUrl,
  oversizeJsonBodyHandler,
  MAX_LEARNING_HISTORY_BATCH,
  MAX_LEARNING_HISTORY_BODY_BYTES
} from "./learning-history-express";

export interface StudentRequestAuth {
  session: { id: string; userId: string; expiresAt: string };
  user: { id: string; email: string; displayName: string; avatarUrl: string | null; profileCompleted: boolean };
  profile: { id: string; email: string; displayName: string; avatarUrl: string | null; profileCompleted: boolean; schoolName: string | null; gradeLevel: string | null };
}

declare global {
  namespace Express {
    interface Request {
      studentAuth?: StudentRequestAuth;
    }
  }
}

function appendCookie(res: Response, name: string, value: string, options: Record<string, string | number | boolean>): void {
  const attributes = Object.entries(options).map(([key, rawValue]) => {
    if (rawValue === false) return "";
    if (rawValue === true) return key === "httpOnly" ? "HttpOnly" : key === "secure" ? "Secure" : key;
    const attribute = key === "maxAge"
      ? "Max-Age"
      : key === "httpOnly"
        ? "HttpOnly"
        : key.charAt(0).toUpperCase() + key.slice(1);
    return `${attribute}=${rawValue}`;
  }).filter(Boolean);
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${attributes.join("; ")}`);
}

function setStudentSessionCookie(res: Response, config: StudentAuthConfig, token: string): void {
  appendCookie(res, config.sessionCookie, token, studentSessionCookieOptions(config));
}

function clearStudentSessionCookie(res: Response, config: StudentAuthConfig): void {
  appendCookie(res, config.sessionCookie, "", { ...clearStudentSessionCookieOptions(config), maxAge: 0 });
}

function publicMe(auth: StudentAuthService, rawToken: string | undefined): StudentAuthMeResponse {
  const response = auth.me(rawToken);
  if (!response.authenticated && rawToken) return { ...response, redirectReason: "session_expired" };
  return response;
}

function rejectOrigin(req: Request, res: Response, config: StudentAuthConfig): boolean {
  if (!studentOriginAllowed(config, req.header("origin"))) {
    res.status(403).json({ error: "STUDENT_ORIGIN_NOT_ALLOWED" });
    return true;
  }
  return false;
}

export function createStudentSessionMiddleware(
  auth: StudentAuthService,
  config: StudentAuthConfig,
  requireProfile = true
): RequestHandler {
  return (req, res, next) => {
    const rawToken = readStudentCookie(req.header("cookie"), config.sessionCookie);
    const restored = auth.restoreSession(rawToken);
    if (!restored) {
      res.status(401).json({ error: rawToken ? "SESSION_EXPIRED" : "AUTH_REQUIRED" });
      return;
    }
    if (requireProfile && !restored.profile.profileCompleted) {
      res.status(403).json({ error: "PROFILE_INCOMPLETE" });
      return;
    }
    req.studentAuth = restored;
    next();
  };
}

export function createStudentAuthRouter(
  auth: StudentAuthService,
  config: StudentAuthConfig = resolveStudentAuthConfig()
): Router {
  const router = express.Router();

  router.get(["/google/start", "/google/callback"], (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "GOOGLE_AUTH_DISABLED" });
  });

  router.get("/access/login", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await auth.completeAccessLogin({
        assertion: req.header("Cf-Access-Jwt-Assertion"),
        returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : undefined,
        ipAddress: req.ip || null,
        userAgent: req.header("user-agent") || null
      });
      setStudentSessionCookie(res, config, result.sessionToken);
      const target = result.profile.profileCompleted ? result.returnTo : `/profile-completion?next=${encodeURIComponent(result.returnTo)}`;
      res.redirect(302, target);
    } catch (error) {
      if (error instanceof AccessEmailConflictError) res.status(403).json({ error: "ACCESS_EMAIL_CONFLICT" });
      else if (error instanceof AccessUnavailableError) res.status(503).json({ error: "ACCESS_UNAVAILABLE" });
      else if (error instanceof AccessInvalidTokenError) res.status(401).json({ error: "ACCESS_ASSERTION_INVALID" });
      else res.status(503).json({ error: "ACCESS_UNAVAILABLE" });
    }
  });

  router.get("/me", (req, res) => {
    const rawToken = readStudentCookie(req.header("cookie"), config.sessionCookie);
    res.setHeader("Cache-Control", "no-store");
    res.json(publicMe(auth, rawToken));
  });

  router.post("/logout", (req, res) => {
    if (rejectOrigin(req, res, config)) return;
    const rawToken = readStudentCookie(req.header("cookie"), config.sessionCookie);
    auth.revokeSession(rawToken);
    clearStudentSessionCookie(res, config);
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  });

  router.get("/profile", createStudentSessionMiddleware(auth, config, false), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ profile: req.studentAuth?.profile ?? null });
  });

  router.patch("/profile", createStudentSessionMiddleware(auth, config, false), (req, res) => {
    if (rejectOrigin(req, res, config)) return;
    const current = req.studentAuth;
    if (!current) {
      res.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : "";
    const schoolName = typeof req.body?.schoolName === "string" ? req.body.schoolName : "";
    const gradeLevel = typeof req.body?.gradeLevel === "string" ? req.body.gradeLevel : "";
    try {
      const profile = auth.updateProfile(current.user.id, { displayName, schoolName, gradeLevel });
      res.setHeader("Cache-Control", "no-store");
      res.json({ profile });
    } catch {
      res.status(400).json({ error: "PROFILE_INCOMPLETE" });
    }
  });

  return router;
}

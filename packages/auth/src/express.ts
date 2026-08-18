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

  router.get("/google/start", (req, res) => {
    try {
      const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : undefined;
      const { authorizationUrl } = auth.beginGoogleLogin(returnTo);
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, authorizationUrl);
    } catch {
      res.status(503).json({ error: "GOOGLE_AUTH_NOT_CONFIGURED" });
    }
  });

  router.get("/google/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code) {
      res.status(400).json({ error: "OAUTH_STATE_INVALID" });
      return;
    }
    try {
      const result = await auth.completeGoogleLogin({
        state,
        code,
        ipAddress: req.ip || null,
        userAgent: req.header("user-agent") || null
      });
      setStudentSessionCookie(res, config, result.sessionToken);
      res.setHeader("Cache-Control", "no-store");
      const target = result.profile.profileCompleted ? result.returnTo : `/profile-completion?next=${encodeURIComponent(result.returnTo)}`;
      res.redirect(302, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const stateError = message === "oauth state is invalid";
      res.status(stateError ? 400 : 502).json({ error: stateError ? "OAUTH_STATE_INVALID" : "OAUTH_PROVIDER_ERROR" });
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

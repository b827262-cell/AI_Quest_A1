import { Router, type Response } from "express";
import type { Repositories } from "@ai-smartbook/db";
import { blockAccountInputSchema, setRiskLevelInputSchema, type ChatSession } from "@ai-smartbook/schema";

export interface AccountsRouterDependencies {
  repos: Repositories;
  onlineWindowMs: number;
  lastSeenBySession: (messages: { sessionId: string; createdAt: string }[]) => Map<string, number>;
  sessionLastActivityMs: (session: ChatSession, messageLastSeen: Map<string, number>) => number;
  describeIpLocation: (session: ChatSession) => string;
  fail: (res: Response, status: number, message: string) => void;
}

export function createAccountsRouter(deps: AccountsRouterDependencies): Router {
  const { repos, onlineWindowMs: ONLINE_WINDOW_MS, lastSeenBySession, sessionLastActivityMs, describeIpLocation, fail } = deps;
  const router = Router();
router.get("/api/admin/accounts", (_req, res) => {
  const sessions = repos.chat.listSessions();
  const messages = repos.chat.listAllMessages();
  const now = Date.now();
  const lastSeen = lastSeenBySession(messages);

  const accounts = sessions
    .map((s) => {
      const last = sessionLastActivityMs(s, lastSeen);
      return {
        id: s.userId || s.id,
        // Admin management actions always target the session row id.
        sessionId: s.id,
        name: s.title?.trim() || "匿名訪客",
        loginMethod: s.userId ? "帳號登入" : "匿名進入",
        osName: s.osName || "未知",
        deviceType: s.deviceType || "未知",
        browserName: s.browserName || "未知",
        ipAddress: s.lastIpAddress ?? null,
        ipLocation: describeIpLocation(s),
        riskLevel: (s.riskLevel as "safe" | "risk" | "dangerous") || "safe",
        riskNote: s.riskNote ?? null,
        isBlocked: !!s.isBlocked,
        blockedReason: s.blockedReason ?? null,
        blockedAt: s.blockedAt ?? null,
        lastSeenAt: new Date(last).toISOString(),
        online: now - last <= ONLINE_WINDOW_MS
      };
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

  res.json({ accounts });
});

// Admin-only: set the risk marking (safe / risk / dangerous) for a session.
router.patch("/api/admin/accounts/:sessionId/risk", (req, res) => {
  const parsed = setRiskLevelInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  if (!session) return fail(res, 404, "account not found");
  const updated = repos.chat.setRiskLevel(session.id, parsed.data.riskLevel, parsed.data.note ?? null);
  res.json({ account: updated });
});

// Admin-only: block / unblock a session. A blocked session (and any other
// session sharing its public IP) is rejected by the student-facing endpoints.
router.patch("/api/admin/accounts/:sessionId/block", (req, res) => {
  const parsed = blockAccountInputSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, parsed.error.message);
  const session = repos.chat.findSessionById(String(req.params.sessionId));
  if (!session) return fail(res, 404, "account not found");
  const updated = repos.chat.setBlocked(session.id, parsed.data.blocked, parsed.data.reason ?? null);
  res.json({ account: updated });
});

  return router;
}

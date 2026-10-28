import { Router, type Request, type Response } from "express";
import { todayTaipei, type AnalyticsService } from "./ai/analytics-service";
import { isValidDateOnly, parseAnalyticsRange as parseAnalyticsDateRange } from "./ai/analytics-query";

export interface AiAnalyticsRouterDependencies {
  analytics: AnalyticsService;
  fail: (res: Response, status: number, message: string) => void;
  requireAdminAccess: (req: Request, res: Response) => boolean;
}

export function createAiAnalyticsRouter(deps: AiAnalyticsRouterDependencies): Router {
  const { analytics, fail, requireAdminAccess } = deps;
  const router = Router();
// ---- AI Analytics (admin) ------------------------------------------------
// Read-side aggregations over ai_request_logs / ai_usage_logs / ai_daily_usage.
// All admin analytics routes are gated by requireAdminAccess when a token is
// configured. Responses never contain raw IPs, API keys, or system prompts.
router.get("/api/admin/ai-analytics/summary", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const date = typeof req.query.date === "string" ? req.query.date : todayTaipei();
  if (!isValidDateOnly(date)) return fail(res, 400, "date must be a valid YYYY-MM-DD date");
  res.json(analytics.summary(date));
});

router.get("/api/admin/ai-analytics/daily", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.daily(range.fromIso, range.toIso));
});

router.get("/api/admin/ai-analytics/providers", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.providers(range.fromIso, range.toIso));
});

router.get("/api/admin/ai-analytics/subjects", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  res.json(analytics.subjects(range.fromIso, range.toIso));
});

router.get("/api/admin/ai-requests", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(page) || page < 1) return fail(res, 400, "page must be a positive integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail(res, 400, "limit must be an integer between 1 and 200");
  }
  const sort = req.query.sort === undefined ? "newest" : req.query.sort;
  if (sort !== "newest" && sort !== "oldest" && sort !== "latency") {
    return fail(res, 400, "sort is not supported");
  }
  const range = parseAnalyticsDateRange(req.query.from, req.query.to);
  if (!range.ok) return fail(res, 400, range.error);
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const requestSource = typeof req.query.requestSource === "string" ? req.query.requestSource : undefined;
  if (provider && !["mock", "gemini", "openai", "kimi", "qwen", "zai"].includes(provider)) {
    return fail(res, 400, "provider is not supported");
  }
  if (subject && !["math", "science", "programming", "language", "humanities", "general", "unknown"].includes(subject)) {
    return fail(res, 400, "subject is not supported");
  }
  if (status && !["pending", "success", "failed", "fallback", "rejected", "timeout"].includes(status)) {
    return fail(res, 400, "status is not supported");
  }
  if (requestSource && !["guest", "student", "book_qa", "admin", "internal"].includes(requestSource)) {
    return fail(res, 400, "requestSource is not supported");
  }
  const model = typeof req.query.model === "string" ? req.query.model.trim() : undefined;
  if (model && (model.length === 0 || model.length > 200)) return fail(res, 400, "model is invalid");
  const result = analytics.listRequests({
    from: range.fromIso,
    to: range.toIso,
    provider,
    model,
    subject,
    status,
    requestSource,
    page,
    limit,
    sort
  });
  res.json(result);
});

router.get("/api/admin/ai-requests/:requestId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const detail = analytics.requestDetail(req.params.requestId);
  if (!detail) return fail(res, 404, "request not found");
  res.json(detail);
});

// Full Q&A + token/cost detail (spec §3.2, §3.3). The full questionText and
// answerText are returned ONLY here; the list endpoint exposes previews.
// Output goes through the typed safe mapper in analytics.usageDetail().
router.get("/api/admin/ai-usage/:requestId", (req, res) => {
  if (!requireAdminAccess(req, res)) return;
  const detail = analytics.usageDetail(req.params.requestId);
  if (!detail) return fail(res, 404, "usage not found");
  res.json(detail);
});

  return router;
}

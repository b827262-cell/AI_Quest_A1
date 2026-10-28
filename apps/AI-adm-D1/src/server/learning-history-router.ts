import { Router } from "express";
import type { Repositories } from "@ai-smartbook/db";

export function createLearningHistoryRouter(studentLearningHistory: Repositories["studentLearningHistory"]): Router {
  const repos = { studentLearningHistory };
  const router = Router();
// Learning history is distinct from guest chat. This route is already behind
// the admin session, CSRF and Origin middleware registered above.
router.get("/api/admin/learning-history", (req, res) => {
  const query = req.query;
  const offset = Number(query.offset ?? 0);
  const limit = Number(query.limit ?? 25);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "INVALID_PAGINATION" });
  }
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const strategy = query.strategy;
  const sourceType = query.sourceType;
  const status = query.status;
  const from = query.from;
  const to = query.to;
  if (q.length > 100 || (strategy !== undefined && strategy !== "api" && strategy !== "google-ai")
    || (sourceType !== undefined && sourceType !== "manual" && sourceType !== "image" && sourceType !== "file")
    || (status !== undefined && status !== "active" && status !== "deleted")
    || (from !== undefined && (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(`${from}T00:00:00+08:00`))))
    || (to !== undefined && (typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(Date.parse(`${to}T23:59:59+08:00`))))) {
    return res.status(400).json({ error: "INVALID_FILTER" });
  }
  return res.json(repos.studentLearningHistory.listAdmin({
    q: q || undefined,
    strategy: strategy as "api" | "google-ai" | undefined,
    sourceType: sourceType as "manual" | "image" | "file" | undefined,
    status: status as "active" | "deleted" | undefined,
    from: from as string | undefined,
    to: to as string | undefined,
    offset, limit
  }));
});

router.get("/api/admin/learning-history/:studentId/:entryId", (req, res) => {
  const detail = repos.studentLearningHistory.adminDetail(String(req.params.studentId), String(req.params.entryId));
  if (!detail) return res.status(404).json({ error: "ENTRY_NOT_FOUND" });
  return res.json({ entry: detail });
});

  return router;
}

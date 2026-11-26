import { randomUUID } from "node:crypto";
import express from "express";
import { originGuard } from "@ai-smartbook/auth/express";
import type { StudentAuthConfig } from "@ai-smartbook/auth/server";
import type { StudentLearningHistoryRepo } from "../../../packages/db/src";
import { studentAiAskInputSchema, type StudentAiAskInput } from "@ai-smartbook/schema";

export interface StudentAiAskEnv {
  STUDENT_AI_ASK_MODE?: string;
  GEMINI_API_KEY?: string;
}

type Dependencies = {
  learningHistory: StudentLearningHistoryRepo;
  env?: StudentAiAskEnv;
  generateAnswer?: (input: StudentAiAskInput, mode: "mock" | "gemini") => Promise<string>;
  rateLimit?: { max: number; windowMs: number; now?: () => number };
};

async function geminiAnswer(question: string, key: string): Promise<string> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: question }] }] }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error("PROVIDER_FAILED");
  const data: unknown = await response.json();
  const parsed = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const answer = parsed.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
  if (!answer || answer.length > 20_000) throw new Error("PROVIDER_INVALID_RESPONSE");
  return answer;
}

export function createStudentAiAskRouter(deps: Dependencies, config: StudentAuthConfig) {
  const router = express.Router();
  const env = deps.env ?? process.env;
  const rate = deps.rateLimit ?? { max: 20, windowMs: 15 * 60_000 };
  if (!Number.isSafeInteger(rate.max) || rate.max < 1 || !Number.isSafeInteger(rate.windowMs) || rate.windowMs < 1) throw new Error("invalid AI ask rate limit");
  const now = rate.now ?? Date.now;
  const windows = new Map<string, number[]>();
  router.use("/ai-ask", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.post("/ai-ask", (req, res, next) => {
    if (!req.studentAuth?.user.id) return res.status(401).json({ error: "AUTH_REQUIRED" });
    return next();
  }, originGuard(config), async (req, res) => {
    const parsed = studentAiAskInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_AI_ASK" });
    const studentId = req.studentAuth!.user.id;
    const time = now();
    for (const [id, times] of windows) if (times[times.length - 1] <= time - rate.windowMs) windows.delete(id);
    const times = (windows.get(studentId) ?? []).filter((at) => at > time - rate.windowMs);
    if (times.length >= rate.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((times[0] + rate.windowMs - time) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "AI_ASK_RATE_LIMITED", retryAfterSeconds });
    }
    times.push(time);
    windows.set(studentId, times);
    const key = env.GEMINI_API_KEY?.trim();
    const mode = env.STUDENT_AI_ASK_MODE === "gemini" && key ? "gemini" : "mock";
    let answer: string;
    try {
      answer = deps.generateAnswer ? await deps.generateAnswer(parsed.data, mode)
        : mode === "gemini" && key ? await geminiAnswer(parsed.data.question, key)
        : `學習引導：請先釐清問題中的關鍵概念，再逐步整理已知條件、推理過程與結論。`;
      if (typeof answer !== "string" || !answer.trim() || answer.length > 20_000 || (key && answer.includes(key))) throw new Error("INVALID_ANSWER");
    } catch {
      console.warn("AI_ASK_PROVIDER_FAILED");
      return res.status(502).json({ error: "AI_ASK_UNAVAILABLE" });
    }
    const entryId = randomUUID();
    const askedAt = new Date(time).toISOString();
    deps.learningHistory.upsertBatch(studentId, [{ id: entryId, askedAt, question: parsed.data.question, category: parsed.data.category, sourceType: "manual", strategy: "api", answer, organizedAnswer: answer, syncVersion: 1 }]);
    return res.json({ entryId, question: parsed.data.question, answer, strategy: "api", providerMode: mode, askedAt });
  });
  return router;
}

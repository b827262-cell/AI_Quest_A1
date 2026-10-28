import { Router } from "express";
import type { Repositories } from "@ai-smartbook/db";

export function createStudentQuestionsRouter(chat: Repositories["chat"], books: Repositories["books"]): Router {
  const repos = { chat, books };
  const router = Router();
router.get("/api/admin/student-questions", (_req, res) => {
  const sessions = repos.chat.listSessions();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bookById = new Map(repos.books.findAll().map((b) => [b.id, b]));
  const messages = repos.chat.listAllMessages();

  const questions = messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const session = sessionById.get(m.sessionId);
      const book = session ? bookById.get(session.bookId) : undefined;
      return {
        id: m.id,
        sessionId: m.sessionId,
        student: "匿名訪客",
        subject: book?.category || "未分類",
        content: m.content,
        createdAt: m.createdAt
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ questions });
});

router.delete("/api/admin/student-questions/:id", (req, res) => {
  repos.chat.deleteMessage(String(req.params.id));
  res.json({ deleted: true });
});

router.post("/api/admin/student-questions/delete", (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  for (const id of ids) repos.chat.deleteMessage(id);
  res.json({ deleted: ids.length });
});

  return router;
}

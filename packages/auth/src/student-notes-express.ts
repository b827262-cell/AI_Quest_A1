import express from "express";
import type { StudentNoteRepo, StudentLearningHistoryRepo, LearningHistoryRecord } from "@ai-smartbook/db";
import { createStudentNoteInputSchema, createStudentNoteFromHistoryInputSchema, updateStudentNoteInputSchema } from "../../schema/src/studentNote.schema";
import { originGuard } from "./learning-history-express";
import type { StudentAuthConfig } from "./server";

export const MAX_STUDENT_NOTE_BODY_BYTES = 256 * 1024;
export function createStudentNotesRouter(deps: { notes: StudentNoteRepo; learningHistory: StudentLearningHistoryRepo }, config: StudentAuthConfig) {
  const router = express.Router();
  router.use("/notes", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); if (!req.studentAuth?.user.id) return res.status(401).json({ error: "AUTH_REQUIRED" }); next(); });
  router.use("/notes", originGuard(config));
  router.get("/notes", (req, res) => {
    const raw = req.query.offset ?? "0";
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 100000) return res.status(400).json({ error: "INVALID_OFFSET" });
    const offset = Number(raw);
    const n = Number(req.query.limit ?? 50);
    const limit = Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100) : 50;
    const tag = req.query.tag;
    const q = req.query.q;
    if ((tag !== undefined && (typeof tag !== "string" || !tag.trim() || tag.trim().length > 24)) ||
        (q !== undefined && (typeof q !== "string" || !q.trim() || q.trim().length > 100))) {
      return res.status(400).json({ error: "INVALID_QUERY" });
    }
    const notes = deps.notes.list(req.studentAuth!.user.id, { offset, limit: limit + 1, includeDeleted: req.query.includeDeleted === "1" || req.query.includeDeleted === "true", bookId: typeof req.query.bookId === "string" ? req.query.bookId : undefined, tag: typeof tag === "string" ? tag.trim() : undefined, q: typeof q === "string" ? q.trim() : undefined });
    return res.json({ notes: notes.slice(0, limit), nextOffset: notes.length > limit ? offset + limit : null });
  });
  router.post("/notes", (req, res) => {
    const parsed = createStudentNoteInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_NOTE" });
    return res.status(201).json({ note: deps.notes.create(req.studentAuth!.user.id, parsed.data) });
  });
  router.post("/notes/from-history", (req, res) => {
    const parsed = createStudentNoteFromHistoryInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_NOTE" });
    const studentId = req.studentAuth!.user.id;
    const entry = deps.learningHistory.findById(studentId, parsed.data.entryId);
    if (!entry || entry.deletedAt) return res.status(404).json({ error: "ENTRY_NOT_FOUND" });
    const existing = deps.notes.findByEntry(studentId, entry.id);
    if (existing) return res.json({ note: existing });
    return res.status(201).json({ note: deps.notes.fromHistory(studentId, entry as LearningHistoryRecord, parsed.data) });
  });
  router.get("/notes/:id", (req, res) => {
    const note = deps.notes.findById(req.studentAuth!.user.id, String(req.params.id));
    return note ? res.json({ note }) : res.status(404).json({ error: "NOTE_NOT_FOUND" });
  });
  router.patch("/notes/:id", (req, res) => {
    const parsed = updateStudentNoteInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_NOTE" });
    const note = deps.notes.update(req.studentAuth!.user.id, String(req.params.id), parsed.data);
    return note ? res.json({ note }) : res.status(404).json({ error: "NOTE_NOT_FOUND" });
  });
  router.delete("/notes/:id", (req, res) => {
    const raw = req.query.syncVersion ?? req.body?.syncVersion;
    const version = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: "INVALID_DELETE" });
    const note = deps.notes.tombstone(req.studentAuth!.user.id, String(req.params.id), version);
    return note ? res.json({ deleted: note.deletedAt !== null, note }) : res.status(404).json({ error: "NOTE_NOT_FOUND" });
  });
  return router;
}

import { Router } from "express";
import { z } from "zod";
import type { Repositories } from "@ai-smartbook/db";
import { generateStudentPasscode, hashStudentPasscode } from "@ai-smartbook/auth/passcode";
import { failValidation } from "./validation-error";

export function createStudentPasscodesRouter(repos: Repositories) {
  const router = Router();
  const base = "/api/admin/student-passcodes";
  router.use(base, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get(base, (_req, res) => res.json({ passcodes: repos.studentPasscodes.listAdmin() }));
  router.post(base, (req, res) => {
    const parsed = z.object({ email: z.string().trim().email().max(320), note: z.string().max(1000).optional() }).safeParse(req.body);
    if (!parsed.success) return failValidation(res, parsed.error);
    const passcode = generateStudentPasscode();
    try {
      repos.studentPasscodes.create({ email: parsed.data.email, note: parsed.data.note, passcodeHash: hashStudentPasscode(passcode) });
      return res.status(201).json({ passcode });
    } catch { return res.status(409).json({ error: "此電子郵件已有通行碼" }); }
  });
  router.post(`${base}/:id/reset`, (req, res) => {
    const existing = repos.studentPasscodes.findById(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "找不到通行碼" });
    const passcode = generateStudentPasscode();
    const hash = hashStudentPasscode(passcode);
    repos.studentPasscodes.changeAndRevoke(existing.id, { passcodeHash: hash });
    return res.json({ passcode });
  });
  router.patch(`${base}/:id/status`, (req, res) => {
    const parsed = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(req.body);
    if (!parsed.success) return failValidation(res, parsed.error);
    const existing = repos.studentPasscodes.findById(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "找不到通行碼" });
    repos.studentPasscodes.changeAndRevoke(existing.id, { status: parsed.data.status });
    return res.json({ ok: true });
  });
  return router;
}

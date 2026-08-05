import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { studentUsers } from "../schema";
import { newId, nowIso } from "./util";

export function makeStudentUserRepo(db: Db) {
  return {
    findByGoogleSubject(googleSubject: string) {
      return db.select().from(studentUsers).where(eq(studentUsers.googleSubject, googleSubject)).get();
    },
    findById(id: string) {
      return db.select().from(studentUsers).where(eq(studentUsers.id, id)).get();
    },
    create(input: { googleSubject: string; email: string; displayName: string; avatarUrl?: string | null }) {
      const now = nowIso();
      const id = newId("stu");
      db.insert(studentUsers).values({
        id,
        googleSubject: input.googleSubject,
        email: input.email,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl ?? null,
        schoolName: null,
        gradeLevel: null,
        profileCompleted: false,
        createdAt: now,
        updatedAt: now
      }).run();
      return this.findById(id)!;
    },
    updateGoogleLogin(id: string, input: { email: string; displayName: string; avatarUrl?: string | null }) {
      const existing = this.findById(id);
      if (!existing) throw new Error("student user not found");
      db.update(studentUsers).set({
        email: input.email,
        ...(existing.profileCompleted ? {} : { displayName: input.displayName }),
        avatarUrl: input.avatarUrl ?? null,
        updatedAt: nowIso()
      }).where(eq(studentUsers.id, id)).run();
      return this.findById(id)!;
    },
    updateProfile(id: string, input: { displayName: string; schoolName: string; gradeLevel: string }) {
      db.update(studentUsers).set({
        displayName: input.displayName,
        schoolName: input.schoolName,
        gradeLevel: input.gradeLevel,
        profileCompleted: true,
        updatedAt: nowIso()
      }).where(eq(studentUsers.id, id)).run();
      return this.findById(id)!;
    }
  };
}

export type StudentUserRepo = ReturnType<typeof makeStudentUserRepo>;

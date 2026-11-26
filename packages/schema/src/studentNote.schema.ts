import { z } from "zod";

export const studentNoteTypeSchema = z.enum(["text", "ai_answer", "canvas"]);
export type StudentNoteType = z.infer<typeof studentNoteTypeSchema>;

export const studentNoteSourceSchema = z.enum(["manual", "google-ai-relay", "gemini-api"]);
export type StudentNoteSource = z.infer<typeof studentNoteSourceSchema>;

/** Persisted row shape returned by the student notes API. */
export const studentNoteSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  entryId: z.string().nullable(),
  bookId: z.string().nullable(),
  chapterId: z.string().nullable(),
  pageNumber: z.number().int().nullable(),
  type: studentNoteTypeSchema,
  title: z.string().max(200),
  content: z.string().max(50_000),
  canvasData: z.string().max(200_000).nullable(),
  tags: z.array(z.string().max(24)).max(20),
  source: studentNoteSourceSchema,
  sourceDetail: z.string().max(2_048).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  syncVersion: z.number().int().min(1).max(1_000_000_000)
});
export type StudentNote = z.infer<typeof studentNoteSchema>;

/**
 * Create body. `studentId` is always derived from the session, never the
 * payload; `.strict()` makes any attempt to smuggle it in fail validation.
 */
export const createStudentNoteInputSchema = z
  .object({
    type: studentNoteTypeSchema.optional().default("text"),
    title: z.string().max(200).optional(),
    content: z.string().max(50_000).optional().default(""),
    canvasData: z.string().max(200_000).nullable().optional(),
    tags: z.array(z.string().max(24)).max(20).optional(),
    bookId: z.string().max(128).nullable().optional(),
    chapterId: z.string().max(128).nullable().optional(),
    pageNumber: z.number().int().min(1).max(100_000).nullable().optional(),
    entryId: z.string().max(128).nullable().optional()
  })
  .strict()
  .refine(
    (v) =>
      v.type === "canvas"
        ? Boolean(v.canvasData && v.canvasData.length > 0)
        : v.content.trim().length > 0,
    { message: "content or canvasData is required" }
  );
export type CreateStudentNoteInput = z.infer<typeof createStudentNoteInputSchema>;

/** Update body. Only provided fields are changed. */
export const updateStudentNoteInputSchema = z
  .object({
    title: z.string().max(200).optional(),
    content: z.string().max(50_000).optional(),
    canvasData: z.string().max(200_000).nullable().optional(),
    tags: z.array(z.string().max(24)).max(20).optional(),
    chapterId: z.string().max(128).nullable().optional(),
    pageNumber: z.number().int().min(1).max(100_000).nullable().optional()
  })
  .strict();
export type UpdateStudentNoteInput = z.infer<typeof updateStudentNoteInputSchema>;

/**
 * Body for converting a `learning_history` entry into a note. The server
 * builds the content snapshot from the entry, so only the link plus optional
 * metadata crosses the boundary.
 */
export const createStudentNoteFromHistoryInputSchema = z
  .object({
    entryId: z.string().min(1).max(128),
    title: z.string().max(200).optional(),
    note: z.string().max(50_000).optional(),
    tags: z.array(z.string().max(24)).max(20).optional(),
    bookId: z.string().max(128).nullable().optional(),
    chapterId: z.string().max(128).nullable().optional(),
    pageNumber: z.number().int().min(1).max(100_000).nullable().optional()
  })
  .strict();
export type CreateStudentNoteFromHistoryInput = z.infer<
  typeof createStudentNoteFromHistoryInputSchema
>;

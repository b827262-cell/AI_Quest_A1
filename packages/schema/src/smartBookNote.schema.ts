import { z } from "zod";

export const smartBookNoteTypeSchema = z.enum(["text", "ai_answer", "canvas"]);
export type SmartBookNoteType = z.infer<typeof smartBookNoteTypeSchema>;

export const smartBookNoteSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  studentId: z.string().nullable(),
  chapterId: z.string().nullable(),
  pageNumber: z.number().int().nullable(),
  type: smartBookNoteTypeSchema,
  title: z.string(),
  content: z.string().nullable(),
  canvasData: z.string().nullable(),
  canvasImageUrl: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type SmartBookNote = z.infer<typeof smartBookNoteSchema>;

/** Create body. bookId comes from the URL, not the payload. */
export const createSmartBookNoteInputSchema = z.object({
  type: smartBookNoteTypeSchema,
  title: z.string().max(200).optional(),
  content: z.string().nullable().optional(),
  canvasData: z.string().nullable().optional(),
  canvasImageUrl: z.string().nullable().optional(),
  chapterId: z.string().nullable().optional(),
  pageNumber: z.number().int().nullable().optional(),
  sourceMessageId: z.string().nullable().optional()
});
export type CreateSmartBookNoteInput = z.infer<typeof createSmartBookNoteInputSchema>;

/** Update body. Only provided fields are changed. */
export const updateSmartBookNoteInputSchema = z
  .object({
    title: z.string().max(200),
    content: z.string().nullable(),
    canvasData: z.string().nullable(),
    canvasImageUrl: z.string().nullable(),
    chapterId: z.string().nullable(),
    pageNumber: z.number().int().nullable()
  })
  .partial();
export type UpdateSmartBookNoteInput = z.infer<typeof updateSmartBookNoteInputSchema>;

import { z } from "zod";

export const publicErrorCategorySchema = z.enum([
  "authentication",
  "authorization",
  "validation",
  "business",
  "conflict",
  "rate_limit",
  "infrastructure",
  "internal"
]);
export type PublicErrorCategory = z.infer<typeof publicErrorCategorySchema>;

/** Versioned, browser-safe error response. Never carries stack or provider details. */
export const publicApiErrorV1Schema = z.object({
  contractVersion: z.literal(1),
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    category: publicErrorCategorySchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    requestId: z.string().min(1).optional()
  }).strict()
}).strict();
export type PublicApiErrorV1 = z.infer<typeof publicApiErrorV1Schema>;

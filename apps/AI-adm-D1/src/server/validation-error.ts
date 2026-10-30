import type { Response } from "express";
import type { ZodError } from "zod";

/** Return only field paths, never the validator's raw messages or input values. */
export function failValidation(res: Response, error: ZodError, message = "請求內容格式不正確") {
  const fields = [...new Set(error.issues.map((issue) => issue.path.map(String).join(".")))];
  return res.status(400).json({ error: message, code: "invalid_request", fields });
}

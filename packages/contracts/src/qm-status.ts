import { z } from "zod";

export const qmClauseStatusSchema = z.enum(["pass", "fail"]);
export type QmClauseStatus = z.infer<typeof qmClauseStatusSchema>;

export const qmContractClauseSchema = z.object({
  status: qmClauseStatusSchema,
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  count: z.number().int().nonnegative().optional()
});
export type QmContractClause = z.infer<typeof qmContractClauseSchema>;

export const qmContractResultSchema = z.object({
  valid: z.boolean(),
  version: z.number().int().nonnegative(),
  clauses: z.record(z.string(), qmContractClauseSchema)
});
export type QmContractResult = z.infer<typeof qmContractResultSchema>;

export const qmDoctorStatusSchema = z.enum(["pass", "blocked", "fail"]);
export type QmDoctorStatus = z.infer<typeof qmDoctorStatusSchema>;

export const qmDoctorBlockerSchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("credential"),
    code: z.literal("missing_or_placeholder"),
    names: z.array(z.string()).optional(),
    message: z.string(),
  }),
  z.object({
    category: z.literal("tool"),
    code: z.literal("missing_tool"),
    name: z.string(),
    message: z.string(),
  }),
  z.object({
    category: z.literal("configuration"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    category: z.literal("environment"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    category: z.literal("unknown"),
    code: z.literal("doctor_failed"),
    message: z.string(),
  }),
]);
export type QmDoctorBlocker = z.infer<typeof qmDoctorBlockerSchema>;

export const qmDoctorResultSchema = z.object({
  status: qmDoctorStatusSchema,
  exitCode: z.number().int(),
  blockers: z.array(qmDoctorBlockerSchema),
  message: z.string().nullable().default(null)
});
export type QmDoctorResult = z.infer<typeof qmDoctorResultSchema>;

export const qmSmokeStatusSchema = z.enum(["pass", "fail", "not_run"]);
export type QmSmokeStatus = z.infer<typeof qmSmokeStatusSchema>;

export const qmSmokeResultSchema = z.object({
  status: qmSmokeStatusSchema,
  checkedAt: z.string().datetime({ offset: true }).nullable(),
  message: z.string().nullable().default(null)
});
export type QmSmokeResult = z.infer<typeof qmSmokeResultSchema>;

export const qmOverallStatusSchema = z.enum(["pass", "warning", "fail"]);
export type QmOverallStatus = z.infer<typeof qmOverallStatusSchema>;

export const qmSystemStatusSchema = z.object({
  overallStatus: qmOverallStatusSchema,
  checkedAt: z.string().datetime({ offset: true }),
  qmCliVersion: z.string(),
  contract: qmContractResultSchema,
  doctor: qmDoctorResultSchema,
  smoke: qmSmokeResultSchema
});
export type QmSystemStatus = z.infer<typeof qmSystemStatusSchema>;

/**
 * Derive the overall QM status from individual results.
 * Contract invalid → fail. Doctor blocked or smoke fail → warning. Otherwise pass.
 * Smoke not_run with everything else passing is still pass.
 */
export function deriveOverallStatus(
  contract: QmContractResult,
  doctor: QmDoctorResult,
  smoke: QmSmokeResult
): QmOverallStatus {
  if (!contract.valid) return "fail";
  if (doctor.status === "blocked" || smoke.status === "fail") return "warning";
  return "pass";
}

import { z } from "zod";

export const auditEventV1Schema = z.object({
  contractVersion: z.literal(1),
  eventId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  actorId: z.string().min(1).nullable(),
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1).nullable(),
  outcome: z.enum(["success", "denied", "failure"]),
  requestId: z.string().min(1).optional()
}).strict();
export type AuditEventV1 = z.infer<typeof auditEventV1Schema>;

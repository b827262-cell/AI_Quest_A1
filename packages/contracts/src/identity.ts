import { z } from "zod";

export const publicActorRoleSchema = z.enum(["teacher", "assistant", "learner", "anonymous"]);
export type PublicActorRole = z.infer<typeof publicActorRoleSchema>;

export const publicActorV1Schema = z.object({
  contractVersion: z.literal(1),
  actorId: z.string().min(1),
  role: publicActorRoleSchema,
  displayName: z.string().min(1)
}).strict();
export type PublicActorV1 = z.infer<typeof publicActorV1Schema>;

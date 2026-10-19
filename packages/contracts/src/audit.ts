import { z } from "zod";
import { rfc3339TimestampSchema, tenantIdSchema, userIdSchema, uuidSchema } from "./primitives.js";

export const auditEventSchema = z.object({
  id: uuidSchema.brand<"AuditEventId">(),
  tenantId: tenantIdSchema,
  actorId: userIdSchema.nullable().optional(),
  actorType: z.string(), // "USER" | "AGENT" | "WORKER" | "SYSTEM"
  action: z.string(),
  resourceType: z.string(),
  resourceId: uuidSchema.nullable().optional(),
  metadataRedacted: z.record(z.unknown()),
  occurredAt: rfc3339TimestampSchema,
});
export type AuditEventDTO = z.infer<typeof auditEventSchema>;

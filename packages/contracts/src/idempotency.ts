import { z } from "zod";
import { rfc3339TimestampSchema, tenantIdSchema, userIdSchema, uuidSchema } from "./primitives.js";

export const idempotencyRecordSchema = z.object({
  id: uuidSchema.brand<"IdempotencyId">(),
  tenantId: tenantIdSchema,
  actorId: userIdSchema,
  operation: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(255),
  requestHash: z.string().length(64), // SHA-256 hash
  state: z.enum(["PENDING", "RESOLVED", "FAILED"]),
  responseStatus: z.number().int().optional(),
  responseBody: z.unknown().optional(),
  createdAt: rfc3339TimestampSchema,
  expiresAt: rfc3339TimestampSchema,
});
export type IdempotencyRecordDTO = z.infer<typeof idempotencyRecordSchema>;

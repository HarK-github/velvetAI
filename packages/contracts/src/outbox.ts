import { z } from "zod";
import { rfc3339TimestampSchema, tenantIdSchema, uuidSchema } from "./primitives.js";

export const outboxEventSchema = z.object({
  id: uuidSchema.brand<"OutboxEventId">(),
  tenantId: tenantIdSchema,
  aggregateType: z.string().min(1),
  aggregateId: uuidSchema,
  eventType: z.string().min(1),
  payload: z.record(z.unknown()),
  createdAt: rfc3339TimestampSchema,
  claimedAt: rfc3339TimestampSchema.nullable().optional(),
  processedAt: rfc3339TimestampSchema.nullable().optional(),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().optional(),
});
export type OutboxEventDTO = z.infer<typeof outboxEventSchema>;

export const inboxEventSchema = z.object({
  id: uuidSchema.brand<"InboxEventId">(),
  consumerName: z.string().min(1),
  eventId: uuidSchema,
  processedAt: rfc3339TimestampSchema,
});
export type InboxEventDTO = z.infer<typeof inboxEventSchema>;

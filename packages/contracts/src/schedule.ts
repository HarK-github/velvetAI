import { z } from "zod";
import { ianaTimeZoneSchema, rfc3339TimestampSchema } from "./primitives.js";

export const scheduleResourceKindSchema = z.enum(["STAFF", "ROOM"]);
export type ScheduleResourceKind = z.infer<typeof scheduleResourceKindSchema>;

export const scheduleEventKindSchema = z.enum(["BOOKING", "HOLD", "DEMO_FIXTURE"]);
export type ScheduleEventKind = z.infer<typeof scheduleEventKindSchema>;

export const schedulePaymentStateSchema = z.enum([
  "NONE",
  "AWAITING_PAYER",
  "VERIFYING",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);
export type SchedulePaymentState = z.infer<typeof schedulePaymentStateSchema>;

export const schedulePreparedBySchema = z.enum(["ASK_AI", "MCP", "WEB", "MERCHANT"]);
export type SchedulePreparedBy = z.infer<typeof schedulePreparedBySchema>;

export const scheduleResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: scheduleResourceKindSchema,
  timeZone: ianaTimeZoneSchema,
});
export type ScheduleResource = z.infer<typeof scheduleResourceSchema>;

export const scheduleEventDisplaySchema = z.object({
  localStart: z.string(),
  localEnd: z.string(),
  timeZoneLabel: z.string(),
});
export type ScheduleEventDisplay = z.infer<typeof scheduleEventDisplaySchema>;

export const scheduleNoShowRiskSchema = z.object({
  band: z.enum(["LOW", "MEDIUM", "HIGH"]),
  bps: z.number().int().min(0).max(10000),
});
export type ScheduleNoShowRisk = z.infer<typeof scheduleNoShowRiskSchema>;

export const scheduleEventSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  display: scheduleEventDisplaySchema,
  serviceName: z.string(),
  kind: scheduleEventKindSchema,
  status: z.string(),
  paymentState: schedulePaymentStateSchema,
  holdExpiresAt: rfc3339TimestampSchema.optional(),
  buyerLabel: z.string(),
  preparedBy: schedulePreparedBySchema.optional(),
  noShowRisk: scheduleNoShowRiskSchema.optional(),
});
export type ScheduleEvent = z.infer<typeof scheduleEventSchema>;

export const scheduleResourceTimeRangeSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  fillProbabilityBps: z.number().int().min(0).max(10000),
  band: z.enum(["WEAK", "NORMAL", "HIGH_DEMAND"]),
  label: z.string(),
});
export type ScheduleResourceTimeRange = z.infer<typeof scheduleResourceTimeRangeSchema>;

export const scheduleResponseSchema = z.object({
  tenantTimeZone: ianaTimeZoneSchema,
  scheduleRevision: z.string(),
  generatedAt: rfc3339TimestampSchema,
  resources: z.array(scheduleResourceSchema),
  events: z.array(scheduleEventSchema),
  resourceTimeRanges: z.array(scheduleResourceTimeRangeSchema),
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export const raceTestInputSchema = z
  .object({
    resourceId: z.string().uuid().optional(),
    startsAt: rfc3339TimestampSchema.optional(),
    serviceId: z.string().uuid().optional(),
    parallel: z.number().int().min(2).max(50).default(20),
  })
  .strict();
export type RaceTestInput = z.infer<typeof raceTestInputSchema>;

export const raceTestResponseSchema = z.object({
  attempts: z.number().int().min(2).max(50),
  succeeded: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  winnerHoldId: z.string().nullable(),
  resourceId: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  display: scheduleEventDisplaySchema,
  durationMs: z.number().int().min(0),
});
export type RaceTestResponse = z.infer<typeof raceTestResponseSchema>;

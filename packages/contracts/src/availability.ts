import { z } from "zod";
import {
  serviceIdSchema,
  locationIdSchema,
  moneySchema,
  ianaTimeZoneSchema,
  rfc3339TimestampSchema,
  resourceIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "./primitives.js";

export const availabilityRuleSchema = z.object({
  id: uuidSchema.brand<"AvailabilityRuleId">(),
  tenantId: tenantIdSchema,
  resourceId: resourceIdSchema,
  timezone: ianaTimeZoneSchema,
  recurrenceRule: z.string(), // e.g. RRULE or RFC 5545 format
  effectiveFrom: rfc3339TimestampSchema,
  effectiveTo: rfc3339TimestampSchema.nullable().optional(),
});
export type AvailabilityRuleDTO = z.infer<typeof availabilityRuleSchema>;

export const searchAvailabilityQuerySchema = z.object({
  serviceId: serviceIdSchema,
  locationId: locationIdSchema,
  from: rfc3339TimestampSchema,
  to: rfc3339TimestampSchema,
  timeZone: ianaTimeZoneSchema,
});
export type SearchAvailabilityQuery = z.infer<typeof searchAvailabilityQuerySchema>;

export const slotDisplaySchema = z.object({
  localDate: z.string(),
  localStart: z.string(),
  localEnd: z.string(),
  timeZone: z.string(),
  timeZoneLabel: z.string(),
});
export type SlotDisplay = z.infer<typeof slotDisplaySchema>;

export const availableSlotSchema = z.object({
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  localStartsAt: z.string(),
  timeZone: ianaTimeZoneSchema,
  resourceId: resourceIdSchema.optional(),
  price: moneySchema,
  depositPreview: moneySchema,
  fillProbability: z.number().min(0).max(1).optional(),
  forecastConfidence: z.enum(["low", "medium", "high"]).optional(),
  display: slotDisplaySchema.optional(),
});
export type AvailableSlot = z.infer<typeof availableSlotSchema>;

export const availabilityResponseSchema = z.object({
  scheduleRevision: z.number().int().nonnegative(),
  generatedAt: rfc3339TimestampSchema,
  serviceName: z.string().optional(),
  timeZone: z.string().optional(),
  slots: z.array(availableSlotSchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

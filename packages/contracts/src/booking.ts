import { z } from "zod";
import {
  bookingIdSchema,
  bookingQuoteIdSchema,
  cancellationPolicyIdSchema,
  ianaTimeZoneSchema,
  locationIdSchema,
  moneySchema,
  resourceIdSchema,
  rfc3339TimestampSchema,
  serviceIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "./primitives.js";

export const bookingStatusSchema = z.enum([
  "HELD",
  "PAYMENT_PENDING",
  "CAPTURE_UNCERTAIN",
  "CONFIRMED",
  "CHECKED_IN",
  "COMPLETED",
  "NO_SHOW",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const createBookingQuoteInputSchema = z.object({
  serviceId: serviceIdSchema,
  locationId: locationIdSchema,
  startsAt: rfc3339TimestampSchema,
  timeZone: ianaTimeZoneSchema,
});
export type CreateBookingQuoteInput = z.infer<typeof createBookingQuoteInputSchema>;

export const bookingQuoteSchema = z.object({
  quoteId: bookingQuoteIdSchema,
  expiresAt: rfc3339TimestampSchema,
  serviceVersion: z.number().int().positive(),
  scheduleRevision: z.number().int().nonnegative(),
  total: moneySchema,
  deposit: moneySchema,
  risk: z
    .object({
      noShowProbability: z.number().min(0).max(1),
      band: z.enum(["low", "medium", "high"]),
      confidence: z.enum(["low", "medium", "high"]),
      modelVersion: z.string(),
    })
    .optional(),
  cancellationPolicy: z.object({
    policyId: cancellationPolicyIdSchema,
    version: z.number().int().positive(),
    summary: z.string(),
  }),
});
export type BookingQuoteDTO = z.infer<typeof bookingQuoteSchema>;

export const customerInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().max(100).optional(),
});

export const createBookingHoldInputSchema = z.object({
  quoteId: bookingQuoteIdSchema,
  customer: customerInputSchema,
  note: z.string().max(1024, "Customer note must not exceed 1 KiB").optional(),
});
export type CreateBookingHoldInput = z.infer<typeof createBookingHoldInputSchema>;

export const bookingHoldResponseSchema = z.object({
  bookingId: bookingIdSchema,
  status: z.literal("HELD"),
  holdExpiresAt: rfc3339TimestampSchema,
  version: z.number().int().positive(),
  signedIntent: z.string(),
});
export type BookingHoldResponse = z.infer<typeof bookingHoldResponseSchema>;

export const bookingSchema = z.object({
  id: bookingIdSchema,
  tenantId: tenantIdSchema,
  customerId: userIdSchema,
  quoteId: bookingQuoteIdSchema,
  status: bookingStatusSchema,
  version: z.number().int().positive(),
  holdExpiresAt: rfc3339TimestampSchema.nullable().optional(),
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  resourceId: resourceIdSchema.nullable().optional(),
});
export type BookingDTO = z.infer<typeof bookingSchema>;

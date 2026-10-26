import { z } from "zod";
import {
  bookingIdSchema,
  bookingQuoteIdSchema,
  cancellationPolicyIdSchema,
  currencyCodeSchema,
  ianaTimeZoneSchema,
  locationIdSchema,
  moneySchema,
  moneyMinorSchema,
  resourceIdSchema,
  rfc3339TimestampSchema,
  serviceIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "./primitives.js";

export const bookingStatusSchema = z.enum([
  "HELD",
  "COMMITTING",
  "REQUIRES_PAYER_ACTION",
  "PAYMENT_PENDING",
  "CAPTURE_UNCERTAIN",
  "CONFIRMED",
  "PAYMENT_WINDOW_EXPIRED",
  "PAYMENT_FAILED",
  "CHECKED_IN",
  "COMPLETED",
  "NO_SHOW",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "EXPIRED",
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const resourceClaimStateSchema = z.enum([
  "HELD",
  "COMMITTING",
  "CAPTURE_UNCERTAIN",
  "CONFIRMED",
  "EXPIRED",
  "CANCELLED",
  "RELEASED",
]);
export type ResourceClaimState = z.infer<typeof resourceClaimStateSchema>;

export const createBookingQuoteInputSchema = z
  .object({
    serviceId: serviceIdSchema,
    locationId: locationIdSchema,
    startsAt: rfc3339TimestampSchema,
    timeZone: ianaTimeZoneSchema,
  })
  .strict();
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

export const customerInputSchema = z
  .object({
    email: z.string().email(),
    displayName: z.string().max(100).optional(),
  })
  .strict();

export const createBookingHoldInputSchema = z
  .object({
    quoteId: bookingQuoteIdSchema,
    customer: customerInputSchema,
    note: z.string().max(1024, "Customer note must not exceed 1 KiB").optional(),
  })
  .strict();
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

export const signedBookingIntentClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(), // actor subject
  client_id: z.string(),
  tenant_id: tenantIdSchema,
  jti: z.string(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  purpose: z.literal("booking_commit"),
  hold_id: bookingIdSchema,
  hold_version: z.number().int().positive(),
  tool_name: z.string(),
  tool_version: z.string(),
  schema_hash: z.string(),
  canonical_argument_hash: z.string(),
  merchant_id: z.string(),
  total_minor: z.string(),
  deposit_minor: z.string(),
  currency: currencyCodeSchema,
  currency_scale: z.number().int().default(2),
  price_version: z.number().int().positive(),
  cancellation_policy_id: cancellationPolicyIdSchema,
  cancellation_policy_version: z.number().int().positive(),
  cancellation_policy_hash: z.string(),
  allowed_surfaces: z.array(z.string()),
});
export type SignedBookingIntentClaims = z.infer<typeof signedBookingIntentClaimsSchema>;

export const prepareBookingInputSchema = z
  .object({
    serviceId: serviceIdSchema,
    locationId: locationIdSchema,
    startsAt: rfc3339TimestampSchema,
    timeZone: ianaTimeZoneSchema,
    customer: customerInputSchema,
    note: z.string().max(1024, "Customer note must not exceed 1 KiB").optional(),
  })
  .strict();
export type PrepareBookingInput = z.infer<typeof prepareBookingInputSchema>;

export const prepareBookingResponseSchema = z.object({
  bookingId: bookingIdSchema,
  status: z.literal("HELD"),
  holdExpiresAt: rfc3339TimestampSchema,
  version: z.number().int().positive(),
  intent: z.string(),
  approvalLocator: z.string(),
  interactionToken: z.string(),
  requiresHumanConfirmation: z.literal(true).default(true),
});
export type PrepareBookingResponse = z.infer<typeof prepareBookingResponseSchema>;

export const bookingApprovalDetailsSchema = z.object({
  bookingId: bookingIdSchema,
  tenantId: tenantIdSchema,
  serviceName: z.string(),
  serviceVersion: z.number().int().positive(),
  startsAt: rfc3339TimestampSchema,
  endsAt: rfc3339TimestampSchema,
  timeZone: ianaTimeZoneSchema,
  allInPriceMinor: z.string(),
  depositMinor: z.string(),
  currency: currencyCodeSchema,
  cancellationSummary: z.string(),
  requestingAgent: z.string(),
  expiresAt: rfc3339TimestampSchema,
  status: z.enum(["PENDING", "APPROVED", "CONSUMED"]).optional(),
});
export type BookingApprovalDetails = z.infer<typeof bookingApprovalDetailsSchema>;

export const confirmBookingApprovalResponseSchema = z.object({
  confirmation: z.string(),
  expiresAt: rfc3339TimestampSchema,
});
export type ConfirmBookingApprovalResponse = z.infer<typeof confirmBookingApprovalResponseSchema>;

export const commitBookingInputSchema = z
  .object({
    intent: z.string().min(10),
    confirmation: z.string().min(10).optional(),
    idempotency_key: z.string().min(1),
  })
  .strict();
export type CommitBookingInput = z.infer<typeof commitBookingInputSchema>;

export const commitBookingResponseSchema = z.object({
  bookingId: bookingIdSchema,
  status: z.literal("COMMITTING"),
  version: z.number().int().positive(),
  committedAt: rfc3339TimestampSchema,
});
export type CommitBookingResponse = z.infer<typeof commitBookingResponseSchema>;

export const prepareCancellationInputSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type PrepareCancellationInput = z.infer<typeof prepareCancellationInputSchema>;

export const prepareCancellationResponseSchema = z.object({
  bookingId: bookingIdSchema,
  cancellationAllowed: z.boolean(),
  refundEligibleMinor: moneyMinorSchema,
  currency: currencyCodeSchema,
  policySummary: z.string(),
  cancellationConfirmationToken: z.string().optional(),
  cutoffPassed: z.boolean().optional(),
  hoursUntilStart: z.number().optional(),
});
export type PrepareCancellationResponse = z.infer<typeof prepareCancellationResponseSchema>;

export const commitCancellationInputSchema = z
  .object({
    cancellationConfirmationToken: z.string().min(10),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CommitCancellationInput = z.infer<typeof commitCancellationInputSchema>;

export const commitCancellationResponseSchema = z.object({
  bookingId: bookingIdSchema,
  status: z.enum(["CANCELLED", "CANCEL_REQUESTED"]),
  refundStatus: z.enum(["COMPLETED", "NO_REFUND", "UNCERTAIN"]),
  refundAmountMinor: moneyMinorSchema,
  currency: currencyCodeSchema,
  resourceClaimReleased: z.boolean(),
  cancelledAt: rfc3339TimestampSchema,
});
export type CommitCancellationResponse = z.infer<typeof commitCancellationResponseSchema>;

export const attendanceActionResponseSchema = z.object({
  bookingId: bookingIdSchema,
  status: z.enum(["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW"]),
  previousStatus: z.string(),
  version: z.number().int().positive(),
  updatedAt: rfc3339TimestampSchema,
});
export type AttendanceActionResponse = z.infer<typeof attendanceActionResponseSchema>;

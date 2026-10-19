import { z } from "zod";
import {
  bookingIdSchema,
  moneySchema,
  paymentCaptureIdSchema,
  paymentIntentIdSchema,
  refundIdSchema,
  tenantIdSchema,
} from "./primitives.js";

export const paymentStateSchema = z.enum([
  "ORDER_REQUIRED",
  "REQUIRES_PAYER_ACTION",
  "PAYER_APPROVED",
  "CAPTURE_IN_FLIGHT",
  "CAPTURED",
  "SUBMISSION_UNKNOWN",
  "REFUND_PENDING",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;

export const createPaymentOrderInputSchema = z.object({
  signedIntent: z.string().min(1),
});
export type CreatePaymentOrderInput = z.infer<typeof createPaymentOrderInputSchema>;

export const createPaymentOrderResponseSchema = z.object({
  paymentIntentId: paymentIntentIdSchema,
  paypalOrderId: z.string(),
  amount: moneySchema,
  status: z.literal("REQUIRES_PAYER_ACTION"),
});
export type CreatePaymentOrderResponse = z.infer<typeof createPaymentOrderResponseSchema>;

export const capturePaymentInputSchema = z.object({
  bookingId: bookingIdSchema,
  signedIntent: z.string().min(1),
});
export type CapturePaymentInput = z.infer<typeof capturePaymentInputSchema>;

export const definitiveCaptureResponseSchema = z.object({
  bookingId: bookingIdSchema,
  bookingStatus: z.literal("CONFIRMED"),
  paymentStatus: z.literal("CAPTURED"),
  providerCaptureId: z.string(),
  version: z.number().int().positive(),
});
export type DefinitiveCaptureResponse = z.infer<typeof definitiveCaptureResponseSchema>;

export const uncertainCaptureResponseSchema = z.object({
  bookingId: bookingIdSchema,
  bookingStatus: z.literal("CAPTURE_UNCERTAIN"),
  operationId: z.string().uuid(),
  statusUrl: z.string(),
});
export type UncertainCaptureResponse = z.infer<typeof uncertainCaptureResponseSchema>;

export const refundSchema = z.object({
  id: refundIdSchema,
  tenantId: tenantIdSchema,
  captureId: paymentCaptureIdSchema,
  providerRefundId: z.string().nullable().optional(),
  amount: moneySchema,
  state: z.enum(["REQUESTED", "SUBMISSION_UNKNOWN", "PENDING", "COMPLETED", "FAILED"]),
  requestId: z.string(),
});
export type RefundDTO = z.infer<typeof refundSchema>;

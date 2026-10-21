import { z } from "zod";
import {
  bookingIdSchema,
  moneySchema,
  moneyMinorSchema,
  paymentCaptureIdSchema,
  paymentIntentIdSchema,
  refundIdSchema,
  tenantIdSchema,
  rfc3339TimestampSchema,
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

export const createPaymentOrderInputSchema = z
  .object({
    signedIntent: z.string().optional(),
  })
  .strict();
export type CreatePaymentOrderInput = z.infer<typeof createPaymentOrderInputSchema>;

export const createPaymentOrderResponseSchema = z.object({
  paymentIntentId: paymentIntentIdSchema,
  paypalOrderId: z.string(),
  amount: moneySchema,
  status: z.literal("REQUIRES_PAYER_ACTION"),
  paymentExpiresAt: rfc3339TimestampSchema.optional(),
});
export type CreatePaymentOrderResponse = z.infer<typeof createPaymentOrderResponseSchema>;

export const capturePaymentInputSchema = z
  .object({
    bookingId: bookingIdSchema.optional(),
    signedIntent: z.string().optional(),
  })
  .strict();
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

export const refundInputSchema = z
  .object({
    reason: z.string().min(1),
    amountMinor: moneyMinorSchema.optional(),
  })
  .strict();
export type RefundInput = z.infer<typeof refundInputSchema>;

export const refundResponseSchema = z.object({
  refundId: refundIdSchema,
  providerRefundId: z.string().nullable().optional(),
  amount: moneySchema,
  status: z.enum(["REQUESTED", "SUBMISSION_UNKNOWN", "PENDING", "COMPLETED", "FAILED"]),
});
export type RefundResponse = z.infer<typeof refundResponseSchema>;

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

export const balanceInvoiceResponseSchema = z.object({
  invoiceId: z.string().uuid(),
  providerInvoiceId: z.string().nullable().optional(),
  providerInvoiceNumber: z.string().nullable().optional(),
  status: z.string(),
  total: moneySchema,
  depositPaid: moneySchema,
  balanceDue: moneySchema,
});
export type BalanceInvoiceResponse = z.infer<typeof balanceInvoiceResponseSchema>;

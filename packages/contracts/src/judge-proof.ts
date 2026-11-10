import { z } from "zod";

export const proofTimelineItemSchema = z.object({
  at: z.string().datetime(),
  event: z.string().min(1),
  detail: z.string().min(1).optional(),
});
export type ProofTimelineItem = z.infer<typeof proofTimelineItemSchema>;

export const bookingProofResponseSchema = z.object({
  bookingId: z.string().uuid(),
  status: z.string().min(1),
  timeline: z.array(proofTimelineItemSchema),
  intent: z
    .object({
      sha256Prefix: z.string().min(1),
      algorithm: z.string().min(1),
      keyId: z.string().min(1),
    })
    .optional(),
  confirmation: z
    .object({
      consumed: z.boolean(),
      consumedAt: z.string().datetime().optional(),
    })
    .optional(),
  idempotency: z
    .object({
      commitKeyHashPrefix: z.string().min(1),
    })
    .optional(),
  resourceClaim: z
    .object({
      blocking: z.boolean(),
      state: z.string().min(1),
    })
    .optional(),
  paypal: z
    .object({
      environment: z.string().min(1),
      orderIdMasked: z.string().min(1).optional(),
      captureIdMasked: z.string().min(1).optional(),
      captureStatus: z.string().min(1).optional(),
    })
    .optional(),
  webhook: z
    .object({
      eventType: z.string().min(1),
      verification: z.string().min(1),
      reconciliation: z.string().min(1),
    })
    .optional(),
  ledger: z
    .object({
      entries: z.number().int().nonnegative(),
      balanced: z.boolean(),
      depositLiabilityMinor: z.string(),
      currency: z.string().min(1),
    })
    .optional(),
  counts: z.object({
    captures: z.number().int().nonnegative(),
    bookingsForHold: z.number().int().nonnegative(),
    journalEntriesForCapture: z.number().int().nonnegative(),
  }),
});
export type BookingProofResponse = z.infer<typeof bookingProofResponseSchema>;

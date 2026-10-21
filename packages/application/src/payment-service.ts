import crypto from "node:crypto";
import { Kysely, sql } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import {
  BookingId,
  PaymentIntentId,
  PaymentCaptureId,
  RefundId,
  TenantId,
  UserId,
  Money,
  currencyCodeSchema,
  moneyMinorSchema,
  paymentIntentIdSchema,
  refundIdSchema,
  bookingIdSchema,
  SlotUnavailableError,
  InvalidStateTransitionError,
  IdempotencyConflictError,
  DomainError,
} from "@velvetai/contracts";
import {
  PaymentPort,
  CreateOrderResult,
  CapturePaymentResult,
  RefundPaymentResult,
} from "./ports.js";
import { canonicalHash } from "./canonicalizer.js";

export interface PaymentActor {
  subject: string;
  userId: UserId;
  tenantId: TenantId;
  roles: string[];
}

export interface CreateDepositOrderResult {
  paymentIntentId: PaymentIntentId;
  paypalOrderId: string;
  amount: Money;
  status: "REQUIRES_PAYER_ACTION";
  paymentExpiresAt: string;
}

export interface CapturePaymentOutcome {
  bookingId: BookingId;
  bookingStatus: "CONFIRMED" | "CAPTURE_UNCERTAIN" | "CANCELLED";
  paymentStatus: "CAPTURED" | "UNCERTAIN" | "FAILED";
  providerCaptureId?: string;
  operationId?: string;
  statusUrl?: string;
  version?: number;
}

export interface RefundOutcome {
  refundId: RefundId;
  providerRefundId?: string;
  amount: Money;
  status: "REQUESTED" | "COMPLETED" | "FAILED" | "UNCERTAIN";
}

export interface BalanceInvoiceResult {
  invoiceId: string;
  providerInvoiceId?: string;
  providerInvoiceNumber?: string;
  status: string;
  total: Money;
  depositPaid: Money;
  balanceDue: Money;
}

export class PaymentService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly paymentPort: PaymentPort,
  ) {}

  /**
   * W3: Creates an Orders v2 deposit order for a COMMITTING booking.
   * Specification v1.1 Amendment Section F.1 & F.4.
   */
  async createDepositOrder(params: {
    tenantId: TenantId;
    bookingId: BookingId;
    idempotencyKey: string;
  }): Promise<CreateDepositOrderResult> {
    const { tenantId, bookingId, idempotencyKey } = params;

    const result = await withTenantTransaction(
      this.db,
      tenantId,
      async (
        trx,
      ): Promise<{ expired: true; paymentExpiresAt: string; dbTime: string } | CreateDepositOrderResult> => {
      // 1. Lock booking row
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError("Booking not found", "BOOKING_NOT_FOUND", 404);
      }

      // Check for idempotent replay
      const existingIntent = await trx
        .selectFrom("payment_intents")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .where("request_id", "=", idempotencyKey)
        .selectAll()
        .executeTakeFirst();

      if (existingIntent && existingIntent.provider_order_id) {
        return {
          paymentIntentId: paymentIntentIdSchema.parse(existingIntent.id),
          paypalOrderId: existingIntent.provider_order_id,
          amount: {
            currency: currencyCodeSchema.parse(existingIntent.currency),
            valueMinor: moneyMinorSchema.parse(existingIntent.amount_minor),
          },
          status: "REQUIRES_PAYER_ACTION" as const,
          paymentExpiresAt: (booking.payment_expires_at ?? existingIntent.payment_expires_at).toISOString(),
        };
      }

      // Check valid booking state
      if (booking.status !== "COMMITTING" && booking.status !== "REQUIRES_PAYER_ACTION") {
        throw new InvalidStateTransitionError(booking.status, "REQUIRES_PAYER_ACTION", {
          bookingId: booking.id,
        });
      }

      // 2. Verify database clock before payment window expiry
      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      if (booking.payment_expires_at && dbNow.getTime() >= booking.payment_expires_at.getTime()) {
        // Transition to PAYMENT_WINDOW_EXPIRED and release claim
        await trx
          .updateTable("bookings")
          .set({ status: "PAYMENT_WINDOW_EXPIRED", version: booking.version + 1 })
          .where("id", "=", bookingId)
          .execute();

        await trx
          .updateTable("resource_claims")
          .set({ state: "RELEASED", blocking: false })
          .where("booking_id", "=", bookingId)
          .where("tenant_id", "=", tenantId)
          .execute();

        return {
          expired: true as const,
          paymentExpiresAt: booking.payment_expires_at.toISOString(),
          dbTime: dbNow.toISOString(),
        };
      }

      // 3. Read immutable snapshot for deposit amount, currency, and merchant
      const snapshot = await trx
        .selectFrom("booking_hold_snapshots")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();

      if (!snapshot) {
        throw new DomainError("Booking snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
      }

      // 4. Compute canonical hash of payload
      const canonicalPayload = {
        tenantId,
        bookingId,
        depositMinor: snapshot.deposit_minor,
        currency: snapshot.currency,
      };
      const payloadHash = canonicalHash(canonicalPayload);

      // 5. Check provider operations for idempotency
      const existingOp = await trx
        .selectFrom("provider_operations")
        .where("tenant_id", "=", tenantId)
        .where("paypal_request_id", "=", idempotencyKey)
        .where("operation_type", "=", "ORDER_CREATE")
        .selectAll()
        .executeTakeFirst();

      if (existingOp) {
        if (existingOp.canonical_payload_hash !== payloadHash) {
          throw new IdempotencyConflictError("PayPal-Request-Id was previously used with different parameters");
        }
        if (existingOp.state === "SUCCEEDED" && existingOp.provider_order_id) {
          const intent = await trx
            .selectFrom("payment_intents")
            .where("provider_order_id", "=", existingOp.provider_order_id)
            .where("tenant_id", "=", tenantId)
            .selectAll()
            .executeTakeFirst();

          if (intent) {
            return {
              paymentIntentId: paymentIntentIdSchema.parse(intent.id),
              paypalOrderId: existingOp.provider_order_id,
              amount: {
                currency: currencyCodeSchema.parse(intent.currency),
                valueMinor: moneyMinorSchema.parse(intent.amount_minor),
              },
              status: "REQUIRES_PAYER_ACTION",
              paymentExpiresAt: (booking.payment_expires_at ?? dbNow).toISOString(),
            };
          }
        }
      }

      // 6. Record provider operation in DISPATCHING state before provider dispatch
      const operationId = crypto.randomUUID();
      await trx
        .insertInto("provider_operations")
        .values({
          id: operationId,
          tenant_id: tenantId,
          booking_id: bookingId,
          provider: "PAYPAL",
          environment: "sandbox",
          operation_type: "ORDER_CREATE",
          state: "DISPATCHING",
          endpoint: "/v2/checkout/orders",
          paypal_request_id: idempotencyKey,
          canonical_payload_hash: payloadHash,
          attempt_count: 1,
          first_dispatched_at: dbNow,
          last_attempt_at: dbNow,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 7. Call PayPal Orders v2 createOrder
      let orderResult: CreateOrderResult;
      try {
        orderResult = await this.paymentPort.createOrder({
          tenantId,
          bookingId,
          amount: {
            currency: currencyCodeSchema.parse(snapshot.currency),
            valueMinor: moneyMinorSchema.parse(snapshot.deposit_minor),
          },
          requestId: idempotencyKey,
        });
      } catch (err: unknown) {
        await trx
          .updateTable("provider_operations")
          .set({
            state: "SENT_UNKNOWN",
            error_code: (err as Error).name,
            updated_at: dbNow,
          })
          .where("id", "=", operationId)
          .execute();
        throw err;
      }

      // 8. Update provider operation and persist payment intent
      await trx
        .updateTable("provider_operations")
        .set({
          state: "SUCCEEDED",
          provider_order_id: orderResult.providerOrderId,
          updated_at: dbNow,
        })
        .where("id", "=", operationId)
        .execute();

      const paymentExpiresAt = booking.payment_expires_at ?? new Date(dbNow.getTime() + 10 * 60_000);

      await trx
        .insertInto("payment_intents")
        .values({
          id: orderResult.paymentIntentId,
          tenant_id: tenantId,
          booking_id: bookingId,
          provider_order_id: orderResult.providerOrderId,
          amount_minor: snapshot.deposit_minor,
          currency: snapshot.currency,
          state: "REQUIRES_PAYER_ACTION",
          payment_expires_at: paymentExpiresAt,
          request_id: idempotencyKey,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 9. Transition booking state to REQUIRES_PAYER_ACTION
      await trx
        .updateTable("bookings")
        .set({
          status: "REQUIRES_PAYER_ACTION",
          version: booking.version + 1,
        })
        .where("id", "=", bookingId)
        .execute();

      return {
        paymentIntentId: orderResult.paymentIntentId,
        paypalOrderId: orderResult.providerOrderId,
        amount: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(snapshot.deposit_minor),
        },
        status: "REQUIRES_PAYER_ACTION" as const,
        paymentExpiresAt: paymentExpiresAt.toISOString(),
      };
    });

    if ("expired" in result) {
      throw new SlotUnavailableError("Payment window expired before deposit order creation", {
        paymentExpiresAt: result.paymentExpiresAt,
        dbTime: result.dbTime,
      });
    }

    return result;
  }

  /**
   * W5: Captures payment for an approved deposit order.
   * Confirmation condition: capture status == COMPLETED.
   * Specification v1.1 Amendment Section F.1 & F.5.
   */
  async capturePayment(params: {
    tenantId: TenantId;
    paymentIntentId: PaymentIntentId;
    idempotencyKey: string;
  }): Promise<CapturePaymentOutcome> {
    const { tenantId, paymentIntentId, idempotencyKey } = params;

    const result = await withTenantTransaction(
      this.db,
      tenantId,
      async (
        trx,
      ): Promise<{ expired: true; paymentExpiresAt: string; dbTime: string } | CapturePaymentOutcome> => {
      // 1. Lock payment intent and booking rows
      const intent = await trx
        .selectFrom("payment_intents")
        .where("id", "=", paymentIntentId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!intent) {
        throw new DomainError("Payment intent not found", "PAYMENT_INTENT_NOT_FOUND", 404);
      }

      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", intent.booking_id)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError("Booking not found", "BOOKING_NOT_FOUND", 404);
      }

      // Check if already captured (idempotent replay)
      if (intent.state === "CAPTURED" && booking.status === "CONFIRMED") {
        const capture = await trx
          .selectFrom("payment_captures")
          .where("payment_intent_id", "=", paymentIntentId)
          .where("tenant_id", "=", tenantId)
          .selectAll()
          .executeTakeFirst();

        return {
          bookingId: bookingIdSchema.parse(booking.id),
          bookingStatus: "CONFIRMED" as const,
          paymentStatus: "CAPTURED" as const,
          providerCaptureId: capture?.provider_capture_id,
          version: booking.version,
        };
      }

      // 2. Verify database clock against payment_expires_at
      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      if (booking.payment_expires_at && dbNow.getTime() >= booking.payment_expires_at.getTime()) {
        await trx
          .updateTable("bookings")
          .set({ status: "PAYMENT_WINDOW_EXPIRED", version: booking.version + 1 })
          .where("id", "=", booking.id)
          .execute();

        await trx
          .updateTable("resource_claims")
          .set({ state: "RELEASED", blocking: false })
          .where("booking_id", "=", booking.id)
          .where("tenant_id", "=", tenantId)
          .execute();

        return {
          expired: true as const,
          paymentExpiresAt: booking.payment_expires_at.toISOString(),
          dbTime: dbNow.toISOString(),
        };
      }

      // 3. Record provider operation in DISPATCHING state before remote call
      const operationId = crypto.randomUUID();
      const canonicalPayload = {
        tenantId,
        paymentIntentId,
        providerOrderId: intent.provider_order_id,
        amountMinor: intent.amount_minor,
      };
      const payloadHash = canonicalHash(canonicalPayload);

      await trx
        .insertInto("provider_operations")
        .values({
          id: operationId,
          tenant_id: tenantId,
          booking_id: booking.id,
          provider: "PAYPAL",
          environment: "sandbox",
          operation_type: "CAPTURE",
          state: "DISPATCHING",
          endpoint: `/v2/checkout/orders/${intent.provider_order_id}/capture`,
          paypal_request_id: idempotencyKey,
          canonical_payload_hash: payloadHash,
          provider_order_id: intent.provider_order_id,
          attempt_count: 1,
          first_dispatched_at: dbNow,
          last_attempt_at: dbNow,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 4. Call PayPal capture API
      let captureResult: CapturePaymentResult;
      try {
        captureResult = await this.paymentPort.capturePayment({
          tenantId,
          paymentIntentId,
          providerOrderId: intent.provider_order_id ?? "",
          amount: {
            currency: currencyCodeSchema.parse(intent.currency),
            valueMinor: moneyMinorSchema.parse(intent.amount_minor),
          },
          requestId: idempotencyKey,
        });
      } catch (err: unknown) {
        // Unknown outcome (timeout, 5xx): retain claim as blocking, mark SENT_UNKNOWN & CAPTURE_UNCERTAIN
        await trx
          .updateTable("provider_operations")
          .set({
            state: "SENT_UNKNOWN",
            error_code: (err as Error).name,
            updated_at: dbNow,
          })
          .where("id", "=", operationId)
          .execute();

        await trx
          .updateTable("bookings")
          .set({ status: "CAPTURE_UNCERTAIN", version: booking.version + 1 })
          .where("id", "=", booking.id)
          .execute();

        await trx
          .updateTable("resource_claims")
          .set({ state: "CAPTURE_UNCERTAIN", blocking: true })
          .where("booking_id", "=", booking.id)
          .where("tenant_id", "=", tenantId)
          .execute();

        return {
          bookingId: bookingIdSchema.parse(booking.id),
          bookingStatus: "CAPTURE_UNCERTAIN",
          paymentStatus: "UNCERTAIN",
          operationId,
          statusUrl: `/v1/operations/${operationId}`,
        };
      }

      // 5. Handle authoritative COMPLETED capture
      if (captureResult.status === "CAPTURED") {
        const nextVersion = booking.version + 1;

        // Persist payment capture record
        await trx
          .insertInto("payment_captures")
          .values({
            id: captureResult.paymentCaptureId,
            tenant_id: tenantId,
            payment_intent_id: paymentIntentId,
            booking_id: booking.id,
            provider_capture_id: captureResult.providerCaptureId,
            amount_minor: intent.amount_minor,
            currency: intent.currency,
            state: "COMPLETED",
            captured_at: dbNow,
            created_at: dbNow,
          })
          .execute();

        // Update payment intent to CAPTURED
        await trx
          .updateTable("payment_intents")
          .set({ state: "CAPTURED", updated_at: dbNow })
          .where("id", "=", paymentIntentId)
          .execute();

        // Transition booking to CONFIRMED
        await trx
          .updateTable("bookings")
          .set({ status: "CONFIRMED", version: nextVersion })
          .where("id", "=", booking.id)
          .execute();

        // Resource claim becomes CONFIRMED and blocking
        await trx
          .updateTable("resource_claims")
          .set({ state: "CONFIRMED", blocking: true })
          .where("booking_id", "=", booking.id)
          .where("tenant_id", "=", tenantId)
          .execute();

        // Update provider operation
        await trx
          .updateTable("provider_operations")
          .set({
            state: "SUCCEEDED",
            provider_capture_id: captureResult.providerCaptureId,
            updated_at: dbNow,
          })
          .where("id", "=", operationId)
          .execute();

        // W8: Double-entry financial journal entry
        const entryId = crypto.randomUUID();
        await trx
          .insertInto("financial_journal_entries")
          .values({
            id: entryId,
            tenant_id: tenantId,
            booking_id: booking.id,
            entry_type: "DEPOSIT_CAPTURE",
            reference_id: captureResult.paymentCaptureId,
            currency: intent.currency,
            posted_at: dbNow,
          })
          .execute();

        // Balanced debit & credit lines:
        // Debit: ASSET:PAYPAL_CLEARING
        // Credit: LIABILITY:CUSTOMER_DEPOSIT
        await trx
          .insertInto("financial_journal_lines")
          .values([
            {
              id: crypto.randomUUID(),
              journal_entry_id: entryId,
              tenant_id: tenantId,
              account: "ASSET:PAYPAL_CLEARING",
              debit_minor: intent.amount_minor,
              credit_minor: "0",
              currency: intent.currency,
              created_at: dbNow,
            },
            {
              id: crypto.randomUUID(),
              journal_entry_id: entryId,
              tenant_id: tenantId,
              account: "LIABILITY:CUSTOMER_DEPOSIT",
              debit_minor: "0",
              credit_minor: intent.amount_minor,
              currency: intent.currency,
              created_at: dbNow,
            },
          ])
          .execute();

        // Outbox event
        await trx
          .insertInto("outbox_events")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            aggregate_type: "BOOKING",
            aggregate_id: booking.id,
            event_type: "PAYMENT_CAPTURED",
            payload: JSON.stringify({
              bookingId: booking.id,
              captureId: captureResult.paymentCaptureId,
              providerCaptureId: captureResult.providerCaptureId,
              amountMinor: intent.amount_minor,
              currency: intent.currency,
            }),
            created_at: dbNow,
          })
          .execute();

        return {
          bookingId: bookingIdSchema.parse(booking.id),
          bookingStatus: "CONFIRMED" as const,
          paymentStatus: "CAPTURED" as const,
          providerCaptureId: captureResult.providerCaptureId,
          version: nextVersion,
        };
      }

      // 6. Handle UNCERTAIN capture (e.g. PayPal PENDING)
      if (captureResult.status === "UNCERTAIN") {
        await trx
          .updateTable("provider_operations")
          .set({
            state: "PENDING",
            provider_capture_id: captureResult.providerCaptureId,
            updated_at: dbNow,
          })
          .where("id", "=", operationId)
          .execute();

        await trx
          .updateTable("bookings")
          .set({ status: "CAPTURE_UNCERTAIN", version: booking.version + 1 })
          .where("id", "=", booking.id)
          .execute();

        await trx
          .updateTable("resource_claims")
          .set({ state: "CAPTURE_UNCERTAIN", blocking: true })
          .where("booking_id", "=", booking.id)
          .where("tenant_id", "=", tenantId)
          .execute();

        return {
          bookingId: bookingIdSchema.parse(booking.id),
          bookingStatus: "CAPTURE_UNCERTAIN" as const,
          paymentStatus: "UNCERTAIN" as const,
          providerCaptureId: captureResult.providerCaptureId,
          operationId,
          statusUrl: `/v1/operations/${operationId}`,
        };
      }

      // 7. Handle authoritative FAILED capture (DECLINED / FAILED)
      await trx
        .updateTable("provider_operations")
        .set({
          state: "FAILED_TERMINAL",
          updated_at: dbNow,
        })
        .where("id", "=", operationId)
        .execute();

      await trx
        .updateTable("payment_intents")
        .set({ state: "FAILED", updated_at: dbNow })
        .where("id", "=", paymentIntentId)
        .execute();

      await trx
        .updateTable("bookings")
        .set({ status: "CANCELLED", version: booking.version + 1 })
        .where("id", "=", booking.id)
        .execute();

      await trx
        .updateTable("resource_claims")
        .set({ state: "RELEASED", blocking: false })
        .where("booking_id", "=", booking.id)
        .where("tenant_id", "=", tenantId)
        .execute();

      return {
        bookingId: bookingIdSchema.parse(booking.id),
        bookingStatus: "CANCELLED" as const,
        paymentStatus: "FAILED" as const,
        version: booking.version + 1,
      };
    });

    if ("expired" in result) {
      throw new SlotUnavailableError("Payment window expired before capture dispatch", {
        paymentExpiresAt: result.paymentExpiresAt,
        dbTime: result.dbTime,
      });
    }

    return result;
  }

  /**
   * W7: Refunds a captured payment with strict row-lock balance reservation.
   * Specification v1.1 Amendment Section F.6.
   */
  async refundPayment(params: {
    tenantId: TenantId;
    captureId: PaymentCaptureId;
    amountMinor?: string;
    reason: string;
    actorRole: string;
    idempotencyKey: string;
  }): Promise<RefundOutcome> {
    const { tenantId, captureId, amountMinor, reason, actorRole, idempotencyKey } = params;

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Lock payment_captures row
      const capture = await trx
        .selectFrom("payment_captures")
        .where("id", "=", captureId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!capture) {
        throw new DomainError("Payment capture not found", "CAPTURE_NOT_FOUND", 404);
      }

      if (capture.state !== "COMPLETED" && capture.state !== "PARTIALLY_REFUNDED") {
        throw new DomainError(`Cannot refund capture in state: ${capture.state}`, "INVALID_CAPTURE_STATE", 400);
      }

      // 2. Query all existing refund reservations under capture lock
      const existingReservations = await trx
        .selectFrom("refund_reservations")
        .where("capture_id", "=", captureId)
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["RESERVED", "DISPATCHING", "COMPLETED", "UNKNOWN"])
        .selectAll()
        .execute();

      const totalReservedMinor = existingReservations.reduce(
        (sum, r) => sum + BigInt(r.amount_minor),
        0n,
      );

      const capturedMinor = BigInt(capture.amount_minor);
      const remainingRefundableMinor = capturedMinor - totalReservedMinor;

      // 3. Determine refund amount
      let targetRefundMinor: bigint;
      if (actorRole === "MERCHANT") {
        targetRefundMinor = amountMinor ? BigInt(amountMinor) : remainingRefundableMinor;
      } else {
        // Policy-driven buyer cancellation: server calculates authoritative refund
        targetRefundMinor = remainingRefundableMinor;
      }

      if (targetRefundMinor <= 0n) {
        throw new DomainError("Refund amount must be positive", "INVALID_REFUND_AMOUNT", 400);
      }

      if (targetRefundMinor > remainingRefundableMinor) {
        throw new DomainError(
          `Requested refund (${targetRefundMinor}) exceeds available refundable balance (${remainingRefundableMinor})`,
          "EXCEEDS_REFUNDABLE_BALANCE",
          409,
        );
      }

      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      // 4. Create immutable refund reservation row
      const refundId = refundIdSchema.parse(crypto.randomUUID());
      await trx
        .insertInto("refund_reservations")
        .values({
          id: refundId,
          tenant_id: tenantId,
          capture_id: captureId,
          booking_id: capture.booking_id,
          amount_minor: targetRefundMinor.toString(),
          currency: capture.currency,
          reason,
          state: "RESERVED",
          request_id: idempotencyKey,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 5. Record provider operation in DISPATCHING state
      const operationId = crypto.randomUUID();
      await trx
        .insertInto("provider_operations")
        .values({
          id: operationId,
          tenant_id: tenantId,
          booking_id: capture.booking_id,
          provider: "PAYPAL",
          environment: "sandbox",
          operation_type: "REFUND",
          state: "DISPATCHING",
          endpoint: `/v2/payments/captures/${capture.provider_capture_id}/refund`,
          paypal_request_id: idempotencyKey,
          canonical_payload_hash: canonicalHash({
            tenantId,
            captureId,
            refundMinor: targetRefundMinor.toString(),
          }),
          provider_capture_id: capture.provider_capture_id,
          attempt_count: 1,
          first_dispatched_at: dbNow,
          last_attempt_at: dbNow,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 6. Call PayPal refund API
      let refundResult: RefundPaymentResult;
      try {
        refundResult = await this.paymentPort.refundPayment({
          tenantId,
          paymentCaptureId: captureId,
          providerCaptureId: capture.provider_capture_id,
          amount: {
            currency: currencyCodeSchema.parse(capture.currency),
            valueMinor: moneyMinorSchema.parse(targetRefundMinor.toString()),
          },
          requestId: idempotencyKey,
        });
      } catch (err: unknown) {
        // Unknown outcome / timeout: reservation remains locked
        await trx
          .updateTable("provider_operations")
          .set({ state: "SENT_UNKNOWN", error_code: (err as Error).name, updated_at: dbNow })
          .where("id", "=", operationId)
          .execute();

        await trx
          .updateTable("refund_reservations")
          .set({ state: "UNKNOWN", updated_at: dbNow })
          .where("id", "=", refundId)
          .execute();

        return {
          refundId,
          amount: {
            currency: currencyCodeSchema.parse(capture.currency),
            valueMinor: moneyMinorSchema.parse(targetRefundMinor.toString()),
          },
          status: "UNCERTAIN",
        };
      }

      // 7. On COMPLETED refund
      if (refundResult.status === "COMPLETED") {
        await trx
          .updateTable("refund_reservations")
          .set({
            state: "COMPLETED",
            provider_refund_id: refundResult.providerRefundId,
            updated_at: dbNow,
          })
          .where("id", "=", refundId)
          .execute();

        const newTotalRefunded = totalReservedMinor + targetRefundMinor;
        const newCaptureState = newTotalRefunded >= capturedMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";

        await trx
          .updateTable("payment_captures")
          .set({ state: newCaptureState })
          .where("id", "=", captureId)
          .execute();

        await trx
          .updateTable("provider_operations")
          .set({
            state: "SUCCEEDED",
            provider_refund_id: refundResult.providerRefundId,
            updated_at: dbNow,
          })
          .where("id", "=", operationId)
          .execute();

        // W8: Double-entry financial journal reversal entry
        const entryId = crypto.randomUUID();
        await trx
          .insertInto("financial_journal_entries")
          .values({
            id: entryId,
            tenant_id: tenantId,
            booking_id: capture.booking_id,
            entry_type: "REFUND",
            reference_id: refundId,
            currency: capture.currency,
            posted_at: dbNow,
          })
          .execute();

        // Reversal lines:
        // Debit: LIABILITY:CUSTOMER_DEPOSIT
        // Credit: ASSET:PAYPAL_CLEARING
        await trx
          .insertInto("financial_journal_lines")
          .values([
            {
              id: crypto.randomUUID(),
              journal_entry_id: entryId,
              tenant_id: tenantId,
              account: "LIABILITY:CUSTOMER_DEPOSIT",
              debit_minor: targetRefundMinor.toString(),
              credit_minor: "0",
              currency: capture.currency,
              created_at: dbNow,
            },
            {
              id: crypto.randomUUID(),
              journal_entry_id: entryId,
              tenant_id: tenantId,
              account: "ASSET:PAYPAL_CLEARING",
              debit_minor: "0",
              credit_minor: targetRefundMinor.toString(),
              currency: capture.currency,
              created_at: dbNow,
            },
          ])
          .execute();

        return {
          refundId,
          providerRefundId: refundResult.providerRefundId,
          amount: {
            currency: currencyCodeSchema.parse(capture.currency),
            valueMinor: moneyMinorSchema.parse(targetRefundMinor.toString()),
          },
          status: "COMPLETED",
        };
      }

      return {
        refundId,
        providerRefundId: refundResult.providerRefundId,
        amount: {
          currency: currencyCodeSchema.parse(capture.currency),
          valueMinor: moneyMinorSchema.parse(targetRefundMinor.toString()),
        },
        status: refundResult.status,
      };
    });
  }

  /**
   * W8: Creates and sends an Invoicing v2 draft for post-appointment balance billing.
   * Specification v1.1 Amendment Section F.7 & W8.
   */
  async createBalanceInvoice(params: {
    tenantId: TenantId;
    bookingId: BookingId;
    customerEmail?: string;
    customerName?: string;
  }): Promise<BalanceInvoiceResult> {
    const { tenantId, bookingId, customerEmail, customerName } = params;

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Verify booking is COMPLETED (fulfilled appointment)
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError("Booking not found", "BOOKING_NOT_FOUND", 404);
      }

      if (booking.status !== "COMPLETED") {
        throw new DomainError(
          `Balance invoice requires appointment status COMPLETED; current: ${booking.status}`,
          "APPOINTMENT_NOT_COMPLETED",
          400,
        );
      }

      // 2. Fetch snapshot for service price total
      const snapshot = await trx
        .selectFrom("booking_hold_snapshots")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();

      if (!snapshot) {
        throw new DomainError("Booking snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
      }

      // 3. Compute net deposit captured (captures minus refunds)
      const captures = await trx
        .selectFrom("payment_captures")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .where("state", "in", ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"])
        .selectAll()
        .execute();

      const totalCaptured = captures.reduce((acc, c) => acc + BigInt(c.amount_minor), 0n);

      const refunds = await trx
        .selectFrom("refund_reservations")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .where("state", "=", "COMPLETED")
        .selectAll()
        .execute();

      const totalRefunded = refunds.reduce((acc, r) => acc + BigInt(r.amount_minor), 0n);
      const netDepositPaid = totalCaptured - totalRefunded;

      const totalServicePrice = BigInt(snapshot.total_minor);
      const balanceDue = totalServicePrice - netDepositPaid;

      if (balanceDue <= 0n) {
        throw new DomainError("No balance due for this booking", "NO_BALANCE_DUE", 400);
      }

      const email = customerEmail ?? "customer@example.com";

      // 4. Create PayPal Invoicing v2 draft
      const draftResult = await this.paymentPort.createInvoiceDraft({
        tenantId,
        bookingId,
        amount: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(totalServicePrice.toString()),
        },
        depositPaid: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(netDepositPaid.toString()),
        },
        balanceDue: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(balanceDue.toString()),
        },
        serviceName: "VelvetAI Salon Service",
        customerEmail: email,
        customerName,
      });

      const invoiceId = crypto.randomUUID();
      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      // 5. Persist invoice record in internal projection
      await trx
        .insertInto("invoices")
        .values({
          id: invoiceId,
          tenant_id: tenantId,
          booking_id: bookingId,
          provider_invoice_id: draftResult.providerInvoiceId,
          provider_invoice_number: draftResult.providerInvoiceNumber,
          status: "DRAFT",
          total_minor: totalServicePrice.toString(),
          deposit_paid_minor: netDepositPaid.toString(),
          balance_due_minor: balanceDue.toString(),
          currency: snapshot.currency,
          created_at: dbNow,
          updated_at: dbNow,
        })
        .execute();

      // 6. Send invoice via PayPal API
      await this.paymentPort.sendInvoice(draftResult.providerInvoiceId);

      await trx
        .updateTable("invoices")
        .set({ status: "SENT", updated_at: dbNow })
        .where("id", "=", invoiceId)
        .execute();

      return {
        invoiceId,
        providerInvoiceId: draftResult.providerInvoiceId,
        providerInvoiceNumber: draftResult.providerInvoiceNumber,
        status: "SENT",
        total: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(totalServicePrice.toString()),
        },
        depositPaid: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(netDepositPaid.toString()),
        },
        balanceDue: {
          currency: currencyCodeSchema.parse(snapshot.currency),
          valueMinor: moneyMinorSchema.parse(balanceDue.toString()),
        },
      };
    });
  }

  /**
   * W6: Ingests raw webhook body into quarantine table without parsing.
   * Specification v1.1 Amendment Section G.1.
   */
  async ingestWebhookDelivery(params: {
    connectionKey: string;
    environment: string;
    transmissionId: string;
    transmissionTime: string;
    certUrl: string;
    authAlgo: string;
    transmissionSig: string;
    rawPayload: string;
    bodyBytesLength: number;
  }): Promise<{ deliveryId: string }> {
    const deliveryId = crypto.randomUUID();
    const dbNow = new Date();

    await this.db
      .insertInto("webhook_deliveries")
      .values({
        id: deliveryId,
        connection_key: params.connectionKey,
        environment: params.environment,
        transmission_id: params.transmissionId,
        transmission_time: params.transmissionTime,
        cert_url: params.certUrl,
        auth_algo: params.authAlgo,
        transmission_sig: params.transmissionSig,
        raw_payload: params.rawPayload,
        body_bytes_length: params.bodyBytesLength,
        verification_state: "UNVERIFIED",
        received_at: dbNow,
      })
      .execute();

    return { deliveryId };
  }

  /**
   * W6: Verifies an unverified webhook delivery and reconciles domain state idempotently.
   */
  async processWebhookDelivery(deliveryId: string, explicitTenantId?: TenantId): Promise<boolean> {
    const delivery = await this.db
      .selectFrom("webhook_deliveries")
      .where("id", "=", deliveryId)
      .selectAll()
      .executeTakeFirst();

    if (!delivery || delivery.verification_state !== "UNVERIFIED") {
      return false;
    }

    const isValid = await this.paymentPort.verifyWebhookSignature({
      headers: {
        "paypal-transmission-id": delivery.transmission_id,
        "paypal-transmission-time": delivery.transmission_time,
        "paypal-cert-url": delivery.cert_url,
        "paypal-auth-algo": delivery.auth_algo,
        "paypal-transmission-sig": delivery.transmission_sig,
      },
      rawBody: delivery.raw_payload,
    });

    if (!isValid) {
      await this.db
        .updateTable("webhook_deliveries")
        .set({ verification_state: "REJECTED" })
        .where("id", "=", deliveryId)
        .execute();
      return false;
    }

    await this.db
      .updateTable("webhook_deliveries")
      .set({ verification_state: "VERIFIED" })
      .where("id", "=", deliveryId)
      .execute();

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(delivery.raw_payload) as Record<string, unknown>;
    } catch {
      return false;
    }

    const providerEventId = String(event.id ?? "");
    const eventType = event.event_type as string;
    if (!providerEventId || !eventType) {
      return false;
    }

    // Resolve tenantId either from parameter or by checking tenant connections
    let tenantId = explicitTenantId;
    let connectionId: string | null = null;

    if (tenantId) {
      const conn = await withTenantTransaction(this.db, tenantId, (trx) =>
        trx
          .selectFrom("provider_connections")
          .where("connection_key", "=", delivery.connection_key)
          .selectAll()
          .executeTakeFirst(),
      );
      connectionId = conn?.id ?? null;
    } else {
      const tenants = await this.db.selectFrom("tenants").select("id").execute();
      for (const t of tenants) {
        const conn = await withTenantTransaction(this.db, t.id as TenantId, (trx) =>
          trx
            .selectFrom("provider_connections")
            .where("connection_key", "=", delivery.connection_key)
            .selectAll()
            .executeTakeFirst(),
        );
        if (conn) {
          tenantId = t.id as TenantId;
          connectionId = conn.id;
          break;
        }
      }
    }

    if (!tenantId) {
      return false;
    }

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // Check for duplicate verified event under tenant isolation
      const existingVerified = await trx
        .selectFrom("verified_provider_events")
        .where("provider_event_id", "=", providerEventId)
        .selectAll()
        .executeTakeFirst();

      if (existingVerified) {
        // Idempotently skip re-processing
        return true;
      }

      const verifiedEventId = crypto.randomUUID();
      const resource = (event.resource as Record<string, unknown> | undefined) ?? {};
      const resourceId = typeof resource.id === "string" ? resource.id : null;

      await trx
        .insertInto("verified_provider_events")
        .values({
          id: verifiedEventId,
          tenant_id: tenantId!,
          provider_connection_id: connectionId,
          environment: delivery.environment,
          provider_event_id: providerEventId,
          event_type: eventType,
          transmission_id: delivery.transmission_id,
          resource_id: resourceId,
          resource_type: typeof event.resource_type === "string" ? event.resource_type : null,
          reconciliation_state: "PROCESSED",
          verified_at: new Date(),
        })
        .execute();

      // Reconcile capture completion if event is PAYMENT.CAPTURE.COMPLETED
      if (eventType === "PAYMENT.CAPTURE.COMPLETED" && resourceId) {
        const capture = await trx
          .selectFrom("payment_captures")
          .where("provider_capture_id", "=", resourceId)
          .selectAll()
          .forUpdate()
          .executeTakeFirst();

        if (capture && capture.state !== "COMPLETED") {
          await trx
            .updateTable("payment_captures")
            .set({ state: "COMPLETED" })
            .where("id", "=", capture.id)
            .execute();

          await trx
            .updateTable("bookings")
            .set({ status: "CONFIRMED" })
            .where("id", "=", capture.booking_id)
            .execute();

          await trx
            .updateTable("resource_claims")
            .set({ state: "CONFIRMED", blocking: true })
            .where("booking_id", "=", capture.booking_id)
            .execute();
        }
      }

      return true;
    });

    return true;
  }
}

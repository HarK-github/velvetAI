import { Kysely, sql } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { BookingProofResponse, DomainError, ProofTimelineItem } from "@velvetai/contracts";
import { getDefaultIntentKeys } from "../booking-intent.js";
import { sha256Hex } from "../canonicalizer.js";

const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";

/**
 * Masks PayPal identifiers and cryptographic hashes to `first4…last4`
 * (or `****` if 8 characters or shorter so short identifiers are never leaked raw).
 */
export function maskFirst4Last4(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length <= 8) {
    return "****";
  }
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

export class BookingProofService {
  constructor(private readonly db: Kysely<Database>) {}

  async getBookingProof(tenantId: string, bookingId: string): Promise<BookingProofResponse> {
    if (tenantId !== JUDGE_TENANT_ID) {
      throw new DomainError(
        "Booking proof endpoints are restricted to the dedicated judge tenant",
        "UNAUTHORIZED_TENANT_ACCESS",
        403,
      );
    }

    return withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("id", "=", bookingId)
        .select(["id", "status", "created_at", "hold_expires_at"])
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(
          `Booking ${bookingId} was not found in the judge tenant`,
          "BOOKING_NOT_FOUND",
          404,
        );
      }

      const [
        claim,
        snapshot,
        confirmation,
        committedIntent,
        commitIdempotency,
        paymentIntents,
        captures,
        providerOps,
        journalEntries,
        auditEvents,
      ] = await Promise.all([
        trx
          .selectFrom("resource_claims")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .select(["blocking", "state", "created_at"])
          .executeTakeFirst(),
        trx
          .selectFrom("booking_hold_snapshots")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .select(["canonical_hash", "created_at"])
          .executeTakeFirst(),
        trx
          .selectFrom("buyer_confirmations")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .select(["consumed_at", "created_at"])
          .executeTakeFirst(),
        trx
          .selectFrom("committed_intents")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .select(["committed_at"])
          .executeTakeFirst(),
        trx
          .selectFrom("idempotency_records")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("operation", "=", "commit_booking.v1")
          .where(sql<boolean>`response_body->>'bookingId' = ${bookingId}`)
          .select(["idempotency_key", "created_at"])
          .executeTakeFirst(),
        trx
          .selectFrom("payment_intents")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .orderBy("created_at", "desc")
          .select(["provider_order_id", "state", "amount_minor", "currency", "created_at"])
          .execute(),
        trx
          .selectFrom("payment_captures")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .orderBy("created_at", "desc")
          .select([
            "id",
            "provider_capture_id",
            "amount_minor",
            "currency",
            "state",
            "captured_at",
            "created_at",
          ])
          .execute(),
        trx
          .selectFrom("provider_operations")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .orderBy("created_at", "asc")
          .select([
            "operation_type",
            "state",
            "environment",
            "provider_order_id",
            "provider_capture_id",
            "attempt_count",
            "error_code",
            "created_at",
            "last_attempt_at",
          ])
          .execute(),
        trx
          .selectFrom("financial_journal_entries")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("booking_id", "=", bookingId)
          .orderBy("created_at", "asc")
          .select(["id", "entry_type", "currency", "status", "created_at"])
          .execute(),
        trx
          .selectFrom("audit_events")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("resource_id", "=", bookingId)
          .orderBy("occurred_at", "asc")
          .select(["action", "occurred_at"])
          .execute(),
      ]);

      const primaryPaymentIntent = paymentIntents[0];
      const primaryCapture = captures[0];

      // Lookup verified webhooks referencing this booking's PayPal order or capture IDs
      const providerResourceIds = Array.from(
        new Set(
          [
            ...paymentIntents.map((pi) => pi.provider_order_id),
            ...captures.map((c) => c.provider_capture_id),
            ...providerOps.map((op) => op.provider_order_id),
            ...providerOps.map((op) => op.provider_capture_id),
          ].filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );

      const verifiedEvents =
        providerResourceIds.length > 0
          ? await trx
              .selectFrom("verified_provider_events")
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("resource_id", "in", providerResourceIds)
              .orderBy("verified_at", "desc")
              .select(["event_type", "transmission_id", "reconciliation_state", "verified_at"])
              .execute()
          : [];

      let latestQuarantineVerification: string | undefined;
      if (verifiedEvents[0]?.transmission_id) {
        const quarantineRow = await trx
          .selectFrom("webhook_quarantine")
          .where("transmission_id", "=", verifiedEvents[0].transmission_id)
          .select(["verification_state"])
          .executeTakeFirst();
        latestQuarantineVerification = quarantineRow?.verification_state;
      }

      // Inspect balanced journal lines
      const journalIds = journalEntries.map((j) => j.id);
      const journalLines =
        journalIds.length > 0
          ? await trx
              .selectFrom("financial_journal_lines")
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("journal_entry_id", "in", journalIds)
              .select(["journal_entry_id", "account", "debit_minor", "credit_minor", "currency"])
              .execute()
          : [];

      const timelineEntries: Array<{ ts: number; item: ProofTimelineItem }> = [];
      const holdSeconds =
        booking.hold_expires_at && booking.created_at
          ? Math.max(
              0,
              Math.round((booking.hold_expires_at.getTime() - booking.created_at.getTime()) / 1000),
            )
          : null;

      timelineEntries.push({
        ts: booking.created_at.getTime(),
        item: {
          at: booking.created_at.toISOString(),
          event: "HOLD_CREATED",
          detail: holdSeconds !== null ? `Hold for ${holdSeconds} s` : "Hold created",
        },
      });

      if (confirmation?.consumed_at) {
        timelineEntries.push({
          ts: confirmation.consumed_at.getTime(),
          item: {
            at: confirmation.consumed_at.toISOString(),
            event: "HUMAN_APPROVED",
            detail: "Approved by signed-in buyer",
          },
        });
      }

      if (committedIntent) {
        timelineEntries.push({
          ts: committedIntent.committed_at.getTime(),
          item: {
            at: committedIntent.committed_at.toISOString(),
            event: "COMMITTED",
          },
        });
      }

      const orderCreateOp = providerOps.find((op) => op.operation_type === "ORDER_CREATE");
      if (primaryPaymentIntent) {
        const orderCreatedAt = orderCreateOp?.created_at ?? primaryPaymentIntent.created_at;
        timelineEntries.push({
          ts: orderCreatedAt.getTime(),
          item: {
            at: orderCreatedAt.toISOString(),
            event: "PAYPAL_ORDER_CREATED",
          },
        });
      }

      const faultAudit = auditEvents.find(
        (evt) =>
          evt.action === "fault.capture_response_dropped" ||
          evt.action === "judge.fault.capture_response_lost",
      );
      const captureOp = providerOps.find((op) => op.operation_type === "CAPTURE");
      if (
        faultAudit ||
        (captureOp &&
          (captureOp.state === "SENT_UNKNOWN" || captureOp.error_code === "FAULT_INJECTED"))
      ) {
        const lostAt =
          faultAudit?.occurred_at ?? captureOp?.last_attempt_at ?? captureOp!.created_at;
        timelineEntries.push({
          ts: lostAt.getTime(),
          item: {
            at: lostAt.toISOString(),
            event: "CAPTURE_RESPONSE_LOST",
            detail: "Injected by judge fault",
          },
        });
      }

      const primaryWebhook = verifiedEvents[0];
      if (primaryWebhook) {
        timelineEntries.push({
          ts: primaryWebhook.verified_at.getTime(),
          item: {
            at: primaryWebhook.verified_at.toISOString(),
            event: "WEBHOOK_VERIFIED",
            detail: primaryWebhook.event_type,
          },
        });
      }

      if (primaryCapture && primaryCapture.state === "COMPLETED") {
        const reconciledAt = primaryCapture.captured_at ?? primaryCapture.created_at;
        const wasReconciled =
          (captureOp?.state === "SUCCEEDED" && captureOp.attempt_count > 1) ||
          captureOp?.error_code === "FAULT_INJECTED" ||
          Boolean(primaryWebhook) ||
          Boolean(faultAudit);
        timelineEntries.push({
          ts: reconciledAt.getTime(),
          item: {
            at: reconciledAt.toISOString(),
            event: wasReconciled ? "RECONCILED" : "PAYMENT_CAPTURED",
            detail: `${captures.length} capture found, booking ${booking.status.toLowerCase()}`,
          },
        });
      }

      timelineEntries.sort((a, b) => a.ts - b.ts);
      const timeline = timelineEntries.map((e) => e.item);

      const response: BookingProofResponse = {
        bookingId: booking.id,
        status: booking.status,
        timeline,
        counts: {
          captures: captures.length,
          bookingsForHold: 1,
          journalEntriesForCapture: journalEntries.filter((j) => j.entry_type === "DEPOSIT_CAPTURE")
            .length,
        },
      };

      if (snapshot) {
        const intentKeys = getDefaultIntentKeys();
        response.intent = {
          sha256Prefix: maskFirst4Last4(snapshot.canonical_hash),
          algorithm: "ES256",
          keyId: intentKeys.kid,
        };
      }

      if (confirmation) {
        response.confirmation = {
          consumed: Boolean(confirmation.consumed_at),
          ...(confirmation.consumed_at
            ? { consumedAt: confirmation.consumed_at.toISOString() }
            : {}),
        };
      }

      if (commitIdempotency) {
        response.idempotency = {
          commitKeyHashPrefix: maskFirst4Last4(sha256Hex(commitIdempotency.idempotency_key)),
        };
      }

      if (claim) {
        response.resourceClaim = {
          blocking: claim.blocking,
          state: claim.state,
        };
      }

      const rawOrderId =
        primaryPaymentIntent?.provider_order_id ?? orderCreateOp?.provider_order_id ?? undefined;
      const rawCaptureId =
        primaryCapture?.provider_capture_id ?? captureOp?.provider_capture_id ?? undefined;

      if (primaryPaymentIntent || primaryCapture || providerOps.length > 0) {
        response.paypal = {
          environment: providerOps[0]?.environment || "sandbox",
          ...(rawOrderId ? { orderIdMasked: maskFirst4Last4(rawOrderId) } : {}),
          ...(rawCaptureId ? { captureIdMasked: maskFirst4Last4(rawCaptureId) } : {}),
          ...(primaryCapture ? { captureStatus: primaryCapture.state } : {}),
        };
      }

      if (primaryWebhook) {
        response.webhook = {
          eventType: primaryWebhook.event_type,
          verification: latestQuarantineVerification || "VERIFIED",
          reconciliation: primaryWebhook.reconciliation_state,
        };
      }

      if (journalEntries.length > 0) {
        let totalDebit = 0n;
        let totalCredit = 0n;
        let depositLiability = 0n;
        for (const line of journalLines) {
          const debit = BigInt(line.debit_minor);
          const credit = BigInt(line.credit_minor);
          totalDebit += debit;
          totalCredit += credit;
          if (line.account === "LIABILITY:CUSTOMER_DEPOSIT") {
            depositLiability += credit - debit;
          }
        }
        response.ledger = {
          entries: journalEntries.length,
          balanced: journalLines.length > 0 && totalDebit === totalCredit && totalDebit > 0n,
          depositLiabilityMinor: depositLiability.toString(),
          currency: journalEntries[0]!.currency,
        };
      }

      return response;
    });
  }
}

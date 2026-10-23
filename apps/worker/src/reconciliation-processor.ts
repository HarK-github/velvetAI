import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { PaymentPort } from "@velvetai/application";
import { createLogger } from "@velvetai/observability";

export interface ReconciliationResult {
  reconciled: number;
  failed: number;
}

export class ReconciliationProcessor {
  private readonly logger = createLogger({ name: "reconciliation-processor" });

  constructor(
    private readonly db: Kysely<Database>,
    private readonly paymentPort: PaymentPort,
  ) {}

  /**
   * Reconciles uncertain PayPal operations using idx_provider_operations_reconcile index.
   * Resolves CAPTURE and REFUND operations against authoritative provider APIs.
   */
  async reconcilePendingOperations(limit = 25, tenantId?: string): Promise<ReconciliationResult> {
    const now = new Date();

    let query = this.db
      .selectFrom("provider_operations")
      .where("state", "in", ["SENT_UNKNOWN", "PENDING", "RECONCILING"])
      .where((eb) =>
        eb.or([eb("next_reconcile_at", "is", null), eb("next_reconcile_at", "<=", now)]),
      );

    if (tenantId) {
      query = query.where("tenant_id", "=", tenantId);
    }

    const ops = await query.selectAll().limit(limit).execute();

    let reconciled = 0;
    let failed = 0;

    for (const op of ops) {
      try {
        this.logger.debug({ opId: op.id, opType: op.operation_type }, "Reconciling operation");
        await withTenantTransaction(this.db, op.tenant_id, async (trx) => {
          await trx
            .updateTable("provider_operations")
            .set({ state: "RECONCILING", updated_at: now })
            .where("tenant_id", "=", op.tenant_id)
            .where("id", "=", op.id)
            .execute();
        });

        if (op.operation_type === "CAPTURE" && (op.provider_capture_id || op.provider_order_id)) {
          let captureStatus = "UNKNOWN";

          if (op.provider_capture_id) {
            const cap = await this.paymentPort.getCapture(op.provider_capture_id);
            captureStatus = cap.status;
          } else if (op.provider_order_id) {
            const ord = await this.paymentPort.getOrder(op.provider_order_id);
            if (ord.captures && ord.captures.length > 0) {
              captureStatus = ord.captures[0]!.status;
            }
          }

          if (captureStatus === "COMPLETED") {
            await withTenantTransaction(this.db, op.tenant_id, async (trx) => {
              await trx
                .updateTable("provider_operations")
                .set({ state: "SUCCEEDED", updated_at: new Date() })
                .where("tenant_id", "=", op.tenant_id)
                .where("id", "=", op.id)
                .execute();

              await trx
                .updateTable("payment_captures")
                .set({ state: "COMPLETED", captured_at: new Date() })
                .where("tenant_id", "=", op.tenant_id)
                .where("booking_id", "=", op.booking_id)
                .execute();

              await trx
                .updateTable("payment_intents")
                .set({ state: "CAPTURED", updated_at: new Date() })
                .where("tenant_id", "=", op.tenant_id)
                .where("booking_id", "=", op.booking_id)
                .execute();

              const booking = await trx
                .selectFrom("bookings")
                .where("tenant_id", "=", op.tenant_id)
                .where("id", "=", op.booking_id)
                .selectAll()
                .executeTakeFirst();

              if (booking && booking.status === "CANCEL_REQUESTED") {
                // If cancellation was requested during uncertain capture, now transition to CANCELLED and release claim
                await trx
                  .updateTable("bookings")
                  .set((eb) => ({ status: "CANCELLED", version: eb("version", "+", 1) }))
                  .where("tenant_id", "=", op.tenant_id)
                  .where("id", "=", op.booking_id)
                  .execute();

                await trx
                  .updateTable("resource_claims")
                  .set({ state: "RELEASED", blocking: false })
                  .where("tenant_id", "=", op.tenant_id)
                  .where("booking_id", "=", op.booking_id)
                  .execute();
              } else if (
                booking &&
                (booking.status === "COMMITTING" || booking.status === "CAPTURE_UNCERTAIN")
              ) {
                await trx
                  .updateTable("bookings")
                  .set((eb) => ({ status: "CONFIRMED", version: eb("version", "+", 1) }))
                  .where("tenant_id", "=", op.tenant_id)
                  .where("id", "=", op.booking_id)
                  .execute();

                await trx
                  .updateTable("resource_claims")
                  .set({ state: "CONFIRMED", blocking: true })
                  .where("tenant_id", "=", op.tenant_id)
                  .where("booking_id", "=", op.booking_id)
                  .execute();
              }
            });
            reconciled++;
          }
        } else if (op.operation_type === "REFUND" && op.provider_refund_id) {
          const ref = await this.paymentPort.getRefund(op.provider_refund_id);
          if (ref.status === "COMPLETED") {
            await withTenantTransaction(this.db, op.tenant_id, async (trx) => {
              await trx
                .updateTable("provider_operations")
                .set({ state: "SUCCEEDED", updated_at: new Date() })
                .where("tenant_id", "=", op.tenant_id)
                .where("id", "=", op.id)
                .execute();

              await trx
                .updateTable("refund_reservations")
                .set({ state: "COMPLETED", provider_refund_id: op.provider_refund_id })
                .where("tenant_id", "=", op.tenant_id)
                .where("provider_refund_id", "=", op.provider_refund_id)
                .execute();
            });
            reconciled++;
          }
        }
      } catch (_err: unknown) {
        failed++;
        const attempts = (op.attempt_count || 0) + 1;
        const backoffMs = Math.min(300_000, 5_000 * Math.pow(2, attempts));
        const nextReconcile = new Date(Date.now() + backoffMs);

        await withTenantTransaction(this.db, op.tenant_id, async (trx) => {
          await trx
            .updateTable("provider_operations")
            .set({
              state: attempts >= 5 ? "MANUAL_REVIEW" : "SENT_UNKNOWN",
              attempt_count: attempts,
              next_reconcile_at: nextReconcile,
              updated_at: new Date(),
            })
            .where("tenant_id", "=", op.tenant_id)
            .where("id", "=", op.id)
            .execute();
        });
      }
    }

    return { reconciled, failed };
  }
}

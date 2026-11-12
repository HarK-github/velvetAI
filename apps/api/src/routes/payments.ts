import "../env-loader.js";
import { FastifyPluginAsync } from "fastify";
import type { Kysely } from "kysely";
import { BookingId, PaymentIntentId, PaymentCaptureId, TenantId } from "@velvetai/contracts";
import { PaymentService } from "@velvetai/application";
import { PayPalSandboxAdapter } from "@velvetai/integrations-paypal";
import { createDatabaseClient, withTenantTransaction, type Database } from "@velvetai/db";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);

const defaultFallbackTenantId = (process.env.PUBLIC_DEMO_TENANT_ID ||
  process.env.SELF_SIGNUP_TENANT_ID ||
  "01932b10-0000-7000-8000-000000000a01") as TenantId;

async function resolveBookingTenant(
  dbClient: Kysely<Database>,
  preferredTenantId: TenantId,
  bookingId: string,
): Promise<TenantId> {
  const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
    return await trx
      .selectFrom("bookings")
      .where("id", "=", bookingId)
      .where("tenant_id", "=", preferredTenantId)
      .select(["tenant_id"])
      .executeTakeFirst();
  });
  if (inPreferred) return inPreferred.tenant_id as TenantId;

  const candidates = await dbClient
    .selectFrom("tenants")
    .where("status", "=", "ACTIVE")
    .where("id", "!=", preferredTenantId)
    .select(["id"])
    .execute();

  for (const candidate of candidates) {
    const candidateTenantId = candidate.id as TenantId;
    const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", candidateTenantId)
        .select(["tenant_id"])
        .executeTakeFirst();
    });
    if (found) return found.tenant_id as TenantId;
  }
  return preferredTenantId;
}

async function resolvePaymentIntentTenant(
  dbClient: Kysely<Database>,
  preferredTenantId: TenantId,
  paymentIntentId: string,
): Promise<TenantId> {
  const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
    return await trx
      .selectFrom("payment_intents")
      .where("id", "=", paymentIntentId)
      .where("tenant_id", "=", preferredTenantId)
      .select(["tenant_id"])
      .executeTakeFirst();
  });
  if (inPreferred) return inPreferred.tenant_id as TenantId;

  const candidates = await dbClient
    .selectFrom("tenants")
    .where("status", "=", "ACTIVE")
    .where("id", "!=", preferredTenantId)
    .select(["id"])
    .execute();

  for (const candidate of candidates) {
    const candidateTenantId = candidate.id as TenantId;
    const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
      return await trx
        .selectFrom("payment_intents")
        .where("id", "=", paymentIntentId)
        .where("tenant_id", "=", candidateTenantId)
        .select(["tenant_id"])
        .executeTakeFirst();
    });
    if (found) return found.tenant_id as TenantId;
  }
  return preferredTenantId;
}

async function resolveCaptureTenant(
  dbClient: Kysely<Database>,
  preferredTenantId: TenantId,
  captureId: string,
): Promise<TenantId> {
  const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
    return await trx
      .selectFrom("payment_captures")
      .where("id", "=", captureId)
      .where("tenant_id", "=", preferredTenantId)
      .select(["tenant_id"])
      .executeTakeFirst();
  });
  if (inPreferred) return inPreferred.tenant_id as TenantId;

  const candidates = await dbClient
    .selectFrom("tenants")
    .where("status", "=", "ACTIVE")
    .where("id", "!=", preferredTenantId)
    .select(["id"])
    .execute();

  for (const candidate of candidates) {
    const candidateTenantId = candidate.id as TenantId;
    const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
      return await trx
        .selectFrom("payment_captures")
        .where("id", "=", captureId)
        .where("tenant_id", "=", candidateTenantId)
        .select(["tenant_id"])
        .executeTakeFirst();
    });
    if (found) return found.tenant_id as TenantId;
  }
  return preferredTenantId;
}

async function resolveOperation(
  dbClient: Kysely<Database>,
  preferredTenantId: TenantId,
  operationId: string,
) {
  const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
    return await trx
      .selectFrom("provider_operations")
      .where("id", "=", operationId)
      .where("tenant_id", "=", preferredTenantId)
      .selectAll()
      .executeTakeFirst();
  });
  if (inPreferred) return inPreferred;

  const candidates = await dbClient
    .selectFrom("tenants")
    .where("status", "=", "ACTIVE")
    .where("id", "!=", preferredTenantId)
    .select(["id"])
    .execute();

  for (const candidate of candidates) {
    const candidateTenantId = candidate.id as TenantId;
    const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
      return await trx
        .selectFrom("provider_operations")
        .where("id", "=", operationId)
        .where("tenant_id", "=", candidateTenantId)
        .selectAll()
        .executeTakeFirst();
    });
    if (found) return found;
  }
  return undefined;
}

// Instantiate PayPal sandbox adapter with explicit sandbox validation
const paypalClientId = process.env.PAYPAL_CLIENT_ID || "sandbox_client_id";
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET || "sandbox_client_secret";
const paypalWebhookId = process.env.PAYPAL_WEBHOOK_ID || "WH-SANDBOX-DEFAULT";
const paypalEnv = process.env.PAYPAL_ENVIRONMENT || "sandbox";

if (paypalEnv !== "sandbox") {
  throw new Error(
    "Only PayPal sandbox environment is permitted in Epic 3; live configuration is rejected",
  );
}

const paypalAdapter = new PayPalSandboxAdapter({
  clientId: paypalClientId,
  clientSecret: paypalClientSecret,
  webhookId: paypalWebhookId,
  environment: "sandbox",
});

let paymentService = new PaymentService(db, paypalAdapter);

export function setPaymentService(service: PaymentService) {
  paymentService = service;
}

export { paymentService, paypalAdapter };

export const paymentsRoutes: FastifyPluginAsync = async (app) => {
  // W3: POST /v1/bookings/:bookingId/payment-order
  // Creates PayPal Orders v2 order for deposit payment
  app.post("/v1/bookings/:bookingId/payment-order", async (request, reply) => {
    const { bookingId } = request.params as { bookingId: string };
    const preferredTenantId = request.tenantId || defaultFallbackTenantId;
    const tenantId = await resolveBookingTenant(db, preferredTenantId, bookingId);
    const idempotencyKey =
      (request.headers["idempotency-key"] as string) ||
      (request.headers["paypal-request-id"] as string) ||
      request.id;

    const result = await paymentService.createDepositOrder({
      tenantId,
      bookingId: bookingId as BookingId,
      idempotencyKey,
    });

    return reply.status(201).send(result);
  });

  // W5: POST /v1/payments/:paymentIntentId/capture
  // Captures payment; requires capture status == COMPLETED for booking confirmation
  app.post("/v1/payments/:paymentIntentId/capture", async (request, reply) => {
    const { paymentIntentId } = request.params as { paymentIntentId: string };
    const preferredTenantId = request.tenantId || defaultFallbackTenantId;
    const tenantId = await resolvePaymentIntentTenant(db, preferredTenantId, paymentIntentId);
    const idempotencyKey =
      (request.headers["idempotency-key"] as string) ||
      (request.headers["paypal-request-id"] as string) ||
      request.id;

    const outcome = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: paymentIntentId as PaymentIntentId,
      idempotencyKey,
    });

    if (outcome.paymentStatus === "CAPTURED") {
      return reply.status(200).send(outcome);
    }

    if (outcome.paymentStatus === "UNCERTAIN") {
      // Return HTTP 202 with status URL per Amendment Section F.1
      return reply.status(202).send(outcome);
    }

    return reply.status(400).send(outcome);
  });

  // GET /v1/operations/:operationId
  // Operation status endpoint for polling uncertain outcomes
  app.get("/v1/operations/:operationId", async (request, reply) => {
    const { operationId } = request.params as { operationId: string };
    const preferredTenantId = request.tenantId || defaultFallbackTenantId;

    let op = await resolveOperation(db, preferredTenantId, operationId);

    if (!op) {
      return reply.status(404).send({
        title: "Not Found",
        status: 404,
        code: "OPERATION_NOT_FOUND",
        detail: "Provider operation not found",
      });
    }

    // Proactive reconciliation on poll if operation is pending/uncertain
    if (op.state !== "SUCCEEDED" && op.state !== "FAILED_TERMINAL") {
      try {
        if (op.operation_type === "CAPTURE" && (op.provider_capture_id || op.provider_order_id)) {
          let captureStatus = "UNKNOWN";

          if (op.provider_capture_id) {
            const cap = await paypalAdapter.getCapture(op.provider_capture_id);
            captureStatus = cap.status;
          } else if (op.provider_order_id) {
            const ord = await paypalAdapter.getOrder(op.provider_order_id);
            if (ord.captures && ord.captures.length > 0) {
              captureStatus = ord.captures[0]!.status;
            } else if (ord.status === "COMPLETED") {
              captureStatus = "COMPLETED";
            }
          }

          if (captureStatus === "COMPLETED") {
            const opTenantId = op.tenant_id as TenantId;
            await withTenantTransaction(db, opTenantId, async (trx) => {
              await trx
                .updateTable("provider_operations")
                .set({ state: "SUCCEEDED", updated_at: new Date() })
                .where("tenant_id", "=", opTenantId)
                .where("id", "=", op!.id)
                .execute();

              if (op!.booking_id) {
                await trx
                  .updateTable("payment_captures")
                  .set({ state: "COMPLETED", captured_at: new Date() })
                  .where("tenant_id", "=", opTenantId)
                  .where("booking_id", "=", op!.booking_id)
                  .execute();

                await trx
                  .updateTable("payment_intents")
                  .set({ state: "CAPTURED", updated_at: new Date() })
                  .where("tenant_id", "=", opTenantId)
                  .where("booking_id", "=", op!.booking_id)
                  .execute();

                const booking = await trx
                  .selectFrom("bookings")
                  .where("tenant_id", "=", opTenantId)
                  .where("id", "=", op!.booking_id)
                  .selectAll()
                  .executeTakeFirst();

                if (booking && booking.status === "CANCEL_REQUESTED") {
                  await trx
                    .updateTable("bookings")
                    .set((eb) => ({ status: "CANCELLED", version: eb("version", "+", 1) }))
                    .where("tenant_id", "=", opTenantId)
                    .where("id", "=", op!.booking_id)
                    .execute();

                  await trx
                    .updateTable("resource_claims")
                    .set({ state: "RELEASED", blocking: false })
                    .where("tenant_id", "=", opTenantId)
                    .where("booking_id", "=", op!.booking_id)
                    .execute();
                } else if (
                  booking &&
                  (booking.status === "COMMITTING" || booking.status === "CAPTURE_UNCERTAIN")
                ) {
                  await trx
                    .updateTable("bookings")
                    .set((eb) => ({ status: "CONFIRMED", version: eb("version", "+", 1) }))
                    .where("tenant_id", "=", opTenantId)
                    .where("id", "=", op!.booking_id)
                    .execute();

                  await trx
                    .updateTable("resource_claims")
                    .set({ state: "CONFIRMED", blocking: true })
                    .where("tenant_id", "=", opTenantId)
                    .where("booking_id", "=", op!.booking_id)
                    .execute();
                }
              }
            });

            op = { ...op, state: "SUCCEEDED" };
          } else if (captureStatus === "FAILED" || captureStatus === "DECLINED") {
            const opTenantId = op.tenant_id as TenantId;
            await withTenantTransaction(db, opTenantId, async (trx) => {
              await trx
                .updateTable("provider_operations")
                .set({ state: "FAILED_TERMINAL", updated_at: new Date() })
                .where("tenant_id", "=", opTenantId)
                .where("id", "=", op!.id)
                .execute();
            });
            op = { ...op, state: "FAILED_TERMINAL" };
          }
        }
      } catch (err: unknown) {
        request.log.warn({ err, operationId }, "Proactive operation reconciliation encountered transient error");
      }
    }

    return reply.status(200).send({
      id: op.id,
      operationType: op.operation_type,
      state: op.state,
      providerOrderId: op.provider_order_id,
      providerCaptureId: op.provider_capture_id,
      attemptCount: op.attempt_count,
      lastAttemptAt: op.last_attempt_at,
      nextReconcileAt: op.next_reconcile_at,
    });
  });

  // W7: POST /v1/captures/:captureId/refunds
  // Issues refund against captured payment under strict row lock
  app.post("/v1/captures/:captureId/refunds", async (request, reply) => {
    const { captureId } = request.params as { captureId: string };
    const preferredTenantId = request.tenantId || defaultFallbackTenantId;
    const tenantId = await resolveCaptureTenant(db, preferredTenantId, captureId);
    const idempotencyKey =
      (request.headers["idempotency-key"] as string) ||
      (request.headers["paypal-request-id"] as string) ||
      request.id;

    const body = (request.body as Record<string, unknown>) || {};
    const reason = typeof body.reason === "string" ? body.reason : "Customer cancellation";
    const amountMinor = typeof body.amountMinor === "string" ? body.amountMinor : undefined;

    const principal = request.principal;
    const isMerchant = principal?.roles?.includes("OWNER") || principal?.roles?.includes("MANAGER");
    const actorRole = isMerchant ? "MERCHANT" : "BUYER";

    const outcome = await paymentService.refundPayment({
      tenantId,
      captureId: captureId as PaymentCaptureId,
      amountMinor,
      reason,
      actorRole,
      idempotencyKey,
    });

    return reply.status(outcome.status === "COMPLETED" ? 200 : 202).send(outcome);
  });

  // W8: POST /v1/bookings/:bookingId/balance-invoice
  // Creates and sends PayPal Invoicing v2 draft for completed appointments
  app.post("/v1/bookings/:bookingId/balance-invoice", async (request, reply) => {
    const { bookingId } = request.params as { bookingId: string };
    const preferredTenantId = request.tenantId || defaultFallbackTenantId;
    const tenantId = await resolveBookingTenant(db, preferredTenantId, bookingId);

    const body = (request.body as Record<string, unknown>) || {};
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail : undefined;
    const customerName = typeof body.customerName === "string" ? body.customerName : undefined;

    const result = await paymentService.createBalanceInvoice({
      tenantId,
      bookingId: bookingId as BookingId,
      customerEmail,
      customerName,
    });

    return reply.status(201).send(result);
  });
};

/**
 * W6: Webhook ingress plugin with route-scoped raw buffer parser and 256 KiB limit.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Scoped content type parser: keeps exact Buffer bytes and enforces 256 KiB limit
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: 262144 },
    (_req, body: Buffer, done) => {
      done(null, body);
    },
  );

  app.post("/v1/webhooks/paypal/:connectionKey", async (request, reply) => {
    const { connectionKey } = request.params as { connectionKey: string };
    const rawBuffer = request.body as Buffer;

    if (!rawBuffer || rawBuffer.length === 0) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "EMPTY_WEBHOOK_BODY",
        detail: "Webhook payload body must not be empty",
      });
    }

    const headers = request.headers;
    const transmissionId = (headers["paypal-transmission-id"] as string) || "";
    const transmissionTime = (headers["paypal-transmission-time"] as string) || "";
    const certUrl = (headers["paypal-cert-url"] as string) || "";
    const authAlgo = (headers["paypal-auth-algo"] as string) || "";
    const transmissionSig = (headers["paypal-transmission-sig"] as string) || "";

    const rawPayload = rawBuffer.toString("utf-8");

    // Ingest into quarantine table
    const { deliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId,
      transmissionTime,
      certUrl,
      authAlgo,
      transmissionSig,
      rawPayload,
      bodyBytesLength: rawBuffer.length,
    });

    // Background verify and reconcile (or outbox worker)
    void paymentService.processWebhookDelivery(deliveryId).catch((err: unknown) => {
      request.log.error({ err, deliveryId }, "Webhook verification failed in background");
    });

    return reply.status(200).send({
      received: true,
      deliveryId,
    });
  });
};

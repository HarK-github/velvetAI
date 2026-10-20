import { describe, it, expect } from "vitest";
import {
  generateUUIDv7,
  tenantIdSchema,
  bookingIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
} from "@velvetai/contracts";
import { PayPalSandboxAdapter } from "../index.js";

describe("PayPalSandboxAdapter", () => {
  const adapter = new PayPalSandboxAdapter({
    clientId: "sandbox_client_id",
    clientSecret: "sandbox_client_secret",
  });

  it("creates a sandbox order with payment intent ID", async () => {
    const result = await adapter.createOrder({
      tenantId: tenantIdSchema.parse(generateUUIDv7()),
      bookingId: bookingIdSchema.parse(generateUUIDv7()),
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse(2500n),
      },
      requestId: "req-123",
    });

    expect(result.providerOrderId).toContain("SANDBOX_ORDER_");
    expect(result.paymentIntentId).toBeDefined();
  });

  it("verifies webhook headers completeness", () => {
    const valid = adapter.verifyWebhookSignature(
      {
        "paypal-transmission-id": "trans-1",
        "paypal-transmission-time": "2026-10-20T10:00:00Z",
        "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "signature==",
      },
      "{}",
    );
    expect(valid).toBe(true);

    const invalid = adapter.verifyWebhookSignature({}, "{}");
    expect(invalid).toBe(false);
  });
});

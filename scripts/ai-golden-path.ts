import process from "node:process";
import { loadRootEnv } from "./load-env.js";
import { buildApp } from "../apps/api/dist/app.js";
import { FakeModelProvider } from "../packages/application/dist/index.js";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import { setAuthAdapter, Auth0AuthenticationAdapter } from "../apps/api/dist/plugins/auth.js";

interface StepResult {
  step: string;
  name: string;
  passed: boolean;
  details: string;
}

export async function runAiGoldenPath(targetUrl?: string) {
  loadRootEnv();

  const tenantId = "01932b10-0000-7000-8000-000000000001";
  const userId = "01932b10-0000-7000-8000-000000000002";
  const serviceId = "01932b10-0001-7000-8000-000000000001"; // Executive Haircut
  const locationId = "01932b10-0002-7000-8000-000000000001"; // SoHo Flagship

  let defaultUrl = targetUrl || process.env.API_URL || "http://localhost:3001";
  let authHeader =
    process.env.AUTH_HEADER ||
    (process.env.AUTH0_TOKEN
      ? `Bearer ${process.env.AUTH0_TOKEN}`
      : `Bearer test-token:${userId}:${tenantId}:BUYER:1`);

  let standaloneServer: any = null;

  console.log("================================================================================");
  console.log("AI GOLDEN PATH VERIFICATION (Over Real HTTP)");
  console.log(`Target Base URL: ${defaultUrl}`);
  console.log("================================================================================\n");

  // Probe target API
  let probeOk = false;
  try {
    const probeRes = await fetch(`${defaultUrl}/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    if (probeRes.ok) {
      // Test auth header
      const authProbe = await fetch(
        `${defaultUrl}/v1/availability?serviceId=${serviceId}&locationId=${locationId}`,
        {
          headers: { authorization: authHeader },
          signal: AbortSignal.timeout(2000),
        },
      );
      if (authProbe.ok) {
        probeOk = true;
      } else {
        const body = await authProbe.text();
        if (body.includes("Dev tokens not allowed")) {
          console.log(
            `Target ${defaultUrl} is running with real Auth0. Spawning isolated real HTTP test instance with mock tokens...`,
          );
        }
      }
    }
  } catch {
    console.log(`Target ${defaultUrl} not reachable. Spawning isolated real HTTP test instance...`);
  }

  if (!probeOk) {
    process.env.OIDC_MOCK_ENABLED = "true";
    process.env.NODE_ENV = "test";
    process.env.AI_PROVIDER = "fake";

    const databaseUrl =
      process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai_b?sslmode=disable";
    const db = createDatabaseClient(databaseUrl);
    setAuthAdapter(new Auth0AuthenticationAdapter({ db, allowDevTokens: true }));

    const app = buildApp({ modelProvider: new FakeModelProvider(), db });
    await app.ready();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    defaultUrl = address;
    standaloneServer = { app, db };
    console.log(`✓ Real HTTP server listening at: ${defaultUrl}\n`);
  }

  const results: StepResult[] = [];
  const logStep = (step: string, name: string, passed: boolean, details: string) => {
    results.push({ step, name, passed, details });
    const mark = passed ? "✓ PASS" : "✗ FAIL";
    console.log(`[${mark}] Step ${step} (${name}): ${details}`);
    if (!passed) {
      throw new Error(`Step ${step} failed: ${details}`);
    }
  };

  try {
    // --------------------------------------------------------------------------------
    // Step 1: GET /v1/availability for tomorrow afternoon
    // --------------------------------------------------------------------------------
    const availUrl = `${defaultUrl}/v1/availability?serviceId=${serviceId}&locationId=${locationId}&day=tomorrow&dayPart=afternoon`;
    const availRes = await fetch(availUrl, {
      headers: { authorization: authHeader },
    });
    const availData = (await availRes.json()) as any;

    if (!availRes.ok || !Array.isArray(availData.slots) || availData.slots.length === 0) {
      logStep(
        "1",
        "Find Tomorrow Afternoon Slots",
        false,
        `HTTP ${availRes.status}: ${JSON.stringify(availData)}`,
      );
    } else {
      const firstSlot = availData.slots[0];
      logStep(
        "1",
        "Find Tomorrow Afternoon Slots",
        true,
        `Resolved date: ${availData.resolvedDate} (${availData.dayPart}) · Found ${availData.slots.length} slot(s). First slot: ${firstSlot.display?.localStart} ${firstSlot.display?.timeZoneLabel}`,
      );
    }

    const targetSlot = availData.slots[0];

    // --------------------------------------------------------------------------------
    // Step 2: POST /v1/booking-quotes
    // --------------------------------------------------------------------------------
    const quoteRes = await fetch(`${defaultUrl}/v1/booking-quotes`, {
      method: "POST",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `quote-golden-${Date.now()}`,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: targetSlot.startsAt,
        timeZone: targetSlot.timeZone || "America/New_York",
      }),
    });
    const quoteData = (await quoteRes.json()) as any;

    if (!quoteRes.ok || !quoteData.quoteId || !quoteData.total?.valueMinor) {
      logStep(
        "2",
        "Create Booking Quote",
        false,
        `HTTP ${quoteRes.status}: ${JSON.stringify(quoteData)}`,
      );
    } else {
      logStep(
        "2",
        "Create Booking Quote",
        true,
        `Quote created: ${quoteData.quoteId} · Total: $${(Number(quoteData.total.valueMinor) / 100).toFixed(2)} · Deposit: $${(Number(quoteData.deposit.valueMinor) / 100).toFixed(2)}`,
      );
    }

    // --------------------------------------------------------------------------------
    // Step 3: POST /v1/bookings/prepare
    // --------------------------------------------------------------------------------
    const idempotencyKey = `prep-golden-${Date.now()}`;
    const prepRes = await fetch(`${defaultUrl}/v1/bookings/prepare`, {
      method: "POST",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "x-client-id": "ask-ai",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        serviceId,
        locationId,
        startsAt: targetSlot.startsAt,
        timeZone: targetSlot.timeZone || "America/New_York",
        customer: {
          email: "golden.buyer@velvetai.example",
          displayName: "Golden Buyer",
        },
        note: "Prepared by Ask AI golden path test",
      }),
    });
    const prepData = (await prepRes.json()) as any;

    if (
      !prepRes.ok ||
      prepData.status !== "HELD" ||
      !prepData.approvalLocator ||
      !prepData.approvalUrl
    ) {
      logStep(
        "3",
        "Prepare Booking Hold",
        false,
        `HTTP ${prepRes.status}: ${JSON.stringify(prepData)}`,
      );
    } else {
      const isAbsoluteUrl =
        prepData.approvalUrl.startsWith("http://") || prepData.approvalUrl.startsWith("https://");
      if (!isAbsoluteUrl) {
        logStep(
          "3",
          "Prepare Booking Hold",
          false,
          `approvalUrl is not an absolute URL: ${prepData.approvalUrl}`,
        );
      } else {
        logStep(
          "3",
          "Prepare Booking Hold",
          true,
          `Booking HELD: ${prepData.bookingId} · Locator: ${prepData.approvalLocator} · Absolute URL: ${prepData.approvalUrl}`,
        );
      }
    }

    // --------------------------------------------------------------------------------
    // Step 4: GET Approval Details via Approval Locator
    // --------------------------------------------------------------------------------
    const approvalRes = await fetch(`${defaultUrl}${prepData.approvalLocator}`, {
      method: "GET",
    });
    const approvalData = (await approvalRes.json()) as any;

    if (!approvalRes.ok || approvalData.status !== "PENDING") {
      logStep(
        "4",
        "Get Approval Details",
        false,
        `HTTP ${approvalRes.status}: ${JSON.stringify(approvalData)}`,
      );
    } else {
      // Assert terms match quote and slot
      const termsMatch =
        approvalData.startsAt === targetSlot.startsAt &&
        approvalData.serviceName &&
        approvalData.allInPriceMinor === quoteData.total?.valueMinor &&
        approvalData.depositMinor === quoteData.deposit?.valueMinor;

      if (!termsMatch) {
        logStep(
          "4",
          "Get Approval Details",
          false,
          `Terms mismatch: expected startsAt=${targetSlot.startsAt}, got ${approvalData.startsAt}; expected total=${quoteData.total?.valueMinor}, got ${approvalData.allInPriceMinor}`,
        );
      } else {
        logStep(
          "4",
          "Get Approval Details",
          true,
          `Verified PENDING approval · Service: ${approvalData.serviceName} · Starts: ${approvalData.display?.localStart} ${approvalData.display?.timeZoneLabel} (${approvalData.display?.localDate}) · Total: ${approvalData.formattedPrice} · Deposit: ${approvalData.formattedDeposit} · Prepared by: ${approvalData.preparedBySurface}`,
        );
      }
    }

    // --------------------------------------------------------------------------------
    // Step 5: POST Approve & Commit (Transition HELD -> COMMITTING)
    // --------------------------------------------------------------------------------
    const approveRes = await fetch(`${defaultUrl}${prepData.approvalLocator}/approve-and-commit`, {
      method: "POST",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
        "idempotency-key": `approve-golden-${Date.now()}`,
      },
      body: JSON.stringify({}),
    });
    const approveData = (await approveRes.json()) as any;

    if (
      !approveRes.ok ||
      approveData.status !== "COMMITTING" ||
      approveData.next?.type !== "PAY_DEPOSIT"
    ) {
      logStep(
        "5",
        "Approve & Commit Booking",
        false,
        `HTTP ${approveRes.status}: ${JSON.stringify(approveData)}`,
      );
    } else {
      logStep(
        "5",
        "Approve & Commit Booking",
        true,
        `Booking ${approveData.bookingId} transitioned to ${approveData.status} (next: ${approveData.next.type})`,
      );
    }

    // --------------------------------------------------------------------------------
    // Step 6: POST Payment Order (Expect HTTP 201 + PayPal Order ID; No Capture)
    // --------------------------------------------------------------------------------
    const paymentOrderIdempotencyKey = `pay-order-golden-${Date.now()}`;
    const orderRes = await fetch(
      `${defaultUrl}/v1/bookings/${approveData.bookingId}/payment-order`,
      {
        method: "POST",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
          "idempotency-key": paymentOrderIdempotencyKey,
        },
        body: JSON.stringify({}),
      },
    );
    const orderData = (await orderRes.json()) as any;

    if (
      orderRes.status !== 201 ||
      typeof orderData.paypalOrderId !== "string" ||
      orderData.paypalOrderId.trim().length === 0 ||
      !orderData.paymentIntentId
    ) {
      logStep(
        "6",
        "Create PayPal Payment Order",
        false,
        `Expected HTTP 201 with paypalOrderId, got HTTP ${orderRes.status}: ${JSON.stringify(orderData)}`,
      );
    } else {
      logStep(
        "6",
        "Create PayPal Payment Order",
        true,
        `HTTP ${orderRes.status} · PayPal Order ID: ${orderData.paypalOrderId} · Payment Intent: ${orderData.paymentIntentId} · Status: ${orderData.status} (no capture invoked)`,
      );
    }

    console.log(
      "\n================================================================================",
    );
    console.log("ALL 6 AI GOLDEN PATH STEPS PASSED OVER REAL HTTP!");
    console.log(
      "================================================================================\n",
    );
  } finally {
    if (standaloneServer) {
      await standaloneServer.app.close();
      await standaloneServer.db.destroy();
    }
  }
}

if (process.argv[1]?.endsWith("ai-golden-path.ts")) {
  runAiGoldenPath()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nAI GOLDEN PATH FAILED:", err.message);
      process.exit(1);
    });
}

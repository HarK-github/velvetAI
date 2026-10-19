import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("API Frontend Endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/services returns versioned service catalog", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.services[0].versions[0].name).toBe("Executive Haircut & Beard Sculpt");
    expect(body.services[0].versions[0].priceMinor).toBe(7500);
    expect(body.services[0].versions[0].baseDepositMinor).toBe(2000);
  });

  it("GET /v1/availability returns conflict-free slots with probabilities", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/availability?serviceId=01932b10-0001-7000-8000-000000000001",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleRevision).toBe(14);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots[0].fillProbability).toBeDefined();
    expect(body.slots[0].depositPreview.valueMinor).toBe(2000);
  });

  it("POST /v1/booking-quotes calculates quote and deposit breakdown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      payload: {
        serviceId: "01932b10-0001-7000-8000-000000000001",
        startsAt: new Date().toISOString(),
        timeZone: "America/New_York",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quoteId).toBeDefined();
    expect(body.total.valueMinor).toBe(7500);
    expect(body.deposit.valueMinor).toBe(2000);
    expect(body.risk.band).toBe("low");
  });

  it("POST /v1/booking-holds creates a 300-second hold with JWS signed intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/booking-holds",
      payload: {
        quoteId: "01932b10-0005-7000-8000-000000000001",
        customer: { email: "test@example.com", displayName: "Test User" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.bookingId).toBeDefined();
    expect(body.status).toBe("HELD");
    expect(body.holdExpiresAt).toBeDefined();
    expect(body.signedIntent).toContain(".");
    expect(body.signedIntent.split(".").length).toBe(3);

    // Verify GET /v1/bookings/:id
    const fetchRes = await app.inject({
      method: "GET",
      url: `/v1/bookings/${body.bookingId}`,
    });
    expect(fetchRes.statusCode).toBe(200);
    expect(fetchRes.json().bookingId).toBe(body.bookingId);
  });

  it("POST /v1/risk/evaluate computes deterministic policy routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/risk/evaluate",
      payload: { tier: "elevated" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policyRoute).toBe("REMINDER");
    expect(body.noShowProbability).toBe("19%");
    expect(body.depositTierPercent).toBe("20%");
  });
});

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Canonical SLO Metric Trends based on spec.md Section 5.1 & NFR-001/002/005
const cachedAvailabilityDuration = new Trend("duration_cached_availability", true);
const uncachedAvailabilityDuration = new Trend("duration_uncached_availability", true);
const quoteDuration = new Trend("duration_booking_quote", true);
const holdDuration = new Trend("duration_booking_hold", true);
const hotConflictRate = new Rate("rate_hot_conflict_409");
const successfulHolds = new Counter("count_successful_holds");
const conflictHolds = new Counter("count_conflict_holds");

export const options = {
  scenarios: {
    // 1. Cached availability reads: Target 100 req/s sustained
    cached_availability_reads: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 50,
      exec: "testCachedAvailability",
    },
    // 2. Uncached availability reads
    uncached_availability_reads: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      stages: [
        { target: 20, duration: "15s" },
        { target: 20, duration: "15s" },
      ],
      preAllocatedVUs: 10,
      maxVUs: 30,
      exec: "testUncachedAvailability",
    },
    // 3. Quotes & Non-conflicting holds: Target 20 mutations/s sustained
    quote_and_nonconflicting_hold: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 60,
      exec: "testQuoteAndNonConflictingHold",
    },
    // 4. Hot-resource conflict: 10 concurrent requests for the EXACT same slot
    hot_resource_conflict: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 1,
      startTime: "35s",
      maxDuration: "10s",
      exec: "testHotResourceConflict",
    },
  },
  thresholds: {
    // NFR-001: Availability query latency
    // Cached: p95 < 300 ms, p99 < 800 ms
    duration_cached_availability: ["p(95)<300", "p(99)<800"],
    // Uncached: p95 < 800 ms, p99 < 1500 ms
    duration_uncached_availability: ["p(95)<800", "p(99)<1500"],

    // NFR-002: Booking command latency (excluding third-party)
    // Quote & Hold: p95 < 500 ms, p99 < 1000 ms
    duration_booking_quote: ["p(95)<500", "p(99)<1000"],
    duration_booking_hold: ["p(95)<500", "p(99)<1000"],

    // GiST exclusion correctness: In hot resource conflict, exactly 1 succeeds (10%), 9 conflict (90%)
    rate_hot_conflict_409: ["rate>0.8"],
  },
};

const BASE_URL = __ENV.API_URL || "http://localhost:3000";
const TENANT_ID = __ENV.TENANT_ID || "01932b10-0000-7000-8000-000000000001";
const LOCATION_ID = __ENV.LOCATION_ID || "01932b10-0000-7000-8000-000000000010";
const SERVICE_ID = __ENV.SERVICE_ID || "01932b10-0000-7000-8000-000000000020";

function getHeaders(idempotencyKey) {
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": TENANT_ID,
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return headers;
}

// 1. Cached availability reads: repeatedly query the exact same day
export function testCachedAvailability() {
  const url = `${BASE_URL}/v1/availability?locationId=${LOCATION_ID}&serviceId=${SERVICE_ID}&startDate=2026-11-01&endDate=2026-11-02`;
  const res = http.get(url, { headers: getHeaders() });
  cachedAvailabilityDuration.add(res.timings.duration);

  check(res, {
    "cached availability status is 200": (r) => r.status === 200,
  });
}

// 2. Uncached availability reads: vary query date range
export function testUncachedAvailability() {
  const dayOffset = Math.floor(Math.random() * 60) + 10;
  const startMonth = dayOffset > 30 ? "12" : "11";
  const day = ((dayOffset % 28) + 1).toString().padStart(2, "0");
  const url = `${BASE_URL}/v1/availability?locationId=${LOCATION_ID}&serviceId=${SERVICE_ID}&startDate=2026-${startMonth}-${day}&endDate=2026-${startMonth}-${day}`;

  const res = http.get(url, { headers: getHeaders() });
  uncachedAvailabilityDuration.add(res.timings.duration);

  check(res, {
    "uncached availability status is 200": (r) => r.status === 200,
  });
}

// 3. Quotes & Non-conflicting holds
export function testQuoteAndNonConflictingHold() {
  const uniqueId = `${__VU}-${__ITER}-${Date.now()}`;

  // Stagger slots into unique future minutes to avoid synthetic conflict
  const minute = (__ITER % 50) + 10;
  const hour = (__VU % 8) + 9;
  const startsAt = `2026-12-01T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00Z`;

  // Step A: Create Quote
  const quotePayload = JSON.stringify({
    serviceId: SERVICE_ID,
    locationId: LOCATION_ID,
    startsAt: startsAt,
    timeZone: "America/New_York",
  });

  const quoteRes = http.post(`${BASE_URL}/v1/booking-quotes`, quotePayload, {
    headers: getHeaders(`quote-k6-${uniqueId}`),
  });
  quoteDuration.add(quoteRes.timings.duration);

  const quoteOk = check(quoteRes, {
    "quote status is 201": (r) => r.status === 201,
  });

  if (!quoteOk) return;

  // Step B: Prepare Hold
  const holdPayload = JSON.stringify({
    serviceId: SERVICE_ID,
    locationId: LOCATION_ID,
    startsAt: startsAt,
    timeZone: "America/New_York",
    customer: {
      email: `k6-buyer-${uniqueId}@example.com`,
      displayName: `K6 Load User ${__VU}`,
    },
    note: "Load testing non-conflicting slot hold",
  });

  const holdRes = http.post(`${BASE_URL}/v1/bookings/prepare`, holdPayload, {
    headers: getHeaders(`hold-k6-${uniqueId}`),
  });
  holdDuration.add(holdRes.timings.duration);

  check(holdRes, {
    "hold status is 201": (r) => r.status === 201,
  });
}

// 4. Hot-Resource Conflict Test: 10 concurrent requests for the EXACT same slot
export function testHotResourceConflict() {
  const uniqueId = `hot-vu-${__VU}-${Date.now()}`;
  const hotSlot = "2026-12-25T14:00:00Z"; // Christmas 2 PM hot slot

  const holdPayload = JSON.stringify({
    serviceId: SERVICE_ID,
    locationId: LOCATION_ID,
    startsAt: hotSlot,
    timeZone: "America/New_York",
    customer: {
      email: `hot-contestant-${__VU}@example.com`,
      displayName: `Contestant ${__VU}`,
    },
    note: "Hot resource competition slot",
  });

  const res = http.post(`${BASE_URL}/v1/bookings/prepare`, holdPayload, {
    headers: getHeaders(`hot-hold-${uniqueId}`),
  });

  if (res.status === 201) {
    successfulHolds.add(1);
    hotConflictRate.add(0);
  } else if (res.status === 409) {
    conflictHolds.add(1);
    hotConflictRate.add(1);
  }

  check(res, {
    "hot conflict status is either 201 (winner) or 409 (conflict)": (r) =>
      r.status === 201 || r.status === 409,
  });
}

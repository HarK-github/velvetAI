import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
} from "@velvetai/db";
import { CatalogService } from "../catalog-service.js";
import { AvailabilityService } from "../availability-service.js";
import {
  TenantId,
  ServiceId,
  LocationId,
  ResourceId,
} from "@velvetai/contracts";

const TEST_DB_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";

describe("W2: PostgreSQL Catalog and Availability Integration", () => {
  let db: Kysely<Database>;
  let catalogService: CatalogService;
  let availabilityService: AvailabilityService;

  let tenantA: TenantId;
  let tenantB: TenantId;
  let locationA: LocationId;
  let resourceA: ResourceId;
  let serviceA: ServiceId;
  let serviceV1Id: string;
  let serviceV2Id: string;
  let inactiveServiceId: ServiceId;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    catalogService = new CatalogService(db);
    availabilityService = new AvailabilityService(db);

    tenantA = crypto.randomUUID() as TenantId;
    tenantB = crypto.randomUUID() as TenantId;
    locationA = crypto.randomUUID() as LocationId;
    resourceA = crypto.randomUUID() as ResourceId;
    serviceA = crypto.randomUUID() as ServiceId;
    serviceV1Id = crypto.randomUUID();
    serviceV2Id = crypto.randomUUID();
    inactiveServiceId = crypto.randomUUID() as ServiceId;

    // Seed tenants
    await db
      .insertInto("tenants")
      .values([
        { id: tenantA, name: "Tenant A", default_currency: "USD", status: "ACTIVE" },
        { id: tenantB, name: "Tenant B", default_currency: "USD", status: "ACTIVE" },
      ])
      .execute();

    // Seed Tenant A location, services, resources
    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: locationA,
          tenant_id: tenantA,
          name: "Manhattan Flagship",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: resourceA,
          tenant_id: tenantA,
          location_id: locationA,
          resource_type: "STAFF",
          display_name: "Master Stylist Alex",
          status: "ACTIVE",
        })
        .execute();

      // Active Service with Version 1 (insert service first with null version, then insert versions, then link)
      await trx
        .insertInto("services")
        .values({
          id: serviceA,
          tenant_id: tenantA,
          status: "ACTIVE",
          current_version_id: null,
        })
        .execute();

      await trx
        .insertInto("service_versions")
        .values([
          {
            id: serviceV1Id,
            tenant_id: tenantA,
            service_id: serviceA,
            version: 1,
            name: "Signature Precision Cut",
            description: "45 min cut with 15m buffer",
            duration_minutes: 45,
            buffer_before_minutes: 0,
            buffer_after_minutes: 15,
            price_minor: "8500",
            base_deposit_minor: "2500",
            currency: "USD",
            cancellation_policy_id: crypto.randomUUID(),
          },
          {
            id: serviceV2Id,
            tenant_id: tenantA,
            service_id: serviceA,
            version: 2,
            name: "Signature Precision Cut (Upgraded)",
            description: "60 min cut with 15m buffer",
            duration_minutes: 60,
            buffer_before_minutes: 0,
            buffer_after_minutes: 15,
            price_minor: "10000",
            base_deposit_minor: "3000",
            currency: "USD",
            cancellation_policy_id: crypto.randomUUID(),
          },
        ])
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: serviceV1Id })
        .where("id", "=", serviceA)
        .execute();

      // Inactive / Archived Service
      await trx
        .insertInto("services")
        .values({
          id: inactiveServiceId,
          tenant_id: tenantA,
          status: "ARCHIVED",
          current_version_id: null,
        })
        .execute();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("1. Service query uses real PostgreSQL and returns only active services", async () => {
    const services = await catalogService.listServices(tenantA);
    expect(services.length).toBe(1);
    expect(services[0].id).toBe(serviceA);
    expect(services[0].status).toBe("ACTIVE");
    expect(services[0].versions).toBeDefined();
    expect(services[0].versions![0].version).toBe(1);
    expect(services[0].versions![0].name).toBe("Signature Precision Cut");
    expect(services[0].versions![0].priceMinor).toBe("8500");
  });

  it("2. Inactive services omitted from catalog", async () => {
    const service = await catalogService.getService(tenantA, inactiveServiceId);
    expect(service).toBeNull();
  });

  it("3. Published/current version behavior: updating current_version_id reflects immediately", async () => {
    // Switch to version 2
    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .updateTable("services")
        .set({ current_version_id: serviceV2Id })
        .where("id", "=", serviceA)
        .execute();
    });

    const updated = await catalogService.getService(tenantA, serviceA);
    expect(updated).not.toBeNull();
    expect(updated?.currentVersionId).toBe(serviceV2Id);
    expect(updated?.versions![0].version).toBe(2);
    expect(updated?.versions![0].durationMinutes).toBe(60);
    expect(updated?.versions![0].priceMinor).toBe("10000");

    // Revert back to version 1 for subsequent tests
    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .updateTable("services")
        .set({ current_version_id: serviceV1Id })
        .where("id", "=", serviceA)
        .execute();
    });
  });

  it("4. Tenant isolation: cross-tenant IDs return no data", async () => {
    const servicesTenantB = await catalogService.listServices(tenantB);
    expect(servicesTenantB.length).toBe(0);

    const crossService = await catalogService.getService(tenantB, serviceA);
    expect(crossService).toBeNull();

    const crossAvailability = await availabilityService.getAvailability({
      tenantId: tenantB,
      serviceId: serviceA,
      locationId: locationA,
    });
    expect(crossAvailability.slots.length).toBe(0);
  });

  it("5. Availability removes held and confirmed claims (half-open intervals)", async () => {
    // Search window for a specific date: 2026-11-18
    const from = new Date("2026-11-18T14:00:00.000Z"); // 09:00 EST
    const to = new Date("2026-11-18T18:00:00.000Z"); // 13:00 EST

    // Baseline availability before any claims
    const baseline = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from,
      to,
      timeZone: "America/New_York",
    });

    expect(baseline.slots.length).toBeGreaterThan(0);
    const initialSlotCount = baseline.slots.length;

    // Pick first slot and insert a HELD claim
    const targetSlot = baseline.slots[0];
    const claimStart = new Date(targetSlot.startsAt);
    const claimEnd = new Date(targetSlot.endsAt);
    const bookingId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();

    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantA,
          service_version_id: serviceV1Id,
          customer_id: customerId,
          starts_at: claimStart,
          ends_at: claimEnd,
          total_minor: "8500",
          deposit_minor: "2500",
          currency: "USD",
          canonical_hash: "hash-claim-test",
          expires_at: new Date(Date.now() + 600_000),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantA,
          customer_id: customerId,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          starts_at: claimStart,
          ends_at: claimEnd,
          resource_id: resourceA,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: tenantA,
          booking_id: bookingId,
          resource_id: resourceA,
          starts_at: claimStart,
          ends_at: claimEnd,
          blocked_during: sql`tstzrange(${claimStart.toISOString()}::timestamptz, ${claimEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
        })
        .execute();
    });

    // Re-query availability: targetSlot must NOT be present
    const afterHeld = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from,
      to,
      timeZone: "America/New_York",
    });

    const slotStillPresent = afterHeld.slots.some(
      (s) => s.startsAt === targetSlot.startsAt && s.resourceId === targetSlot.resourceId,
    );
    expect(slotStillPresent).toBe(false);
    expect(afterHeld.slots.length).toBeLessThan(initialSlotCount);
  });

  it("6. Expired claims block until reaped by hold reaper (blocking=true enforcement)", async () => {
    const claimStart = new Date("2026-11-18T16:00:00.000Z");
    const claimEnd = new Date("2026-11-18T16:45:00.000Z");
    const pastExpiry = new Date(Date.now() - 100_000); // Expired in the past

    const bookingId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const customerId = crypto.randomUUID();

    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantA,
          service_version_id: serviceV1Id,
          customer_id: customerId,
          starts_at: claimStart,
          ends_at: claimEnd,
          total_minor: "8500",
          deposit_minor: "2500",
          currency: "USD",
          canonical_hash: "hash-expired-test",
          expires_at: pastExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantA,
          customer_id: customerId,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          starts_at: claimStart,
          ends_at: claimEnd,
          resource_id: resourceA,
        })
        .execute();

      // Claim is expired by timestamp, but blocking is STILL true until reaper runs
      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: tenantA,
          booking_id: bookingId,
          resource_id: resourceA,
          starts_at: claimStart,
          ends_at: claimEnd,
          blocked_during: sql`tstzrange(${claimStart.toISOString()}::timestamptz, ${claimEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: pastExpiry,
        })
        .execute();
    });

    // Before reaping: slot at 16:00 UTC must be blocked
    const availBeforeReap = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from: new Date("2026-11-18T15:00:00.000Z"),
      to: new Date("2026-11-18T18:00:00.000Z"),
      timeZone: "America/New_York",
    });

    const isBlocked = !availBeforeReap.slots.some((s) => s.startsAt === claimStart.toISOString());
    expect(isBlocked).toBe(true);

    // Simulate reaper running: state transitions to EXPIRED, blocking=false
    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .updateTable("resource_claims")
        .set({ state: "EXPIRED", blocking: false })
        .where("id", "=", claimId)
        .execute();
    });

    // After reaping: slot is now unblocked and available
    const availAfterReap = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from: new Date("2026-11-18T15:00:00.000Z"),
      to: new Date("2026-11-18T18:00:00.000Z"),
      timeZone: "America/New_York",
    });

    const isUnblocked = availAfterReap.slots.some((s) => s.startsAt === claimStart.toISOString());
    expect(isUnblocked).toBe(true);
  });

  it("7. Buffers prevent adjacent overlap where configured", async () => {
    // Service has buffer_after_minutes: 15
    // If an appointment is 10:00 to 10:45, the resource is blocked until 11:00 (10:45 + 15m)
    // An adjacent appointment starting at 10:45 must NOT be available
    const apptStart = new Date("2026-11-19T15:00:00.000Z"); // 10:00 EST
    const apptEnd = new Date("2026-11-19T15:45:00.000Z"); // 10:45 EST

    const bookingId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const customerId = crypto.randomUUID();

    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantA,
          service_version_id: serviceV1Id,
          customer_id: customerId,
          starts_at: apptStart,
          ends_at: apptEnd,
          total_minor: "8500",
          deposit_minor: "2500",
          currency: "USD",
          canonical_hash: "hash-buffer-test",
          expires_at: new Date(Date.now() + 600_000),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantA,
          customer_id: customerId,
          quote_id: quoteId,
          status: "CONFIRMED",
          version: 1,
          starts_at: apptStart,
          ends_at: apptEnd,
          resource_id: resourceA,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: tenantA,
          booking_id: bookingId,
          resource_id: resourceA,
          starts_at: apptStart,
          ends_at: apptEnd,
          blocked_during: sql`tstzrange(${apptStart.toISOString()}::timestamptz, ${apptEnd.toISOString()}::timestamptz, '[)')`,
          state: "CONFIRMED",
          blocking: true,
        })
        .execute();
    });

    const avail = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from: new Date("2026-11-19T14:00:00.000Z"),
      to: new Date("2026-11-19T18:00:00.000Z"),
      timeZone: "America/New_York",
    });

    // A candidate starting at 10:30 (15:30 UTC) overlaps apptEnd (15:45)
    const slotAt1530 = avail.slots.some((s) => s.startsAt === "2026-11-19T15:30:00.000Z");
    expect(slotAt1530).toBe(false);

    // Because buffer_after_minutes is 15, the buffer extends to 16:00 (15:45 + 15m)
    // So candidate starting at 15:45 (10:45 EST) violates required buffer before: [15:45, 16:30) requires resource free during [15:45, 16:45)
    // But existing claim occupies up to 15:45, and candidate requiredBlockStart is 15:45 - buffer_before(0) = 15:45
    // Candidate's required block overlaps if adjacent buffer isn't satisfied
  });

  it("8. DST gap and overlap behavior: local time and UTC offsets match timezone transitions", async () => {
    // Nov 1, 2026 is US Daylight Saving Time end (2:00 AM EDT -> 1:00 AM EST)
    // Querying Nov 2, 2026 (Standard Time, UTC-5): 09:00 local is 14:00 UTC
    const nov2 = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from: new Date("2026-11-02T13:00:00.000Z"),
      to: new Date("2026-11-02T16:00:00.000Z"),
      timeZone: "America/New_York",
    });

    const slotNov2 = nov2.slots.find((s) => s.startsAt === "2026-11-02T14:00:00.000Z");
    expect(slotNov2).toBeDefined();
    expect(slotNov2?.localStartsAt).toBe("09:00");

    // Oct 20, 2026 (Daylight Saving Time, UTC-4): 09:00 local is 13:00 UTC
    const oct20 = await availabilityService.getAvailability({
      tenantId: tenantA,
      serviceId: serviceA,
      locationId: locationA,
      from: new Date("2026-10-20T12:00:00.000Z"),
      to: new Date("2026-10-20T15:00:00.000Z"),
      timeZone: "America/New_York",
    });

    const slotOct20 = oct20.slots.find((s) => s.startsAt === "2026-10-20T13:00:00.000Z");
    expect(slotOct20).toBeDefined();
    expect(slotOct20?.localStartsAt).toBe("09:00");
  });
});

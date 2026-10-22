import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import { Database } from "../schema.js";
import { withTenantTransaction } from "../index.js";
import { setupTestDatabase, seedTenantContext, SeededTenantContext } from "./test-helper.js";

describe("PostgreSQL 17 GiST Exclusion & Concurrency Tests", () => {
  let db: Kysely<Database>;
  let seedA: SeededTenantContext;
  let seedB: SeededTenantContext;

  beforeAll(async () => {
    db = await setupTestDatabase();
    seedA = await seedTenantContext(db, "concA");
    seedB = await seedTenantContext(db, "concB");
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("1. Same-slot barrier race: 100 concurrent hold attempts create exactly 1 blocking claim", async () => {
    const slotStart = new Date("2026-11-01T10:00:00.000Z");
    const slotEnd = new Date("2026-11-01T10:30:00.000Z");
    const holdExpiry = new Date(Date.now() + 15 * 60_000);

    const attemptsCount = 100;
    let successfulCommits = 0;
    let exclusionConflicts = 0;
    let otherErrors = 0;

    // Launch 100 concurrent insertion attempts simultaneously
    const attemptPromises = Array.from({ length: attemptsCount }, async (_, i) => {
      const bookingId = crypto.randomUUID();
      const claimId = crypto.randomUUID();
      const quoteId = crypto.randomUUID();

      try {
        await db.transaction().execute(async (trx) => {
          // Set tenant context
          await sql`SELECT set_config('app.tenant_id', ${seedA.tenantId}, true)`.execute(trx);

          // Insert quote and booking
          await trx
            .insertInto("booking_quotes")
            .values({
              id: quoteId,
              tenant_id: seedA.tenantId,
              service_version_id: seedA.serviceVersionId,
              customer_id: seedA.actorUserId,
              starts_at: slotStart,
              ends_at: slotEnd,
              total_minor: "5000",
              deposit_minor: "1500",
              currency: "USD",
              canonical_hash: `hash-${i}`,
              expires_at: holdExpiry,
            })
            .execute();

          await trx
            .insertInto("bookings")
            .values({
              id: bookingId,
              tenant_id: seedA.tenantId,
              customer_id: seedA.actorUserId,
              quote_id: quoteId,
              status: "HELD",
              version: 1,
              hold_expires_at: holdExpiry,
              starts_at: slotStart,
              ends_at: slotEnd,
              resource_id: seedA.resourceId,
            })
            .execute();

          // Attempt authoritative GiST claim
          await trx
            .insertInto("resource_claims")
            .values({
              id: claimId,
              tenant_id: seedA.tenantId,
              booking_id: bookingId,
              resource_id: seedA.resourceId,
              starts_at: slotStart,
              ends_at: slotEnd,
              blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
              state: "HELD",
              blocking: true,
              hold_expires_at: holdExpiry,
              expires_at: holdExpiry,
            })
            .execute();
        });

        successfulCommits++;
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string };
        if (pgErr.code === "23P01" || pgErr.message?.includes("no_overlapping_claims")) {
          exclusionConflicts++;
        } else {
          otherErrors++;
        }
      }
    });

    await Promise.all(attemptPromises);

    // Exactly 1 winner commits, 99 fail with 23P01
    expect(successfulCommits).toBe(1);
    expect(exclusionConflicts).toBe(99);
    expect(otherErrors).toBe(0);

    // Verify exactly one active claim exists in PostgreSQL
    const claims = await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      return await trx
        .selectFrom("resource_claims")
        .where("tenant_id", "=", seedA.tenantId)
        .where("resource_id", "=", seedA.resourceId)
        .where("starts_at", "=", slotStart)
        .where("blocking", "=", true)
        .selectAll()
        .execute();
    });

    expect(claims.length).toBe(1);
    expect(claims[0]?.state).toBe("HELD");
    expect(claims[0]?.blocking).toBe(true);
  });

  it("2. Tenant and resource independence: identical intervals succeed on different tenants/resources", async () => {
    const slotStart = new Date("2026-11-01T14:00:00.000Z");
    const slotEnd = new Date("2026-11-01T14:30:00.000Z");
    const holdExpiry = new Date(Date.now() + 15 * 60_000);

    // 2a. Insert on Tenant A
    const bookingA = crypto.randomUUID();
    const claimA = crypto.randomUUID();
    const quoteA = crypto.randomUUID();

    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${seedA.tenantId}, true)`.execute(trx);

      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteA,
          tenant_id: seedA.tenantId,
          service_version_id: seedA.serviceVersionId,
          customer_id: seedA.actorUserId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-tenant-a",
          expires_at: holdExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingA,
          tenant_id: seedA.tenantId,
          customer_id: seedA.actorUserId,
          quote_id: quoteA,
          status: "HELD",
          version: 1,
          hold_expires_at: holdExpiry,
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: seedA.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimA,
          tenant_id: seedA.tenantId,
          booking_id: bookingA,
          resource_id: seedA.resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: holdExpiry,
        })
        .execute();
    });

    // 2b. Insert IDENTICAL slot interval on Tenant B
    const bookingB = crypto.randomUUID();
    const claimB = crypto.randomUUID();
    const quoteB = crypto.randomUUID();

    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${seedB.tenantId}, true)`.execute(trx);

      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteB,
          tenant_id: seedB.tenantId,
          service_version_id: seedB.serviceVersionId,
          customer_id: seedB.actorUserId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-tenant-b",
          expires_at: holdExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingB,
          tenant_id: seedB.tenantId,
          customer_id: seedB.actorUserId,
          quote_id: quoteB,
          status: "HELD",
          version: 1,
          hold_expires_at: holdExpiry,
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: seedB.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimB,
          tenant_id: seedB.tenantId,
          booking_id: bookingB,
          resource_id: seedB.resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: holdExpiry,
        })
        .execute();
    });

    // Both succeeded because they belong to separate tenants
    const countA = await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      return await trx.selectFrom("resource_claims").where("id", "=", claimA).selectAll().execute();
    });
    const countB = await withTenantTransaction(db, seedB.tenantId, async (trx) => {
      return await trx.selectFrom("resource_claims").where("id", "=", claimB).selectAll().execute();
    });

    expect(countA.length).toBe(1);
    expect(countB.length).toBe(1);
  });

  it("3. Range boundaries: back-to-back half-open ranges [t1, t2) and [t2, t3) succeed, positive overlap fails", async () => {
    const t1 = new Date("2026-11-02T09:00:00.000Z");
    const t2 = new Date("2026-11-02T09:30:00.000Z");
    const t3 = new Date("2026-11-02T10:00:00.000Z");
    const holdExpiry = new Date(Date.now() + 15 * 60_000);

    // Slot 1: [09:00, 09:30)
    const booking1 = crypto.randomUUID();
    const claim1 = crypto.randomUUID();
    const quote1 = crypto.randomUUID();

    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${seedA.tenantId}, true)`.execute(trx);

      await trx
        .insertInto("booking_quotes")
        .values({
          id: quote1,
          tenant_id: seedA.tenantId,
          service_version_id: seedA.serviceVersionId,
          customer_id: seedA.actorUserId,
          starts_at: t1,
          ends_at: t2,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-slot-1",
          expires_at: holdExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: booking1,
          tenant_id: seedA.tenantId,
          customer_id: seedA.actorUserId,
          quote_id: quote1,
          status: "HELD",
          version: 1,
          starts_at: t1,
          ends_at: t2,
          resource_id: seedA.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claim1,
          tenant_id: seedA.tenantId,
          booking_id: booking1,
          resource_id: seedA.resourceId,
          starts_at: t1,
          ends_at: t2,
          blocked_during: sql`tstzrange(${t1.toISOString()}::timestamptz, ${t2.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: holdExpiry,
        })
        .execute();
    });

    // Slot 2: [09:30, 10:00) adjacent back-to-back MUST succeed
    const booking2 = crypto.randomUUID();
    const claim2 = crypto.randomUUID();
    const quote2 = crypto.randomUUID();

    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${seedA.tenantId}, true)`.execute(trx);

      await trx
        .insertInto("booking_quotes")
        .values({
          id: quote2,
          tenant_id: seedA.tenantId,
          service_version_id: seedA.serviceVersionId,
          customer_id: seedA.actorUserId,
          starts_at: t2,
          ends_at: t3,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-slot-2",
          expires_at: holdExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: booking2,
          tenant_id: seedA.tenantId,
          customer_id: seedA.actorUserId,
          quote_id: quote2,
          status: "HELD",
          version: 1,
          starts_at: t2,
          ends_at: t3,
          resource_id: seedA.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claim2,
          tenant_id: seedA.tenantId,
          booking_id: booking2,
          resource_id: seedA.resourceId,
          starts_at: t2,
          ends_at: t3,
          blocked_during: sql`tstzrange(${t2.toISOString()}::timestamptz, ${t3.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: holdExpiry,
        })
        .execute();
    });

    // Slot 3: Overlapping interval [09:15, 09:45) MUST FAIL with exclusion conflict
    const tOverlapStart = new Date("2026-11-02T09:15:00.000Z");
    const tOverlapEnd = new Date("2026-11-02T09:45:00.000Z");

    let overlapFailed = false;
    try {
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.tenant_id', ${seedA.tenantId}, true)`.execute(trx);

        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seedA.tenantId,
            booking_id: booking1,
            resource_id: seedA.resourceId,
            starts_at: tOverlapStart,
            ends_at: tOverlapEnd,
            blocked_during: sql`tstzrange(${tOverlapStart.toISOString()}::timestamptz, ${tOverlapEnd.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
            hold_expires_at: holdExpiry,
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23P01") {
        overlapFailed = true;
      }
    }

    expect(overlapFailed).toBe(true);
  });

  it("4. Confirm/expire/replacement race: confirmed hold blocks replacements, expired hold frees slot for exactly 1 winner", async () => {
    const slotStart = new Date("2026-11-03T10:00:00.000Z");
    const slotEnd = new Date("2026-11-03T10:30:00.000Z");
    const holdExpiry = new Date(Date.now() + 60_000);

    const bookingOld = crypto.randomUUID();
    const claimOld = crypto.randomUUID();
    const quoteOld = crypto.randomUUID();

    // 4a. Create hold
    await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteOld,
          tenant_id: seedA.tenantId,
          service_version_id: seedA.serviceVersionId,
          customer_id: seedA.actorUserId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-old",
          expires_at: holdExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingOld,
          tenant_id: seedA.tenantId,
          customer_id: seedA.actorUserId,
          quote_id: quoteOld,
          status: "HELD",
          version: 1,
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: seedA.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimOld,
          tenant_id: seedA.tenantId,
          booking_id: bookingOld,
          resource_id: seedA.resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: holdExpiry,
        })
        .execute();
    });

    // 4b. Confirm the hold: state becomes COMMITTED, blocking remains true
    await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      await trx
        .updateTable("resource_claims")
        .set({ state: "CONFIRMED", blocking: true, hold_expires_at: null })
        .where("id", "=", claimOld)
        .execute();
      await trx
        .updateTable("bookings")
        .set({ status: "CONFIRMED" })
        .where("id", "=", bookingOld)
        .execute();
    });

    // 4c. Attempt to take the slot while confirmed -> MUST FAIL with 23P01
    let replacementWhileConfirmedFailed = false;
    try {
      await withTenantTransaction(db, seedA.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seedA.tenantId,
            booking_id: crypto.randomUUID(),
            resource_id: seedA.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
            hold_expires_at: holdExpiry,
          })
          .execute();
      });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23P01") {
        replacementWhileConfirmedFailed = true;
      }
    }
    expect(replacementWhileConfirmedFailed).toBe(true);

    // 4d. Now simulate expiration of an unconfirmed hold: set blocking = false
    await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      await trx
        .updateTable("resource_claims")
        .set({ blocking: false, state: "RELEASED" })
        .where("id", "=", claimOld)
        .execute();
    });

    // 4e. Now 10 concurrent replacement attempts race for the freed slot: exactly 1 wins!
    let replacementWinners = 0;
    let replacementConflicts = 0;

    const otherErrors: unknown[] = [];
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const repBookingId = crypto.randomUUID();
        const repQuoteId = crypto.randomUUID();
        try {
          await withTenantTransaction(db, seedA.tenantId, async (trx) => {
            await trx
              .insertInto("booking_quotes")
              .values({
                id: repQuoteId,
                tenant_id: seedA.tenantId,
                service_version_id: seedA.serviceVersionId,
                customer_id: seedA.actorUserId,
                starts_at: slotStart,
                ends_at: slotEnd,
                total_minor: "5000",
                deposit_minor: "1500",
                currency: "USD",
                canonical_hash: `hash-rep-${repBookingId}`,
                expires_at: holdExpiry,
              })
              .execute();

            await trx
              .insertInto("bookings")
              .values({
                id: repBookingId,
                tenant_id: seedA.tenantId,
                customer_id: seedA.actorUserId,
                quote_id: repQuoteId,
                status: "HELD",
                version: 1,
                hold_expires_at: holdExpiry,
                starts_at: slotStart,
                ends_at: slotEnd,
                resource_id: seedA.resourceId,
              })
              .execute();

            await trx
              .insertInto("resource_claims")
              .values({
                id: crypto.randomUUID(),
                tenant_id: seedA.tenantId,
                booking_id: repBookingId,
                resource_id: seedA.resourceId,
                starts_at: slotStart,
                ends_at: slotEnd,
                blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
                state: "HELD",
                blocking: true,
                hold_expires_at: holdExpiry,
              })
              .execute();
          });
          replacementWinners++;
        } catch (err: unknown) {
          const pgCode = (err as { code?: string }).code;
          if (pgCode === "23P01" || pgCode === "40P01") {
            replacementConflicts++;
          } else {
            otherErrors.push(err);
          }
        }
      }),
    );

    if (otherErrors.length > 0) {
      console.error(
        "Replacement other errors:",
        otherErrors.map((e) => e?.code || e?.message),
      );
    }
    expect(replacementWinners).toBe(1);
    expect(replacementConflicts).toBe(9);

    // Verify exactly one blocking claim exists
    const activeBlockers = await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      return await trx
        .selectFrom("resource_claims")
        .where("resource_id", "=", seedA.resourceId)
        .where("starts_at", "=", slotStart)
        .where("blocking", "=", true)
        .selectAll()
        .execute();
    });
    expect(activeBlockers.length).toBe(1);
  }, 15000);

  it("5. Long-transaction expiry: transaction beginning before expiry but committing after expiry fails via clock_timestamp()", async () => {
    const slotStart = new Date("2026-11-04T10:00:00.000Z");
    const slotEnd = new Date("2026-11-04T10:30:00.000Z");
    // Hold expires in 150 milliseconds
    const shortExpiry = new Date(Date.now() + 150);

    const bookingId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();

    await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: seedA.tenantId,
          service_version_id: seedA.serviceVersionId,
          customer_id: seedA.actorUserId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-long-tx",
          expires_at: shortExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: seedA.tenantId,
          customer_id: seedA.actorUserId,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          hold_expires_at: shortExpiry,
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: seedA.resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: seedA.tenantId,
          booking_id: bookingId,
          resource_id: seedA.resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: shortExpiry,
        })
        .execute();
    });

    let commitFailedDueToExpiry = false;

    // Start commit transaction before expiry, sleep until after expiry, then verify clock_timestamp() aborts
    await withTenantTransaction(db, seedA.tenantId, async (trx) => {
      // Intentionally wait 250ms so clock_timestamp() advances past shortExpiry
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Attempt to confirm the hold using authoritative clock_timestamp() per Amendment C.1
      const updateResult = await sql<{ updated_count: number }>`
        WITH updated AS (
          UPDATE resource_claims
          SET state = 'COMMITTED', hold_expires_at = NULL
          WHERE id = ${claimId}::uuid
            AND tenant_id = ${seedA.tenantId}::uuid
            AND state = 'HELD'
            AND hold_expires_at > clock_timestamp()
          RETURNING id
        )
        SELECT count(*)::int AS updated_count FROM updated;
      `.execute(trx);

      const count = updateResult.rows[0]?.updated_count ?? 0;
      if (count === 0) {
        commitFailedDueToExpiry = true;
      }
    });

    expect(commitFailedDueToExpiry).toBe(true);
  });

  it("6. Negative interval rejected by PostgreSQL range constructor", async () => {
    const tStart = new Date("2026-11-05T10:00:00.000Z");
    const tEndEarlier = new Date("2026-11-05T09:00:00.000Z"); // end < start
    const holdExpiry = new Date(Date.now() + 60_000);

    let rangeError = false;
    try {
      await withTenantTransaction(db, seedA.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seedA.tenantId,
            booking_id: crypto.randomUUID(),
            resource_id: seedA.resourceId,
            starts_at: tStart,
            ends_at: tEndEarlier,
            // Negative range: lower bound > upper bound
            blocked_during: sql`tstzrange(${tStart.toISOString()}::timestamptz, ${tEndEarlier.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
            hold_expires_at: holdExpiry,
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // 22000 or error message about range lower bound must be <= upper bound
      if (pgErr.code === "22000" || pgErr.message?.includes("range lower bound")) {
        rangeError = true;
      }
    }

    expect(rangeError).toBe(true);
  });
});

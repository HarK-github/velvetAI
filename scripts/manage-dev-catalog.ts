import {
  createDatabaseClient,
  withTenantTransaction,
  sql,
  type Database,
  type Kysely,
} from "../packages/db/src/index.ts";
import { loadRootEnv, extractDatabaseName } from "./load-env.js";
import { ensureSyntheticDevTenant } from "./provision-test-user.js";

export const SYNTHETIC_DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
export const CANONICAL_SERVICES = [
  {
    serviceId: "01932b10-0001-7000-8000-000000000001",
    versionId: "01932b10-0002-7000-8000-000000000001",
    versionNumber: 1,
    name: "Executive Haircut & Beard Sculpt",
    description:
      "Signature tailored haircut with precision hot towel beard contouring and styling.",
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    priceMinor: "7500", // $75.00
    baseDepositMinor: "2000", // $20.00
    currency: "USD",
    cancellationPolicyId: "01932b10-0003-7000-8000-000000000001",
  },
  {
    serviceId: "01932b10-0001-7000-8000-000000000002",
    versionId: "01932b10-0002-7000-8000-000000000002",
    versionNumber: 1,
    name: "Deep Tissue & Mobility Session",
    description:
      "Targeted therapeutic deep tissue work focused on joint decompression and recovery.",
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    priceMinor: "12000", // $120.00
    baseDepositMinor: "3500", // $35.00
    currency: "USD",
    cancellationPolicyId: "01932b10-0003-7000-8000-000000000001",
  },
  {
    serviceId: "01932b10-0001-7000-8000-000000000003",
    versionId: "01932b10-0002-7000-8000-000000000003",
    versionNumber: 1,
    name: "Private Acoustic Studio Block",
    description:
      "Exclusive acoustically calibrated studio booking with dedicated sound engineer support.",
    durationMinutes: 120,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    priceMinor: "16000", // $160.00
    baseDepositMinor: "5000", // $50.00
    currency: "USD",
    cancellationPolicyId: "01932b10-0003-7000-8000-000000000001",
  },
];

export function assertSafeDevEnvironment(dbUrl: string): void {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_HOSTED_SEED !== "1") {
    throw new Error(
      "REFUSED: Catalog cleanup/seed cannot be run in production (NODE_ENV=production). Set ALLOW_HOSTED_SEED=1 to seed a hosted demo database.",
    );
  }

  const parsed = new URL(dbUrl);
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();

  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocalHost && process.env.ALLOW_HOSTED_SEED !== "1") {
    throw new Error(
      `REFUSED: Database host "${host}" is not localhost. Catalog cleanup is restricted to local development or hosted demo seeding with ALLOW_HOSTED_SEED=1.`,
    );
  }

  if (dbName.includes("prod") || dbName.includes("production")) {
    throw new Error(`REFUSED: Database name "${dbName}" indicates production.`);
  }
}

export async function manageDevCatalog(options?: {
  confirm?: boolean;
  databaseUrl?: string;
  db?: Kysely<Database>;
}) {
  loadRootEnv();
  const dbUrl = options?.databaseUrl || process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is required for catalog manager but was not found in environment, .env.local, or .env.",
    );
  }

  assertSafeDevEnvironment(dbUrl);
  const dbName = extractDatabaseName(dbUrl);
  console.log(`Target database: ${dbName}`);

  const db = options?.db || createDatabaseClient(dbUrl);
  const isConfirmed = Boolean(options?.confirm);

  try {
    console.log("==================================================");
    console.log("velvetAI Development Catalog Manager (Synthetic Dev Tenant)");
    console.log(`Tenant ID: ${SYNTHETIC_DEV_TENANT_ID}`);
    console.log(`Database:  ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
    console.log(
      `Mode:      ${isConfirmed ? "EXECUTE (MUTATION ENABLED)" : "PREVIEW ONLY (DRY RUN)"}`,
    );
    console.log("==================================================");

    // 0. Idempotently ensure the synthetic development tenant and dependencies exist
    await ensureSyntheticDevTenant(db);

    // 1. Audit existing records in synthetic development tenant within RLS tenant context
    const { existingServices, existingVersions, existingBookings, existingPaymentIntents } =
      await withTenantTransaction(db, SYNTHETIC_DEV_TENANT_ID as any, async (trx) => {
        const services = await trx
          .selectFrom("services")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .selectAll()
          .execute();

        const versions = await trx
          .selectFrom("service_versions")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .selectAll()
          .execute();

        const bookings = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .select(["id", "status"])
          .execute();

        const paymentIntents = await trx
          .selectFrom("payment_intents")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .select(["id", "booking_id", "state"])
          .execute();

        return {
          existingServices: services,
          existingVersions: versions,
          existingBookings: bookings,
          existingPaymentIntents: paymentIntents,
        };
      });

    console.log("\n[CURRENT STATE PREVIEW]");
    console.log(`Total services in dev tenant:         ${existingServices.length}`);
    console.log(`Total service versions in dev tenant: ${existingVersions.length}`);
    console.log(`Total bookings preserved:             ${existingBookings.length}`);
    console.log(`Total payment intents preserved:      ${existingPaymentIntents.length}`);

    // Identify fixture services to remove:
    // Any service whose versions match known test names (Equivalence, AI Signature Cut) or not in canonical ID list
    const canonicalServiceIds = new Set(CANONICAL_SERVICES.map((s) => s.serviceId));
    const fixtureServiceIds: string[] = [];

    for (const s of existingServices) {
      const versions = existingVersions.filter((v) => v.service_id === s.id);
      const isFixture =
        !canonicalServiceIds.has(s.id) ||
        versions.some(
          (v) =>
            v.name.includes("Equivalence") ||
            v.name.includes("AI Signature") ||
            v.name.startsWith("test-") ||
            v.name.includes("Fixture"),
        );

      if (isFixture) {
        fixtureServiceIds.push(s.id);
      }
    }

    console.log(`\nFound ${fixtureServiceIds.length} test fixture service(s) marked for cleanup:`);
    for (const fId of fixtureServiceIds) {
      const vNames = existingVersions
        .filter((v) => v.service_id === fId)
        .map((v) => `"${v.name}" (version ${v.version})`)
        .join(", ");
      console.log(` - Service ID ${fId}: ${vNames || "No version records"}`);
    }

    if (!isConfirmed) {
      console.log("\n[DRY RUN COMPLETE] No modifications made.");
      console.log("To apply these changes, re-run with --confirm:");
      console.log("  npx tsx scripts/manage-dev-catalog.ts --confirm\n");
      return {
        fixtureCount: fixtureServiceIds.length,
        canonicalCount: CANONICAL_SERVICES.length,
        modified: false,
      };
    }

    // 2. Perform safe mutation in transaction
    await withTenantTransaction(db, SYNTHETIC_DEV_TENANT_ID as any, async (trx) => {
      // Step A: Remove known fixture services and their versions
      if (fixtureServiceIds.length > 0) {
        for (const fId of fixtureServiceIds) {
          // Find all versions for this fixture service
          const versions = await trx
            .selectFrom("service_versions")
            .where("service_id", "=", fId)
            .select(["id"])
            .execute();
          const versionIds = versions.map((v) => v.id);

          if (versionIds.length > 0) {
            // Find all quotes referencing these fixture versions
            const quotes = await trx
              .selectFrom("booking_quotes")
              .where("service_version_id", "in", versionIds)
              .select(["id"])
              .execute();
            const quoteIds = quotes.map((q) => q.id);

            if (quoteIds.length > 0) {
              // Find all bookings referencing these quotes
              const bookings = await trx
                .selectFrom("bookings")
                .where("quote_id", "in", quoteIds)
                .select(["id"])
                .execute();
              const bookingIds = bookings.map((b) => b.id);

              if (bookingIds.length > 0) {
                // Safety invariant: NEVER remove bookings with payments
                const payments = await trx
                  .selectFrom("payment_intents")
                  .where("booking_id", "in", bookingIds)
                  .select(["id"])
                  .execute();

                if (payments.length > 0) {
                  throw new Error(
                    `SAFETY CHECK FAILED: Cannot delete fixture service ${fId}; it has active payment records!`,
                  );
                }

                // Delete claims and hold snapshots for fixture bookings
                await trx
                  .deleteFrom("resource_claims")
                  .where("booking_id", "in", bookingIds)
                  .execute();
                await trx
                  .deleteFrom("booking_hold_snapshots")
                  .where("booking_id", "in", bookingIds)
                  .execute();
                await trx.deleteFrom("bookings").where("id", "in", bookingIds).execute();
              }

              // Delete quotes
              await trx.deleteFrom("booking_quotes").where("id", "in", quoteIds).execute();
            }

            // Delete hold snapshots pointing to version
            await trx
              .deleteFrom("booking_hold_snapshots")
              .where("service_version_id", "in", versionIds)
              .execute();

            // Delete service versions
            await trx.deleteFrom("service_versions").where("service_id", "=", fId).execute();
          }

          // Delete fixture service
          await trx.deleteFrom("services").where("id", "=", fId).execute();
        }
      }

      // Step B: Upsert canonical services and published versions
      for (const service of CANONICAL_SERVICES) {
        // Upsert service
        await trx
          .insertInto("services")
          .values({
            id: service.serviceId,
            tenant_id: SYNTHETIC_DEV_TENANT_ID,
            status: "ACTIVE",
            current_version_id: null,
          })
          .onConflict((oc) =>
            oc.columns(["tenant_id", "id"]).doUpdateSet({
              status: "ACTIVE",
            }),
          )
          .execute();

        // Upsert published service version
        await trx
          .insertInto("service_versions")
          .values({
            id: service.versionId,
            tenant_id: SYNTHETIC_DEV_TENANT_ID,
            service_id: service.serviceId,
            version: service.versionNumber,
            name: service.name,
            description: service.description,
            duration_minutes: service.durationMinutes,
            buffer_before_minutes: service.bufferBeforeMinutes,
            buffer_after_minutes: service.bufferAfterMinutes,
            price_minor: BigInt(service.priceMinor) as any,
            base_deposit_minor: BigInt(service.baseDepositMinor) as any,
            currency: service.currency,
            cancellation_policy_id: service.cancellationPolicyId,
            published_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(["tenant_id", "id"]).doUpdateSet({
              name: service.name,
              description: service.description,
              duration_minutes: service.durationMinutes,
              price_minor: BigInt(service.priceMinor) as any,
              base_deposit_minor: BigInt(service.baseDepositMinor) as any,
              currency: service.currency,
              cancellation_policy_id: service.cancellationPolicyId,
            }),
          )
          .execute();

        // Point service to current published version
        await trx
          .updateTable("services")
          .set({ current_version_id: service.versionId })
          .where("id", "=", service.serviceId)
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .execute();
      }
    });

    // 3. Print count after mutation
    const { finalServices, finalVersions } = await withTenantTransaction(
      db,
      SYNTHETIC_DEV_TENANT_ID as any,
      async (trx) => {
        const services = await trx
          .selectFrom("services")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .where("status", "=", "ACTIVE")
          .selectAll()
          .execute();

        const versions = await trx
          .selectFrom("service_versions")
          .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
          .selectAll()
          .execute();

        return { finalServices: services, finalVersions: versions };
      },
    );

    console.log("\n[SUCCESS] Development catalog successfully cleaned and seeded!");
    console.log(`Active services: ${finalServices.length}`);
    console.log(`Service versions: ${finalVersions.length}`);
    for (const s of finalServices) {
      const v = finalVersions.find((ver) => ver.id === s.current_version_id);
      console.log(
        ` ✓ [${s.id}] ${v?.name || "Unknown"} • ${v?.duration_minutes}m • $${Number(v?.price_minor || 0) / 100} (deposit $${Number(v?.base_deposit_minor || 0) / 100})`,
      );
    }

    return {
      fixtureCount: fixtureServiceIds.length,
      canonicalCount: finalServices.length,
      modified: true,
    };
  } finally {
    if (!options?.db) {
      await db.destroy();
    }
  }
}

// Standalone CLI execution
if (process.argv[1] && process.argv[1].endsWith("manage-dev-catalog.ts")) {
  const isConfirm = process.argv.includes("--confirm");
  manageDevCatalog({ confirm: isConfirm }).catch((err) => {
    console.error("FATAL ERROR in manageDevCatalog:", err);
    process.exit(1);
  });
}

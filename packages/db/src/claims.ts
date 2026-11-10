import { Kysely, sql } from "kysely";
import { SlotUnavailableError } from "@velvetai/contracts";
import type { Database } from "./schema.js";

export interface BlockingResourceClaimInput {
  claimId: string;
  tenantId: string;
  bookingId: string | null;
  claimSource?: "BOOKING" | "DEMO_FIXTURE";
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
  state: "HELD" | "CONFIRMED" | "COMMITTING";
  holdExpiresAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * Extracts PostgreSQL SQLSTATE code and message, traversing wrapped `cause` errors if present.
 */
function extractPgErrorInfo(err: unknown): { code?: string; message?: string } {
  let current: unknown = err;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : undefined,
      };
    }
    current = candidate.cause;
  }
  if (err && typeof err === "object") {
    const candidate = err as { message?: unknown };
    return {
      message: typeof candidate.message === "string" ? candidate.message : undefined,
    };
  }
  return {};
}

/**
 * Returns true when PostgreSQL reports a resource-claim exclusion or deadlock conflict:
 * - `23P01`: `exclusion_violation` (authoritative GiST constraint `no_overlapping_claims`)
 * - `40P01`: `deadlock_detected` (concurrent GiST index probe cycle fallback)
 */
export function isSlotConflictPgError(err: unknown): boolean {
  const { code, message } = extractPgErrorInfo(err);
  return (
    code === "23P01" ||
    code === "40P01" ||
    Boolean(message?.includes("no_overlapping_claims"))
  );
}

/**
 * Maps PostgreSQL `23P01` (`exclusion_violation`) and `40P01` (`deadlock_detected`)
 * to a safe HTTP 409 `SlotUnavailableError`, preserving all other errors unchanged.
 */
export function mapPgSlotConflictError(
  err: unknown,
  buildConflictDetails?: () => Record<string, unknown>,
): unknown {
  if (err instanceof SlotUnavailableError) {
    return err;
  }
  if (isSlotConflictPgError(err)) {
    return new SlotUnavailableError(
      "The selected slot is no longer available",
      buildConflictDetails?.(),
    );
  }
  return err;
}

/**
 * Authoritative production resource-claim insert path.
 *
 * Inside the caller's active database transaction:
 * 1. Acquires a transaction-scoped advisory lock on `(tenant_id, resource_id)` so concurrent
 *    transactions targeting the same resource serialize GiST index probes instead of forming
 *    deadlock cycles (`40P01`).
 * 2. Inserts the blocking claim into `resource_claims`, where the PostgreSQL GiST exclusion
 *    constraint `no_overlapping_claims` remains the authoritative concurrency barrier.
 * 3. Maps both `23P01` (`exclusion_violation`) and `40P01` (`deadlock_detected`) to HTTP 409
 *    `SlotUnavailableError`.
 */
export async function insertBlockingResourceClaim(
  trx: Kysely<Database>,
  input: BlockingResourceClaimInput,
  buildConflictDetails?: () => Record<string, unknown>,
): Promise<void> {
  // Serialize concurrent claim inserts per (tenant_id, resource_id) within the transaction
  // to prevent GiST index scan deadlock cycles; released automatically on commit/rollback.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId}), hashtext(${input.resourceId}))`.execute(
    trx,
  );

  try {
    await trx
      .insertInto("resource_claims")
      .values({
        id: input.claimId,
        tenant_id: input.tenantId,
        booking_id: input.bookingId as string,
        claim_source: input.claimSource ?? "BOOKING",
        resource_id: input.resourceId,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        blocked_during: sql`tstzrange(${input.startsAt.toISOString()}::timestamptz, ${input.endsAt.toISOString()}::timestamptz, '[)')`,
        state: input.state,
        blocking: true,
        hold_expires_at: input.holdExpiresAt ?? null,
        expires_at: input.expiresAt ?? null,
      })
      .execute();
  } catch (err: unknown) {
    throw mapPgSlotConflictError(err, buildConflictDetails);
  }
}


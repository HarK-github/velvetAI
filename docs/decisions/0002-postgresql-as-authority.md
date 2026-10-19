# 2. PostgreSQL as the Authoritative Store

## Status

Accepted

## Context

velvetAI requires strict concurrency safety for appointment slot allocations, atomic deposit capture recordings, balanced financial journals, immutable service snapshots, and multi-tenant isolation. No two appointments can overlap on the same resource unit, and no deposit can be captured or refunded without durable ACID records.

## Decision

PostgreSQL (version 17+) is the single authoritative source of truth for all bookings, resources, payments, idempotency records, outbox events, and audit logs:

- Exclusion constraints using `btree_gist` and `tstzrange` enforce non-overlapping resource claims at the database level.
- Multi-tenancy is enforced with non-null `tenant_id` on all tenant-owned rows and composite foreign keys.
- Kysely provides type-safe SQL query building without hidden ORM abstractions or runtime query overhead.
- Redis is used strictly as an ephemeral cache and async queue delivery mechanism; Redis is never the sole durable copy of critical state.

## Consequences

- Guarantees zero double bookings and zero over-refunds at the persistence tier.
- Database time (`CURRENT_TIMESTAMP` / `timestamptz`) is authoritative for holds, expirations, and cutoffs.
- Requires migrations that are strictly tested up and down.

## Alternatives Considered

- Prisma: Rejected due to heavy runtime, limited native support for exclusion constraints, and ORM abstractions that obscure SQL transaction control.
- In-memory / SQLite / NoSQL for authority: Prohibited by spec.md; lacks GiST exclusion constraints, robust concurrency guarantees, and production parity.

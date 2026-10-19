# 3. Transactional Outbox and Idempotent Consumers

## Status

Accepted

## Context

Asynchronous processing is necessary for webhook handling, background notifications, payment reconciliation, and waitlist refill. If an external message broker (like Redis or RabbitMQ) is updated separately from the database transaction, network failure can cause dual-write inconsistency (either the event is emitted but DB rolled back, or DB committed but event was lost).

## Decision

We implement the Transactional Outbox pattern:

1. Every domain mutation and its corresponding outbox event(s) are written in the exact same PostgreSQL database transaction.
2. Background workers poll or subscribe to outbox events, claim rows using safe concurrent semantics (`FOR UPDATE SKIP LOCKED`), and dispatch them to BullMQ queues.
3. Every asynchronous consumer implements inbox deduplication: before applying an effect, it checks and records event processing in the same transaction as its local mutation.
4. If a worker crashes or Redis is restarted, unprocessed outbox events remain in PostgreSQL and resume delivery upon recovery.

## Consequences

- At-least-once delivery with strictly idempotent processing.
- Guaranteed survival of domain events across worker and queue outages.
- Requires polling or listener overhead and periodic cleanup/archival of processed outbox entries.

## Alternatives Considered

- Direct Redis publish in route handlers: Rejected because failures during publish cause permanent event loss after DB commit.
- 2-Phase Commit (2PC): Rejected due to complexity, lack of support in Redis, and severe performance bottlenecks.

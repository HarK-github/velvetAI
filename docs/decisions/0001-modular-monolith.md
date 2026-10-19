# 1. Modular Monolith Architecture

## Status

Accepted

## Context

velvetAI is an appointment booking, deposit settlement, and agent safety platform. It integrates complex bounded contexts: identity & tenancy, catalog & policy, resource availability, concurrency-safe booking, PayPal payments, forecasting, and the Agent Abuse Lab. Microservices at this stage would introduce distributed transactions, network latency, deployment overhead, and eventual consistency issues in slot holds and financial journals. A monolithic codebase with tightly coupled spaghetti code would violate domain boundaries.

## Decision

We adopt a modular monolith architecture structured as a TypeScript pnpm workspace with Turborepo:

- `apps/`: Deployable services (`web`, `api`, `worker`, `abuse-lab`).
- `packages/`: Strict bounded contexts and shared capabilities (`contracts`, `domain`, `application`, `db`, `tool-registry`, `integrations-paypal`, `forecasting`, `observability`).
- Hexagonal architecture: `domain` and `application` packages contain core business logic and do not import Fastify, PayPal, Redis, Bryntum, OIDC, or model-provider SDKs.
- External systems are accessed via typed ports and adapters.

## Consequences

- Fast local development and single-repo atomic refactoring.
- Clear boundary enforcement using package dependencies and TypeScript project references.
- Easy migration to independent microservices if measured scale warrants it in future phases.

## Alternatives Considered

- Microservices: Rejected due to distributed transaction overhead, operational complexity, and latency risks.
- Single flat package/monorepo without packages: Rejected because domain invariants and external framework coupling would easily leak across boundaries.

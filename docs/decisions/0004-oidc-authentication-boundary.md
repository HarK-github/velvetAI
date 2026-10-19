# 4. OIDC Authentication Boundary and Membership RBAC

## Status

Accepted

## Context

velvetAI is a multi-tenant platform accessed by merchant owners, staff schedulers, buyers, and delegated AI assistants. A single user may belong to multiple tenants with different roles. Tenant ID must never be trusted from client request bodies or query parameters, as that would enable cross-tenant data tampering.

## Decision

1. Identity is authenticated via OpenID Connect (OIDC) Authorization Code with PKCE.
2. Tenant context is derived strictly from verified tenant membership records associated with the authenticated user ID.
3. The API runs requests under a validated tenant context; requests attempting to access or mutate resources outside that tenant are denied with non-enumerating 403 Forbidden responses.
4. For development and testing, an isolated mock authentication adapter is provided that issues valid test tokens and tenant memberships without requiring external OIDC infrastructure.
5. Buyer booking links utilize short-lived, signed tokens bound to booking ID, email, tenant, and allowed actions.

## Consequences

- Prevents cross-tenant parameter tampering and privilege escalation.
- Clean separation between Identity Provider (IdP) authentication and application-level authorization (RBAC).
- Requires tenant context resolution on every protected API call.

## Alternatives Considered

- Client-provided `tenant_id` header or body parameter without membership validation: Rejected due to severe cross-tenant security vulnerabilities (spec AL-006, AL-008).
- Database-per-tenant: Rejected for MVP due to connection pooling overhead, migration complexity, and operational cost; schema-level multi-tenancy with row-level constraints is sufficient and scalable.

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";
  readonly statusCode = 422;
}

export class EntityNotFoundError extends DomainError {
  readonly code = "ENTITY_NOT_FOUND";
  readonly statusCode = 404;

  constructor(entityName: string, id: string) {
    super(`${entityName} with id '${id}' was not found`);
  }
}

export class StaleVersionError extends DomainError {
  readonly code = "STALE_VERSION";
  readonly statusCode = 409;
}

export class ConcurrencyConflictError extends DomainError {
  readonly code = "CONCURRENCY_CONFLICT";
  readonly statusCode = 409;
}

export class UnauthorizedTenantAccessError extends DomainError {
  readonly code = "FORBIDDEN_TENANT_ACCESS";
  readonly statusCode = 403;

  constructor(tenantId: string) {
    super(`Access denied for tenant context '${tenantId}'`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  readonly statusCode = 409;

  constructor(key: string) {
    super(`Idempotency key '${key}' was already executed with a different canonical payload hash`);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";
  readonly statusCode = 400;

  constructor(fromState: string, toState: string, entity: string) {
    super(`Cannot transition ${entity} from state '${fromState}' to '${toState}'`);
  }
}

export class ImmutableVersionModificationError extends DomainError {
  readonly code = "IMMUTABLE_VERSION_MODIFICATION";
  readonly statusCode = 400;

  constructor(serviceVersionId: string) {
    super(`Published service version '${serviceVersionId}' is immutable and cannot be modified`);
  }
}

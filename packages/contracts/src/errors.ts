export class DomainError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SlotUnavailableError extends DomainError {
  constructor(
    message = "The selected slot is no longer available",
    details?: Record<string, unknown>,
  ) {
    super(message, "slot_unavailable", 409, details);
  }
}

export class StaleQuoteError extends DomainError {
  constructor(
    message = "The quote has expired or schedule revision changed",
    details?: Record<string, unknown>,
  ) {
    super(message, "stale_quote", 409, details);
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(fromState: string, toState: string, details?: Record<string, unknown>) {
    super(
      `Cannot transition from state '${fromState}' to '${toState}'`,
      "invalid_state_transition",
      409,
      { fromState, toState, ...details },
    );
  }
}

export class TenantIsolationViolationError extends DomainError {
  constructor(message = "Access to resource in another tenant is forbidden") {
    super(message, "tenant_forbidden", 403);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = "Idempotency key reused with different request payload") {
    super(message, "idempotency_conflict", 409);
  }
}

export class ImmutabilityViolationError extends DomainError {
  constructor(message = "Published service version or confirmed booking terms are immutable") {
    super(message, "immutability_violation", 422);
  }
}

export class OverRefundError extends DomainError {
  constructor(message = "Cumulative refund amount cannot exceed captured deposit") {
    super(message, "over_refund_prohibited", 422);
  }
}

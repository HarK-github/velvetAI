/**
 * Typed error taxonomy for PayPal Sandbox operations matching Epic 3 specification.
 */

export class PayPalError extends Error {
  readonly debugId?: string;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options?: {
      debugId?: string;
      httpStatus?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "PayPalError";
    this.debugId = options?.debugId;
    this.httpStatus = options?.httpStatus;
    this.errorCode = options?.errorCode;
    this.details = options?.details;
  }
}

/**
 * Definitive client failure: HTTP 4xx (except 401/408/429), unprocessable entity, invalid payload.
 * Non-retryable without changing the request.
 */
export class PayPalClientError extends PayPalError {
  constructor(
    message: string,
    options?: {
      debugId?: string;
      httpStatus?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PayPalClientError";
  }
}

/**
 * Retryable transport or server failure: HTTP 429 rate limit, 503 service unavailable, transient connection drop before dispatch.
 */
export class PayPalRetryableError extends PayPalError {
  constructor(
    message: string,
    options?: {
      debugId?: string;
      httpStatus?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PayPalRetryableError";
  }
}

/**
 * Unknown mutation outcome: HTTP 500/502/504 on POST, socket timeout, or connection reset after dispatch.
 * Mutation MUST NOT be retried with a new request ID; outcome must be reconciled.
 */
export class PayPalUnknownOutcomeError extends PayPalError {
  constructor(
    message: string,
    options?: {
      debugId?: string;
      httpStatus?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PayPalUnknownOutcomeError";
  }
}

/**
 * Authentication or configuration failure: 401 Unauthorized, invalid client credentials, or disallowed environment.
 */
export class PayPalAuthError extends PayPalError {
  constructor(
    message: string,
    options?: {
      debugId?: string;
      httpStatus?: number;
      errorCode?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PayPalAuthError";
  }
}

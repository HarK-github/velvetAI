import {
  TenantId,
  UserId,
  UUID,
} from "@velvetai/contracts";
import {
  InvariantViolationError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
} from "./errors.js";

export type IdempotencyState = "PENDING" | "RESOLVED" | "FAILED";

export interface IdempotencyRecordProps {
  id: UUID;
  tenantId: TenantId;
  actorId: UserId;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  state: IdempotencyState;
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export class IdempotencyRecord {
  readonly id: UUID;
  readonly tenantId: TenantId;
  readonly actorId: UserId;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  private _state: IdempotencyState;
  private _responseStatus?: number;
  private _responseBody?: unknown;
  readonly createdAt: Date;
  readonly expiresAt: Date;

  constructor(props: IdempotencyRecordProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Idempotency record must have a tenantId");
    }
    if (!props.idempotencyKey || props.idempotencyKey.trim().length === 0) {
      throw new InvariantViolationError("Idempotency key must not be empty");
    }
    if (!props.requestHash || props.requestHash.length !== 64) {
      throw new InvariantViolationError("Request hash must be a 64-character SHA-256 string");
    }

    this.id = props.id;
    this.tenantId = props.tenantId;
    this.actorId = props.actorId;
    this.operation = props.operation;
    this.idempotencyKey = props.idempotencyKey;
    this.requestHash = props.requestHash;
    this._state = props.state;
    this._responseStatus = props.responseStatus;
    this._responseBody = props.responseBody;
    this.createdAt = props.createdAt;
    this.expiresAt = props.expiresAt;
  }

  get state(): IdempotencyState {
    return this._state;
  }

  get responseStatus(): number | undefined {
    return this._responseStatus;
  }

  get responseBody(): unknown | undefined {
    return this._responseBody;
  }

  /**
   * Validates incoming request hash against stored hash.
   * Throws IdempotencyConflictError if hashes do not match.
   */
  validatePayloadHash(incomingHash: string): void {
    if (this.requestHash !== incomingHash) {
      throw new IdempotencyConflictError(this.idempotencyKey);
    }
  }

  resolve(status: number, body: unknown): void {
    if (this._state !== "PENDING") {
      throw new InvalidStateTransitionError(this._state, "RESOLVED", "IdempotencyRecord");
    }
    this._state = "RESOLVED";
    this._responseStatus = status;
    this._responseBody = body;
  }

  fail(status: number, body: unknown): void {
    if (this._state !== "PENDING") {
      throw new InvalidStateTransitionError(this._state, "FAILED", "IdempotencyRecord");
    }
    this._state = "FAILED";
    this._responseStatus = status;
    this._responseBody = body;
  }
}

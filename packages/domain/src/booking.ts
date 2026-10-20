import {
  BookingId,
  BookingQuoteId,
  TenantId,
  UserId,
  ResourceId,
  ServiceVersionId,
  CurrencyCode,
  MoneyMinor,
  BookingStatus,
} from "@velvetai/contracts";
import {
  InvariantViolationError,
  InvalidStateTransitionError,
} from "./errors.js";

export interface BookingQuoteProps {
  id: BookingQuoteId;
  tenantId: TenantId;
  serviceVersionId: ServiceVersionId;
  customerId: UserId;
  startsAt: Date;
  endsAt: Date;
  totalMinor: MoneyMinor;
  depositMinor: MoneyMinor;
  currency: CurrencyCode;
  canonicalHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export class BookingQuote {
  readonly id: BookingQuoteId;
  readonly tenantId: TenantId;
  readonly serviceVersionId: ServiceVersionId;
  readonly customerId: UserId;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly totalMinor: MoneyMinor;
  readonly depositMinor: MoneyMinor;
  readonly currency: CurrencyCode;
  readonly canonicalHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;

  constructor(props: BookingQuoteProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Booking quote must belong to a tenant");
    }
    if (props.startsAt.getTime() >= props.endsAt.getTime()) {
      throw new InvariantViolationError("Quote appointment start must precede end");
    }
    if (props.depositMinor > props.totalMinor) {
      throw new InvariantViolationError("Deposit cannot exceed total price");
    }
    // Quote lifetime must not exceed 5 minutes (300,000 ms) + 5s clock tolerance
    const maxExpiryMs = props.createdAt.getTime() + 305_000;
    if (props.expiresAt.getTime() > maxExpiryMs) {
      throw new InvariantViolationError("Quote lifetime cannot exceed 5 minutes");
    }

    this.id = props.id;
    this.tenantId = props.tenantId;
    this.serviceVersionId = props.serviceVersionId;
    this.customerId = props.customerId;
    this.startsAt = props.startsAt;
    this.endsAt = props.endsAt;
    this.totalMinor = props.totalMinor;
    this.depositMinor = props.depositMinor;
    this.currency = props.currency;
    this.canonicalHash = props.canonicalHash;
    this.expiresAt = props.expiresAt;
    this.createdAt = props.createdAt;

    Object.freeze(this);
  }

  isExpired(asOf: Date = new Date()): boolean {
    return asOf.getTime() >= this.expiresAt.getTime();
  }
}

export interface BookingProps {
  id: BookingId;
  tenantId: TenantId;
  customerId: UserId;
  quoteId: BookingQuoteId;
  status: BookingStatus;
  version: number;
  holdExpiresAt: Date | null;
  startsAt: Date;
  endsAt: Date;
  resourceId: ResourceId | null;
  createdAt: Date;
}

const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  HELD: ["PAYMENT_PENDING", "EXPIRED", "CANCELLED"],
  PAYMENT_PENDING: ["CONFIRMED", "CAPTURE_UNCERTAIN", "EXPIRED"],
  CAPTURE_UNCERTAIN: ["CONFIRMED", "EXPIRED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "NO_SHOW", "CANCEL_REQUESTED", "CANCELLED"],
  CHECKED_IN: ["COMPLETED", "NO_SHOW"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCEL_REQUESTED: ["CANCELLED"],
  CANCELLED: [],
  EXPIRED: [],
};

export class Booking {
  readonly id: BookingId;
  readonly tenantId: TenantId;
  readonly customerId: UserId;
  readonly quoteId: BookingQuoteId;
  private _status: BookingStatus;
  private _version: number;
  private _holdExpiresAt: Date | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  private _resourceId: ResourceId | null;
  readonly createdAt: Date;

  constructor(props: BookingProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Booking must belong to a tenant");
    }
    if (props.version < 1) {
      throw new InvariantViolationError("Booking version must be a positive integer");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.customerId = props.customerId;
    this.quoteId = props.quoteId;
    this._status = props.status;
    this._version = props.version;
    this._holdExpiresAt = props.holdExpiresAt;
    this.startsAt = props.startsAt;
    this.endsAt = props.endsAt;
    this._resourceId = props.resourceId;
    this.createdAt = props.createdAt;
  }

  get status(): BookingStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  get holdExpiresAt(): Date | null {
    return this._holdExpiresAt;
  }

  get resourceId(): ResourceId | null {
    return this._resourceId;
  }

  transitionTo(nextStatus: BookingStatus): void {
    const allowed = ALLOWED_TRANSITIONS[this._status];
    if (!allowed || !allowed.includes(nextStatus)) {
      throw new InvalidStateTransitionError(this._status, nextStatus, "Booking");
    }
    this._status = nextStatus;
    this._version += 1;
    if (nextStatus === "CONFIRMED" || nextStatus === "EXPIRED" || nextStatus === "CANCELLED") {
      this._holdExpiresAt = null;
    }
  }

  assignResource(resourceId: ResourceId): void {
    if (this._status !== "HELD" && this._status !== "CONFIRMED") {
      throw new InvariantViolationError("Cannot assign resource in terminal or pending payment state");
    }
    this._resourceId = resourceId;
    this._version += 1;
  }
}

import {
  TenantId,
  ResourceId,
  IanaTimeZone,
  UUID,
} from "@velvetai/contracts";
import { InvariantViolationError } from "./errors.js";

export class TimeRange {
  readonly startsAt: Date;
  readonly endsAt: Date;

  constructor(startsAt: Date, endsAt: Date) {
    if (startsAt.getTime() >= endsAt.getTime()) {
      throw new InvariantViolationError("TimeRange start must be strictly before end");
    }
    this.startsAt = startsAt;
    this.endsAt = endsAt;
    Object.freeze(this);
  }

  get durationMs(): number {
    return this.endsAt.getTime() - this.startsAt.getTime();
  }

  overlaps(other: TimeRange): boolean {
    return this.startsAt.getTime() < other.endsAt.getTime() &&
           other.startsAt.getTime() < this.endsAt.getTime();
  }

  contains(date: Date): boolean {
    return date.getTime() >= this.startsAt.getTime() && date.getTime() < this.endsAt.getTime();
  }
}

export interface AvailabilityRuleProps {
  id: UUID;
  tenantId: TenantId;
  resourceId: ResourceId;
  timezone: IanaTimeZone;
  recurrenceRule: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}

export class AvailabilityRule {
  readonly id: UUID;
  readonly tenantId: TenantId;
  readonly resourceId: ResourceId;
  readonly timezone: IanaTimeZone;
  readonly recurrenceRule: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;

  constructor(props: AvailabilityRuleProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Availability rule must have a tenantId");
    }
    if (!props.resourceId) {
      throw new InvariantViolationError("Availability rule must specify a resourceId");
    }
    if (!props.recurrenceRule || props.recurrenceRule.trim().length === 0) {
      throw new InvariantViolationError("Recurrence rule must not be empty");
    }
    if (props.effectiveTo && props.effectiveFrom.getTime() >= props.effectiveTo.getTime()) {
      throw new InvariantViolationError("effectiveFrom must be earlier than effectiveTo");
    }

    this.id = props.id;
    this.tenantId = props.tenantId;
    this.resourceId = props.resourceId;
    this.timezone = props.timezone;
    this.recurrenceRule = props.recurrenceRule;
    this.effectiveFrom = props.effectiveFrom;
    this.effectiveTo = props.effectiveTo ?? null;
  }
}

export interface AvailabilityExceptionProps {
  id: UUID;
  tenantId: TenantId;
  resourceId: ResourceId;
  range: TimeRange;
  isAvailable: boolean; // false = closure/blackout, true = override open
  reason?: string;
}

export class AvailabilityException {
  readonly id: UUID;
  readonly tenantId: TenantId;
  readonly resourceId: ResourceId;
  readonly range: TimeRange;
  readonly isAvailable: boolean;
  readonly reason: string | null;

  constructor(props: AvailabilityExceptionProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Availability exception must have a tenantId");
    }
    if (!props.resourceId) {
      throw new InvariantViolationError("Availability exception must specify a resourceId");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.resourceId = props.resourceId;
    this.range = props.range;
    this.isAvailable = props.isAvailable;
    this.reason = props.reason ?? null;
  }
}

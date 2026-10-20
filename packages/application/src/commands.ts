import {
  TenantId,
  UserId,
  ServiceId,
  LocationId,
  ResourceId,
  CancellationPolicyId,
  BookingQuoteId,
  MoneyMinor,
  CurrencyCode,
  IanaTimeZone,
  ResourceType,
} from "@velvetai/contracts";

export interface CreateServiceCommand {
  tenantId: TenantId;
  name: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceMinor: MoneyMinor;
  baseDepositMinor: MoneyMinor;
  currency: CurrencyCode;
  cancellationPolicyId: CancellationPolicyId;
}

export interface PublishServiceVersionCommand {
  tenantId: TenantId;
  serviceId: ServiceId;
  name: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceMinor: MoneyMinor;
  baseDepositMinor: MoneyMinor;
  currency: CurrencyCode;
  cancellationPolicyId: CancellationPolicyId;
}

export interface CreateResourceCommand {
  tenantId: TenantId;
  locationId: LocationId;
  resourceType: ResourceType;
  displayName: string;
}

export interface CreateAvailabilityRuleCommand {
  tenantId: TenantId;
  resourceId: ResourceId;
  timezone: IanaTimeZone;
  recurrenceRule: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}

export interface CreateBookingQuoteCommand {
  tenantId: TenantId;
  customerId: UserId;
  serviceId: ServiceId;
  locationId: LocationId;
  startsAt: Date;
  timeZone: IanaTimeZone;
}

export interface CreateBookingHoldCommand {
  tenantId: TenantId;
  customerId: UserId;
  quoteId: BookingQuoteId;
  customerNote?: string;
  idempotencyKey: string;
}

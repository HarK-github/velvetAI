import {
  TenantId,
  ServiceId,
  LocationId,
  BookingId,
  IanaTimeZone,
} from "@velvetai/contracts";

export interface ListServicesQuery {
  tenantId: TenantId;
  includeArchived?: boolean;
}

export interface GetServiceQuery {
  tenantId: TenantId;
  serviceId: ServiceId;
}

export interface ListResourcesQuery {
  tenantId: TenantId;
  locationId?: LocationId;
}

export interface GetAvailabilityQuery {
  tenantId: TenantId;
  serviceId: ServiceId;
  locationId: LocationId;
  from: Date;
  to: Date;
  timeZone: IanaTimeZone;
}

export interface GetBookingQuery {
  tenantId: TenantId;
  bookingId: BookingId;
}

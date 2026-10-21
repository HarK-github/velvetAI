import {
  TenantId,
  ServiceId,
  ServiceVersionId,
  ResourceId,
  LocationId,
  CancellationPolicyId,
  CurrencyCode,
  MoneyMinor,
  ResourceType,
} from "@velvetai/contracts";
import {
  InvariantViolationError,
  ImmutableVersionModificationError,
} from "./errors.js";

export interface ServiceVersionProps {
  id: ServiceVersionId;
  tenantId: TenantId;
  serviceId: ServiceId;
  version: number;
  name: string;
  description?: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: MoneyMinor;
  baseDepositMinor: MoneyMinor;
  currency: CurrencyCode;
  cancellationPolicyId: CancellationPolicyId;
  publishedAt: Date;
}

export class ServiceVersion {
  readonly id: ServiceVersionId;
  readonly tenantId: TenantId;
  readonly serviceId: ServiceId;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly priceMinor: MoneyMinor;
  readonly baseDepositMinor: MoneyMinor;
  readonly currency: CurrencyCode;
  readonly cancellationPolicyId: CancellationPolicyId;
  readonly publishedAt: Date;

  constructor(props: ServiceVersionProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Service version must belong to a tenant");
    }
    if (!props.serviceId) {
      throw new InvariantViolationError("Service version must reference a service");
    }
    if (props.version < 1) {
      throw new InvariantViolationError("Service version number must be a positive integer");
    }
    if (!props.name || props.name.trim().length === 0) {
      throw new InvariantViolationError("Service name must not be empty");
    }
    if (props.durationMinutes < 5 || props.durationMinutes > 480) {
      throw new InvariantViolationError(
        `Duration must be between 5 and 480 minutes, got ${props.durationMinutes}`,
      );
    }
    if (props.bufferBeforeMinutes < 0 || props.bufferBeforeMinutes > 240) {
      throw new InvariantViolationError(
        `Buffer before must be between 0 and 240 minutes, got ${props.bufferBeforeMinutes}`,
      );
    }
    if (props.bufferAfterMinutes < 0 || props.bufferAfterMinutes > 240) {
      throw new InvariantViolationError(
        `Buffer after must be between 0 and 240 minutes, got ${props.bufferAfterMinutes}`,
      );
    }
    const price = BigInt(props.priceMinor);
    const deposit = BigInt(props.baseDepositMinor);
    if (price < 0n) {
      throw new InvariantViolationError("Price minor cannot be negative");
    }
    if (deposit < 0n) {
      throw new InvariantViolationError("Base deposit minor cannot be negative");
    }
    if (deposit > price) {
      throw new InvariantViolationError("Base deposit cannot exceed total service price");
    }

    this.id = props.id;
    this.tenantId = props.tenantId;
    this.serviceId = props.serviceId;
    this.version = props.version;
    this.name = props.name.trim();
    this.description = props.description ?? null;
    this.durationMinutes = props.durationMinutes;
    this.bufferBeforeMinutes = props.bufferBeforeMinutes;
    this.bufferAfterMinutes = props.bufferAfterMinutes;
    this.priceMinor = props.priceMinor;
    this.baseDepositMinor = props.baseDepositMinor;
    this.currency = props.currency;
    this.cancellationPolicyId = props.cancellationPolicyId;
    this.publishedAt = props.publishedAt;

    // Freeze instance to enforce runtime immutability
    Object.freeze(this);
  }

  // Prevent any in-place mutation attempts
  mutate(): never {
    throw new ImmutableVersionModificationError(this.id);
  }
}

export interface ServiceProps {
  id: ServiceId;
  tenantId: TenantId;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  currentVersionId: ServiceVersionId | null;
  createdAt: Date;
}

export class Service {
  readonly id: ServiceId;
  readonly tenantId: TenantId;
  private _status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  private _currentVersionId: ServiceVersionId | null;
  readonly createdAt: Date;

  constructor(props: ServiceProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Service must belong to a tenant");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this._status = props.status;
    this._currentVersionId = props.currentVersionId;
    this.createdAt = props.createdAt;
  }

  get status(): "DRAFT" | "ACTIVE" | "ARCHIVED" {
    return this._status;
  }

  get currentVersionId(): ServiceVersionId | null {
    return this._currentVersionId;
  }

  publishVersion(newVersion: ServiceVersion): void {
    if (newVersion.serviceId !== this.id) {
      throw new InvariantViolationError("Version does not belong to this service");
    }
    if (newVersion.tenantId !== this.tenantId) {
      throw new InvariantViolationError("Version tenant does not match service tenant");
    }
    this._currentVersionId = newVersion.id;
    this._status = "ACTIVE";
  }

  archive(): void {
    this._status = "ARCHIVED";
  }
}

export interface ResourceProps {
  id: ResourceId;
  tenantId: TenantId;
  locationId: LocationId;
  resourceType: ResourceType;
  displayName: string;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
}

export class Resource {
  readonly id: ResourceId;
  readonly tenantId: TenantId;
  readonly locationId: LocationId;
  readonly resourceType: ResourceType;
  readonly displayName: string;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly createdAt: Date;

  constructor(props: ResourceProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Resource must belong to a tenant");
    }
    if (!props.locationId) {
      throw new InvariantViolationError("Resource must belong to a location");
    }
    if (!props.displayName || props.displayName.trim().length === 0) {
      throw new InvariantViolationError("Resource display name cannot be empty");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.locationId = props.locationId;
    this.resourceType = props.resourceType;
    this.displayName = props.displayName.trim();
    this.status = props.status;
    this.createdAt = props.createdAt;
  }
}

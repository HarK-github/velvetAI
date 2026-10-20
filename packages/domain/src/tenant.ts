import {
  TenantId,
  UserId,
  LocationId,
  CurrencyCode,
  IanaTimeZone,
  Role,
} from "@velvetai/contracts";
import { InvariantViolationError, UnauthorizedTenantAccessError } from "./errors.js";

export interface TenantProps {
  id: TenantId;
  name: string;
  defaultCurrency: CurrencyCode;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  createdAt: Date;
}

export class Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly defaultCurrency: CurrencyCode;
  readonly status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly createdAt: Date;

  constructor(props: TenantProps) {
    if (!props.id) {
      throw new InvariantViolationError("Tenant ID must not be null or empty");
    }
    if (!props.name || props.name.trim().length === 0) {
      throw new InvariantViolationError("Tenant name must not be empty");
    }
    if (!props.defaultCurrency || props.defaultCurrency.length !== 3) {
      throw new InvariantViolationError("Tenant default currency must be a 3-character ISO code");
    }

    this.id = props.id;
    this.name = props.name.trim();
    this.defaultCurrency = props.defaultCurrency;
    this.status = props.status;
    this.createdAt = props.createdAt;
  }
}

export interface LocationProps {
  id: LocationId;
  tenantId: TenantId;
  name: string;
  timezone: IanaTimeZone;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
}

export class Location {
  readonly id: LocationId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly timezone: IanaTimeZone;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly createdAt: Date;

  constructor(props: LocationProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Location must belong to a tenant (tenantId cannot be null)");
    }
    if (!props.name || props.name.trim().length === 0) {
      throw new InvariantViolationError("Location name cannot be empty");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.name = props.name.trim();
    this.timezone = props.timezone;
    this.status = props.status;
    this.createdAt = props.createdAt;
  }
}

export interface MembershipProps {
  tenantId: TenantId;
  role: Role;
  roleVersion: number;
  revokedAt: Date | null;
}

export interface PrincipalProps {
  id: UserId;
  oidcSubject: string;
  emailCiphertext: string;
  memberships: MembershipProps[];
}

export class UserPrincipal {
  readonly id: UserId;
  readonly oidcSubject: string;
  readonly emailCiphertext: string;
  readonly memberships: readonly MembershipProps[];

  constructor(props: PrincipalProps) {
    if (!props.id) {
      throw new InvariantViolationError("User ID must be provided");
    }
    if (!props.oidcSubject) {
      throw new InvariantViolationError("OIDC subject must be provided");
    }
    this.id = props.id;
    this.oidcSubject = props.oidcSubject;
    this.emailCiphertext = props.emailCiphertext;
    this.memberships = Object.freeze([...props.memberships]);
  }

  /**
   * Asserts user has active membership for the given tenant and returns their role.
   * Throws UnauthorizedTenantAccessError if not member or membership is revoked.
   */
  assertMembership(tenantId: TenantId): { role: Role; roleVersion: number } {
    const membership = this.memberships.find(
      (m) => m.tenantId === tenantId && m.revokedAt === null,
    );
    if (!membership) {
      throw new UnauthorizedTenantAccessError(tenantId);
    }
    return { role: membership.role, roleVersion: membership.roleVersion };
  }

  hasRole(tenantId: TenantId, allowedRoles: readonly Role[]): boolean {
    const membership = this.memberships.find(
      (m) => m.tenantId === tenantId && m.revokedAt === null,
    );
    if (!membership) return false;
    return allowedRoles.includes(membership.role);
  }
}

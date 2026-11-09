import type { TenantId } from "@velvetai/contracts";
import { DomainError } from "./errors.js";

export const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01" as TenantId;
export const JUDGE_SEED_VERSION = "judge-seed-v1";
export const JUDGE_NAMESPACE = "01932b10-0000-7000-8000-000000000a00";

export class JudgeResetInProgressError extends DomainError {
  readonly code = "JUDGE_RESET_IN_PROGRESS";
  readonly statusCode = 409;

  constructor(message = "A judge reset run is currently in progress") {
    super(message);
  }
}

export class JudgeResetTenantMismatchError extends DomainError {
  readonly code = "FORBIDDEN_TENANT_ACCESS";
  readonly statusCode = 403;

  constructor(tenantId: string) {
    super(`Cannot run judge reset on non-judge tenant '${tenantId}'`);
  }
}


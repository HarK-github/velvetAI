import { describe, it, expect } from "vitest";
import {
  DomainError,
  SlotUnavailableError,
  InvalidStateTransitionError,
  TenantIsolationViolationError,
} from "../errors.js";

describe("Domain Errors", () => {
  it("creates DomainError with correct status and code", () => {
    const error = new DomainError("Test error", "test_code", 400);
    expect(error.message).toBe("Test error");
    expect(error.code).toBe("test_code");
    expect(error.status).toBe(400);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof DomainError).toBe(true);
  });

  it("creates SlotUnavailableError as 409", () => {
    const error = new SlotUnavailableError();
    expect(error.status).toBe(409);
    expect(error.code).toBe("slot_unavailable");
  });

  it("creates InvalidStateTransitionError with state details", () => {
    const error = new InvalidStateTransitionError("HELD", "COMPLETED");
    expect(error.status).toBe(409);
    expect(error.code).toBe("invalid_state_transition");
    expect(error.details?.fromState).toBe("HELD");
    expect(error.details?.toState).toBe("COMPLETED");
  });

  it("creates TenantIsolationViolationError as 403", () => {
    const error = new TenantIsolationViolationError();
    expect(error.status).toBe(403);
    expect(error.code).toBe("tenant_forbidden");
  });
});

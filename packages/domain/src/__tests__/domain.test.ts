import { describe, it, expect } from "vitest";
import {
  generateUUIDv7,
  tenantIdSchema,
  userIdSchema,
  serviceIdSchema,
  serviceVersionIdSchema,
  cancellationPolicyIdSchema,
  locationIdSchema,
  resourceIdSchema,
  bookingIdSchema,
  bookingQuoteIdSchema,
  currencyCodeSchema,
  ianaTimeZoneSchema,
  moneyMinorSchema,
} from "@velvetai/contracts";
import {
  Tenant,
  Location,
  UserPrincipal,
  ServiceVersion,
  Service,
  Resource,
  Booking,
  BookingQuote,
  TimeRange,
  IdempotencyRecord,
  AuditEvent,
  InvariantViolationError,
  ImmutableVersionModificationError,
  UnauthorizedTenantAccessError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
} from "../index.js";

describe("Domain Models & Invariants", () => {
  const tenantId = tenantIdSchema.parse(generateUUIDv7());
  const otherTenantId = tenantIdSchema.parse(generateUUIDv7());
  const userId = userIdSchema.parse(generateUUIDv7());
  const locationId = locationIdSchema.parse(generateUUIDv7());
  const usd = currencyCodeSchema.parse("USD");
  const nyTz = ianaTimeZoneSchema.parse("America/New_York");

  describe("Tenant & Location", () => {
    it("creates valid Tenant and rejects invalid names", () => {
      const tenant = new Tenant({
        id: tenantId,
        name: "Acme Salon",
        defaultCurrency: usd,
        status: "ACTIVE",
        createdAt: new Date(),
      });
      expect(tenant.name).toBe("Acme Salon");

      expect(() => {
        new Tenant({
          id: tenantId,
          name: "",
          defaultCurrency: usd,
          status: "ACTIVE",
          createdAt: new Date(),
        });
      }).toThrow(InvariantViolationError);
    });

    it("creates Location and enforces non-null tenantId", () => {
      const location = new Location({
        id: locationId,
        tenantId,
        name: "Downtown Branch",
        timezone: nyTz,
        status: "ACTIVE",
        createdAt: new Date(),
      });
      expect(location.tenantId).toBe(tenantId);
    });
  });

  describe("UserPrincipal & Tenant Isolation", () => {
    it("validates membership and enforces tenant isolation", () => {
      const principal = new UserPrincipal({
        id: userId,
        oidcSubject: "auth0|12345",
        emailCiphertext: "enc_email",
        memberships: [
          {
            tenantId,
            role: "OWNER",
            roleVersion: 1,
            revokedAt: null,
          },
        ],
      });

      const { role } = principal.assertMembership(tenantId);
      expect(role).toBe("OWNER");

      expect(() => {
        principal.assertMembership(otherTenantId);
      }).toThrow(UnauthorizedTenantAccessError);
    });
  });

  describe("Catalog & ServiceVersion Immutability", () => {
    it("enforces duration boundaries between 5 and 480 minutes", () => {
      const serviceId = serviceIdSchema.parse(generateUUIDv7());
      const versionId = serviceVersionIdSchema.parse(generateUUIDv7());
      const policyId = cancellationPolicyIdSchema.parse(generateUUIDv7());

      expect(() => {
        new ServiceVersion({
          id: versionId,
          tenantId,
          serviceId,
          version: 1,
          name: "Too short haircut",
          durationMinutes: 2, // < 5 min
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceMinor: moneyMinorSchema.parse("5000"),
          baseDepositMinor: moneyMinorSchema.parse("1500"),
          currency: usd,
          cancellationPolicyId: policyId,
          publishedAt: new Date(),
        });
      }).toThrow(InvariantViolationError);

      expect(() => {
        new ServiceVersion({
          id: versionId,
          tenantId,
          serviceId,
          version: 1,
          name: "Too long haircut",
          durationMinutes: 600, // > 480 min
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceMinor: moneyMinorSchema.parse("5000"),
          baseDepositMinor: moneyMinorSchema.parse("1500"),
          currency: usd,
          cancellationPolicyId: policyId,
          publishedAt: new Date(),
        });
      }).toThrow(InvariantViolationError);
    });

    it("enforces base deposit cannot exceed total service price", () => {
      const serviceId = serviceIdSchema.parse(generateUUIDv7());
      const versionId = serviceVersionIdSchema.parse(generateUUIDv7());
      const policyId = cancellationPolicyIdSchema.parse(generateUUIDv7());

      expect(() => {
        new ServiceVersion({
          id: versionId,
          tenantId,
          serviceId,
          version: 1,
          name: "Haircut",
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceMinor: moneyMinorSchema.parse("5000"),
          baseDepositMinor: moneyMinorSchema.parse("6000"), // > price
          currency: usd,
          cancellationPolicyId: policyId,
          publishedAt: new Date(),
        });
      }).toThrow(InvariantViolationError);
    });

    it("enforces service version immutability after publication", () => {
      const serviceId = serviceIdSchema.parse(generateUUIDv7());
      const versionId = serviceVersionIdSchema.parse(generateUUIDv7());
      const policyId = cancellationPolicyIdSchema.parse(generateUUIDv7());

      const version = new ServiceVersion({
        id: versionId,
        tenantId,
        serviceId,
        version: 1,
        name: "Standard Cut",
        durationMinutes: 45,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        priceMinor: moneyMinorSchema.parse("4000"),
        baseDepositMinor: moneyMinorSchema.parse("1000"),
        currency: usd,
        cancellationPolicyId: policyId,
        publishedAt: new Date(),
      });

      expect(() => {
        version.mutate();
      }).toThrow(ImmutableVersionModificationError);

      expect(() => {
        (version as unknown as { name: string }).name = "Modified Name";
      }).toThrow();
    });

    it("manages Service lifecycle and Resource configuration", () => {
      const serviceId = serviceIdSchema.parse(generateUUIDv7());
      const service = new Service({
        id: serviceId,
        tenantId,
        status: "DRAFT",
        currentVersionId: null,
        createdAt: new Date(),
      });
      expect(service.status).toBe("DRAFT");
      service.archive();
      expect(service.status).toBe("ARCHIVED");

      const resource = new Resource({
        id: resourceIdSchema.parse(generateUUIDv7()),
        tenantId,
        locationId,
        resourceType: "STAFF",
        displayName: "Stylist Emma",
        status: "ACTIVE",
        createdAt: new Date(),
      });
      expect(resource.displayName).toBe("Stylist Emma");
    });
  });

  describe("TimeRange and Availability", () => {
    it("validates time ranges and detects overlaps", () => {
      const start = new Date(Date.now() + 3600_000);
      const end = new Date(Date.now() + 7200_000);
      const range1 = new TimeRange(start, end);
      expect(range1.durationMs).toBe(3600_000);

      const overlappingRange = new TimeRange(
        new Date(start.getTime() + 1800_000),
        new Date(end.getTime() + 1800_000),
      );
      expect(range1.overlaps(overlappingRange)).toBe(true);

      expect(() => new TimeRange(end, start)).toThrow(InvariantViolationError);
    });
  });

  describe("Booking & State Transitions", () => {
    it("enforces state machine transitions", () => {
      const booking = new Booking({
        id: bookingIdSchema.parse(generateUUIDv7()),
        tenantId,
        customerId: userId,
        quoteId: bookingQuoteIdSchema.parse(generateUUIDv7()),
        status: "HELD",
        version: 1,
        holdExpiresAt: new Date(Date.now() + 300_000),
        startsAt: new Date(Date.now() + 86400_000),
        endsAt: new Date(Date.now() + 86400_000 + 3600_000),
        resourceId: null,
        createdAt: new Date(),
      });

      expect(booking.status).toBe("HELD");
      booking.transitionTo("PAYMENT_PENDING");
      expect(booking.status).toBe("PAYMENT_PENDING");
      expect(booking.version).toBe(2);

      booking.transitionTo("CONFIRMED");
      expect(booking.status).toBe("CONFIRMED");
      expect(booking.holdExpiresAt).toBeNull();

      expect(() => {
        booking.transitionTo("EXPIRED");
      }).toThrow(InvalidStateTransitionError);
    });

    it("rejects booking quotes with TTL > 5 minutes", () => {
      const now = new Date();
      expect(() => {
        new BookingQuote({
          id: bookingQuoteIdSchema.parse(generateUUIDv7()),
          tenantId,
          serviceVersionId: serviceVersionIdSchema.parse(generateUUIDv7()),
          customerId: userId,
          startsAt: new Date(now.getTime() + 86400_000),
          endsAt: new Date(now.getTime() + 86400_000 + 3600_000),
          totalMinor: moneyMinorSchema.parse("5000"),
          depositMinor: moneyMinorSchema.parse("1500"),
          currency: usd,
          canonicalHash: "a".repeat(64),
          expiresAt: new Date(now.getTime() + 600_000),
          createdAt: now,
        });
      }).toThrow(InvariantViolationError);
    });
  });

  describe("Idempotency & Request Hash", () => {
    it("detects payload hash conflicts", () => {
      const hash1 = "1".repeat(64);
      const hash2 = "2".repeat(64);

      const record = new IdempotencyRecord({
        id: generateUUIDv7(),
        tenantId,
        actorId: userId,
        operation: "create_booking_hold",
        idempotencyKey: "idem-key-123",
        requestHash: hash1,
        state: "PENDING",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
      });

      expect(() => record.validatePayloadHash(hash1)).not.toThrow();
      expect(() => record.validatePayloadHash(hash2)).toThrow(IdempotencyConflictError);
    });
  });

  describe("Audit Events", () => {
    it("creates append-only frozen audit events", () => {
      const audit = new AuditEvent({
        id: generateUUIDv7(),
        tenantId,
        actorId: userId,
        actorType: "USER",
        action: "SERVICE_CREATED",
        resourceType: "SERVICE",
        resourceId: generateUUIDv7(),
        metadataRedacted: { serviceName: "Haircut" },
        occurredAt: new Date(),
      });

      expect(audit.action).toBe("SERVICE_CREATED");
      expect(() => {
        (audit as unknown as { action: string }).action = "MUTATED";
      }).toThrow();
    });
  });
});

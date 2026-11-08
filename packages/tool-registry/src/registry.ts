import { z } from "zod";
import {
  Role,
  Scope,
  createBookingQuoteInputSchema,
  prepareBookingInputSchema,
  commitBookingInputSchema,
  BookingId,
  TenantId,
  ServiceId,
  LocationId,
  IanaTimeZone,
  InsufficientScopeError,
  DomainError,
  canonicalMoneySchema,
  formatMoney,
} from "@velvetai/contracts";
import {
  BookingService,
  CatalogService,
  AvailabilityService,
  BookingActor,
} from "@velvetai/application";
import { Database, withTenantTransaction } from "@velvetai/db";
import { Kysely } from "kysely";

export type ToolRiskLevel = "READ_ONLY" | "LOW_RISK" | "CONSEQUENTIAL";

export interface ToolExecutionContext {
  tenantId: TenantId;
  actor: BookingActor;
  clientId: string;
  scopes?: Scope[];
  bookingService: BookingService;
  catalogService: CatalogService;
  availabilityService: AvailabilityService;
  db?: Kysely<Database>;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  riskLevel: ToolRiskLevel;
  requiredScopes?: Scope[];
  requiredRoles: Role[];
  requiresConfirmation: boolean;
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  enabled?: boolean;
  execute: (input: TInput, context: any) => Promise<TOutput>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    const fullKey = `${tool.name}@${tool.version}`;
    this.tools.set(fullKey, tool as unknown as ToolDefinition<unknown, unknown>);
    this.tools.set(tool.name, tool as unknown as ToolDefinition<unknown, unknown>);

    // If name has .v1, also alias without version suffix
    if (tool.name.includes(".")) {
      const baseName = tool.name.split(".")[0];
      if (baseName && !this.tools.has(baseName)) {
        this.tools.set(baseName, tool as unknown as ToolDefinition<unknown, unknown>);
      }
    }
  }

  get(name: string, version?: string): ToolDefinition | undefined {
    if (version) {
      return this.tools.get(`${name}@${version}`);
    }
    if (this.tools.has(name)) {
      return this.tools.get(name);
    }
    for (const [key, tool] of this.tools.entries()) {
      if (key.startsWith(`${name}@`) || key === name) {
        return tool;
      }
    }
    return undefined;
  }

  list(): Array<Omit<ToolDefinition, "execute">> {
    const unique = new Map<string, ToolDefinition>();
    for (const tool of this.tools.values()) {
      unique.set(tool.name, tool);
    }
    return Array.from(unique.values()).map(({ execute: _, ...rest }) => rest);
  }

  async execute<TInput, TOutput>(name: string, rawInput: TInput, context: any): Promise<TOutput> {
    const tool = this.get(name);
    if (!tool) {
      throw new DomainError(`Tool '${name}' not found in registry`, "tool_not_found", 404);
    }

    if (tool.enabled === false) {
      throw new DomainError(`Tool '${name}' is currently disabled`, "tool_disabled", 403);
    }

    // 1. Authoritative Scope Enforcement
    if (context?.scopes && tool.requiredScopes && tool.requiredScopes.length > 0) {
      const hasAllScopes = tool.requiredScopes.every((s: Scope) => context.scopes!.includes(s));
      if (!hasAllScopes) {
        throw new InsufficientScopeError(tool.requiredScopes, context.scopes);
      }
    }

    // 2. Authoritative Role Enforcement
    if (context?.actor?.roles && tool.requiredRoles.length > 0) {
      const hasRole = context.actor.roles.some((r: string) =>
        tool.requiredRoles.includes(r as Role),
      );
      if (!hasRole) {
        throw new DomainError(
          `Actor with roles [${context.actor.roles.join(", ")}] is not authorized for tool '${name}'`,
          "unauthorized_role",
          403,
        );
      }
    }

    // 3. Strict Closed Schema Validation
    const parsedInput = tool.inputSchema.parse(rawInput);

    // 4. Execute Real Application Service Adapter
    return (await tool.execute(parsedInput, context)) as TOutput;
  }
}

export const sharedToolRegistry = new ToolRegistry();

// 1. list_services.v1 (Read-Only)
sharedToolRegistry.register({
  name: "list_services.v1",
  version: "1.0.0",
  description: "Lists active bookable services and published service versions for the tenant.",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    services: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        durationMinutes: z.number(),
        price: canonicalMoneySchema,
        deposit: canonicalMoneySchema,
        formattedPrice: z.string().optional(),
        formattedDeposit: z.string().optional(),
        cancellationPolicyId: z.string().optional(),
        status: z.string().optional(),
        currentVersionId: z.string().optional().nullable(),
        versions: z.array(z.any()).optional(),
      }),
    ),
    total: z.number(),
  }),
  riskLevel: "READ_ONLY",
  requiredScopes: ["booking:read"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "WORKER", "SUPPORT", "ABUSE_LAB"],
  requiresConfirmation: false,
  readOnlyHint: true,
  consequentialHint: false,
  enabled: true,
  execute: async (_input, context) => {
    if (!context?.catalogService) {
      return { services: [], total: 0 };
    }
    const services = await context.catalogService.listServices(context.tenantId);
    const mapped = services.map((s: any) => {
      const v = s.versions?.[0];
      const price = {
        valueMinor: v ? String(v.priceMinor) : "0",
        currency: v?.currency || "USD",
      };
      const deposit = {
        valueMinor: v ? String(v.baseDepositMinor) : "0",
        currency: v?.currency || "USD",
      };
      return {
        id: s.id,
        name: v?.name ?? "Service",
        description: v?.description,
        durationMinutes: v?.durationMinutes ?? 45,
        price,
        deposit,
        formattedPrice: formatMoney(price),
        formattedDeposit: formatMoney(deposit),
        cancellationPolicyId: v?.cancellationPolicyId,
        status: s.status,
        currentVersionId: s.currentVersionId,
        versions: s.versions,
      };
    });
    return {
      services: mapped,
      total: mapped.length,
    };
  },
});

// 2. find_available_slots.v1 (Read-Only)
sharedToolRegistry.register({
  name: "find_available_slots.v1",
  version: "1.0.0",
  description:
    "Calculates authoritative available booking slots for a service, location, and window.",
  inputSchema: z
    .object({
      serviceId: z.string().uuid(),
      locationId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      timeZone: z.string().max(100).optional(),
    })
    .strict(),
  outputSchema: z.object({
    slots: z.array(z.any()),
    scheduleRevision: z.number().optional(),
    generatedAt: z.string().optional(),
  }),
  riskLevel: "READ_ONLY",
  requiredScopes: ["booking:read"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "WORKER", "SUPPORT", "ABUSE_LAB"],
  requiresConfirmation: false,
  readOnlyHint: true,
  consequentialHint: false,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.availabilityService) {
      return { slots: [] };
    }
    const result = await context.availabilityService.getAvailability({
      tenantId: context.tenantId,
      serviceId: input.serviceId as ServiceId,
      locationId: input.locationId as LocationId | undefined,
      from: input.from ? new Date(input.from) : undefined,
      to: input.to ? new Date(input.to) : undefined,
      timeZone: input.timeZone as IanaTimeZone | undefined,
    });
    return result;
  },
});

// 3. quote_booking.v1 (Idempotent Quote Generation)
sharedToolRegistry.register({
  name: "quote_booking.v1",
  version: "1.0.0",
  description:
    "Generates an authoritative 5-minute versioned quote with pricing, deposit, and policy snapshot.",
  inputSchema: createBookingQuoteInputSchema,
  outputSchema: z.object({
    quoteId: z.string(),
    expiresAt: z.string(),
    serviceVersion: z.number(),
    scheduleRevision: z.number(),
    total: z.object({ valueMinor: z.bigint().or(z.string()), currency: z.string() }),
    deposit: z.object({ valueMinor: z.bigint().or(z.string()), currency: z.string() }),
    cancellationPolicy: z.object({
      policyId: z.string(),
      version: z.number(),
      summary: z.string(),
    }),
  }),
  riskLevel: "LOW_RISK",
  requiredScopes: ["booking:quote"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "ABUSE_LAB"],
  requiresConfirmation: false,
  readOnlyHint: false,
  consequentialHint: false,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.bookingService) {
      return {
        quoteId: "mock-quote",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        serviceVersion: 1,
        scheduleRevision: 1,
        total: { valueMinor: "7500", currency: "USD" },
        deposit: { valueMinor: "2000", currency: "USD" },
        cancellationPolicy: { policyId: "mock-policy", version: 1, summary: "24h full refund" },
      };
    }
    return await context.bookingService.createQuote(context.tenantId, context.actor, input as any);
  },
});

// 4. prepare_booking.v1 (Scarce Inventory Hold - Two-Phase Phase 1)
sharedToolRegistry.register({
  name: "prepare_booking.v1",
  version: "1.0.0",
  description:
    "Creates an authoritative slot hold with GiST exclusion and approval locator URL. Never returns confirmation token.",
  inputSchema: prepareBookingInputSchema,
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.literal("HELD"),
    holdExpiresAt: z.string(),
    version: z.number(),
    intent: z.string(),
    approvalLocator: z.string(),
    approvalUrl: z.string().optional(),
    requiresHumanConfirmation: z.literal(true),
    terms: z.object({
      serviceId: z.string(),
      startsAt: z.string(),
      timeZone: z.string(),
    }),
  }),
  riskLevel: "CONSEQUENTIAL",
  requiredScopes: ["booking:prepare"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "ABUSE_LAB"],
  requiresConfirmation: true,
  readOnlyHint: false,
  consequentialHint: true,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.bookingService) {
      return {
        bookingId: "mock-booking",
        status: "HELD" as const,
        holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        version: 1,
        intent: "mock.intent.jwt",
        approvalLocator: "/v1/booking-approvals/mock-loc",
        requiresHumanConfirmation: true as const,
        terms: {
          serviceId: input.serviceId,
          startsAt: input.startsAt,
          timeZone: input.timeZone,
        },
      };
    }
    const res = await context.bookingService.prepareBooking(
      context.tenantId,
      context.actor,
      context.clientId,
      input as any,
    );

    // Human Approval Invariant (W4): Return approval locator, never raw confirmation token to agent
    return {
      bookingId: res.bookingId,
      status: res.status,
      holdExpiresAt: res.holdExpiresAt,
      version: res.version,
      intent: res.intent,
      approvalLocator: res.approvalLocator,
      approvalUrl: res.approvalUrl,
      requiresHumanConfirmation: true as const,
      terms: {
        serviceId: input.serviceId,
        startsAt: input.startsAt,
        timeZone: input.timeZone,
      },
    };
  },
});

// 5. get_booking.v1 (Read-Only Booking Status)
sharedToolRegistry.register({
  name: "get_booking.v1",
  version: "1.0.0",
  description: "Retrieves details and status of an existing booking by ID.",
  inputSchema: z
    .object({
      bookingId: z.string().uuid(),
    })
    .strict(),
  outputSchema: z.object({
    id: z.string(),
    tenantId: z.string(),
    customerId: z.string().optional(),
    quoteId: z.string().optional(),
    status: z.string(),
    version: z.number(),
    holdExpiresAt: z.string().nullable().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
  }),
  riskLevel: "READ_ONLY",
  requiredScopes: ["booking:read"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "WORKER", "SUPPORT", "ABUSE_LAB"],
  requiresConfirmation: false,
  readOnlyHint: true,
  consequentialHint: false,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.db) {
      return {
        id: input.bookingId,
        tenantId: context?.tenantId || "01932b10-0000-7000-8000-000000000001",
        status: "HELD",
        version: 1,
      };
    }
    const booking = await withTenantTransaction(context.db, context.tenantId, async (trx: any) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", input.bookingId)
        .where("tenant_id", "=", context.tenantId)
        .selectAll()
        .executeTakeFirst();
    });

    if (!booking) {
      throw new DomainError(`Booking '${input.bookingId}' not found`, "booking_not_found", 404);
    }

    return {
      id: booking.id,
      tenantId: booking.tenant_id,
      customerId: booking.customer_id,
      quoteId: booking.quote_id,
      status: booking.status,
      version: booking.version,
      holdExpiresAt: booking.hold_expires_at ? booking.hold_expires_at.toISOString() : null,
      startsAt: booking.starts_at.toISOString(),
      endsAt: booking.ends_at.toISOString(),
    };
  },
});

// 6. prepare_cancellation.v1 (Cancellation Quote & Refund Calculation)
sharedToolRegistry.register({
  name: "prepare_cancellation.v1",
  version: "1.0.0",
  description:
    "Quotes cancellation terms, cutoff thresholds, and eligible refund calculation based on immutable policy.",
  inputSchema: z
    .object({
      bookingId: z.string().uuid(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  outputSchema: z.object({
    bookingId: z.string(),
    cancellationAllowed: z.boolean(),
    refundEligibleMinor: z.string(),
    currency: z.string(),
    policySummary: z.string(),
    cancellationConfirmationToken: z.string().optional(),
    cutoffPassed: z.boolean().optional(),
    hoursUntilStart: z.number().optional(),
  }),
  riskLevel: "LOW_RISK",
  requiredScopes: ["booking:cancel"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "SUPPORT", "ABUSE_LAB"],
  requiresConfirmation: false,
  readOnlyHint: false,
  consequentialHint: false,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.bookingService) {
      return {
        bookingId: input.bookingId,
        cancellationAllowed: true,
        refundEligibleMinor: "2000",
        currency: "USD",
        policySummary: "Full refund 24h prior",
      };
    }
    return await context.bookingService.prepareCancellation(
      context.tenantId,
      context.actor,
      input.bookingId as BookingId,
      { reason: input.reason },
    );
  },
});

// 7. commit_booking.v1 (Consequential Commit Requiring Valid Human Confirmation)
sharedToolRegistry.register({
  name: "commit_booking.v1",
  version: "1.0.0",
  description:
    "Atomic booking commit requiring server-issued intent, verified one-time human confirmation token, and idempotency key.",
  inputSchema: commitBookingInputSchema,
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.enum(["COMMITTING", "CONFIRMED"]),
    version: z.number(),
    committedAt: z.string(),
    code: z.string().optional(),
  }),
  riskLevel: "CONSEQUENTIAL",
  requiredScopes: ["booking:commit"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "ABUSE_LAB"],
  requiresConfirmation: true,
  readOnlyHint: false,
  consequentialHint: true,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.bookingService) {
      throw new DomainError("BookingService required for commit_booking", "service_required", 500);
    }
    return await context.bookingService.commitBooking(
      context.tenantId,
      context.actor,
      context.clientId,
      input,
    );
  },
});

// 8. commit_cancellation.v1 (Consequential Cancellation Commitment)
sharedToolRegistry.register({
  name: "commit_cancellation.v1",
  version: "1.0.0",
  description: "Commits booking cancellation using verified cancellation confirmation token.",
  inputSchema: z
    .object({
      bookingId: z.string().uuid(),
      cancellationConfirmationToken: z.string().min(10),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.enum(["CANCELLED", "CANCEL_REQUESTED"]),
    refundStatus: z.enum(["COMPLETED", "NO_REFUND", "UNCERTAIN"]),
    refundAmountMinor: z.string(),
    currency: z.string(),
    resourceClaimReleased: z.boolean(),
    cancelledAt: z.string(),
  }),
  riskLevel: "CONSEQUENTIAL",
  requiredScopes: ["booking:cancel"],
  requiredRoles: ["BUYER", "SCHEDULER", "MANAGER", "OWNER", "SUPPORT", "ABUSE_LAB"],
  requiresConfirmation: true,
  readOnlyHint: false,
  consequentialHint: true,
  enabled: true,
  execute: async (input, context) => {
    if (!context?.bookingService) {
      throw new DomainError(
        "BookingService required for commit_cancellation",
        "service_required",
        500,
      );
    }
    return await context.bookingService.commitCancellation(
      context.tenantId,
      context.actor,
      input.bookingId as BookingId,
      {
        cancellationConfirmationToken: input.cancellationConfirmationToken,
        reason: input.reason,
      },
    );
  },
});

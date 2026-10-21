import { z } from "zod";
import {
  Role,
  createBookingQuoteInputSchema,
  prepareBookingInputSchema,
  commitBookingInputSchema,
  prepareCancellationInputSchema,
} from "@velvetai/contracts";

export type ToolRiskLevel = "READ_ONLY" | "LOW_RISK" | "CONSEQUENTIAL";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  riskLevel: ToolRiskLevel;
  requiredRoles: Role[];
  requiresConfirmation: boolean;
  enabled?: boolean;
  execute: (input: TInput, context: Record<string, unknown>) => Promise<TOutput>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    const key = `${tool.name}@${tool.version}`;
    this.tools.set(key, tool as unknown as ToolDefinition<unknown, unknown>);
  }

  get(name: string, version?: string): ToolDefinition | undefined {
    if (version) {
      return this.tools.get(`${name}@${version}`);
    }
    for (const [key, tool] of this.tools.entries()) {
      if (key.startsWith(`${name}@`)) {
        return tool;
      }
    }
    return undefined;
  }

  list(): Array<Omit<ToolDefinition, "execute">> {
    return Array.from(this.tools.values()).map(({ execute: _, ...rest }) => rest);
  }
}

export const sharedToolRegistry = new ToolRegistry();

// 1. find_available_slots
sharedToolRegistry.register({
  name: "find_available_slots",
  version: "1.0.0",
  description: "Finds advisory appointment slots for a given service and location.",
  inputSchema: z.object({
    serviceId: z.string(),
    locationId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  outputSchema: z.object({
    slots: z.array(z.object({ startsAt: z.string(), endsAt: z.string() })),
  }),
  riskLevel: "READ_ONLY",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: false,
  enabled: true,
  execute: async () => ({ slots: [] }),
});

// 2. quote_booking
sharedToolRegistry.register({
  name: "quote_booking",
  version: "1.0.0",
  description: "Generates a versioned quote with pricing, deposit and cancellation policy.",
  inputSchema: createBookingQuoteInputSchema,
  outputSchema: z.object({
    quoteId: z.string(),
    expiresAt: z.string(),
    serviceVersion: z.number(),
    scheduleRevision: z.number(),
    total: z.object({ valueMinor: z.bigint(), currency: z.string() }),
    deposit: z.object({ valueMinor: z.bigint(), currency: z.string() }),
    cancellationPolicy: z.object({
      policyId: z.string(),
      version: z.number(),
      summary: z.string(),
    }),
  }),
  riskLevel: "READ_ONLY",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: false,
  enabled: true,
  execute: async () => ({
    quoteId: "mock-quote",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    serviceVersion: 1,
    scheduleRevision: 1,
    total: { valueMinor: 7500n, currency: "USD" },
    deposit: { valueMinor: 2000n, currency: "USD" },
    cancellationPolicy: {
      policyId: "mock-policy",
      version: 1,
      summary: "Full refund prior to 24h",
    },
  }),
});

// 3. prepare_booking
sharedToolRegistry.register({
  name: "prepare_booking",
  version: "1.0.0",
  description: "Creates an authoritative slot hold, ES256 signed intent, and approval locator.",
  inputSchema: prepareBookingInputSchema,
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.literal("HELD"),
    holdExpiresAt: z.string(),
    version: z.number(),
    intent: z.string(),
    approvalLocator: z.string(),
    interactionToken: z.string(),
  }),
  riskLevel: "LOW_RISK",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: false,
  enabled: true,
  execute: async () => ({
    bookingId: "mock-booking",
    status: "HELD" as const,
    holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    version: 1,
    intent: "mock.intent.jwt",
    approvalLocator: "/v1/booking-approvals/mock-loc",
    interactionToken: "mock-itok",
  }),
});

// 4. get_booking
sharedToolRegistry.register({
  name: "get_booking",
  version: "1.0.0",
  description: "Retrieves details of an existing booking by ID.",
  inputSchema: z.object({
    bookingId: z.string(),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.string(),
  }),
  riskLevel: "READ_ONLY",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: false,
  enabled: true,
  execute: async (input) => ({
    id: input.bookingId,
    status: "HELD",
  }),
});

// 5. prepare_cancellation
sharedToolRegistry.register({
  name: "prepare_cancellation",
  version: "1.0.0",
  description: "Quotes cancellation terms and refund eligibility for a booking.",
  inputSchema: prepareCancellationInputSchema.extend({
    bookingId: z.string(),
  }),
  outputSchema: z.object({
    bookingId: z.string(),
    cancellationAllowed: z.boolean(),
    refundEligibleMinor: z.string(),
  }),
  riskLevel: "READ_ONLY",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: false,
  enabled: true,
  execute: async (input) => ({
    bookingId: input.bookingId,
    cancellationAllowed: true,
    refundEligibleMinor: "2000",
  }),
});

// 6. commit_booking (MCP/WebMCP execution disabled behind feature flag until Epic 4 per W5)
sharedToolRegistry.register({
  name: "commit_booking",
  version: "1.0.0",
  description: "Atomic booking commit requiring signed intent and one-time buyer confirmation.",
  inputSchema: commitBookingInputSchema,
  outputSchema: z.object({
    bookingId: z.string(),
    status: z.literal("COMMITTING"),
    version: z.number(),
    committedAt: z.string(),
  }),
  riskLevel: "CONSEQUENTIAL",
  requiredRoles: ["BUYER", "SCHEDULER", "OWNER"],
  requiresConfirmation: true,
  enabled: false, // Disabled for MCP/WebMCP execution until Epic 4
  execute: async () => {
    throw new Error("Direct MCP execution of commit_booking is disabled until Epic 4");
  },
});

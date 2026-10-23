import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry, sharedToolRegistry } from "../index.js";

describe("ToolRegistry", () => {
  it("registers and retrieves tools by name and version", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "list_services",
      version: "1.0.0",
      description: "List catalog services",
      inputSchema: z.object({ tenantId: z.string() }),
      outputSchema: z.array(z.string()),
      riskLevel: "READ_ONLY",
      requiredRoles: ["BUYER"],
      requiresConfirmation: false,
      execute: async () => ["Service A", "Service B"],
    });

    const tool = registry.get("list_services", "1.0.0");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("list_services");

    const result = await tool?.execute({ tenantId: "tenant-1" }, {});
    expect(result).toEqual(["Service A", "Service B"]);
  });

  it("lists all registered tools excluding execute handler", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "custom_tool",
      version: "1.0.0",
      description: "Custom tool",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      riskLevel: "READ_ONLY",
      requiredRoles: ["BUYER"],
      requiresConfirmation: false,
      execute: async () => ({}),
    });

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("custom_tool");
    expect("execute" in (list[0] ?? {})).toBe(false);
  });

  it("sharedToolRegistry contains Epic 4 versioned tools with consequential boundaries", async () => {
    const tools = sharedToolRegistry.list();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("find_available_slots.v1");
    expect(toolNames).toContain("quote_booking.v1");
    expect(toolNames).toContain("prepare_booking.v1");
    expect(toolNames).toContain("get_booking.v1");
    expect(toolNames).toContain("prepare_cancellation.v1");
    expect(toolNames).toContain("commit_booking.v1");
    expect(toolNames).toContain("commit_cancellation.v1");

    const commitTool = sharedToolRegistry.get("commit_booking.v1", "1.0.0");
    expect(commitTool).toBeDefined();
    expect(commitTool?.enabled).toBe(true);
    expect(commitTool?.riskLevel).toBe("CONSEQUENTIAL");
    expect(commitTool?.requiresConfirmation).toBe(true);
    expect(commitTool?.consequentialHint).toBe(true);

    // Consequential commit requires booking service and valid confirmation
    await expect(
      commitTool?.execute(
        {
          intent: "mock-intent-token-12345",
          confirmation: "mock-conf-token-12345",
          idempotency_key: "idemp-1",
        },
        {},
      ),
    ).rejects.toThrow(/BookingService required for commit_booking/);
  });

  it("list_services.v1 outputs canonical money wire shape with formatted prices", async () => {
    const listTool = sharedToolRegistry.get("list_services.v1");
    expect(listTool).toBeDefined();

    const mockCatalogService = {
      listServices: async () => [
        {
          id: "01932b10-0000-7000-8000-000000000010",
          status: "ACTIVE",
          currentVersionId: "01932b10-0000-7000-8000-000000000011",
          versions: [
            {
              id: "01932b10-0000-7000-8000-000000000011",
              name: "Signature Styling",
              description: "Full cut and styling",
              durationMinutes: 60,
              priceMinor: "7500",
              baseDepositMinor: "2000",
              currency: "USD",
              cancellationPolicyId: "01932b10-0000-7000-8000-000000000012",
            },
          ],
        },
      ],
    };

    const res: any = await listTool?.execute(
      {},
      {
        tenantId: "01932b10-0000-7000-8000-000000000001",
        catalogService: mockCatalogService,
      },
    );

    expect(res.total).toBe(1);
    expect(res.services).toHaveLength(1);
    const service = res.services[0];
    expect(service.name).toBe("Signature Styling");
    expect(service.durationMinutes).toBe(60);
    expect(service.price).toEqual({ valueMinor: "7500", currency: "USD" });
    expect(service.deposit).toEqual({ valueMinor: "2000", currency: "USD" });
    expect(service.formattedPrice).toBe("$75.00");
    expect(service.formattedDeposit).toBe("$20.00");
  });
});

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../index.js";

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
      name: "find_available_slots",
      version: "1.0.0",
      description: "Find available booking slots",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      riskLevel: "READ_ONLY",
      requiredRoles: ["BUYER"],
      requiresConfirmation: false,
      execute: async () => ({}),
    });

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("find_available_slots");
    expect("execute" in (list[0] ?? {})).toBe(false);
  });
});

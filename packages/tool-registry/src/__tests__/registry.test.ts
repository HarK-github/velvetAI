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

  it("sharedToolRegistry contains Epic 2 booking tools with commit_booking disabled", async () => {
    const tools = sharedToolRegistry.list();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("find_available_slots");
    expect(toolNames).toContain("quote_booking");
    expect(toolNames).toContain("prepare_booking");
    expect(toolNames).toContain("get_booking");
    expect(toolNames).toContain("prepare_cancellation");
    expect(toolNames).toContain("commit_booking");

    const commitTool = sharedToolRegistry.get("commit_booking", "1.0.0");
    expect(commitTool).toBeDefined();
    expect(commitTool?.enabled).toBe(false);
    expect(commitTool?.riskLevel).toBe("CONSEQUENTIAL");
    expect(commitTool?.requiresConfirmation).toBe(true);

    await expect(
      commitTool?.execute({ intent: "mock", confirmation: "mock", idempotency_key: "mock" }, {}),
    ).rejects.toThrow(/Direct MCP execution of commit_booking is disabled until Epic 4/);
  });
});

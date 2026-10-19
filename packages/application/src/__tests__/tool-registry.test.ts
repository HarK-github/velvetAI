import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../tool-registry.js";

describe("Tool Registry", () => {
  it("registers and retrieves tools by version", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "check_availability",
      version: "1.0.0",
      description: "Checks availability for a slot",
      inputSchema: z.object({ slotId: z.string() }),
      outputSchema: z.object({ available: z.boolean() }),
      riskLevel: "READ_ONLY",
      requiredRoles: ["ANONYMOUS"],
      requiresConfirmation: false,
      execute: async () => ({ available: true }),
    });

    const tool = registry.get("check_availability", "1.0.0");
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("check_availability");
    expect(tool?.riskLevel).toBe("READ_ONLY");

    const toolsList = registry.list();
    expect(toolsList.length).toBe(1);
    expect(toolsList[0]?.name).toBe("check_availability");
  });
});

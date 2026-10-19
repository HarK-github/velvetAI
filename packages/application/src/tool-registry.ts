import { z } from "zod";
import { Role } from "@velvetai/contracts";

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
    // Return latest version matching name
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

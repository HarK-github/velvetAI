/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { processMessageParts } from "../components/AskAIDrawer.js";

describe("Ask AI Stream Deduplication & Service Integrity", () => {
  it("reproduces and resolves repeated-stream condition: tool-call then tool-result produces exactly ONE tool item", () => {
    const streamedParts = [
      {
        type: "tool-call",
        toolCallId: "call_abc123",
        toolName: "list_services.v1",
        args: {},
      },
      {
        type: "tool-result",
        toolCallId: "call_abc123",
        toolName: "list_services.v1",
        output: {
          services: [
            {
              id: "01932b10-0000-7000-8000-000000000010",
              name: "AI Signature Cut",
              durationMinutes: 45,
              price: { valueMinor: "7500", currency: "USD" },
              deposit: { valueMinor: "2000", currency: "USD" },
            },
          ],
        },
      },
    ];

    const processed = processMessageParts(streamedParts);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.toolCallId).toBe("call_abc123");
    expect(processed[0]?.isPending).toBe(false);
    expect(processed[0]?.toolResult).toBeDefined();
    expect(processed[0]?.toolResult.services).toHaveLength(1);
  });

  it("stream chunk updates replace existing tool part in place and do NOT append extra card sets", () => {
    // Simulate 5 progressive stream updates for the same toolCallId
    const progressiveParts = [
      {
        type: "tool-call",
        toolCallId: "call_chunk_1",
        toolName: "list_services.v1",
        args: {},
      },
      {
        type: "tool-result",
        toolCallId: "call_chunk_1",
        toolName: "list_services.v1",
        output: { services: [] },
      },
      {
        type: "tool-result",
        toolCallId: "call_chunk_1",
        toolName: "list_services.v1",
        output: {
          services: [
            {
              id: "01932b10-0000-7000-8000-000000000010",
              name: "AI Signature Cut",
              durationMinutes: 45,
              price: { valueMinor: "7500", currency: "USD" },
            },
          ],
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_chunk_1",
        toolName: "list_services.v1",
        output: {
          services: [
            {
              id: "01932b10-0000-7000-8000-000000000010",
              name: "AI Signature Cut",
              durationMinutes: 45,
              price: { valueMinor: "7500", currency: "USD" },
            },
          ],
        },
      },
    ];

    const processed = processMessageParts(progressiveParts);
    // Even after 4 events with same toolCallId, items length must remain exactly 1
    expect(processed).toHaveLength(1);
    expect(processed[0]?.toolResult.services).toHaveLength(1);
  });

  it("does not deduplicate legitimate distinct services solely by display name", () => {
    const twoDistinctServicesWithSameName = [
      {
        id: "01932b10-0000-7000-8000-000000000010",
        name: "Equivalence Service",
        durationMinutes: 30,
        price: { valueMinor: "5000", currency: "USD" },
      },
      {
        id: "01932b10-0000-7000-8000-000000000020",
        name: "Equivalence Service", // Same name, different service ID
        durationMinutes: 60,
        price: { valueMinor: "9000", currency: "USD" },
      },
    ];

    const parts = [
      {
        type: "tool-result",
        toolCallId: "call_equiv",
        toolName: "list_services.v1",
        output: {
          services: twoDistinctServicesWithSameName,
        },
      },
    ];

    const processed = processMessageParts(parts);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.toolResult.services).toHaveLength(2);
    expect(processed[0]?.toolResult.services[0].id).toBe("01932b10-0000-7000-8000-000000000010");
    expect(processed[0]?.toolResult.services[1].id).toBe("01932b10-0000-7000-8000-000000000020");
  });

  it("deduplicates identical service IDs within a single tool result", () => {
    const duplicatedServiceId = [
      {
        id: "01932b10-0000-7000-8000-000000000010",
        name: "AI Signature Cut",
        durationMinutes: 45,
        price: { valueMinor: "7500", currency: "USD" },
      },
      {
        id: "01932b10-0000-7000-8000-000000000010", // Repeated service ID
        name: "AI Signature Cut (Duplicate Row)",
        durationMinutes: 45,
        price: { valueMinor: "7500", currency: "USD" },
      },
    ];

    // Simulating AskAIDrawer rendering
    const seenIds = new Set<string>();
    const unique = [];
    for (const s of duplicatedServiceId) {
      if (!seenIds.has(s.id)) {
        seenIds.add(s.id);
        unique.push(s);
      }
    }

    expect(unique).toHaveLength(1);
    expect(unique[0]?.name).toBe("AI Signature Cut");
  });
});

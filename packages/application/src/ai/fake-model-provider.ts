import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { ModelProviderPort } from "./ports.js";

export interface ScriptedStep {
  type: "text" | "tool-call";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
}

export class FakeModelProvider implements ModelProviderPort {
  public readonly providerName = "fake";
  public isVerified = false;
  public recordedPrompts: any[] = [];
  private scriptedQueue: ScriptedStep[][] = [];
  private currentCallIndex = 0;

  get lastPrompt(): any {
    return this.recordedPrompts[this.recordedPrompts.length - 1];
  }

  markVerified(): void {
    this.isVerified = true;
  }

  constructor(initialScript?: ScriptedStep[][]) {
    if (initialScript) {
      this.scriptedQueue = [...initialScript];
    }
  }

  /**
   * Enqueue scripted step sequence for deterministic testing.
   */
  queueScript(steps: ScriptedStep[]): void {
    this.scriptedQueue.push(steps);
  }

  /**
   * Reset queued scripts and call counters.
   */
  reset(): void {
    this.scriptedQueue = [];
    this.recordedPrompts = [];
    this.currentCallIndex = 0;
    this.isVerified = false;
  }

  getLanguageModel(modelId = "fake-model"): any {
    return new MockLanguageModelV4({
      provider: "fake",
      modelId,
      doStream: async (options) => {
        this.currentCallIndex++;
        this.recordedPrompts.push(options.prompt);

        // 1. Check for explicit scripted step
        if (this.scriptedQueue.length > 0) {
          const steps = this.scriptedQueue.shift()!;
          const chunks: any[] = [];

          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!step) continue;
            if (step.type === "tool-call") {
              chunks.push({
                type: "tool-call",
                toolCallId: step.toolCallId || `call-${Date.now()}-${i}`,
                toolName: step.toolName || "list_services.v1",
                input: step.toolArgs || "{}",
              });
              chunks.push({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" } as any,
                usage: {
                  inputTokens: { total: 10, noCache: 10 },
                  outputTokens: { total: 10, text: 10 },
                } as any,
              });
            } else if (step.type === "text") {
              chunks.push({ type: "text-start", id: `t-${i}` });
              chunks.push({ type: "text-delta", id: `t-${i}`, delta: step.text || "" });
              chunks.push({ type: "text-end", id: `t-${i}` });
              chunks.push({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" } as any,
                usage: {
                  inputTokens: { total: 10, noCache: 10 },
                  outputTokens: { total: 10, text: 10 },
                } as any,
              });
            }
          }

          return {
            stream: simulateReadableStream({ chunks }),
          };
        }

        // 2. Default intelligent simulation based on prompt / messages
        const promptStr = JSON.stringify(options.prompt || "");
        const hasToolResult = promptStr.includes("tool-result") || promptStr.includes("toolResult");

        // Find user inquiry text across all user messages
        let userText = "";
        if (typeof options.prompt === "string") {
          userText = options.prompt;
        } else if (Array.isArray(options.prompt)) {
          const userMsgs = options.prompt.filter((m: any) => m.role === "user");
          const lastUser = userMsgs[userMsgs.length - 1];
          if (lastUser && typeof lastUser.content === "string") {
            userText = lastUser.content;
          } else if (lastUser && Array.isArray(lastUser.content)) {
            userText = lastUser.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ");
          }
        }

        const lower = userText.toLowerCase();

        // 1. If tool results are present, produce helpful authoritative summaries
        if (hasToolResult) {
          let responseText = "Here are the authoritative results for your request.";
          if (promptStr.includes("list_services")) {
            responseText =
              "Here are our available luxury grooming services. Please let me know which service and time window you would like to book.";
          } else if (promptStr.includes("find_available_slots")) {
            responseText =
              "Here are the authoritative available booking slots for your selected service. Would you like me to prepare a hold for one of these slots?";
          } else if (promptStr.includes("prepare_booking")) {
            responseText =
              "I have placed an authoritative 300-second hold on your selected slot. Please click 'Review Terms & Confirm Hold' above to review the policy terms and approve the reservation.";
          }

          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: `t-resp-${Date.now()}` },
                { type: "text-delta", id: `t-resp-${Date.now()}`, delta: responseText },
                { type: "text-end", id: `t-resp-${Date.now()}` },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" } as any,
                  usage: {
                    inputTokens: { total: 15, noCache: 15 },
                    outputTokens: { total: 25, text: 25 },
                  } as any,
                },
              ],
            }),
          };
        }

        // 2. Adversarial attempt to bypass human approval -> refuse deterministically
        if (
          lower.includes("without approval") ||
          lower.includes("ignore all policy") ||
          lower.includes("force commit") ||
          lower.includes("commit without")
        ) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: `t-adv-${Date.now()}` },
                {
                  type: "text-delta",
                  id: `t-adv-${Date.now()}`,
                  delta:
                    "I cannot bypass security policy or commit bookings autonomously. All bookings require explicit human approval via the approval locator.",
                },
                { type: "text-end", id: `t-adv-${Date.now()}` },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" } as any,
                  usage: {
                    inputTokens: { total: 10, noCache: 10 },
                    outputTokens: { total: 20, text: 20 },
                  } as any,
                },
              ],
            }),
          };
        }

        // 3. Flow 1: Services list inquiry
        if (
          lower.includes("service") ||
          lower.includes("offer") ||
          lower.includes("catalog") ||
          lower.includes("menu")
        ) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: `call-srv-${Date.now()}`,
                  toolName: "list_services_v1",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" } as any,
                  usage: {
                    inputTokens: { total: 10, noCache: 10 },
                    outputTokens: { total: 10, text: 10 },
                  } as any,
                },
              ],
            }),
          };
        }

        // 4. Flow 3: Prepare booking hold inquiry (evaluated before generic slot inquiry)
        if (
          lower.includes("prepare") ||
          lower.includes("reserve") ||
          lower.includes("hold") ||
          lower.includes("2 pm") ||
          lower.includes("2pm")
        ) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setUTCHours(14, 0, 0, 0);

          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: `call-prep-${Date.now()}`,
                  toolName: "prepare_booking_v1",
                  input: JSON.stringify({
                    serviceId: "01932b10-0001-7000-8000-000000000001",
                    locationId: "01932b10-0002-7000-8000-000000000001",
                    startsAt: tomorrow.toISOString(),
                    timeZone: "UTC",
                    customer: {
                      email: "buyer@example.com",
                      displayName: "Valued Customer",
                    },
                  }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" } as any,
                  usage: {
                    inputTokens: { total: 10, noCache: 10 },
                    outputTokens: { total: 10, text: 10 },
                  } as any,
                },
              ],
            }),
          };
        }

        // 5. Flow 2: Available slots inquiry
        if (
          lower.includes("slot") ||
          lower.includes("availab") ||
          lower.includes("tomorrow") ||
          lower.includes("haircut") ||
          lower.includes("afternoon")
        ) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: `call-slot-${Date.now()}`,
                  toolName: "find_available_slots_v1",
                  input: JSON.stringify({
                    serviceId: "01932b10-0001-7000-8000-000000000001",
                  }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" } as any,
                  usage: {
                    inputTokens: { total: 10, noCache: 10 },
                    outputTokens: { total: 10, text: 10 },
                  } as any,
                },
              ],
            }),
          };
        }

        // Default conversational text response
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t-default" },
              {
                type: "text-delta",
                id: "t-default",
                delta:
                  "Hello! I am your velvetAI concierge. You can ask me to list available services, check slot availability, or prepare a guaranteed booking hold.",
              },
              { type: "text-end", id: "t-default" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" } as any,
                usage: {
                  inputTokens: { total: 12, noCache: 12 },
                  outputTokens: { total: 20, text: 20 },
                } as any,
              },
            ],
          }),
        };
      },
    });
  }
}

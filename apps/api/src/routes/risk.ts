import { FastifyPluginAsync } from "fastify";

export interface RiskEvaluationRequest {
  tier?: "low" | "elevated" | "high";
  leadDays?: number;
  customerHistoryScore?: number;
}

export interface RiskEvaluationResponse {
  noShowProbability: string;
  depositTierPercent: string;
  policyRoute: string;
  rationale: string;
}

export const riskRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/risk/evaluate", async (request, reply) => {
    const body = (request.body as RiskEvaluationRequest) || {};
    const tier = body.tier || "low";

    const tierMap: Record<string, RiskEvaluationResponse> = {
      low: {
        noShowProbability: "08%",
        depositTierPercent: "10%",
        policyRoute: "BASELINE",
        rationale: "Established customer with zero historical cancellations within 48h.",
      },
      elevated: {
        noShowProbability: "19%",
        depositTierPercent: "20%",
        policyRoute: "REMINDER",
        rationale: "First-time customer booking peak weekend afternoon slot.",
      },
      high: {
        noShowProbability: "31%",
        depositTierPercent: "30%",
        policyRoute: "REVIEW",
        rationale: "Multiple late reschedules or high lead-time multi-hour block.",
      },
    };

    const evaluation = tierMap[tier] || tierMap.low!;
    return reply.status(200).send(evaluation);
  });
};

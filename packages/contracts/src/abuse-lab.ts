import { z } from "zod";

export const abuseScenarioSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export type AbuseScenarioSeverity = z.infer<typeof abuseScenarioSeveritySchema>;

export const abuseScenarioCategorySchema = z.enum([
  "TENANCY",
  "IDEMPOTENCY",
  "INJECTION",
  "CONCURRENCY",
  "PAYMENT",
  "AUTH",
  "CRYPTO",
]);
export type AbuseScenarioCategory = z.infer<typeof abuseScenarioCategorySchema>;

export const ciAbuseScenarioReportItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: abuseScenarioCategorySchema,
  severity: abuseScenarioSeveritySchema,
  threat: z.string().min(1),
  protects: z.string().min(1),
  result: z.enum(["PASS", "FAIL"]),
  durationMs: z.number().nonnegative(),
});
export type CiAbuseScenarioReportItem = z.infer<typeof ciAbuseScenarioReportItemSchema>;

export const abuseLabReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i, "Expected full 40-char git commit SHA"),
    total: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    scenarios: z.array(ciAbuseScenarioReportItemSchema).min(1),
  })
  .refine((data) => data.scenarios.length === data.total, {
    message: "scenarios length must equal total",
  })
  .refine(
    (data) => data.passed === data.total && data.scenarios.every((s) => s.result === "PASS"),
    {
      message: "CI report can only be published when all scenarios pass",
    },
  );
export type AbuseLabReport = z.infer<typeof abuseLabReportSchema>;

export const liveAbuseScenarioStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "PASS",
  "FAIL",
  "ERROR",
]);
export type LiveAbuseScenarioStatus = z.infer<typeof liveAbuseScenarioStatusSchema>;

export const liveAbuseScenarioLevelSchema = z.enum(["HTTP", "Service"]);
export type LiveAbuseScenarioLevel = z.infer<typeof liveAbuseScenarioLevelSchema>;

export const liveAbuseStateCountsSchema = z.object({
  activeBlockingClaims: z.number().int().nonnegative(),
  bookings: z.number().int().nonnegative(),
  committedIntents: z.number().int().nonnegative(),
  consumedConfirmations: z.number().int().nonnegative(),
  paymentIntents: z.number().int().nonnegative(),
  captures: z.number().int().nonnegative(),
  outboxEvents: z.number().int().nonnegative(),
});
export type LiveAbuseStateCounts = z.infer<typeof liveAbuseStateCountsSchema>;

export const liveAbuseScenarioResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  level: liveAbuseScenarioLevelSchema,
  ciScenarioId: z.string().min(1),
  status: liveAbuseScenarioStatusSchema,
  expected: z.string(),
  observed: z.string(),
  stateUnchanged: z.boolean().nullable(),
  beforeCounts: liveAbuseStateCountsSchema.optional(),
  afterCounts: liveAbuseStateCountsSchema.optional(),
  durationMs: z.number().nonnegative(),
});
export type LiveAbuseScenarioResult = z.infer<typeof liveAbuseScenarioResultSchema>;

export const liveAbuseRunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "FAILED"]);
export type LiveAbuseRunStatus = z.infer<typeof liveAbuseRunStatusSchema>;

export const liveAbuseRunSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  allStateUnchanged: z.boolean(),
});
export type LiveAbuseRunSummary = z.infer<typeof liveAbuseRunSummarySchema>;

export const liveAbuseRunSchema = z.object({
  runId: z.string().uuid(),
  status: liveAbuseRunStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  scenarios: z.array(liveAbuseScenarioResultSchema),
  summary: liveAbuseRunSummarySchema.nullable(),
});
export type LiveAbuseRun = z.infer<typeof liveAbuseRunSchema>;

export const triggerLiveAbuseRunResponseSchema = z.object({
  runId: z.string().uuid(),
  status: liveAbuseRunStatusSchema,
  statusUrl: z.string().min(1),
});
export type TriggerLiveAbuseRunResponse = z.infer<typeof triggerLiveAbuseRunResponseSchema>;

export const listLiveAbuseRunsResponseSchema = z.object({
  isJudge: z.literal(true),
  tenantId: z.string().uuid(),
  latestRun: liveAbuseRunSchema.nullable(),
  runs: z.array(liveAbuseRunSchema),
});
export type ListLiveAbuseRunsResponse = z.infer<typeof listLiveAbuseRunsResponseSchema>;

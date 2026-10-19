import { z } from "zod";

export const problemDetailsSchema = z.object({
  type: z.string().url().default("https://api.velvetai.example/problems/general-error"),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  code: z.string(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().uuid().optional(),
  invalidParams: z
    .array(
      z.object({
        name: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  alternatives: z.array(z.record(z.unknown())).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export function createProblemDetails(params: {
  type?: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  invalidParams?: Array<{ name: string; reason: string }>;
  alternatives?: Array<Record<string, unknown>>;
}): ProblemDetails {
  return problemDetailsSchema.parse({
    type: params.type ?? `https://api.velvetai.example/problems/${params.code}`,
    ...params,
  });
}

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Kysely, sql } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { BookingActor, BookingService } from "@velvetai/application";
import {
  BookingId,
  DomainError,
  IanaTimeZone,
  ListLiveAbuseRunsResponse,
  LiveAbuseRun,
  LiveAbuseRunStatus,
  LiveAbuseRunSummary,
  LiveAbuseScenarioLevel,
  LiveAbuseScenarioResult,
  LiveAbuseStateCounts,
  LocationId,
  Rfc3339Timestamp,
  ServiceId,
  SlotUnavailableError,
  TenantId,
  UserId,
} from "@velvetai/contracts";

export const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01" as TenantId;
export const DEFAULT_SCENARIO_TIMEOUT_MS = 5_000;
export const DEFAULT_TOTAL_BUDGET_MS = 25_000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 30_000;
export const MAX_STORED_RUNS = 50;

export class UnauthorizedTenantAccessError extends DomainError {
  constructor(attemptedTenantId: string) {
    super(
      `Tenant ${attemptedTenantId} is forbidden for live abuse checks. Only judge tenant ${JUDGE_TENANT_ID} is permitted.`,
      "UNAUTHORIZED_TENANT_ACCESS",
      403,
    );
  }
}

export class JudgeAbuseRateLimitError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Rate limit exceeded: please wait ${retryAfterSeconds}s before running live checks again.`,
      "rate_limit_exceeded",
      429,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface LiveScenarioExecutionContext {
  runId: string;
  scenarioIndex: number;
  db: Kysely<Database>;
  app: FastifyInstance | null;
  bookingService: BookingService;
  actor: BookingActor;
  authHeader?: string;
  target: {
    serviceId: ServiceId;
    locationId: LocationId;
    timeZone: IanaTimeZone;
  };
  probeBookingIds: Set<string>;
  probeCustomerEmails: Set<string>;
  probeAppUserIds: Set<string>;
  probeIdempotencyPrefixes: Set<string>;
}

export interface LiveScenarioOutcome {
  passed: boolean;
  observed: string;
}

export interface LiveScenarioDefinition {
  id: string;
  name: string;
  level: LiveAbuseScenarioLevel;
  ciScenarioId: string;
  expected: string;
  execute: (ctx: LiveScenarioExecutionContext) => Promise<LiveScenarioOutcome>;
}

export interface JudgeAbuseLabOptions {
  scenarios?: readonly LiveScenarioDefinition[];
  scenarioTimeoutMs?: number;
  totalBudgetMs?: number;
  rateLimitWindowMs?: number;
}

class ScenarioTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Scenario exceeded ${timeoutMs}ms timeout`);
  }
}

function getSlotWindow(scenarioIndex: number, offsetHours = 0): string {
  const baseMs = Date.UTC(2027, 6, 15, 10, 0, 0) + scenarioIndex * 6 * 3600_000;
  return new Date(baseMs + offsetHours * 3600_000).toISOString();
}

function makeProbeEmail(ctx: LiveScenarioExecutionContext, tag: string): string {
  const email = `probe-${ctx.runId.slice(0, 8)}-${ctx.scenarioIndex}-${tag}@abuse-lab.velvetai.local`;
  ctx.probeCustomerEmails.add(email);
  return email;
}

function areStateCountsEqual(before: LiveAbuseStateCounts, after: LiveAbuseStateCounts): boolean {
  return (
    before.activeBlockingClaims === after.activeBlockingClaims &&
    before.bookings === after.bookings &&
    before.committedIntents === after.committedIntents &&
    before.consumedConfirmations === after.consumedConfirmations &&
    before.paymentIntents === after.paymentIntents &&
    before.captures === after.captures &&
    before.outboxEvents === after.outboxEvents
  );
}

function isDomainFailureWithCode(
  err: unknown,
  expectedCode: string,
  expectedStatus?: number,
): boolean {
  if (!(err instanceof DomainError)) {
    return false;
  }
  if (err.code !== expectedCode) {
    return false;
  }
  if (expectedStatus !== undefined && err.status !== expectedStatus) {
    return false;
  }
  return true;
}

export const DEFAULT_LIVE_SCENARIOS: readonly LiveScenarioDefinition[] = [
  {
    id: "L1",
    name: "Concurrent slot hoarding race",
    level: "Service",
    ciScenarioId: "SEC-003",
    expected: "1 winner + 19 slot_unavailable (409)",
    execute: async (ctx) => {
      const startsAt = getSlotWindow(ctx.scenarioIndex) as Rfc3339Timestamp;
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => {
          const email = makeProbeEmail(ctx, `racer-${i}`);
          return ctx.bookingService.prepareBooking(
            JUDGE_TENANT_ID,
            ctx.actor,
            `probe-client-${i}`,
            {
              serviceId: ctx.target.serviceId,
              locationId: ctx.target.locationId,
              startsAt,
              timeZone: ctx.target.timeZone,
              customer: { email, displayName: `Probe Racer ${i}` },
            },
          );
        }),
      );

      let winners = 0;
      let conflicts = 0;
      let unexpected = 0;

      for (const res of results) {
        if (res.status === "fulfilled") {
          winners += 1;
          ctx.probeBookingIds.add(res.value.bookingId);
        } else if (
          res.reason instanceof SlotUnavailableError ||
          isDomainFailureWithCode(res.reason, "slot_unavailable", 409)
        ) {
          conflicts += 1;
        } else {
          unexpected += 1;
        }
      }

      const passed = winners === 1 && conflicts === 19 && unexpected === 0;
      return {
        passed,
        observed: `${winners} winner, ${conflicts} slot_unavailable (409), ${unexpected} other errors`,
      };
    },
  },
  // Placeholder slot: L2 and L3 (chat safety & tool allowlist) will be slotted here after WP 02 merges.
  {
    id: "L4",
    name: "Agent approves its own hold with M2M token",
    level: "Service",
    ciScenarioId: "TRANS-021",
    expected: "HUMAN_APPROVAL_REQUIRED (403)",
    execute: async (ctx) => {
      const prep = await ctx.bookingService.prepareBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l4", {
        serviceId: ctx.target.serviceId,
        locationId: ctx.target.locationId,
        startsAt: getSlotWindow(ctx.scenarioIndex) as Rfc3339Timestamp,
        timeZone: ctx.target.timeZone,
        customer: { email: makeProbeEmail(ctx, "m2m"), displayName: "Probe M2M Buyer" },
      });
      ctx.probeBookingIds.add(prep.bookingId);

      try {
        await ctx.bookingService.confirmApproval(
          JUDGE_TENANT_ID,
          prep.approvalLocator,
          ctx.actor.userId,
          { actorSubject: "m2m-agent@clients" },
        );
        return { passed: false, observed: "M2M confirmation unexpectedly succeeded" };
      } catch (err: unknown) {
        const passed = isDomainFailureWithCode(err, "HUMAN_APPROVAL_REQUIRED", 403);
        const code = err instanceof DomainError ? `${err.code} (${err.status})` : String(err);
        return { passed, observed: `Rejected with ${code}` };
      }
    },
  },
  {
    id: "L5",
    name: "Unauthenticated HTTP confirmation rejected",
    level: "HTTP",
    ciScenarioId: "TRANS-022",
    expected: "401 Unauthorized",
    execute: async (ctx) => {
      if (!ctx.app) {
        throw new Error("Fastify instance unavailable for HTTP scenario L5");
      }
      const res = await ctx.app.inject({
        method: "POST",
        url: `/v1/booking-approvals/loc_unauth_${ctx.runId.slice(0, 8)}/confirm`,
        headers: {
          "content-type": "application/json",
        },
        payload: {},
      });
      const passed = res.statusCode === 401;
      return {
        passed,
        observed: `HTTP ${res.statusCode} returned for unauthenticated confirmation`,
      };
    },
  },
  {
    id: "L6",
    name: "Cross-buyer approval hijacking blocked",
    level: "Service",
    ciScenarioId: "TRANS-023",
    expected: "BUYER_MISMATCH (403)",
    execute: async (ctx) => {
      const prep = await ctx.bookingService.prepareBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l6", {
        serviceId: ctx.target.serviceId,
        locationId: ctx.target.locationId,
        startsAt: getSlotWindow(ctx.scenarioIndex) as Rfc3339Timestamp,
        timeZone: ctx.target.timeZone,
        customer: { email: makeProbeEmail(ctx, "buyer-a"), displayName: "Probe Buyer A" },
      });
      ctx.probeBookingIds.add(prep.bookingId);

      const buyerBId = crypto.randomUUID() as UserId;
      ctx.probeAppUserIds.add(buyerBId);
      await ctx.db
        .insertInto("app_users")
        .values({
          id: buyerBId,
          oidc_subject: `auth0|probe-buyer-b-${ctx.runId}-${Date.now()}`,
          email_ciphertext: makeProbeEmail(ctx, "buyer-b"),
        })
        .execute();

      try {
        await ctx.bookingService.confirmApproval(JUDGE_TENANT_ID, prep.approvalLocator, buyerBId);
        return { passed: false, observed: "Cross-buyer confirmation unexpectedly succeeded" };
      } catch (err: unknown) {
        const passed = isDomainFailureWithCode(err, "BUYER_MISMATCH", 403);
        const code = err instanceof DomainError ? `${err.code} (${err.status})` : String(err);
        return { passed, observed: `Rejected with ${code}` };
      }
    },
  },
  {
    id: "L7",
    name: "Single-use approval token replay blocked",
    level: "Service",
    ciScenarioId: "SEC-002",
    expected: "CONFIRMATION_REPLAY_BLOCKED (409)",
    execute: async (ctx) => {
      const idempPrefix = `probe-l7-${ctx.runId}-`;
      ctx.probeIdempotencyPrefixes.add(idempPrefix);

      const prep = await ctx.bookingService.prepareBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l7", {
        serviceId: ctx.target.serviceId,
        locationId: ctx.target.locationId,
        startsAt: getSlotWindow(ctx.scenarioIndex) as Rfc3339Timestamp,
        timeZone: ctx.target.timeZone,
        customer: { email: makeProbeEmail(ctx, "replay"), displayName: "Probe Replay Buyer" },
      });
      ctx.probeBookingIds.add(prep.bookingId);

      const conf = await ctx.bookingService.confirmApproval(
        JUDGE_TENANT_ID,
        prep.approvalLocator,
        ctx.actor.userId,
      );

      await ctx.bookingService.commitBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l7", {
        intent: prep.intent,
        confirmation: conf.confirmation,
        idempotency_key: `${idempPrefix}first`,
      });

      try {
        await ctx.bookingService.commitBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l7", {
          intent: prep.intent,
          confirmation: conf.confirmation,
          idempotency_key: `${idempPrefix}replay`,
        });
        return { passed: false, observed: "Replay commit unexpectedly succeeded" };
      } catch (err: unknown) {
        const passed = isDomainFailureWithCode(err, "CONFIRMATION_REPLAY_BLOCKED", 409);
        const code = err instanceof DomainError ? `${err.code} (${err.status})` : String(err);
        return { passed, observed: `Second commit rejected with ${code}` };
      }
    },
  },
  {
    id: "L8",
    name: "Swapped intent and confirmation across holds blocked",
    level: "Service",
    ciScenarioId: "SEC-001",
    expected: "INVALID_CONFIRMATION (400)",
    execute: async (ctx) => {
      const idempPrefix = `probe-l8-${ctx.runId}-`;
      ctx.probeIdempotencyPrefixes.add(idempPrefix);

      const prepA = await ctx.bookingService.prepareBooking(
        JUDGE_TENANT_ID,
        ctx.actor,
        "probe-l8",
        {
          serviceId: ctx.target.serviceId,
          locationId: ctx.target.locationId,
          startsAt: getSlotWindow(ctx.scenarioIndex, 0) as Rfc3339Timestamp,
          timeZone: ctx.target.timeZone,
          customer: { email: makeProbeEmail(ctx, "swap-a"), displayName: "Probe Swap A" },
        },
      );
      ctx.probeBookingIds.add(prepA.bookingId);

      const prepB = await ctx.bookingService.prepareBooking(
        JUDGE_TENANT_ID,
        ctx.actor,
        "probe-l8",
        {
          serviceId: ctx.target.serviceId,
          locationId: ctx.target.locationId,
          startsAt: getSlotWindow(ctx.scenarioIndex, 2) as Rfc3339Timestamp,
          timeZone: ctx.target.timeZone,
          customer: { email: makeProbeEmail(ctx, "swap-b"), displayName: "Probe Swap B" },
        },
      );
      ctx.probeBookingIds.add(prepB.bookingId);

      const confB = await ctx.bookingService.confirmApproval(
        JUDGE_TENANT_ID,
        prepB.approvalLocator,
        ctx.actor.userId,
      );

      try {
        await ctx.bookingService.commitBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l8", {
          intent: prepA.intent,
          confirmation: confB.confirmation,
          idempotency_key: `${idempPrefix}swap`,
        });
        return { passed: false, observed: "Cross-hold intent/confirmation swap succeeded" };
      } catch (err: unknown) {
        const passed = isDomainFailureWithCode(err, "INVALID_CONFIRMATION", 400);
        const code = err instanceof DomainError ? `${err.code} (${err.status})` : String(err);
        return { passed, observed: `Rejected with ${code}` };
      }
    },
  },
  {
    id: "L9",
    name: "Tampered ES256 signed intent deposit rejected",
    level: "Service",
    ciScenarioId: "SEC-012",
    expected: "INVALID_SIGNED_INTENT (400)",
    execute: async (ctx) => {
      const idempPrefix = `probe-l9-${ctx.runId}-`;
      ctx.probeIdempotencyPrefixes.add(idempPrefix);

      const prep = await ctx.bookingService.prepareBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l9", {
        serviceId: ctx.target.serviceId,
        locationId: ctx.target.locationId,
        startsAt: getSlotWindow(ctx.scenarioIndex) as Rfc3339Timestamp,
        timeZone: ctx.target.timeZone,
        customer: { email: makeProbeEmail(ctx, "tamper"), displayName: "Probe Tamper Buyer" },
      });
      ctx.probeBookingIds.add(prep.bookingId);

      const conf = await ctx.bookingService.confirmApproval(
        JUDGE_TENANT_ID,
        prep.approvalLocator,
        ctx.actor.userId,
      );

      const jwsParts = prep.intent.split(".");
      if (jwsParts.length !== 3) {
        throw new Error("Expected compact ES256 JWS intent token");
      }
      const decodedPayload = JSON.parse(
        Buffer.from(jwsParts[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      decodedPayload.deposit_minor = decodedPayload.deposit_minor === "0" ? "1" : "0";
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(decodedPayload), "utf8").toString(
        "base64url",
      );
      const tamperedIntent = `${jwsParts[0]}.${tamperedPayloadB64}.${jwsParts[2]}`;

      try {
        await ctx.bookingService.commitBooking(JUDGE_TENANT_ID, ctx.actor, "probe-l9", {
          intent: tamperedIntent,
          confirmation: conf.confirmation,
          idempotency_key: `${idempPrefix}tamper`,
        });
        return { passed: false, observed: "Tampered JWS deposit unexpectedly accepted" };
      } catch (err: unknown) {
        const passed = isDomainFailureWithCode(err, "INVALID_SIGNED_INTENT", 400);
        const code = err instanceof DomainError ? `${err.code} (${err.status})` : String(err);
        return { passed, observed: `Rejected with ${code}` };
      }
    },
  },
  {
    id: "L10",
    name: "Duplicate JSON keys rejected before business logic",
    level: "HTTP",
    ciScenarioId: "SEC-007",
    expected: "400 invalid_request_schema",
    execute: async (ctx) => {
      if (!ctx.app) {
        throw new Error("Fastify instance unavailable for HTTP scenario L10");
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "idempotency-key": `probe-l10-${ctx.runId}`,
      };
      if (ctx.authHeader) {
        headers.authorization = ctx.authHeader;
      }
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/bookings/prepare",
        headers,
        payload: '{"serviceId":"svc-1","amount":100,"amount":1}',
      });
      const body = JSON.parse(res.body || "{}") as { code?: string };
      const passed = res.statusCode === 400 && body.code === "invalid_request_schema";
      return {
        passed,
        observed: `HTTP ${res.statusCode} (${body.code ?? "no_code"})`,
      };
    },
  },
  {
    id: "L11",
    name: "Missing Idempotency-Key on mutating POST rejected",
    level: "HTTP",
    // Directly exercises apps/api/src/plugins/idempotency.ts:118 ("idempotency_key_required")
    ciScenarioId: "No direct CI equivalent",
    expected: "400 idempotency_key_required",
    execute: async (ctx) => {
      if (!ctx.app) {
        throw new Error("Fastify instance unavailable for HTTP scenario L11");
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (ctx.authHeader) {
        headers.authorization = ctx.authHeader;
      }
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/bookings/prepare",
        headers,
        payload: {},
      });
      const body = JSON.parse(res.body || "{}") as { code?: string };
      const passed = res.statusCode === 400 && body.code === "idempotency_key_required";
      return {
        passed,
        observed: `HTTP ${res.statusCode} (${body.code ?? "no_code"})`,
      };
    },
  },
  {
    id: "L12",
    name: "Unsupported MCP protocol revision downgrade rejected",
    level: "HTTP",
    ciScenarioId: "TRANS-003",
    expected: "400 unsupported_protocol_version",
    execute: async (ctx) => {
      if (!ctx.app) {
        throw new Error("Fastify instance unavailable for HTTP scenario L12");
      }
      const res = await ctx.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2024-11-05",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        },
      });
      const body = JSON.parse(res.body || "{}") as { code?: string };
      const passed = res.statusCode === 400 && body.code === "unsupported_protocol_version";
      return {
        passed,
        observed: `HTTP ${res.statusCode} (${body.code ?? "no_code"})`,
      };
    },
  },
];

export class JudgeAbuseLabService {
  private readonly bookingService: BookingService;
  private readonly scenarios: readonly LiveScenarioDefinition[];
  private readonly scenarioTimeoutMs: number;
  private readonly totalBudgetMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly lastRunAtByActor = new Map<string, number>();
  private readonly activeExecutions = new Map<string, Promise<LiveAbuseRun>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly app: FastifyInstance | null = null,
    options: JudgeAbuseLabOptions = {},
  ) {
    this.bookingService = new BookingService(db);
    this.scenarios = options.scenarios ?? DEFAULT_LIVE_SCENARIOS;
    this.scenarioTimeoutMs = options.scenarioTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
    this.totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  }

  private assertJudgeTenant(tenantId: string): void {
    if (tenantId !== JUDGE_TENANT_ID) {
      throw new UnauthorizedTenantAccessError(tenantId);
    }
  }

  async startRun(input: {
    tenantId: string;
    actor: BookingActor;
    authHeader?: string;
  }): Promise<{ runId: string; status: LiveAbuseRunStatus; statusUrl: string }> {
    this.assertJudgeTenant(input.tenantId);

    const rateKey = `${input.tenantId}:${input.actor.userId}`;
    const now = Date.now();
    const lastRunAt = this.lastRunAtByActor.get(rateKey);
    if (lastRunAt !== undefined) {
      const elapsed = now - lastRunAt;
      if (elapsed < this.rateLimitWindowMs) {
        const retryAfterSeconds = Math.max(1, Math.ceil((this.rateLimitWindowMs - elapsed) / 1000));
        throw new JudgeAbuseRateLimitError(retryAfterSeconds);
      }
    }
    this.lastRunAtByActor.set(rateKey, now);

    const runId = crypto.randomUUID();
    const initialScenarios: LiveAbuseScenarioResult[] = this.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      level: s.level,
      ciScenarioId: s.ciScenarioId,
      status: "PENDING",
      expected: s.expected,
      observed: "",
      stateUnchanged: null,
      durationMs: 0,
    }));

    await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      await trx
        .insertInto("judge_abuse_runs")
        .values({
          id: runId,
          tenant_id: JUDGE_TENANT_ID,
          status: "RUNNING",
          requested_by: input.actor.subject,
          scenarios: JSON.stringify(initialScenarios),
          summary: null,
        })
        .execute();

      await sql`
        DELETE FROM judge_abuse_runs
        WHERE tenant_id = ${JUDGE_TENANT_ID}::uuid
          AND id IN (
            SELECT id FROM judge_abuse_runs
            WHERE tenant_id = ${JUDGE_TENANT_ID}::uuid
            ORDER BY started_at DESC
            OFFSET ${MAX_STORED_RUNS}
          )
      `.execute(trx);
    });

    const execPromise = this.executeRunBackground(
      runId,
      input.actor,
      initialScenarios,
      input.authHeader,
    );
    this.activeExecutions.set(runId, execPromise);
    void execPromise.finally(() => {
      this.activeExecutions.delete(runId);
    });

    return {
      runId,
      status: "RUNNING",
      statusUrl: `/v1/judge/abuse-lab/runs/${runId}`,
    };
  }

  async waitForRun(runId: string): Promise<LiveAbuseRun | null> {
    const active = this.activeExecutions.get(runId);
    if (active) {
      await active;
    }
    return this.getRun(JUDGE_TENANT_ID, runId);
  }

  async getRun(tenantId: string, runId: string): Promise<LiveAbuseRun | null> {
    this.assertJudgeTenant(tenantId);
    const row = await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      return trx
        .selectFrom("judge_abuse_runs")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("id", "=", runId)
        .selectAll()
        .executeTakeFirst();
    });
    return row ? this.mapRowToRun(row) : null;
  }

  async listRuns(tenantId: string): Promise<ListLiveAbuseRunsResponse> {
    this.assertJudgeTenant(tenantId);
    const rows = await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      return trx
        .selectFrom("judge_abuse_runs")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .orderBy("started_at", "desc")
        .limit(MAX_STORED_RUNS)
        .selectAll()
        .execute();
    });

    const runs = rows.map((row) => this.mapRowToRun(row));
    return {
      isJudge: true,
      tenantId: JUDGE_TENANT_ID,
      latestRun: runs[0] ?? null,
      runs,
    };
  }

  private mapRowToRun(row: {
    id: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
    scenarios: unknown;
    summary: unknown | null;
  }): LiveAbuseRun {
    const parsedScenarios = Array.isArray(row.scenarios)
      ? (row.scenarios as LiveAbuseScenarioResult[])
      : [];
    const parsedSummary =
      row.summary && typeof row.summary === "object" ? (row.summary as LiveAbuseRunSummary) : null;

    return {
      runId: row.id,
      status: row.status as LiveAbuseRunStatus,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      scenarios: parsedScenarios,
      summary: parsedSummary,
    };
  }

  private async measureStateCounts(): Promise<LiveAbuseStateCounts> {
    return withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      const [
        claimsRes,
        bookingsRes,
        intentsRes,
        confirmationsRes,
        paymentIntentsRes,
        capturesRes,
        outboxRes,
      ] = await Promise.all([
        sql<{
          cnt: number;
        }>`SELECT COUNT(*)::int AS cnt FROM resource_claims WHERE blocking = true`.execute(trx),
        sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM bookings`.execute(trx),
        sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM committed_intents`.execute(trx),
        sql<{
          cnt: number;
        }>`SELECT COUNT(*)::int AS cnt FROM buyer_confirmations WHERE consumed_at IS NOT NULL`.execute(
          trx,
        ),
        sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM payment_intents`.execute(trx),
        sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM payment_captures`.execute(trx),
        sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM outbox_events`.execute(trx),
      ]);

      return {
        activeBlockingClaims: Number(claimsRes.rows[0]?.cnt ?? 0),
        bookings: Number(bookingsRes.rows[0]?.cnt ?? 0),
        committedIntents: Number(intentsRes.rows[0]?.cnt ?? 0),
        consumedConfirmations: Number(confirmationsRes.rows[0]?.cnt ?? 0),
        paymentIntents: Number(paymentIntentsRes.rows[0]?.cnt ?? 0),
        captures: Number(capturesRes.rows[0]?.cnt ?? 0),
        outboxEvents: Number(outboxRes.rows[0]?.cnt ?? 0),
      };
    });
  }

  private async resolveJudgeTarget(): Promise<{
    serviceId: ServiceId;
    locationId: LocationId;
    timeZone: IanaTimeZone;
  }> {
    return withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      const serviceRow = await trx
        .selectFrom("services")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("status", "=", "ACTIVE")
        .select(["id"])
        .executeTakeFirst();

      const resourceRow = await trx
        .selectFrom("resources")
        .innerJoin("locations", "locations.id", "resources.location_id")
        .where("resources.tenant_id", "=", JUDGE_TENANT_ID)
        .where("resources.status", "=", "ACTIVE")
        .select(["resources.location_id as locationId", "locations.timezone as timezone"])
        .executeTakeFirst();

      if (!serviceRow || !resourceRow) {
        throw new DomainError(
          "Judge tenant must be seeded before running live abuse checks",
          "JUDGE_TENANT_NOT_SEEDED",
          409,
        );
      }

      return {
        serviceId: serviceRow.id as ServiceId,
        locationId: resourceRow.locationId as LocationId,
        timeZone: (resourceRow.timezone || "America/New_York") as IanaTimeZone,
      };
    });
  }

  private async cleanupScenarioProbes(ctx: LiveScenarioExecutionContext): Promise<void> {
    const bookingIdsToRelease = Array.from(ctx.probeBookingIds);
    for (const bookingId of bookingIdsToRelease) {
      try {
        const booking = await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) =>
          trx
            .selectFrom("bookings")
            .where("id", "=", bookingId)
            .where("tenant_id", "=", JUDGE_TENANT_ID)
            .select(["id", "status"])
            .executeTakeFirst(),
        );
        if (booking && booking.status === "HELD") {
          const prepCancel = await this.bookingService.prepareCancellation(
            JUDGE_TENANT_ID,
            ctx.actor,
            bookingId as BookingId,
          );
          if (prepCancel.cancellationConfirmationToken) {
            await this.bookingService.commitCancellation(
              JUDGE_TENANT_ID,
              ctx.actor,
              bookingId as BookingId,
              {
                cancellationConfirmationToken: prepCancel.cancellationConfirmationToken,
                reason: "Live abuse-lab probe release",
              },
            );
          }
        }
      } catch {
        // Ignore release errors on partial/rolled-back holds; probe deletion below handles cleanup
      }
    }

    await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      const probeEmails = Array.from(ctx.probeCustomerEmails);
      const discoveredCustomerIds =
        probeEmails.length > 0
          ? (
              await trx
                .selectFrom("customers")
                .where("tenant_id", "=", JUDGE_TENANT_ID)
                .where("email_ciphertext", "in", probeEmails)
                .select(["id"])
                .execute()
            ).map((c) => c.id)
          : [];

      const extraBookings =
        discoveredCustomerIds.length > 0
          ? await trx
              .selectFrom("bookings")
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("customer_id", "in", discoveredCustomerIds)
              .select(["id", "quote_id"])
              .execute()
          : [];

      const allBookingIds = Array.from(
        new Set([...ctx.probeBookingIds, ...extraBookings.map((b) => b.id)]),
      );

      let quoteIds: string[] = extraBookings.map((b) => b.quote_id);
      if (allBookingIds.length > 0) {
        const trackedQuotes = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", allBookingIds)
          .select(["quote_id"])
          .execute();
        quoteIds = Array.from(new Set([...quoteIds, ...trackedQuotes.map((q) => q.quote_id)]));

        await trx
          .deleteFrom("outbox_events")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("aggregate_type", "=", "booking")
          .where("aggregate_id", "in", allBookingIds)
          .execute();

        await trx
          .deleteFrom("audit_events")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("resource_id", "in", allBookingIds)
          .execute();

        await trx
          .deleteFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", allBookingIds)
          .execute();
      }

      for (const prefix of ctx.probeIdempotencyPrefixes) {
        await trx
          .deleteFrom("idempotency_records")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("idempotency_key", "like", `${prefix}%`)
          .execute();
      }

      if (quoteIds.length > 0) {
        await trx
          .deleteFrom("booking_quotes")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", quoteIds)
          .execute();
      }

      if (discoveredCustomerIds.length > 0) {
        await trx
          .deleteFrom("customers")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", discoveredCustomerIds)
          .execute();
      }

      const appUserIds = Array.from(ctx.probeAppUserIds);
      if (appUserIds.length > 0) {
        await trx.deleteFrom("app_users").where("id", "in", appUserIds).execute();
      }
    });
  }

  private async persistRunProgress(
    runId: string,
    scenarios: LiveAbuseScenarioResult[],
    terminal?: { status: "SUCCEEDED" | "FAILED"; summary: LiveAbuseRunSummary },
  ): Promise<void> {
    await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      await trx
        .updateTable("judge_abuse_runs")
        .set({
          scenarios: JSON.stringify(scenarios),
          ...(terminal
            ? {
                status: terminal.status,
                summary: JSON.stringify(terminal.summary),
                finished_at: new Date(),
              }
            : {}),
        })
        .where("id", "=", runId)
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .execute();
    });
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new ScenarioTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeRunBackground(
    runId: string,
    actor: BookingActor,
    results: LiveAbuseScenarioResult[],
    authHeader?: string,
  ): Promise<LiveAbuseRun> {
    const runStartedMs = Date.now();
    let target: { serviceId: ServiceId; locationId: LocationId; timeZone: IanaTimeZone } | null =
      null;

    try {
      target = await this.resolveJudgeTarget();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      for (let i = 0; i < results.length; i += 1) {
        results[i] = {
          ...results[i]!,
          status: "ERROR",
          observed: msg,
          stateUnchanged: true,
          durationMs: 0,
        };
      }
      const summary: LiveAbuseRunSummary = {
        total: results.length,
        passed: 0,
        failed: 0,
        errored: results.length,
        allStateUnchanged: true,
      };
      await this.persistRunProgress(runId, results, { status: "FAILED", summary });
      const finalRun = await this.getRun(JUDGE_TENANT_ID, runId);
      return finalRun!;
    }

    for (let idx = 0; idx < this.scenarios.length; idx += 1) {
      const def = this.scenarios[idx]!;
      const remainingBudget = this.totalBudgetMs - (Date.now() - runStartedMs);
      if (remainingBudget <= 0) {
        results[idx] = {
          ...results[idx]!,
          status: "ERROR",
          observed: `Total run budget of ${this.totalBudgetMs}ms exceeded`,
          stateUnchanged: null,
          durationMs: 0,
        };
        await this.persistRunProgress(runId, results);
        continue;
      }

      results[idx] = { ...results[idx]!, status: "RUNNING" };
      await this.persistRunProgress(runId, results);

      const scenarioStart = Date.now();
      let beforeCounts: LiveAbuseStateCounts | undefined;
      let afterCounts: LiveAbuseStateCounts | undefined;

      const ctx: LiveScenarioExecutionContext = {
        runId,
        scenarioIndex: idx,
        db: this.db,
        app: this.app,
        bookingService: this.bookingService,
        actor,
        authHeader,
        target,
        probeBookingIds: new Set<string>(),
        probeCustomerEmails: new Set<string>(),
        probeAppUserIds: new Set<string>(),
        probeIdempotencyPrefixes: new Set<string>(),
      };

      let status: LiveAbuseScenarioResult["status"] = "ERROR";
      let observed = "";
      let stateUnchanged: boolean | null = null;

      try {
        beforeCounts = await this.measureStateCounts();
        const perScenarioCap = Math.max(1, Math.min(this.scenarioTimeoutMs, remainingBudget));
        const outcome = await this.executeWithTimeout(() => def.execute(ctx), perScenarioCap);
        observed = outcome.observed;
        status = outcome.passed ? "PASS" : "FAIL";
      } catch (err: unknown) {
        status = "ERROR";
        observed = err instanceof Error ? err.message : String(err);
      } finally {
        try {
          await this.cleanupScenarioProbes(ctx);
          if (beforeCounts) {
            afterCounts = await this.measureStateCounts();
            stateUnchanged = areStateCountsEqual(beforeCounts, afterCounts);
            if (!stateUnchanged && status === "PASS") {
              status = "FAIL";
              observed = `${observed} (state changed unexpectedly)`;
            }
          }
        } catch (cleanupErr: unknown) {
          status = "ERROR";
          observed = `${observed ? `${observed}; ` : ""}Cleanup failed: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`;
          stateUnchanged = false;
        }
      }

      results[idx] = {
        ...results[idx]!,
        status,
        observed,
        stateUnchanged,
        beforeCounts,
        afterCounts,
        durationMs: Math.max(0, Date.now() - scenarioStart),
      };
      await this.persistRunProgress(runId, results);
    }

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const errored = results.filter((r) => r.status === "ERROR").length;
    const allStateUnchanged = results.every((r) => r.stateUnchanged !== false);

    const summary: LiveAbuseRunSummary = {
      total: results.length,
      passed,
      failed,
      errored,
      allStateUnchanged,
    };

    await this.persistRunProgress(runId, results, {
      status: failed === 0 && errored === 0 && allStateUnchanged ? "SUCCEEDED" : "FAILED",
      summary,
    });

    const completed = await this.getRun(JUDGE_TENANT_ID, runId);
    return completed!;
  }
}

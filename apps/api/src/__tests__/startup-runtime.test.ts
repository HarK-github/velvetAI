import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { createDatabaseClient, getTestDatabaseUrl } from "@velvetai/db";
import type { PaymentPort } from "@velvetai/application";
import { OutboxWorker, InMemoryOutboxStore } from "@velvetai/worker";
import { startApiServer } from "../server.js";

const testEcKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const testEcBase64 = Buffer.from(
  testEcKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
).toString("base64");

function buildBaseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: "test",
    PORT: "0",
    HOST: "127.0.0.1",
    DATABASE_URL: getTestDatabaseUrl(),
    OIDC_MOCK_ENABLED: "true",
    INTENT_SIGNING_KEY: testEcBase64,
    CONFIRMATION_TOKEN_SECRET: "test_confirmation_token_secret_at_least_32_chars",
    ENVELOPE_ENCRYPTION_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  return env;
}

describe("Free Hosting Runtime: MIGRATE_ON_START and RUN_WORKER_IN_PROCESS", () => {
  const createdApps: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    while (createdApps.length > 0) {
      const app = createdApps.pop();
      if (app) {
        await app.close().catch(() => undefined);
      }
    }
  });

  it("defaults MIGRATE_ON_START and RUN_WORKER_IN_PROCESS to false", async () => {
    const runMigrations = vi.fn(async () => undefined);
    const workerFactory = vi.fn(() => new OutboxWorker(new InMemoryOutboxStore()));

    const runtime = await startApiServer({
      rawEnv: buildBaseEnv(),
      runMigrations,
      workerFactory,
      listen: false,
      registerSignals: false,
    });
    createdApps.push(runtime.app);

    expect(runtime.env.MIGRATE_ON_START).toBe(false);
    expect(runtime.env.RUN_WORKER_IN_PROCESS).toBe(false);
    expect(runtime.migrated).toBe(false);
    expect(runtime.worker).toBeNull();
    expect(runMigrations).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("refuses to serve if MIGRATE_ON_START=true lacks DATABASE_MIGRATION_URL or migration fails", async () => {
    await expect(
      startApiServer({
        rawEnv: buildBaseEnv({ MIGRATE_ON_START: "true" }),
        listen: false,
        registerSignals: false,
      }),
    ).rejects.toThrow(/DATABASE_MIGRATION_URL is required/);

    const testDb = createDatabaseClient(getTestDatabaseUrl());
    try {
      await expect(
        startApiServer({
          rawEnv: buildBaseEnv({
            MIGRATE_ON_START: "true",
            DATABASE_MIGRATION_URL: getTestDatabaseUrl(),
          }),
          appDb: testDb,
          runMigrations: async () => {
            throw new Error("Simulated migration failure");
          },
          listen: true,
          registerSignals: false,
        }),
      ).rejects.toThrow("Simulated migration failure");
    } finally {
      await testDb.destroy();
    }
  });

  it("completes advisory-locked MIGRATE_ON_START migrations before API serves requests", async () => {
    const events: string[] = [];
    const runtime = await startApiServer({
      rawEnv: buildBaseEnv({
        MIGRATE_ON_START: "true",
        DATABASE_MIGRATION_URL: getTestDatabaseUrl(),
      }),
      runMigrations: async () => {
        events.push("migrate:start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        events.push("migrate:done");
      },
      listen: true,
      registerSignals: false,
    });
    createdApps.push(runtime.app);
    events.push("server:listening");

    expect(runtime.migrated).toBe(true);
    expect(events).toEqual(["migrate:start", "migrate:done", "server:listening"]);

    const healthRes = await runtime.app.inject({ method: "GET", url: "/health/live" });
    expect(healthRes.statusCode).toBe(200);
  });

  it("starts OutboxWorker with outbox relay, hold reaper, and reconciliation when RUN_WORKER_IN_PROCESS=true and stops gracefully on close", async () => {
    const testDb = createDatabaseClient(getTestDatabaseUrl());
    const stubPaymentPort = {
      getOrder: vi.fn(),
      getCapture: vi.fn(),
      getRefund: vi.fn(),
    } as unknown as PaymentPort;

    const worker = new OutboxWorker(undefined, testDb, stubPaymentPort);
    const startSpy = vi.spyOn(worker, "start");
    const stopSpy = vi.spyOn(worker, "stop");

    const runtime = await startApiServer({
      rawEnv: buildBaseEnv({ RUN_WORKER_IN_PROCESS: "true" }),
      appDb: testDb,
      workerDb: testDb,
      paymentPort: stubPaymentPort,
      workerFactory: (wDb, pPort) => {
        expect(wDb).toBe(testDb);
        expect(pPort).toBe(stubPaymentPort);
        return worker;
      },
      listen: false,
      registerSignals: false,
    });

    try {
      expect(runtime.worker).toBe(worker);
      expect(worker.holdReaper).toBeDefined();
      expect(worker.reconciliation).toBeDefined();
      expect(worker.getStatus().isRunning).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.app.close();
      await testDb.destroy();
    }

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(worker.getStatus().isRunning).toBe(false);
  });
});

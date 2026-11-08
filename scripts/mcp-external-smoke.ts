import readline from "node:readline";
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadRootEnv } from "./load-env.js";

export function redact(val: string | null | undefined): string {
  if (!val) return "(none)";
  if (val.length <= 8) return "***";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

export interface SmokeResult {
  step: string;
  name: string;
  passed: boolean;
  details: string;
}

async function fetchM2mToken(): Promise<string> {
  const domain =
    process.env.VITE_AUTH0_DOMAIN ||
    (process.env.AUTH0_ISSUER_URL ? new URL(process.env.AUTH0_ISSUER_URL).hostname : null);
  const clientId = process.env.AUTH0_AGENT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_AGENT_CLIENT_SECRET;
  const audience =
    process.env.MCP_RESOURCE_URL || process.env.AUTH0_MCP_AUDIENCE || "http://localhost:3000/mcp";

  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      "Missing Auth0 M2M credentials. Ensure VITE_AUTH0_DOMAIN, AUTH0_AGENT_CLIENT_ID, and AUTH0_AGENT_CLIENT_SECRET are set in .env.local",
    );
  }

  const tokenRes = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: audience,
      grant_type: "client_credentials",
    }),
  });

  const data = (await tokenRes.json()) as Record<string, unknown>;
  if (!tokenRes.ok || typeof data.access_token !== "string") {
    throw new Error(
      `Auth0 token exchange failed (${tokenRes.status}): ${data.error || "unknown"} - ${data.error_description || "no description"}`,
    );
  }

  return data.access_token;
}

export async function runMcpSmoke(options?: {
  baseUrl?: string;
  token?: string;
  autoApprove?: boolean;
}): Promise<{ results: SmokeResult[]; allPassed: boolean }> {
  loadRootEnv();
  const baseUrl = options?.baseUrl || "http://localhost:3000";
  const mcpUrl = new URL("/mcp", baseUrl);
  const autoApprove = options?.autoApprove ?? process.argv.includes("--auto-approve");

  const results: SmokeResult[] = [];
  const logStep = (step: string, name: string, passed: boolean, details: string) => {
    results.push({ step, name, passed, details });
    const mark = passed ? "✓ PASS" : "✗ FAIL";
    console.log(`[${mark}] Step ${step} (${name}): ${details}`);
  };

  // Obtain M2M token
  let token = options?.token;
  if (!token) {
    console.log("[mcp:smoke] Fetching Auth0 M2M Bearer token via client credentials grant...");
    token = await fetchM2mToken();
    console.log("[mcp:smoke] Successfully obtained Auth0 M2M Bearer token.");
  }

  // 1. Initialize MCP Client over HTTP with official SDK
  console.log(
    `[mcp:smoke] Connecting official @modelcontextprotocol/client to ${mcpUrl.toString()}...`,
  );
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
      },
    },
  });

  const client = new Client(
    { name: "velvetai-external-smoke", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: { pin: "2026-07-28" },
      },
    },
  );
  await client.connect(transport);
  console.log("[mcp:smoke] Connected. Sessionless Streamable HTTP transport initialized.");

  let activeServiceId = "";
  let activeLocationId = "";
  let activeSlotTime = "";
  let signedIntent = "";
  let approvalLocator = "";
  let confirmationToken = "";

  // ----------------------------------------------------
  // a. tools/list -> expect 8 versioned tools
  // ----------------------------------------------------
  try {
    const listRes = await client.listTools();
    const toolNames = listRes.tools.map((t) => t.name).sort();
    const expected = [
      "commit_booking.v1",
      "commit_cancellation.v1",
      "find_available_slots.v1",
      "get_booking.v1",
      "list_services.v1",
      "prepare_booking.v1",
      "prepare_cancellation.v1",
      "quote_booking.v1",
    ].sort();

    const matches = expected.every((exp) => toolNames.includes(exp)) && toolNames.length === 8;
    logStep("a", "tools/list", matches, `Found ${toolNames.length} tools: ${toolNames.join(", ")}`);
  } catch (err: unknown) {
    logStep("a", "tools/list", false, (err as Error).message);
  }

  // ----------------------------------------------------
  // b. list_services.v1 -> 3 canonical services with money
  // ----------------------------------------------------
  try {
    const res = (await client.callTool({ name: "list_services.v1", arguments: {} })) as Record<
      string,
      unknown
    >;
    const content = (res.content as Array<{ text: string }>) || [];
    const textData = JSON.parse(content[0]?.text || "{}");
    const services = (textData.services as Array<Record<string, unknown>>) || [];
    const hasCanonicalMoney = services.every((s) => {
      const p = s.price as Record<string, unknown> | undefined;
      const d = s.deposit as Record<string, unknown> | undefined;
      return (
        p &&
        d &&
        typeof p.currency === "string" &&
        (typeof p.valueMinor === "string" || typeof p.valueMinor === "number") &&
        (typeof d.valueMinor === "string" || typeof d.valueMinor === "number")
      );
    });

    if (services.length > 0) {
      activeServiceId = (services[0]?.id as string) || "";
    }

    logStep(
      "b",
      "list_services.v1",
      services.length >= 3 && hasCanonicalMoney,
      `Returned ${services.length} services with canonical money. Selected: ${redact(activeServiceId)}`,
    );
  } catch (err: unknown) {
    logStep("b", "list_services.v1", false, (err as Error).message);
  }

  // ----------------------------------------------------
  // c. find_available_slots.v1 for tomorrow
  // ----------------------------------------------------
  try {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const fromStr = `${tomorrow.toISOString().split("T")[0]}T09:00:00.000Z`;
    const toStr = `${tomorrow.toISOString().split("T")[0]}T19:00:00.000Z`;

    const res = (await client.callTool({
      name: "find_available_slots.v1",
      arguments: {
        serviceId: activeServiceId,
        from: fromStr,
        to: toStr,
        timeZone: "UTC",
      },
    })) as Record<string, unknown>;

    const content = (res.content as Array<{ text: string }>) || [];
    const textData = JSON.parse(content[0]?.text || "{}");
    const slots = (textData.slots as Array<Record<string, unknown>>) || [];

    if (slots.length > 0) {
      // Pick the first available slot directly from find_available_slots
      activeSlotTime = (slots[0]?.startsAt as string) || fromStr;
      activeLocationId = "01932b10-0002-7000-8000-000000000001";
    } else {
      activeSlotTime = fromStr;
      activeLocationId = "01932b10-0002-7000-8000-000000000001";
    }

    logStep(
      "c",
      "find_available_slots.v1",
      slots.length > 0,
      `Found ${slots.length} available slots tomorrow. Selected: ${activeSlotTime}`,
    );
  } catch (err: unknown) {
    logStep("c", "find_available_slots.v1", false, (err as Error).message);
  }

  // ----------------------------------------------------
  // d. prepare_booking.v1 -> HELD, approval locator, no confirmation token
  // ----------------------------------------------------
  try {
    const res = (await client.callTool({
      name: "prepare_booking.v1",
      arguments: {
        serviceId: activeServiceId,
        locationId: activeLocationId,
        startsAt: activeSlotTime,
        timeZone: "UTC",
        customer: {
          email: "m2m-agent@velvetai.example",
          displayName: "Automated MCP Agent",
        },
        note: "External MCP client smoke verification",
      },
    })) as Record<string, unknown>;

    const content = (res.content as Array<{ text: string }>) || [];
    const rawText = content[0]?.text || "{}";

    if (res.isError) {
      const errMsg = `prepare_booking.v1 failed with isError=true: ${rawText}`;
      logStep("d", "prepare_booking.v1", false, errMsg);
      console.error(`\n[FATAL] ${errMsg}`);
      process.exit(1);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawText);
    } catch {
      const errMsg = `prepare_booking.v1 returned non-JSON payload: ${rawText}`;
      logStep("d", "prepare_booking.v1", false, errMsg);
      console.error(`\n[FATAL] ${errMsg}`);
      process.exit(1);
    }

    signedIntent = ((data.intent || data.signedIntent || "") as string).trim();
    approvalLocator = ((data.approvalLocator || "") as string).trim();

    if (!signedIntent || !approvalLocator) {
      const errMsg = `prepare_booking.v1 returned empty locator or intent: intentPresent=${Boolean(signedIntent)}, locatorPresent=${Boolean(approvalLocator)}, raw=${rawText}`;
      logStep("d", "prepare_booking.v1", false, errMsg);
      console.error(`\n[FATAL] ${errMsg}`);
      process.exit(1);
    }

    const isHeld = data.status === "HELD";
    const hasLocator = approvalLocator.includes("/v1/booking-approvals/");
    const noRawConfirmationToken =
      !rawText.includes("confirmationToken") && !data.confirmationToken;

    if (!isHeld || !hasLocator) {
      const errMsg = `prepare_booking.v1 did not produce a valid HELD state with approval locator: status=${data.status}, locator=${approvalLocator}`;
      logStep("d", "prepare_booking.v1", false, errMsg);
      console.error(`\n[FATAL] ${errMsg}`);
      process.exit(1);
    }

    logStep(
      "d",
      "prepare_booking.v1",
      isHeld && hasLocator && noRawConfirmationToken,
      `Status: ${data.status}, Locator: ${approvalLocator}, Raw confirmation token leaked: ${!noRawConfirmationToken}`,
    );
  } catch (err: unknown) {
    const errorMsg = (err as Error).message;
    logStep("d", "prepare_booking.v1", false, errorMsg);
    console.error(`\n[FATAL] MCP smoke test halted at step d (prepare_booking.v1): ${errorMsg}`);
    console.error(
      "Cannot proceed to approval or commit steps without a valid booking hold and locator.",
    );
    process.exit(1);
  }

  // ----------------------------------------------------
  // e. commit_booking.v1 before approval -> fails with APPROVAL_INCOMPLETE
  // ----------------------------------------------------
  try {
    const res = (await client.callTool({
      name: "commit_booking.v1",
      arguments: {
        intent: signedIntent,
        confirmation: "unapproved-bogus-token-12345",
        idempotency_key: crypto.randomUUID(),
      },
    })) as Record<string, unknown>;

    const isError = res.isError === true;
    const content = (res.content as Array<{ text: string }>) || [];
    const errText = content[0]?.text || "";
    const lower = errText.toLowerCase();
    const mentionsIncomplete =
      lower.includes("approval_incomplete") ||
      lower.includes("invalid") ||
      lower.includes("signature") ||
      lower.includes("not found") ||
      lower.includes("incomplete");

    logStep(
      "e",
      "commit_booking.v1 (before approval)",
      isError && mentionsIncomplete,
      `Fails closed with isError=true (${errText.slice(0, 100)})`,
    );
  } catch (err: unknown) {
    const msg = (err as Error).message;
    const lower = msg.toLowerCase();
    const passed =
      lower.includes("approval_incomplete") ||
      lower.includes("invalid") ||
      lower.includes("not found") ||
      lower.includes("signature");
    logStep("e", "commit_booking.v1 (before approval)", passed, `Error thrown: ${msg}`);
  }

  // ----------------------------------------------------
  // f. Pause and print approval locator URL
  // ----------------------------------------------------
  if (!approvalLocator || !approvalLocator.includes("/v1/booking-approvals/")) {
    console.error("[FATAL] Missing valid approval locator URL. Aborting smoke test.");
    process.exit(1);
  }

  const locatorId = approvalLocator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
  if (!locatorId) {
    console.error("[FATAL] Extracted locatorId is empty. Aborting smoke test.");
    process.exit(1);
  }

  const webPort = process.env.WEB_PORT || "5173";
  const webApprovalUrl = `http://localhost:${webPort}/approve/${locatorId}`;
  const apiApprovalUrl = `${baseUrl}/v1/booking-approvals/${locatorId}`;

  console.log("\n========================================================");
  console.log("HUMAN BUYER APPROVAL REQUIRED (Section D.4 / Epic 4 F1)");
  console.log("Web Approval URL: ", webApprovalUrl);
  console.log("API Inspection:   ", apiApprovalUrl);
  console.log("--------------------------------------------------------");
  console.log("Please open the Web Approval URL in your browser, sign in");
  console.log("with Auth0 as the buyer, and click 'Approve Booking Hold'.");
  console.log("Polling authoritative ledger for human buyer approval...");
  console.log("========================================================\n");

  let isApproved = false;

  if (autoApprove && process.env.NODE_ENV === "test") {
    // In-process test environment with test buyer identity
    console.log("[mcp:smoke] Test environment detected: confirming via in-process test buyer...");
    try {
      const confirmRes = await fetch(`${baseUrl}/v1/booking-approvals/${locatorId}/confirm`, {
        method: "POST",
        headers: {
          Authorization:
            "Bearer test-token:01932b10-0000-7000-8000-000000000002:01932b10-0000-7000-8000-000000000001:BUYER:1",
          "Content-Type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      if (confirmRes.ok) {
        isApproved = true;
        const confirmData = (await confirmRes.json()) as {
          confirmation?: string;
          confirmationToken?: string;
        };
        confirmationToken = confirmData.confirmation || confirmData.confirmationToken || "";
      }
    } catch (err: unknown) {
      console.error("[mcp:smoke] Test confirmation failed:", err);
    }
  } else {
    if (autoApprove && process.env.NODE_ENV !== "test") {
      console.log(
        "[mcp:smoke] Note: --auto-approve is strictly ignored against non-test environment per F1 security invariant.",
      );
      console.log("[mcp:smoke] A human buyer must authorize the hold via the web approval page.");
    }

    const pollStart = Date.now();
    const timeoutMs = 120_000; // 2 minutes

    while (Date.now() - pollStart < timeoutMs) {
      try {
        const checkRes = await fetch(apiApprovalUrl);
        if (checkRes.ok) {
          const checkData = (await checkRes.json()) as { status?: string };
          if (checkData.status === "APPROVED" || checkData.status === "CONSUMED") {
            isApproved = true;
            console.log("\n[mcp:smoke] ✓ Human approval detected on authoritative ledger!");
            break;
          }
        }
      } catch {
        // Retry
      }
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("");
  }

  logStep(
    "f",
    "Approval confirmation",
    isApproved,
    isApproved
      ? "Booking hold terms approved by authenticated human buyer"
      : "Timed out waiting for human buyer approval (exceeded 120s)",
  );

  // ----------------------------------------------------
  // g. commit_booking.v1 after approval -> succeeds once
  // ----------------------------------------------------
  const idempotencyKey = crypto.randomUUID();
  try {
    const res = (await client.callTool({
      name: "commit_booking.v1",
      arguments: {
        intent: signedIntent,
        ...(confirmationToken ? { confirmation: confirmationToken } : {}),
        idempotency_key: idempotencyKey,
      },
    })) as Record<string, unknown>;

    const isError = res.isError === true;
    const content = (res.content as Array<{ text: string }>) || [];
    let textData: Record<string, unknown> = {};
    try {
      textData = JSON.parse(content[0]?.text || "{}");
    } catch {
      textData = { errorText: content[0]?.text };
    }
    const isCommitted = textData.status === "COMMITTING" || textData.status === "CONFIRMED";

    logStep(
      "g",
      "commit_booking.v1 (after approval)",
      !isError && isCommitted,
      isCommitted
        ? `Status: ${textData.status}, Booking ID: ${redact((textData.id || textData.bookingId) as string)}`
        : `Failed: ${content[0]?.text || "Unknown error"}`,
    );
  } catch (err: unknown) {
    logStep("g", "commit_booking.v1 (after approval)", false, (err as Error).message);
  }

  // ----------------------------------------------------
  // h. Replay same commit with new idempotency key -> fails closed
  // ----------------------------------------------------
  try {
    const replayRes = (await client.callTool({
      name: "commit_booking.v1",
      arguments: {
        intent: signedIntent,
        ...(confirmationToken ? { confirmation: confirmationToken } : {}),
        idempotency_key: crypto.randomUUID(), // New idempotency key -> MUST NOT re-consume confirmation token
      },
    })) as Record<string, unknown>;

    const isError = replayRes.isError === true;
    const content = (replayRes.content as Array<{ text: string }>) || [];
    const raw = content[0]?.text || "";
    const isReplayBlocked =
      raw.includes("CONFIRMATION_REPLAY_BLOCKED") ||
      raw.includes("INTENT_REPLAY_BLOCKED") ||
      raw.includes("consumed") ||
      raw.includes("already");

    logStep(
      "h",
      "commit_booking.v1 (replay prevention)",
      isError && isReplayBlocked,
      `Fails closed with isError=${isError} (${raw.slice(0, 100)})`,
    );
  } catch (err: unknown) {
    const msg = (err as Error).message;
    const passed =
      msg.includes("CONFIRMATION_REPLAY_BLOCKED") ||
      msg.includes("INTENT_REPLAY_BLOCKED") ||
      msg.includes("consumed") ||
      msg.includes("already");
    logStep("h", "commit_booking.v1 (replay prevention)", passed, `Error thrown: ${msg}`);
  }

  // ----------------------------------------------------
  // i. Request with missing or wrong protocol revision -> rejected
  // ----------------------------------------------------
  try {
    const badRevRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "mcp-protocol-version": "2024-01-01", // Unsupported revision
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bad-rev-test",
        method: "tools/list",
        params: {},
      }),
    });

    const is400 = badRevRes.status === 400;
    const body = (await badRevRes.json()) as Record<string, unknown>;
    const errMsg = (body.error as { message?: string })?.message || "";

    logStep(
      "i",
      "Protocol revision rejection",
      is400 && errMsg.includes("Unsupported protocol revision"),
      `HTTP ${badRevRes.status}: ${errMsg}`,
    );
  } catch (err: unknown) {
    logStep("i", "Protocol revision rejection", false, (err as Error).message);
  }

  // ----------------------------------------------------
  // j. Request without bearer token -> 401 with WWW-Authenticate
  // ----------------------------------------------------
  try {
    const noAuthRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "no-auth-test",
        method: "tools/list",
        params: {},
      }),
    });

    const is401 = noAuthRes.status === 401;
    const wwwAuth = noAuthRes.headers.get("www-authenticate") || "";
    const hasMetadataLink =
      wwwAuth.includes("resource_metadata=") &&
      wwwAuth.includes("/.well-known/oauth-protected-resource");

    logStep(
      "j",
      "401 WWW-Authenticate metadata pointer",
      is401 && hasMetadataLink,
      `HTTP ${noAuthRes.status}, WWW-Authenticate: ${wwwAuth}`,
    );
  } catch (err: unknown) {
    logStep("j", "401 WWW-Authenticate metadata pointer", false, (err as Error).message);
  }

  const allPassed = results.every((r) => r.passed);
  console.log(
    `\n[mcp:smoke] Finished. Passed: ${results.filter((r) => r.passed).length}/${results.length}. All passed: ${allPassed}`,
  );
  return { results, allPassed };
}

if (process.argv[1]?.endsWith("mcp-external-smoke.ts")) {
  runMcpSmoke()
    .then(({ allPassed }) => {
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error("[mcp:smoke] Fatal error:", err.message);
      process.exit(1);
    });
}

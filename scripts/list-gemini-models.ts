import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface ModelListing {
  name: string;
  displayName: string;
  supportsGenerateContent: boolean;
}

export function loadRootEnv(): void {
  let rootDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(rootDir, "pnpm-workspace.yaml"))) {
      break;
    }
    const parent = path.dirname(rootDir);
    if (parent === rootDir) break;
    rootDir = parent;
  }

  const loadIfExists = (filePath: string) => {
    if (fs.existsSync(filePath) && typeof process.loadEnvFile === "function") {
      try {
        process.loadEnvFile(filePath);
      } catch {
        // Ignore parse/read errors
      }
    }
  };

  loadIfExists(path.join(rootDir, ".env"));
  loadIfExists(path.join(rootDir, ".env.local"));
}

export async function fetchGeminiModels(apiKey: string): Promise<ModelListing[]> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch (_err) {
    throw new Error("ai_provider_unavailable: Network connection error to Gemini models endpoint.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "ai_provider_authentication: Invalid or unauthorized GOOGLE_GENERATIVE_AI_API_KEY.",
    );
  }

  if (res.status === 429) {
    throw new Error("ai_quota_exceeded: Rate limit or quota exhausted for this API key.");
  }

  if (res.status === 503) {
    throw new Error("ai_provider_unavailable: Gemini service temporarily unavailable.");
  }

  if (!res.ok) {
    throw new Error(`ai_stream_error: Models endpoint returned HTTP ${res.status}.`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("ai_stream_error: Failed to parse models JSON response.");
  }

  if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
    throw new Error("ai_stream_error: Unexpected models response structure.");
  }

  const rawModels = body.models as Array<{
    name?: unknown;
    displayName?: unknown;
    supportedGenerationMethods?: unknown;
  }>;

  const results: ModelListing[] = [];
  for (const item of rawModels) {
    const rawName = typeof item.name === "string" ? item.name : "";
    const cleanName = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
    const displayName = typeof item.displayName === "string" ? item.displayName : cleanName;
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods.map((m) => String(m))
      : [];
    const supportsGenerateContent = methods.includes("generateContent");

    if (cleanName && supportsGenerateContent) {
      results.push({
        name: cleanName,
        displayName,
        supportsGenerateContent,
      });
    }
  }

  return results;
}

async function main() {
  if (process.env.NODE_ENV === "production" && !process.argv.includes("--allow-production")) {
    console.error(
      "Error: ai:list-models is a development command and refuses to run in production without --allow-production.",
    );
    process.exit(1);
  }

  loadRootEnv();

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error(
      "Error: GOOGLE_GENERATIVE_AI_API_KEY is not configured in server environment or .env.local.",
    );
    process.exit(1);
  }

  try {
    const models = await fetchGeminiModels(apiKey);
    if (models.length === 0) {
      console.log("No models supporting generateContent found for this API key.");
      return;
    }

    console.log("\nAvailable Gemini Models supporting generateContent:\n");
    console.log(`${"Model Name".padEnd(35)} | ${"Display Name".padEnd(35)} | ${"generateContent"}`);
    console.log(`${"-".repeat(35)}-+-${"-".repeat(35)}-+-${"-".repeat(15)}`);
    for (const m of models) {
      console.log(
        `${m.name.padEnd(35)} | ${m.displayName.padEnd(35)} | ${m.supportsGenerateContent ? "supported" : "not supported"}`,
      );
    }
    console.log(
      `\nTotal models supporting generateContent: ${models.length} (Safe listing: no secrets, headers, or keys printed).\n`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("list-gemini-models.ts")) {
  main();
}

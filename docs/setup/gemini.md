# Google Gemini Setup Guide for VelvetAI

This guide explains how to configure Google Gemini as the production model provider for VelvetAI's In-Page Ask AI assistant via the Vercel AI SDK.

> [!IMPORTANT]
> The Google Gemini API key is server-only. It must NEVER be exposed to the client bundle or prefixed with `VITE_`.
> Do not commit real API keys to the repository.

---

## 1. Obtain a Google Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/).
2. Sign in with your Google account.
3. Click **Get API key** and create a key in a new or existing Google Cloud project.
4. Copy the generated API key.

---

## 2. Configure Environment Variables

In your local `.env` file (untracked):

```bash
# Set model provider to gemini
AI_PROVIDER=gemini

# Secret server-side API key
GOOGLE_GENERATIVE_AI_API_KEY=AIzaSy...

# Optional model selection (defaults to gemini-2.5-flash)
AI_MODEL=gemini-2.5-flash
```

For staging / Render deployments, add `GOOGLE_GENERATIVE_AI_API_KEY` to your environment secrets in the Render dashboard.

---

## 3. Architecture & Security Boundary

VelvetAI enforces strict security controls around all model interactions:

- **No Direct Commit**: Models and assistants are strictly prohibited from committing bookings, charging payments, or issuing refunds autonomously.
- **Two-Phase Human Confirmation**: Consequential actions require an explicit human review on the hardened velvetAI approval route.
- **Untrusted User Quarantine**: Prompt boundaries separate system instructions, tool definitions, and untrusted user input to prevent prompt injection. Customer notes and database credentials are excluded from model context.
- **Strict Execution Budgets**:
  - Maximum 20 tool calls per assistant interaction run.
  - 30-second wall-clock execution timeout.
  - Per-user and per-tenant rate limits.
  - Streaming responses abort when client disconnects.

---

## 4. Test Adapter vs Real Provider Verification

VelvetAI provides dual model provider adapters:

- **`FakeModelProvider`**: Used in automated CI, unit tests, and abuse lab tests to ensure 100% deterministic, offline execution without external API dependencies.
- **`GeminiModelProvider`**: Used when `AI_PROVIDER=gemini` and `GOOGLE_GENERATIVE_AI_API_KEY` is present.
- In automated test suites, if no valid key is configured, live Gemini E2E tests are marked as `BLOCKED/NOT_RUN` and clearly reported.

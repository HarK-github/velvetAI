# velvetAI Auth0 and Gemini Setup

## Security rules

- Never paste Auth0 tokens, Auth0 management secrets, Gemini keys, `.env` contents, or browser storage into an LLM chat.
- Never commit real credentials.
- Do not prefix the Gemini key with `VITE_`.
- The Auth0 SPA Client ID is public.
- velvetAI PostgreSQL memberships remain authoritative for tenant and role authorization.

---

# Part A: Auth0

## 1. Create an Auth0 account and tenant

Open:

https://auth0.com/signup

Create a dedicated development tenant, for example:

```text
velvetai-hackathon
```

Choose the region closest to the planned Render deployment.

Enable MFA on the Auth0 administrator account.

## 2. Create the velvetAI API

In the Auth0 Dashboard:

```text
Applications → APIs → Create API
```

Recommended values:

```text
Name: velvetAI API
Identifier: https://velvetai.example/api
Signing Algorithm: RS256
```

The identifier is the OAuth audience. Auth0 does not call this URL, but it cannot be changed later.

Use the same value consistently across local and hosted environments.

If available, select the RFC 9068 access-token profile.

## 3. Add API permissions

Add these permissions:

```text
booking:read
booking:quote
booking:prepare
booking:commit
booking:cancel
merchant:schedule
merchant:refund
```

Enable RBAC:

```text
Applications → APIs → velvetAI API → Settings
```

Enable:

```text
Enable RBAC
```

You may also enable:

```text
Add Permissions in the Access Token
```

Local PostgreSQL memberships and roles remain the final authorization authority even when Auth0 scopes are valid.

## 4. Create the React SPA application

Navigate to:

```text
Applications → Applications → Create Application
```

Use:

```text
Name: velvetAI Web
Application Type: Single Page Web Application
```

Open its **Settings**.

Configure the local URLs:

```text
Allowed Callback URLs:
http://localhost:5173

Allowed Logout URLs:
http://localhost:5173

Allowed Web Origins:
http://localhost:5173

Allowed Origins (CORS), if required:
http://localhost:5173
```

Do not use wildcard origins.

After Render deployment, add the exact Render web URL as an additional entry.

Do not remove the local entry until local testing is complete.

## 5. Record only non-secret values

Privately record:

- Auth0 domain.
- SPA Client ID.
- API identifier/audience.

The SPA Client ID is public.

Do not create or place an Auth0 client secret in browser code.

## 6. Configure the local untracked environment

Use the environment-file location documented by the repository.

Example:

```text
VITE_AUTH0_DOMAIN=<AUTH0_DOMAIN>
VITE_AUTH0_CLIENT_ID=YOUR_PUBLIC_SPA_CLIENT_ID
VITE_AUTH0_AUDIENCE=https://velvetai.example/api

AUTH0_ISSUER=<AUTH0_ISSUER>
AUTH0_AUDIENCE=https://velvetai.example/api
```

Ensure the Auth0 issuer includes the final `/`.

Verify that your environment file is ignored by Git:

```zsh
git check-ignore PATH_TO_ENV_FILE
```

For example:

```zsh
git check-ignore .env.local
```

Do not continue if the file is not ignored.

## 7. Create a test user

Create a dedicated hackathon test user through Auth0.

Do not use a real customer account.

The Auth0 user subject will map to:

```text
app_users.oidc_subject
```

velvetAI will then retrieve the user's tenant memberships and roles from PostgreSQL.

## 8. Do not create the MCP client yet

Do not enable dynamic client registration.

If Epic 4 requires a separate MCP demo client:

1. Create a pre-registered Auth0 Native application.
2. Use Authorization Code with PKCE.
3. Add only the exact callback URI used by the chosen MCP client.
4. Grant only the necessary booking scopes.

Wait for the coding LLM to document the required MCP callback URL before creating this application.

## 9. Auth0 verification checklist

- [ ] Auth0 tenant exists.
- [ ] Administrator MFA is enabled.
- [ ] velvetAI API exists.
- [ ] API audience is recorded.
- [ ] RS256 is configured.
- [ ] API permissions are defined.
- [ ] RBAC is enabled.
- [ ] SPA application exists.
- [ ] Exact localhost callback is configured.
- [ ] Exact localhost logout URL is configured.
- [ ] Exact localhost web origin is configured.
- [ ] SPA Client ID is stored locally.
- [ ] API audience is stored locally.
- [ ] No Auth0 management credential is committed.
- [ ] No wildcard callback or origin is configured.

---

# Part B: Google Gemini

## 1. Open Google AI Studio

Open:

https://aistudio.google.com/

Sign in with the Google account that will own the hackathon project.

## 2. Create or select a project

Open:

```text
Dashboard → Projects
```

Create or import a project named:

```text
velvetAI Hackathon
```

If the account belongs to an organization and key creation is blocked, either:

- Request the necessary permissions, or
- Create a separate personal Google Cloud project for the hackathon.

## 3. Create the API key

Open:

```text
Dashboard → API Keys
```

Create a key for the velvetAI project.

New keys are authorization keys by default where supported.

Do not show the key during screen recording or screenshots.

Do not paste the key into an LLM prompt.

## 4. Secure the key

Store it in:

- A password manager.
- The untracked local server environment file.
- Later, Render's server-side environment/secret settings.

Use:

```text
GOOGLE_GENERATIVE_AI_API_KEY=<secret>
AI_PROVIDER=gemini
AI_MODEL=<model selected by the implementation>
```

Never use:

```text
VITE_GOOGLE_GENERATIVE_AI_API_KEY
```

Variables beginning with `VITE_` are bundled into browser code.

Gemini calls must happen from the velvetAI server.

## 5. Apply restrictions and budgets

In Google AI Studio or Google Cloud Console, where available:

- Restrict the key to the Gemini or Generative Language API.
- Limit it to the velvetAI project.
- Configure quota or billing alerts.
- Do not grant broad unrelated Google Cloud permissions.
- Do not enable unnecessary APIs.

## 6. Verify Git ignores the key file

If the key is stored in `.env.local`:

```zsh
git check-ignore .env.local
```

If it prints:

```text
.env.local
```

the file is ignored.

If it prints nothing, stop and fix `.gitignore` before saving the key.

## 7. Do not test by exposing the key

Prefer testing through the server-side velvetAI Gemini adapter after Epic 4 implements it.

If a manual test is required:

- Load the key from an environment variable.
- Never type the literal key directly into a shell command.
- Never print all environment variables.
- Never paste complete command output if it may contain the key.

## 8. Gemini verification checklist

- [ ] Google AI Studio project exists.
- [ ] Gemini API key is created.
- [ ] Key is stored in a password manager.
- [ ] Key is stored only in an untracked server environment.
- [ ] Key does not use a `VITE_` variable.
- [ ] Gemini/Generative Language API restriction is enabled where available.
- [ ] Quota or billing alert is configured.
- [ ] No key was committed.
- [ ] No key was shared with an LLM.
- [ ] No key appears in browser source.

---

# Part C: Environment-file example

Do not copy actual values into documentation.

Your untracked local environment file may contain:

```text
# Auth0 — browser-safe values
VITE_AUTH0_DOMAIN=<AUTH0_DOMAIN>
VITE_AUTH0_CLIENT_ID=your-public-spa-client-id
VITE_AUTH0_AUDIENCE=https://velvetai.example/api

# Auth0 — server verification values
AUTH0_ISSUER=<AUTH0_ISSUER>
AUTH0_AUDIENCE=https://velvetai.example/api

# Gemini — server only
AI_PROVIDER=gemini
AI_MODEL=MODEL_SELECTED_BY_IMPLEMENTATION
GOOGLE_GENERATIVE_AI_API_KEY=your-secret-key
```

Only placeholder variable names belong in `.env.example`.

Never add real values to `.env.example`.

---

# Part D: Safe status message for the coding LLM

After setup, report only:

```text
Auth0 tenant: configured
Auth0 velvetAI API/audience: configured
Auth0 SPA application: configured
Auth0 local callback/logout/origin URLs: configured
Auth0 credentials: stored locally and untracked

Google AI Studio project: configured
Gemini API key: configured server-side and untracked
Gemini API restriction: configured
No secret values shared
```

Do not include:

- Auth0 management secrets.
- Gemini API key.
- Access tokens.
- ID tokens.
- Refresh tokens.
- Passwords.
- Complete environment-file contents.

---

# Part E: Render configuration later

After Render deploys the application, add the exact hosted URLs to Auth0.

Example only:

```text
Allowed Callback URLs:
http://localhost:5173,
https://YOUR-VELVETAI-WEB.onrender.com

Allowed Logout URLs:
http://localhost:5173,
https://YOUR-VELVETAI-WEB.onrender.com

Allowed Web Origins:
http://localhost:5173,
https://YOUR-VELVETAI-WEB.onrender.com
```

Do not add wildcard Render subdomains.

In Render, configure server-only values:

```text
AUTH0_ISSUER
AUTH0_AUDIENCE
GOOGLE_GENERATIVE_AI_API_KEY
AI_PROVIDER
AI_MODEL
```

Configure public web build values:

```text
VITE_AUTH0_DOMAIN
VITE_AUTH0_CLIENT_ID
VITE_AUTH0_AUDIENCE
```

Never configure the Gemini key as a public web variable.

---

# Part F: Troubleshooting

## Auth0 login redirects to an error

Check:

- Callback URL matches exactly.
- Port is correct.
- No trailing slash mismatch.
- Auth0 domain is correct.
- Client ID belongs to the SPA application.
- Audience matches the API identifier exactly.

## Auth0 token is rejected by the API

Check:

- `iss` equals `AUTH0_ISSUER`.
- `aud` contains `AUTH0_AUDIENCE`.
- Token is an access token—not an ID token.
- RS256 is used.
- Required scope exists.
- Local PostgreSQL membership exists.
- Membership is not revoked.

## Gemini returns unauthorized

Check:

- The key is in `GOOGLE_GENERATIVE_AI_API_KEY`.
- The variable is available to the server process.
- The Gemini API is enabled.
- The key restriction allows Gemini.
- The selected model is available to the project.
- The key was not revoked after leak detection.

## Environment variable appears undefined in the browser

Only `VITE_` variables are exposed to the Vite browser build.

This is intentional.

The Gemini key and server Auth0 validation values must remain unavailable to browser JavaScript.

---

# Official references

- Auth0 React quickstart: https://auth0.com/docs/quickstart/spa/react
- Auth0 API registration: https://auth0.com/docs/get-started/auth0-overview/set-up-apis
- Auth0 API RBAC: https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis
- Auth0 application settings: https://auth0.com/docs/get-started/applications/application-settings
- Auth0 PKCE flow: https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/call-your-api-using-the-authorization-code-flow-with-pkce
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Gemini getting started: https://ai.google.dev/gemini-api/docs/get-started
- Vercel AI SDK Google provider: https://ai-sdk.dev/providers/ai-sdk-providers/google

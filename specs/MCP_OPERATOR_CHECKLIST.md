# MCP Operator Checklist

Every manual step an operator must perform to ship the Trips MCP server. The swarm run never deployed, created Cloudflare resources, or set secrets. Values in `<angle brackets>` or `${VARS}` are deployment-specific and must never be committed.

## Stage 1: MCP endpoint behind Cloudflare Access (main hostname)

No new DNS record, Worker route, KV namespace, GitHub secret, or Worker secret.

1. **Route:** nothing to do. `/api/mcp` is served by the existing `<app-host>/api/*` Worker route.
2. **Service token:** Zero Trust → Access → Service Auth → Service Tokens. Create (or reuse) a token for the MCP client. Store its Client ID and Secret outside the repo (for example as `TRIPS_CF_ID` and `TRIPS_CF_SECRET` in the client's environment).
3. **Service Auth policy:** on the existing Trips Access application, add a policy with action **Service Auth** that includes that token, alongside the existing External Evaluation Allow policy. First check whether one already exists for the current agent integration (PRD 12 open question).
4. **No other Access app catches `/api/mcp`:** confirm the Eval app (`/api/eval/*`) and the Invites & Linking app (`/api/auth/invite/*`, `/api/auth/link*`) do not match it.
5. **Map the token to a user:** as an admin, `POST /api/admin/service-identities` with `{ "cfAccessSubject": "<token common_name>", "commonName": "<token common_name>", "userId": "<user uuid>" }`. Access sets `sub` to `""` for service tokens, and `authMiddleware` looks up `serviceIdentities.cfAccessSubject` by `sub || common_name` (`api/src/middleware/auth.ts:81`), so `cfAccessSubject` must be the token's `common_name` (its Client ID). The route rejects an empty `cfAccessSubject`, and a duplicate returns 409.
6. **Rate limiter:** nothing to create. `MCP_RATE_LIMITER` (namespace `1002`, 120 per 60 s per user) is declared in `api/wrangler.toml` and takes effect on deploy.
7. **Secrets:** no `wrangler secret put` for Stage 1.
8. **Verify:**
   ```bash
   claude mcp add --transport http trips "${TRIPS_MCP_URL}" \
     --header "CF-Access-Client-Id: ${TRIPS_CF_ID}" \
     --header "CF-Access-Client-Secret: ${TRIPS_CF_SECRET}"
   ```
   Then call `get_me` and confirm it resolves to the mapped user.

## Stage 2: OAuth on the dedicated MCP hostname

> **Do steps 1 and 2 before the next push to `main` that touches `api/`.** The deploy workflow's "Inject OAuth KV Namespace ID" step fails with `::error::Repository secret CLOUDFLARE_KV_OAUTH_ID is not set` until they are done. This blocks every API deploy, not only Stage 2.

1. **KV namespace:** `npx wrangler kv namespace create OAUTH_KV` (or create it in the dashboard). Record the id.
2. **GitHub secret `CLOUDFLARE_KV_OAUTH_ID`:** set it to that id.
3. **DNS:** add a proxied record for `<mcp-host>` in `<zone>` (for example `AAAA` → `100::`, as usual for Worker-only hostnames).
4. **Access for SaaS app (OIDC):** Zero Trust → Access → Applications → Add → SaaS → OIDC.
   - Redirect URL: `https://<mcp-host>/callback`.
   - Attach the same External Evaluation rule as the main Trips application.
   - Record the client id, client secret, authorization endpoint, token endpoint, JWKS endpoint and issuer.
5. **No Access app may match `<mcp-host>`:** no self-hosted Access application, wildcards included, may cover the MCP hostname. The OAuth endpoints, `/.well-known/*` and `/mcp` must reach the Worker without an Access challenge.
6. **Worker route:** do not add it in the dashboard. Set GitHub secrets `MCP_HOST` (the bare `<mcp-host>`) and `MCP_ZONE_NAME` (`<zone>`); the workflow inserts `<mcp-host>/*` on deploy.
7. **Other GitHub secrets** (all required once `MCP_HOST` is set; the workflow fails otherwise):
   - `MCP_PUBLIC_URL` = `https://<mcp-host>/mcp`. It must exactly equal the URL users enter in Claude or Gemini.
   - `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER` from step 4.
8. **Worker secrets** (from `api/`, before or right after the first Stage 2 deploy):
   ```bash
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   ```
8a. **Access for SaaS details:** scopes `openid email`; turn PKCE on if offered (the Worker sends S256 as well as the client secret).
8b. **WAF / Bot settings:** make sure Bot Fight Mode, managed challenges and WAF rules do not challenge `/.well-known/*`, `/oauth/token`, `/oauth/register` or `/mcp` on `<mcp-host>` for Anthropic and Google egress ranges. Those clients cannot solve challenges.
8c. **`MCP_PUBLIC_URL` format:** lowercase, no trailing slash, exactly `https://<mcp-host>/mcp`.
9. **Rate limiter:** nothing to create. `OAUTH_RATE_LIMITER` (namespace `1003`, 30 per 60 s per IP) takes effect on deploy.
10. **Disable or roll back Stage 2:** delete the `MCP_HOST` secret and redeploy. The var becomes empty, no MCP route is added, and the dispatcher stays off.

## Stage 2: static OAuth client for Gemini Spark (only if Gemini asks for a client ID and secret)

1. Stage 2 must be on (real `MCP_HOST`, `MCP_PUBLIC_URL`, `OAUTH_KV`); until then the endpoint returns 503 `OAuth is not configured`.
2. Signed in as an admin, in a browser (the signed-in `/api/docs` page), `POST /api/admin/oauth-clients` with `{"clientName":"Gemini Spark","redirectUris":["<exact redirect URI shown by Gemini's connected-apps UI>"]}`. The URI must be `https://vertexaisearch.cloud.google.com/oauth-redirect` or under `https://oauth-redirect.googleusercontent.com/`. Add `"tokenEndpointAuthMethod":"client_secret_post"` only if Gemini sends the secret in the form body. The request contains no secret; the **response** does, so avoid logged terminals.
3. Copy `clientId` and `clientSecret` into Gemini Spark immediately. The secret is stored only as a SHA-256 hash and cannot be shown again; if it is lost, delete the client and create a new one.
4. To retire it: `DELETE /api/admin/oauth-clients/{clientId}` (also revokes all of its grants).

## Repository hygiene notes (for the operator to decide)

- `api/.dev.vars` is tracked in git (it holds only `DEV_MODE=true` today) and is not gitignored. Anyone adding a secret there would commit it. Consider untracking it and keeping only `api/.dev.vars.example`.
- `wrangler dev` loads only `.dev.vars` (or `.dev.vars.<env>` with `--env`); a `.dev.vars.local` file is not read automatically. Use `npx wrangler dev --env-file .dev.vars --env-file .dev.vars.local` (verified in Phase 3; the later file wins). Local Stage 2 needs its own process: `MCP_HOST=localhost`, `MCP_PUBLIC_URL=http://localhost:<port>/mcp`, and `--local-upstream localhost:<port>`, because `wrangler dev` rewrites every request to a single host.

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

> **Do steps 1 and 2 before the next push to `main` that touches `api/`.** The deploy workflow's "Validate Deploy Secrets" step fails with `::error::Repository secret CLOUDFLARE_KV_OAUTH_ID is not set (id of the OAUTH_KV namespace).` until they are done. This blocks every API deploy, not only Stage 2.

0. **Secret formats are validated before every deploy** (step "Validate Deploy Secrets"; failures print `::error::<SECRET NAME> ...` and never the value). Check these before merging:
   - `CLOUDFLARE_D1_DATABASE_ID` is a standard UUID; `CLOUDFLARE_KV_OAUTH_ID` is 32 lowercase hex characters.
   - `MCP_HOST` is a bare hostname (it is lowercased) in a zone on this Cloudflare account. `MCP_ZONE_NAME` is no longer used; delete it if you set it.
   - `MCP_PUBLIC_URL` is exactly `https://<MCP_HOST in lowercase>/mcp`, and is not set while `MCP_HOST` is empty.
   - Each `ACCESS_*` URL starts with `https://` and has no whitespace, quotes or backslashes.
   - The deploy step now runs `npx wrangler deploy` directly (with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from env) instead of `wrangler-action`; migrations still use `wrangler-action`.
1. **KV namespace:** `npx wrangler kv namespace create OAUTH_KV` (or create it in the dashboard). Record the id.
2. **GitHub secret `CLOUDFLARE_KV_OAUTH_ID`:** set it to that id.
3. **DNS: do not add a record.** The deploy attaches `<mcp-host>` as a Workers Custom Domain, which creates the proxied DNS record and the certificate. If a record for `<mcp-host>` already exists, delete it first, or the deploy fails. The deploy's `CLOUDFLARE_API_TOKEN` must be allowed to manage Workers Custom Domains and DNS on that zone (for example *Zone → Workers Routes: Edit* and *Zone → DNS: Edit*); if it is not, the first Stage 2 deploy fails with an authorization error.
4. **Access for SaaS app (OIDC):** Zero Trust → Access → Applications → Add → SaaS → OIDC.
   - Redirect URL: `https://<mcp-host>/callback`.
   - Attach the same External Evaluation rule as the main Trips application.
   - Record the client id, client secret, authorization endpoint, token endpoint, JWKS endpoint and issuer.
5. **No Access app may match `<mcp-host>`:** no self-hosted Access application, wildcards included, may cover the MCP hostname. The OAuth endpoints, `/.well-known/*` and `/mcp` must reach the Worker without an Access challenge.
6. **Custom Domain:** do not add it in the dashboard. Set the GitHub secret `MCP_HOST` (the bare `<mcp-host>`); the workflow inserts `{ pattern = "<mcp-host>", custom_domain = true }` on deploy.
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
10. **Disable or roll back Stage 2:** delete the `MCP_HOST` secret and redeploy. The var becomes empty and the dispatcher stays off. Then remove `<mcp-host>` under Workers → the API Worker → Settings → Domains & Routes, so the Custom Domain and its DNS record go away (a deploy without it in `routes` may not detach it).

## Stage 2: static OAuth client for Gemini Spark (only if Gemini asks for a client ID and secret)

1. Stage 2 must be on (real `MCP_HOST`, `MCP_PUBLIC_URL`, `OAUTH_KV`); until then the endpoint returns 503 `OAuth is not configured`.
2. Signed in as an admin, in a browser (the signed-in `/api/docs` page), `POST /api/admin/oauth-clients` with `{"clientName":"Gemini Spark","redirectUris":["<exact redirect URI shown by Gemini's connected-apps UI>"]}`. The URI must be `https://vertexaisearch.cloud.google.com/oauth-redirect` or under `https://oauth-redirect.googleusercontent.com/`. Add `"tokenEndpointAuthMethod":"client_secret_post"` only if Gemini sends the secret in the form body. The request contains no secret; the **response** does, so avoid logged terminals.
3. Copy `clientId` and `clientSecret` into Gemini Spark immediately. The secret is stored only as a SHA-256 hash and cannot be shown again; if it is lost, delete the client and create a new one.
4. To retire it: `DELETE /api/admin/oauth-clients/{clientId}` (also revokes all of its grants).

## Repository hygiene notes (for the operator to decide)

- `api/.dev.vars` is tracked in git (it holds only `DEV_MODE=true` today) and is not gitignored. Anyone adding a secret there would commit it. Consider untracking it and keeping only `api/.dev.vars.example`.
- `wrangler dev` loads only `.dev.vars` (or `.dev.vars.<env>` with `--env`); a `.dev.vars.local` file is not read automatically. Use `npx wrangler dev --env-file .dev.vars --env-file .dev.vars.local` (verified in Phase 3; the later file wins). Local Stage 2 needs its own process: `MCP_HOST=localhost`, `MCP_PUBLIC_URL=http://localhost:<port>/mcp`, and `--local-upstream localhost:<port>`, because `wrangler dev` rewrites every request to a single host.

## Manual verification after deploy (cannot be automated offline)

From the bottom of `api/test/acceptance.test.ts`:

1. **Stage 1, real service token:** `claude mcp add` with `CF-Access-Client-Id`/`Secret` against production `/api/mcp`, then `get_me` resolves to the user mapped in `service_identities`.
2. **Claude Code, Stage 2:** `claude mcp add --transport http trips "${MCP_PUBLIC_URL}"`, `/mcp` sign-in over the loopback redirect, `get_me` returns the same user id as step 1. Note whether Claude Code keeps the same loopback host and path across sessions (only the port may change).
3. **claude.ai custom connector:** Settings → Connectors → Add custom connector with `${MCP_PUBLIC_URL}`; DCR, consent page, Access sign-in, then `list_trips` in chat. Repeat in Desktop and mobile.
4. **Gemini Spark:** Custom apps for Spark → Add a custom app (DCR, or a static client from Admin → OAuth clients). Record which redirect URI Google registers (it must be on the allow-list), then "@trips" returns trips.
5. **Gemini Spark unattended refresh:** run a recurring routine for more than 1 hour (ideally a day); it never re-prompts, and logs show `refresh_token` grants with no new `/authorize`.
6. **Latency:** from Anthropic/Google egress (or nearby), time `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/oauth/register`, `/oauth/token` (p95 < 1 s), and check Worker duration metrics.
7. **D1 LIKE limit in production:** run `search_itineraries` with a 40-character `text`; it must succeed. The 50-byte pattern limit was measured locally only.

## Accepted risks (recorded by the security reviews)

- A failed PKCE verifier does not consume the authorization code (library 1.2.4 behavior; 43+ character verifier, 30/min/IP on `/oauth/token`).
- No OIDC `nonce` on the Access leg (PKCE S256 + confidential client + single-use, browser-bound state).
- The library reflects any `Origin` on its token, registration, metadata and `/mcp` responses (never with credentials; bearer auth only).
- Refresh tokens are issued whether or not `offline_access` is granted, rotate on use, have no reuse detection, and live as long as they are used at least every 30 days (user decision: no absolute cap).
- The Google relay rule accepts any `https://oauth-redirect.googleusercontent.com/...` target (per TDD 7.4); the consent page's client name, publisher note and redirect host are the control.
- Future tools must register `outputSchema` as a `z.object(...)`: the output guard skips schemas without `~standard`, which would fall back to the SDK's path-revealing error text.

## Pre-existing hard-coded config (not introduced by this work; operator to decide)

- Since main #28, the app route, zone and Access team domain are placeholders injected from the `CLOUDFLARE_ROUTE_PATTERN`, `CLOUDFLARE_ZONE_NAME` and `CF_ACCESS_TEAM_DOMAIN` secrets, and the CORS origin comes from `WEB_APP_ORIGIN`. The deploy now **fails** if any of the first three is missing, and warns if `WEB_APP_ORIGIN` is missing. Set all four before merging.
- `api/wrangler.toml` still contains the `CF_ACCESS_AUDIENCE` and `CF_ACCESS_INVITE_AUDIENCE` values, and `api/src/index.ts` still allows `*.trips-web-cm1.pages.dev` preview origins.
- `authMiddleware` enables the dev bypass when `DEV_MODE` is any non-empty string (`DEV_MODE=false` would enable it). Consider `=== "true"`.
- Web lint: 5 pre-existing errors remain in `ItineraryTimeline.tsx`, `lib/auth.tsx`, `AcceptInvite.tsx` and `TripDetail.tsx` (×2); the 6 in `Account.tsx`/`Admin.tsx` were fixed.

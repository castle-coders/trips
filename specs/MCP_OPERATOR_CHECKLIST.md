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

## Repository hygiene notes (for the operator to decide)

- `api/.dev.vars` is tracked in git (it holds only `DEV_MODE=true` today) and is not gitignored. Anyone adding a secret there would commit it. Consider untracking it and keeping only `api/.dev.vars.example`.
- `wrangler dev` loads only `.dev.vars` (or `.dev.vars.<env>` with `--env`); a `.dev.vars.local` file is not read automatically. Use `npx wrangler dev --env-file .dev.vars --env-file .dev.vars.local` (from wrangler source; not yet run).

# Trips

A travel itinerary management app for organizing group trips. Plan flights, lodging, restaurants, activities, and more — with role-based access so trip owners control who can view or edit.

## Architecture

Monorepo with two packages:

- **`web/`** — React 19 SPA (Vite, Tailwind CSS, React Router)
- **`api/`** — Hono REST API on Cloudflare Workers (D1 SQLite, Drizzle ORM)

The web app proxies `/api` requests to the API server during development.

## Getting Started

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)

### Setup

```bash
# Install dependencies
cd api && npm install
cd ../web && npm install
```

### Database

```bash
cd api

# Generate migrations from schema
npm run db:generate

# Apply migrations locally
npm run db:migrate:local

# (Optional) Open Drizzle Studio
npm run db:studio
```

### Development

Run both servers in separate terminals:

```bash
# Terminal 1 — API (port 8787)
cd api
npm run dev

# Terminal 2 — Web (port 5173)
cd web
npm run dev
```

Open http://localhost:5173. The first registered user is automatically an admin.

### Testing

The API tests run with Vitest inside the Workers runtime (workerd), through `@cloudflare/vitest-pool-workers`. The config is `api/vitest.config.mts`.

```bash
cd api
npm test                               # run the test suite
npx tsc --noEmit -p test/tsconfig.json # typecheck the tests
```

The PRD acceptance tests for the [MCP server](#mcp-server) are in `api/test/acceptance.test.ts`. The checks that need live clients or production Cloudflare (claude.ai, Gemini Spark, a real Access service token, latency from Anthropic and Google networks) can't run offline. They are listed as manual steps in the comment at the bottom of that file.

## Roles & Permissions

### Global roles (set by admins)

| Role | Access |
|---|---|
| **admin** | Full system access, user management |
| **editor** | Can be granted edit access to trips |
| **viewer** | Default for new/invited users |

### Trip-level roles (per participant)

| Role | Can do |
|---|---|
| **Owner** | Full control — edit trip, manage participants & invites, CRUD all items |
| **Editor** | CRUD itineraries, expenses, documents. Cannot manage participants or invites |
| **Viewer** | Read-only. Sensitive fields (confirmation numbers, ticket numbers) are stripped from API responses via dedicated view schemas |

## Data Model

All trip content is stored in a single `itineraries` table with type-specific JSON content:

- **Flight** — supports multiple legs, per-leg seat assignments, timezone-aware times
- **Lodging** — check-in/check-out with planned arrival/departure
- **Rail** — train operator, stations, carriage/seat assignments
- **Car** — rental with driver roles per participant
- **Restaurant** — reservation time, party size
- **Transport** — buses, ferries, shuttles
- **Activity** — events with location and time

Other tables: `trips`, `participants`, `users`, `expenses`, `documents`, `invites`, `service_identities`.

## API

OpenAPI docs available at `/docs` when the API is running.

Key endpoint groups:

- `POST /auth/login` | `/auth/register` | `/auth/google` — authentication
- `GET/POST /trips` — trip CRUD
- `GET/POST/PUT/DELETE /trips/:tripId/itineraries` — itinerary management
- `GET/POST/PUT/DELETE /trips/:tripId/participants` — participant management (owners only)
- `GET/POST/DELETE /trips/:tripId/invites` — invite management (owners only)
- `GET/POST/PUT/DELETE /trips/:tripId/expenses` — expense tracking
- `GET/POST/PUT/DELETE /trips/:tripId/documents` — document attachments
- `GET/POST/PUT/DELETE /admin/*` — user & service identity management (admins only)
- `/mcp` — MCP server for AI agents (see [MCP server](#mcp-server))

### Behavior changes

Three REST behaviors changed on purpose. The first two came with moving trip, itinerary and expense logic into a shared service layer (`api/src/services/`); the third came with the MCP server's hardening. All other responses are unchanged.

**Non-members get 404 from itinerary reads.** Before, a signed-in user who was not a participant of a trip could read that trip's itineraries if they knew the trip id. They got `200` with the viewer projection. Now a non-admin who is not a participant gets `404`:

| Endpoint | Before | Now |
|---|---|---|
| `GET /trips/:tripId/itineraries` | `200` with viewer-projected items | `404` `{"error":"Trip not found"}` |
| `GET /trips/:tripId/itineraries/:itineraryId` | `200` with the viewer-projected item | `404` `{"error":"Not found"}`, the same response as for an itinerary that does not exist |

This also applies when a non-admin requests a trip id that does not exist. The list endpoint returned `200 []` before and now returns `404` `{"error":"Trip not found"}`. Participants are unaffected and still get the projection for their role. Admins are also unaffected: they get the full projection on every trip, and the list endpoint still returns `200 []` for a trip id that does not exist.

**Creating a trip adds the creator as Owner.** `POST /trips` now inserts a `participants` row for the creator (`userId`, `email`, `name`, role `Owner`, not traveling) in the same batch as the trip, so both rows are written or neither is. This applies to admins too. The `201` response body is the same trip object as before. As a result, a non-admin creator can now see, edit and delete the trip they created, and the trip shows up in their trip list. Before, they were not a participant and could not read it back. Global viewers still get `403` and nothing is written.

**Account-link errors no longer echo internal messages.** `POST /auth/me/link` and `POST /auth/link` used to return the exception text in a `500` body. They now always return `500` `{"error":"Internal server error"}`, and the detail is logged on the server only. `POST /auth/link/:token/confirm` still answers with its generic HTML error page. When the token's owner no longer exists, all three now answer as for an unknown token (`404` `{"error":"Token not found or already used"}`, or the "Link Not Found" page) before anything is changed.

## MCP server

The API also serves a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents can read and edit trips through tools instead of raw REST calls. The tools call the same service layer as the REST routes (`api/src/services/`), so they enforce the same trip roles and the same Viewer projection.

The same Worker serves the MCP server in two ways:

| | Stage 1 | Stage 2 |
|---|---|---|
| Endpoint | `/api/mcp` on the app host, served by the existing `/api/*` Worker route | `/mcp` on a dedicated MCP hostname (`${MCP_PUBLIC_URL}`) |
| Auth | Cloudflare Access (service token), through the same `authMiddleware` as the REST API | OAuth 2.1 bearer token issued by the Worker itself |
| For | Clients that can send custom HTTP headers: Claude Code, the MCP Inspector, curl, local scripts | Any MCP client with OAuth: Claude Code, claude.ai, Claude Desktop and mobile, Gemini Spark, Gemini CLI |
| Scopes | Always `trips:read` and `trips:write` | What the user approved on the consent page |

- **Transport:** Streamable HTTP, stateless, on both endpoints. Each request builds a fresh server, and the user is reloaded from D1 on every request, so a role change applies to the next call. If the user has been deleted, the next request gets `401`: in Stage 1 from `authMiddleware`, in Stage 2 as `invalid_token` with the same `WWW-Authenticate` challenge as a bad token.
- **Stage 1 auth:** requests that don't resolve to an existing user get `401` before any MCP handling.
- **Stage 2 auth:** requests without a valid bearer token get `401` with a `WWW-Authenticate` header that points the client at the discovery metadata, which starts the sign-in. See [Stage 2: OAuth on the MCP hostname](#stage-2-oauth-on-the-mcp-hostname).

Stage 2 is off until it is configured: with `MCP_HOST` empty (the committed default), every request is served by the existing app.

### Tools

| Tool | Scope | Required trip role | Read/write |
|---|---|---|---|
| `get_me` | `trips:read` | none | read |
| `list_trips` | `trips:read` | none (returns only trips you belong to) | read |
| `get_trip` | `trips:read` | Viewer | read |
| `search_itineraries` | `trips:read` | Viewer (searches only trips you belong to) | read |
| `list_expenses` | `trips:read` | Viewer | read |
| `create_trip` | `trips:write` | none (global role `editor` or `admin`; global viewers are refused) | write |
| `create_itinerary` | `trips:write` | Editor | write |
| `update_itinerary` | `trips:write` | Editor | write |
| `add_expense` | `trips:write` | Editor | write |

Read tools carry the MCP annotation `readOnlyHint: true`. All tools set `destructiveHint: false`, and there is no delete tool. `update_itinerary` is idempotent. `create_trip`, `create_itinerary` and `add_expense` are not, so each call creates a new record. `create_trip` makes the caller the trip's Owner.

**Scopes.** Each tool checks its scope before it runs, read tools included. Stage 1 grants every caller both `trips:read` and `trips:write`, so in Stage 1 only the trip role limits what a caller can do. In Stage 2 the token carries only the scopes the user ticked on the consent page, and both the scope and the trip role must allow the call.

**Roles.** "Editor" in the table means Editor or Owner. Admins are treated as Owner on every trip. A trip you don't belong to looks the same as a trip that doesn't exist: the tool returns `Trip not found`.

**Viewer projection.** A caller with the Viewer role on a trip gets itineraries with confirmation numbers and traveler ticket numbers removed. That applies in `get_trip` and `search_itineraries`. A search across several trips projects each item for your role on that item's trip. Seat assignments are still visible to Viewers. Editors and Owners see every field.

**Search limits.** `search_itineraries` returns at most `limit` items (default 50, max 200). `text` is a case-insensitive substring of at most 40 characters. The search loads at most 1000 candidate rows from the database; when there are more, `truncated` is `true` and `total` is a lower bound. The cap is applied before the date filter and the time sort, so a truncated search with `from`/`to` can miss matching items. Narrow it with `tripId`, `types` or `text`. D1 rejects `LIKE` patterns longer than 50 bytes, so text that grows past that once `%`, `_` and `\` are escaped (or that uses multi-byte characters) is refused with `Search text is too long; use a shorter phrase`.

**Errors.** Tool failures come back as MCP tool errors (`isError: true`) with a short message, for example a missing scope, `Trip not found`, `Forbidden`, or a validation error listing the invalid fields. Any unexpected error comes back as `Internal error`, and the details are logged on the server only. The server also checks each tool's result against the tool's output schema before sending it. A result that doesn't match comes back as `Internal error` too, so schema details never reach the client.

### Rate limit

`/api/mcp` and the Stage 2 `/mcp` endpoint are limited to 120 requests per 60 seconds per user, through the `MCP_RATE_LIMITER` binding in `api/wrangler.toml`. The limit is keyed on the resolved Trips user id, not the IP address, and both endpoints share it. It counts every HTTP request to the endpoint, not only tool calls. Over the limit, the endpoint answers `429` `{"error":"Too many requests"}`. If the binding is missing, no limit is applied.

On the MCP hostname, `/authorize`, `/callback`, `/oauth/token` and `/oauth/register` are also limited to 30 requests per 60 seconds per IP address (`cf-connecting-ip`), through the `OAUTH_RATE_LIMITER` binding. Over the limit, these paths answer `429` `{"error":"Too many requests"}`. The `/.well-known/` metadata is not rate-limited.

### Audit log

Every tool call writes one line to the Worker logs (Workers observability is enabled in `wrangler.toml`):

```
[mcp] tool=<name> user=<user id> trip=<trip id or -> scopes=<comma-separated scopes> ok=<true|false> err=<code or -> ms=<duration>
```

`trip` comes from the call's `tripId` argument, or is `-` when there isn't one. `err` is `-` on success. On failure it is `scope`, a service error code (such as `not_found`, `forbidden` or `validation`), `internal`, or `output`. Unexpected errors also log a second `[mcp] tool=<name> internal error: ...` line, with the error message stripped of control characters and clipped to 200 characters. `output` means the tool ran but its result failed the output schema check. It appears on an extra line, `[mcp] tool=<name> user=... trip=... scopes=... ok=false err=output paths=<schema paths>`, logged after the tool's own line (which still reads `ok=true`). It names the failing fields but never their values. Tool log lines don't include credentials or the `X-Dev-User-Email` value.

The Stage 2 sign-in flow logs `[oauth] event=<authorize|consent|upstream|error> ...` lines with the client id, the consent decision and approved scopes, the sign-in step, the user id once known, and OAuth error codes. They never include tokens, authorization codes, PKCE verifiers, state, client secrets or email addresses.

### Connecting (Stage 1: Cloudflare Access service token)

1. **Create a service token.** In Zero Trust → Access → Service Auth → Service Tokens, create (or reuse) a token for the MCP client. Keep its Client ID and Client Secret out of the repo, for example as `TRIPS_CF_ID` and `TRIPS_CF_SECRET` in the client's environment.
2. **Allow the token on the Trips Access application.** Add a policy with action **Service Auth** that includes the token, next to the existing External Evaluation policy (see [Cloudflare Access configuration](#cloudflare-access-configuration)).
3. **Map the token to a user.** A service token has no email, so `authMiddleware` looks it up in `service_identities`. Access sets `sub` to `""` for service tokens, so the middleware uses the token's `common_name` (its Client ID) as the subject and matches it against `cfAccessSubject`. As an admin, call:

   ```
   POST /api/admin/service-identities
   { "cfAccessSubject": "<token common_name>", "commonName": "<token common_name>", "userId": "<user id>" }
   ```

   The token then acts as that user, with that user's global role and trip roles. A subject can be mapped only once (`409` otherwise).
4. **Add the server to Claude Code:**

   ```bash
   claude mcp add --transport http trips "${TRIPS_MCP_URL}" \
     --header "CF-Access-Client-Id: ${TRIPS_CF_ID}" \
     --header "CF-Access-Client-Secret: ${TRIPS_CF_SECRET}"
   ```

   `TRIPS_MCP_URL` is `https://<app-host>/api/mcp`.
5. **Verify.** Call `get_me` and check that it returns the mapped user.

### Stage 2: OAuth on the MCP hostname

- **Dedicated hostname.** Stage 2 runs on its own hostname (`MCP_HOST`), routed to the same Worker. The Worker dispatches on the hostname: requests to `MCP_HOST` go to the OAuth provider, everything else keeps the `/api` behavior. A separate hostname is needed because OAuth discovery metadata must sit at `/.well-known/` on the origin root, and no Access application may cover it.
- **OAuth 2.1 with PKCE `S256`**, implemented with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Clients register through Dynamic Client Registration, identify themselves with a client metadata document URL, or use a static client an admin created.
- **Consent page.** The Worker shows the app's name, who publishes it (or a note that it is self-registered and can't be verified), the host it will send you back to, a warning when that is a program on your computer (loopback redirect), and one checkbox per scope. Deny, or approving with nothing ticked, sends the app an `access_denied` error.
- **Sign-in through Cloudflare Access.** After you approve, the Worker sends you to a Cloudflare Access for SaaS OIDC application, where you sign in as usual. The Worker verifies the returned ID token and looks up its email in `user_emails`. **The user must already exist**: an unknown email gets an "Account not registered" page and nothing is created.
- **Scopes.** `trips:read` (view trips, itineraries and expenses), `trips:write` (create and update, never delete) and `offline_access` (stay connected while you are away). `trips:read` and `offline_access` are ticked by default; `trips:write` is not, so tick it to let the app make changes. The page offers only the scopes the app asked for (all three if it asked for none), and a forged form can't add others.
- **Token lifetimes.** Access tokens last 1 hour. Refresh tokens rotate on every use. A grant stays alive as long as it is refreshed at least once every 30 days, with no absolute cap.
- **Revocation.** Disconnecting an app from the Account or Admin page deletes the grant and its tokens. The app's next `/mcp` call gets `401` and its refresh token stops working, so it must sign in again.
- **Deleted and merged users.** Deleting a user (`DELETE /api/admin/users/{userId}`) revokes all of that user's grants first. Merging accounts, by an admin or through account linking, revokes the grants of the account that is merged away; the kept account's grants are untouched. Apps that were connected under the merged-away account must reconnect, signing in as the kept account. If revoking fails, the delete or merge stops with `500` and nothing is changed. A token whose user no longer exists gets `401` `invalid_token`.

### Stage 2 endpoints

All on `https://${MCP_HOST}`:

| Path | Purpose |
|---|---|
| `/mcp` | MCP endpoint (Streamable HTTP). Needs `Authorization: Bearer <access token>` |
| `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728). Its `resource` equals `MCP_PUBLIC_URL` exactly |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Consent page (`GET`) and consent decision (`POST`) |
| `/callback` | Return from the Cloudflare Access for SaaS sign-in |
| `/oauth/token` | Code exchange and refresh |

- **Tokens only in the header.** A request to any path on the MCP hostname with a `token`, `access_token` or `apiKey` query parameter (any case) gets `400` `invalid_request`, before any other handling. Cloudflare's own request logs still record the URL, so never put a token in one.
- **Redirect allow-list.** Every client redirect URI must be one of:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://vertexaisearch.cloud.google.com/oauth-redirect`
  - any path under `https://oauth-redirect.googleusercontent.com/`
  - loopback `http://localhost[:port]/...` or `http://127.0.0.1[:port]/...`

  Registration with any other URI fails with `invalid_redirect_uri`. The list is checked again at `/authorize` for every client, including static and metadata-document clients; a mismatch shows an error page and never redirects. URIs must be written in canonical form (lowercase host, no userinfo, no fragment, no extra port on the https targets).

### Connecting (Stage 2: OAuth)

`${MCP_PUBLIC_URL}` is `https://<mcp-host>/mcp`. Enter it exactly: the client compares it with the `resource` in the discovery metadata. In every client the sign-in opens a browser for the consent page and then the Cloudflare Access sign-in.

**Claude Code**

```bash
claude mcp add --transport http trips "${MCP_PUBLIC_URL}"
```

Then run `/mcp` inside Claude Code to sign in. Claude Code registers itself with a loopback redirect such as `http://localhost:<port>/callback`. A different port on later sign-ins is fine, but the host (`localhost` and `127.0.0.1` are not interchangeable) and the path must stay the same as when it registered. No `callbackPort` setting is needed. If you also keep a Stage 1 entry, give one of them a different name.

**claude.ai, Claude Desktop and Claude mobile**

Settings → Connectors → Add custom connector, and enter `${MCP_PUBLIC_URL}`. Claude registers itself (Dynamic Client Registration or a client metadata document) with the `https://claude.ai/api/mcp/auth_callback` redirect and opens the consent page.

**Gemini Spark**

1. In gemini.google.com, open **Settings & help** → **Connected Apps** → **Custom apps for Spark** → **Add a custom app**.
2. Enter `${MCP_PUBLIC_URL}`.
3. If Gemini asks for a client ID and secret, an admin creates a static client in **Admin → OAuth clients** (or with `POST /api/admin/oauth-clients`, see [Connected apps and OAuth clients](#connected-apps-and-oauth-clients)) using the exact redirect URI Gemini shows (it must be one of the two Google entries on the allow-list), then copies the client ID and secret into Gemini. **The secret is shown once.** Otherwise Gemini registers itself.
4. Sign in through Cloudflare Access and approve. Keep `offline_access` ticked for scheduled routines, and tick `trips:write` if Spark should make changes.
5. Use the tools in chat or from recurring routines.

**Gemini CLI**

Add `${MCP_PUBLIC_URL}` as a remote HTTP MCP server and sign in when prompted. The CLI uses a loopback redirect (`http://localhost:<port>/...`), which is on the allow-list.

### Connected apps and OAuth clients

- **Account page → Connected apps:** lists the apps you connected (name, permissions, connected date) with a **Revoke** button.
- **Admin page → Connected apps:** every user's grants, with the user's email, and a revoke action per row.
- **Admin page → OAuth clients:** lists stored clients (static and dynamically registered, never their secrets), creates a static client and deletes a client. Creating one shows the client ID and secret once; the secret is stored only as a hash and cannot be shown again. If it is lost, delete the client and create a new one. Deleting a client also revokes all of its grants.

The pages call these endpoints on the main hostname:

| Endpoint | Guard | Description |
|---|---|---|
| `GET /api/auth/me/grants` | signed in | Your grants, newest first |
| `DELETE /api/auth/me/grants/{grantId}` | signed in | Revoke one of your grants. `404` if it isn't yours |
| `GET /api/admin/grants` | admin | Every user's grants |
| `DELETE /api/admin/grants/{userId}/{grantId}` | admin | Revoke any grant. The owner's `userId` is required |
| `GET /api/admin/oauth-clients` | admin | Stored clients, without secrets |
| `POST /api/admin/oauth-clients` | admin | Create a static confidential client. Body: `clientName`, `redirectUris` (1 to 10, each on the allow-list), optional `tokenEndpointAuthMethod` (`client_secret_basic`, the default, or `client_secret_post`). The `201` response is the only place the `clientSecret` appears |
| `DELETE /api/admin/oauth-clients/{clientId}` | admin | Delete a client and revoke its grants. Clients identified by a metadata document URL are not stored and give `404`; revoke their grants instead |

While Stage 2 is not configured (`MCP_PUBLIC_URL` empty), the list endpoints return `[]` and the others return `503` `{"error":"OAuth is not configured"}`.

### Local development

`api/.dev.vars` is committed with `DEV_MODE=true`, so `npm run dev` (`wrangler dev`, port 8787) accepts an `X-Dev-User-Email` header instead of Cloudflare Access. This works for both the REST API and `/api/mcp`.

```bash
# Terminal 1
cd api
npm run dev

# Terminal 2: register the local server with Claude Code
claude mcp add --transport http trips-local http://localhost:8787/api/mcp \
  --header "X-Dev-User-Email: <your seeded email>"
```

To try the tools interactively, run the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector, choose the **Streamable HTTP** transport, enter `http://localhost:8787/api/mcp`, and add the same `X-Dev-User-Email` header.

The dev header works only when `DEV_MODE` is set and the email is already in the `user_emails` table of your local database. An unknown email gets `401`, and no user is created.

**Stage 2 locally.** `wrangler dev` rewrites every request URL to a single host, so one process can't serve both the app and the MCP hostname. Run Stage 2 as its own `wrangler dev` process next to the normal one. `api/.dev.vars.example` lists every name.

1. Create a **dev** Access for SaaS OIDC application (never reuse the production one) with the redirect URL `http://localhost:8788/callback` and a policy that lets your account in.
2. Put the Stage 2 values in `api/.dev.vars.local` (gitignored): `MCP_HOST=localhost`, `MCP_PUBLIC_URL=http://localhost:8788/mcp`, the three `ACCESS_*` endpoint URLs, `ACCESS_ISSUER`, and the `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` of the dev app. Plain `wrangler dev` reads only `.dev.vars`, so pass both files; the later one wins.
3. Start the Stage 2 process:

   ```bash
   cd api
   npx wrangler dev --port 8788 \
     --env-file .dev.vars --env-file .dev.vars.local \
     --local-upstream localhost:8788
   ```

   `--local-upstream` makes the Worker see `http://localhost:8788/...`, which matches `MCP_HOST` and `MCP_PUBLIC_URL`. Keep `npm run dev` on port 8787 for the web app.
4. Connect the MCP Inspector or `claude mcp add --transport http trips-dev http://localhost:8788/mcp`.

The local D1, `OAUTH_KV` and rate limiters are simulated by `wrangler dev`. The dev proxy also rewrites `localhost` origins inside response headers such as `Location` and the `resource_metadata` pointer, so when you register a test client by hand, use `http://127.0.0.1:<port>/...` redirect URIs. The port in step 1 can be any free port, as long as the Access redirect URL, `MCP_PUBLIC_URL`, `--port` and `--local-upstream` all use the same one.

## Authentication & Access Control

Authentication is handled by Cloudflare Access with an External Evaluation rule that restricts access to known users only. New users can only be created through invite acceptance or account linking.

### How it works

1. **Known users** — the eval endpoint checks if the authenticating email exists in the `userEmails` table. If so, access is granted.
2. **Invite/link flow** — invite and account linking paths use a separate CF Access application with an "Allow Everyone" policy. Any authenticated user can reach these endpoints. The app-level `jwtOnlyMiddleware` validates the actual invite/link token before creating a user. After completing the flow, the user must re-authenticate through the main application (where the eval now recognizes them).
3. **Unknown users** — blocked by External Evaluation (`success: false`). CF Access denies access.

### Cloudflare Access configuration

Three CF Access applications are required:

| Application | Path(s) | Policy | Purpose |
|---|---|---|---|
| Trips - Eval | `trips.prenticew.com/api/eval/*` | **Bypass** | Allows CF Access to call the eval endpoints without triggering another eval |
| Trips - Invites & Linking | `trips.prenticew.com/api/auth/invite/*`, `trips.prenticew.com/api/auth/link*` | **Allow — Everyone** | Lets unknown users authenticate to accept invites or link accounts |
| Trips | `trips.prenticew.com` | **Allow — External Evaluation** | Blocks unknown users at the CF Access layer |

The External Evaluation rule on the "Trips" application should be configured with:

- **Evaluate URL**: `https://trips.prenticew.com/api/eval/evaluate`
- **Keys URL**: `https://trips.prenticew.com/api/eval/keys`

For the [MCP server](#mcp-server), the "Trips" application also needs a **Service Auth** policy that includes the MCP client's service token, next to the External Evaluation policy. `/api/mcp` must not match the Eval or Invites & Linking applications. With the paths above, it doesn't.

Stage 2 adds a fourth application of a different kind: an **Access for SaaS (OIDC)** application that the Worker uses as its sign-in provider. It carries the same External Evaluation rule as "Trips", so unknown users are blocked at Access as well as in the Worker's callback. The MCP hostname itself must **not** be covered by any self-hosted Access application, because the Worker's OAuth layer is the gate there. See [MCP hostname (Stage 2)](#mcp-hostname-stage-2).

The `jwtOnlyMiddleware` accepts JWTs from both the main application and the invite/link application (configured via `CF_ACCESS_AUDIENCE` and `CF_ACCESS_INVITE_AUDIENCE`).

### MCP hostname (Stage 2)

These steps turn on Stage 2 of the [MCP server](#mcp-server). Nothing is created by the deploy itself. The full operator list, including the static client for Gemini Spark and rollback, is in [`specs/MCP_OPERATOR_CHECKLIST.md`](specs/MCP_OPERATOR_CHECKLIST.md).

> **Do steps 1 and 2 before the next push to `main` that touches `api/`.** The deploy workflow now injects the `OAUTH_KV` namespace id and fails with `Repository secret CLOUDFLARE_KV_OAUTH_ID is not set` until it exists. This blocks every API deploy, not only Stage 2.

1. **KV namespace.** Create it and note the id:

   ```bash
   cd api
   npx wrangler kv namespace create OAUTH_KV
   ```

2. **GitHub secret `CLOUDFLARE_KV_OAUTH_ID`** set to that id.
3. **DNS: nothing to add.** The deploy attaches `<mcp-host>` to the Worker as a Workers Custom Domain, and Cloudflare creates the DNS record and certificate. The hostname must be in a zone on this account and must **not** already have a DNS record; delete any existing one first, or the deploy fails.
4. **Access for SaaS OIDC application.** Zero Trust → Access → Applications → Add → SaaS → OIDC:
   - Redirect URL: `https://<mcp-host>/callback`.
   - Scopes `openid email`; turn PKCE on if offered (the Worker sends `S256` and the client secret).
   - Policy: the same **External Evaluation** rule as the "Trips" application.
   - Note its client ID, client secret, authorization endpoint, token endpoint, JWKS endpoint and issuer.
5. **Verify that no Access application matches `<mcp-host>`.** Check every self-hosted application, wildcards included. `/mcp`, `/authorize`, `/oauth/*`, `/callback` and `/.well-known/*` must reach the Worker without an Access challenge. Also make sure Bot Fight Mode, managed challenges and WAF rules don't challenge them: Claude and Gemini can't solve challenges.
6. **Custom Domain.** Don't add it in the dashboard. Set the GitHub secret `MCP_HOST` (bare `<mcp-host>`), and the deploy workflow adds `{ pattern = "<mcp-host>", custom_domain = true }` to `routes`.
7. **Other GitHub secrets**, all required once `MCP_HOST` is set: `MCP_PUBLIC_URL` (exactly `https://<mcp-host>/mcp`, lowercase, no trailing slash), `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL` and `ACCESS_ISSUER` from step 4. The deploy checks their format first (see [Deployment](#deployment)).
8. **Worker secrets** (see [Worker secrets](#worker-secrets)): `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` from step 4.
9. **Deploy and verify.** Push to `main` (or re-run the workflow), then connect a client (see [Connecting (Stage 2: OAuth)](#connecting-stage-2-oauth)) and call `get_me`.

To turn Stage 2 off, delete the `MCP_HOST` GitHub secret and redeploy: the var becomes empty, no MCP route is added, and the Worker serves only the app.

### Worker secrets

The eval endpoint signs response JWTs with an RSA private key. Generate and store it:

```bash
# Generate RSA key pair (PKCS#8 format required by jose)
openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:4096

# Store as Worker secret
cd api
npx wrangler secret put EXTERNAL_EVAL_PRIVATE_KEY < private.pem
```

Stage 2 of the MCP server also needs the Access for SaaS application's credentials. Each command prompts for the value:

```bash
cd api
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
```

### Environment variables

Configured in `wrangler.toml` under `[vars]`:

| Variable | Description |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain (e.g., `yourteam.cloudflareaccess.com`) |
| `CF_ACCESS_AUDIENCE` | AUD tag from the main "Trips" CF Access application |
| `CF_ACCESS_INVITE_AUDIENCE` | AUD tag from the "Trips - Invites & Linking" CF Access application |
| `BOOTSTRAP_ADMIN_EMAIL` | Email that gets admin role on first login |
| `EXTERNAL_EVAL_KEY_ID` | Key ID for the eval JWKS (default: `eval-key-1`) |
| `MCP_HOST` | Stage 2. Bare MCP hostname (`<mcp-host>`, no scheme, port or path). Empty turns Stage 2 off |
| `MCP_PUBLIC_URL` | Stage 2. Public MCP endpoint, `https://<mcp-host>/mcp`, used as the OAuth resource identifier. Must equal the URL entered in clients exactly |
| `ACCESS_AUTHORIZATION_URL` | Stage 2. Authorization endpoint of the Access for SaaS OIDC application |
| `ACCESS_TOKEN_URL` | Stage 2. Token endpoint of the Access for SaaS OIDC application |
| `ACCESS_JWKS_URL` | Stage 2. JWKS endpoint of the Access for SaaS OIDC application |
| `ACCESS_ISSUER` | Stage 2. Expected `iss` of the Access for SaaS ID token |

The Stage 2 vars are committed as empty strings. The deploy workflow overrides them with `wrangler deploy --var NAME:value` from GitHub secrets of the same name.

Secrets (set via `wrangler secret put`):

| Secret | Description |
|---|---|
| `EXTERNAL_EVAL_PRIVATE_KEY` | RSA private key (PEM) for signing eval response JWTs |
| `ACCESS_CLIENT_ID` | Stage 2. Client ID of the Access for SaaS OIDC application |
| `ACCESS_CLIENT_SECRET` | Stage 2. Client secret of the Access for SaaS OIDC application |

Bindings (declared in `wrangler.toml`):

| Binding | Type | Description |
|---|---|---|
| `DB` | D1 database | `trips-db`. The database id is injected at deploy time |
| `EVAL_RATE_LIMITER` | Rate limit (namespace `1001`) | 30 requests per 60 s per IP on the External Evaluation endpoints |
| `MCP_RATE_LIMITER` | Rate limit (namespace `1002`) | 120 requests per 60 s per user on `/api/mcp` and the Stage 2 `/mcp` |
| `OAUTH_KV` | KV namespace | OAuth provider storage: clients, grants, hashed tokens, consent and sign-in state. The namespace id is injected at deploy time |
| `OAUTH_RATE_LIMITER` | Rate limit (namespace `1003`) | 30 requests per 60 s per IP on `/authorize`, `/callback`, `/oauth/token` and `/oauth/register` on the MCP hostname |

`wrangler.toml` also sets the compatibility flag `global_fetch_strictly_public`. The OAuth library needs it to accept clients identified by a metadata document URL. With it, every outbound `fetch()` from the Worker goes to the public Internet, even for hostnames on the Worker's own zone.

Local only (set in `api/.dev.vars`, never in production):

| Variable | Description |
|---|---|
| `DEV_MODE` | When set, skips Cloudflare Access checks and identifies the user from the `X-Dev-User-Email` header. Used by the REST API and `/api/mcp` |

## Deployment

Deployment is automated via GitHub Actions on push to `main`:

- **API** (`.github/workflows/deploy-api.yml`) — triggers on changes to `api/`, deploys to Cloudflare Workers
- **Web** (`.github/workflows/deploy-web.yml`) — triggers on changes to `web/`, deploys to Cloudflare Pages

GitHub Actions secrets required:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers and D1 permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database ID (injected into `wrangler.toml` at deploy time) |
| `BOOTSTRAP_ADMIN_EMAIL` | Passed as a var override during API deploy |
| `CLOUDFLARE_KV_OAUTH_ID` | `OAUTH_KV` namespace ID (injected into `wrangler.toml` at deploy time). **Required**: the API deploy fails without it |
| `MCP_HOST` | MCP Stage 2. Bare `<mcp-host>`. When set, the workflow attaches it as a Workers Custom Domain and passes it as a var. Leave unset to keep Stage 2 off |
| `MCP_PUBLIC_URL` | MCP Stage 2. Passed as a var |
| `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER` | MCP Stage 2. Passed as vars |

Stage 2 is all or nothing: when `MCP_HOST` is set, the workflow fails unless `MCP_PUBLIC_URL` and the four `ACCESS_*` secrets are set too. `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` are Worker secrets, not GitHub secrets (see [Worker secrets](#worker-secrets)).

The workflow's first step after `npm ci`, **Validate Deploy Secrets**, checks the format of every secret before anything edits `wrangler.toml`. Errors name the secret, never its value:

| Secret | Rule |
|---|---|
| `CLOUDFLARE_D1_DATABASE_ID` | Required. A UUID |
| `CLOUDFLARE_KV_OAUTH_ID` | Required. 32 lowercase hex characters |
| `MCP_HOST` | Bare hostname: after lowercasing, only `a-z`, `0-9`, `.` and `-` |
| `MCP_PUBLIC_URL` | Exactly `https://<MCP_HOST in lowercase>/mcp`. Must be empty when `MCP_HOST` is empty |
| `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER` | When set, start with `https://` and contain no whitespace, quotes or backslashes |

`MCP_HOST` is lowercased for both the route and the `MCP_HOST` var, so the secret may be in any case. Migrations run through `cloudflare/wrangler-action`. The deploy itself runs `npx wrangler deploy` directly, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment and each value passed as a quoted `--var`.

Manual deploy:

```bash
cd api
npm run deploy
```

A manual deploy uses `wrangler.toml` as committed, so replace `PROD_DB_ID_PLACEHOLDER` and `OAUTH_KV_ID_PLACEHOLDER` first. If Stage 2 is on, also replace the `# MCP_ROUTE_PLACEHOLDER` line with `{ pattern = "<mcp-host>", custom_domain = true },` and pass the Stage 2 vars with `--var`, as the workflow does.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Tailwind CSS 4, Lucide icons, Vite |
| Backend | Hono, Zod + OpenAPI, Drizzle ORM |
| Database | Cloudflare D1 (SQLite) |
| Auth | JWT, Google OAuth, Cloudflare Access |
| Deployment | Cloudflare Workers |

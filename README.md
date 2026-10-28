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

Two REST behaviors changed on purpose when trip, itinerary and expense logic moved into a shared service layer (`api/src/services/`). All other responses are unchanged.

**Non-members get 404 from itinerary reads.** Before, a signed-in user who was not a participant of a trip could read that trip's itineraries if they knew the trip id. They got `200` with the viewer projection. Now a non-admin who is not a participant gets `404`:

| Endpoint | Before | Now |
|---|---|---|
| `GET /trips/:tripId/itineraries` | `200` with viewer-projected items | `404` `{"error":"Trip not found"}` |
| `GET /trips/:tripId/itineraries/:itineraryId` | `200` with the viewer-projected item | `404` `{"error":"Not found"}`, the same response as for an itinerary that does not exist |

This also applies when a non-admin requests a trip id that does not exist. The list endpoint returned `200 []` before and now returns `404` `{"error":"Trip not found"}`. Participants are unaffected and still get the projection for their role. Admins are also unaffected: they get the full projection on every trip, and the list endpoint still returns `200 []` for a trip id that does not exist.

**Creating a trip adds the creator as Owner.** `POST /trips` now inserts a `participants` row for the creator (`userId`, `email`, `name`, role `Owner`, not traveling) in the same batch as the trip, so both rows are written or neither is. This applies to admins too. The `201` response body is the same trip object as before. As a result, a non-admin creator can now see, edit and delete the trip they created, and the trip shows up in their trip list. Before, they were not a participant and could not read it back. Global viewers still get `403` and nothing is written.

## MCP server

The API also serves a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents can read and edit trips through tools instead of raw REST calls. The tools call the same service layer as the REST routes (`api/src/services/`), so they enforce the same trip roles and the same Viewer projection.

- **Endpoint:** `/api/mcp` on the app host, served by the existing `/api/*` Worker route.
- **Transport:** Streamable HTTP, stateless. Each request builds a fresh server, and the user is reloaded from D1 on every request, so a role change applies to the next call.
- **Auth (Stage 1):** the same `authMiddleware` as the REST API, so the endpoint sits behind Cloudflare Access. Requests that don't resolve to an existing user get `401` before any MCP handling.

Stage 1 is meant for clients that can send custom HTTP headers, such as Claude Code, the MCP Inspector, curl and local scripts. Hosted connectors such as claude.ai and Gemini Spark can't send custom headers. They need Stage 2 (OAuth on a dedicated MCP hostname), which hasn't been built yet.

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

**Scopes.** Each tool checks its scope before it runs. Stage 1 grants every caller both `trips:read` and `trips:write`, so in Stage 1 only the trip role limits what a caller can do.

**Roles.** "Editor" in the table means Editor or Owner. Admins are treated as Owner on every trip. A trip you don't belong to looks the same as a trip that doesn't exist: the tool returns `Trip not found`.

**Viewer projection.** A caller with the Viewer role on a trip gets itineraries with confirmation numbers and traveler ticket numbers removed. That applies in `get_trip` and `search_itineraries`. A search across several trips projects each item for your role on that item's trip. Seat assignments are still visible to Viewers. Editors and Owners see every field.

**Errors.** Tool failures come back as MCP tool errors (`isError: true`) with a short message, for example a missing scope, `Trip not found`, `Forbidden`, or a validation error listing the invalid fields. Any unexpected error comes back as `Internal error`, and the details are logged on the server only.

### Rate limit

`/api/mcp` is limited to 120 requests per 60 seconds per user, through the `MCP_RATE_LIMITER` binding in `api/wrangler.toml`. The limit is keyed on the resolved Trips user id, not the IP address. It counts every HTTP request to the endpoint, not only tool calls. Over the limit, the endpoint answers `429` `{"error":"Too many requests"}`. If the binding is missing, no limit is applied.

### Audit log

Every tool call writes one line to the Worker logs (Workers observability is enabled in `wrangler.toml`):

```
[mcp] tool=<name> user=<user id> trip=<trip id or -> scopes=<comma-separated scopes> ok=<true|false> err=<code or -> ms=<duration>
```

`trip` comes from the call's `tripId` argument, or is `-` when there isn't one. `err` is `-` on success. On failure it is `scope`, a service error code (such as `not_found`, `forbidden` or `validation`), or `internal`. Unexpected errors also log a second `[mcp] tool=<name> internal error: ...` line. Tool log lines don't include credentials or the `X-Dev-User-Email` value.

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

The `jwtOnlyMiddleware` accepts JWTs from both the main application and the invite/link application (configured via `CF_ACCESS_AUDIENCE` and `CF_ACCESS_INVITE_AUDIENCE`).

### Worker secrets

The eval endpoint signs response JWTs with an RSA private key. Generate and store it:

```bash
# Generate RSA key pair (PKCS#8 format required by jose)
openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:4096

# Store as Worker secret
cd api
npx wrangler secret put EXTERNAL_EVAL_PRIVATE_KEY < private.pem
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

Secrets (set via `wrangler secret put`):

| Secret | Description |
|---|---|
| `EXTERNAL_EVAL_PRIVATE_KEY` | RSA private key (PEM) for signing eval response JWTs |

Bindings (declared in `wrangler.toml`):

| Binding | Type | Description |
|---|---|---|
| `DB` | D1 database | `trips-db`. The database id is injected at deploy time |
| `EVAL_RATE_LIMITER` | Rate limit (namespace `1001`) | 30 requests per 60 s per IP on the External Evaluation endpoints |
| `MCP_RATE_LIMITER` | Rate limit (namespace `1002`) | 120 requests per 60 s per user on `/api/mcp` |

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

Manual deploy:

```bash
cd api
npm run deploy
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Tailwind CSS 4, Lucide icons, Vite |
| Backend | Hono, Zod + OpenAPI, Drizzle ORM |
| Database | Cloudflare D1 (SQLite) |
| Auth | JWT, Google OAuth, Cloudflare Access |
| Deployment | Cloudflare Workers |

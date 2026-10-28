# Technical Design Document: Trips MCP Server

Companion to `specs/MCP_PRD.md`. The PRD states what is required. This document states how it will be built.

## 1. Summary

The MCP server is added to the existing Hono Worker in `api/`. It uses the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) in stateless Streamable HTTP mode, and `@cloudflare/workers-oauth-provider` as the OAuth 2.1 authorization server in Stage 2. Business logic moves out of the route handlers into a service layer that both REST and MCP call. Identity resolution and trip-role checks are shared, so the MCP surface can never be more permissive than the REST surface.

Library facts below were checked against current documentation on 2026-10-27. Items marked **verify** could not be confirmed from documentation and must be checked against the installed package before relying on them.

## 2. Dependencies

| Package | Version seen | Purpose | Notes |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.4.x | `McpServer`, `registerTool`, `createMcpHandler` | Web-standard `{ fetch }` handler. Tool schemas accept Zod v4 (`zod/v4`). The project already has `zod` 4.3.x. |
| `@cloudflare/workers-oauth-provider` | 1.2.x | OAuth 2.1 authorization server, token storage, discovery metadata, consent helpers | Needs a KV binding named `OAUTH_KV`. Needs the `global_fetch_strictly_public` compatibility flag only if CIMD is enabled. |
| `jose` | already present | Verify the upstream ID token in the OAuth callback | Reuses the existing JWKS cache pattern from `api/src/middleware/auth.ts`. |

The Cloudflare `agents` package is not used. Its `createMcpHandler` is a thin wrapper over the SDK's, and it pulls a large peer dependency set that this project does not need.

**verify:** whether `@modelcontextprotocol/server` runs on Workers without the `nodejs_compat` compatibility flag. The web-standard handler is documented as working on Workers, but the flag may still be needed for transitive imports. Check during the first local build.

## 3. Module Layout

```
api/src/
  index.ts                 Worker export: host-based dispatch (section 5)
  services/
    errors.ts              ServiceError and error codes
    access.ts              requireTripRole, role ranking
    trips.ts               listTrips, getTrip, createTrip
    itineraries.ts         listItineraries, getItinerary, createItinerary, updateItinerary,
                           normalizeFlightContent, toViewerProjection (moved from routes)
    expenses.ts            listExpenses, createExpense
  mcp/
    server.ts              buildTripsServer(ctx): McpServer with all tools
    tools/
      trips.ts             get_me, list_trips, get_trip, create_trip
      itineraries.ts       search_itineraries, create_itinerary, update_itinerary
      expenses.ts          list_expenses, add_expense
    context.ts             McpRequestContext type, scope helpers
    handler.ts             createTripsMcpHandler(env, ctx): wires authInfo to the SDK handler
    stage1.ts              Hono route: /mcp behind authMiddleware (main hostname)
  oauth/
    provider.ts            buildOAuthProvider(env): OAuthProvider instance (memoized)
    authorize.ts           GET/POST /authorize: consent page
    upstream.ts            beginUpstream redirect, /callback handler, ID token verification
    consent-page.ts        HTML renderer
    grants.ts              listGrantsForUser, revokeGrant wrappers
  routes/
    trips.ts, itineraries.ts, expenses.ts   now thin: validate, call service, map errors
    admin.ts               adds grant list/revoke endpoints
    me.ts (or auth.ts)     adds self-service grant endpoints
```

## 4. Service Layer

### 4.1 Errors

```ts
// services/errors.ts
export type ServiceErrorCode = "not_found" | "forbidden" | "validation" | "conflict";
export class ServiceError extends Error {
  constructor(public code: ServiceErrorCode, message: string, public details?: unknown) { super(message); }
}
```

REST maps codes to 404, 403, 400, 409. MCP maps every code to a tool result with `isError: true` and the message as text. Neither surface exposes `details` beyond what the current REST handlers already return for validation.

### 4.2 Access checks

```ts
// services/access.ts
export type TripRole = "Owner" | "Editor" | "Viewer";
const RANK: Record<TripRole, number> = { Viewer: 0, Editor: 1, Owner: 2 };

export async function requireTripRole(db, user: AuthUser, tripId: string, min: TripRole): Promise<TripRole> {
  // admins are Owner everywhere (existing getTripRole behavior)
  // non-members get not_found, never a Viewer role
  // members below `min` get forbidden
}
```

**Behavior change from today.** `getTripRole` in `api/src/middleware/tripRole.ts` returns `Viewer` for a user who is not a participant, and the itinerary list and get handlers in `api/src/routes/itineraries.ts` do not check membership. A non-member who knows a trip id can read that trip's itineraries (viewer-projected). The trips and expenses handlers do check membership. `requireTripRole` returns `not_found` for non-members, and once the itinerary routes call the service layer, the REST API inherits the fix. This is a deliberate tightening and is called out in the rollout.

### 4.3 Service functions

Each function takes `db` and the acting `AuthUser` first. Signatures:

```ts
listTrips(db, user): Promise<Array<Trip & { role: TripRole }>>
getTrip(db, user, tripId): Promise<{ trip: Trip; role: TripRole; participants: ParticipantSummary[] }>
createTrip(db, user, input: CreateTrip): Promise<Trip>          // global viewers: forbidden (matches requireTripEditor)
                                                                // inserts an Owner participant row for the creator (see below)

listItineraries(db, user, tripId): Promise<Itinerary[] | ItineraryView[]>   // projection chosen by role
getItinerary(db, user, tripId, itineraryId)
createItinerary(db, user, tripId, input: CreateItinerary)        // requires Editor
updateItinerary(db, user, tripId, itineraryId, patch: UpdateItinerary)  // requires Editor
searchItineraries(db, user, filter: { tripId?, types?, from?, to?, text? })  // across member trips only

listExpenses(db, user, tripId)                                   // left-joins participants for payer name
createExpense(db, user, tripId, input: CreateExpense)            // requires Editor
```

**Owner on create.** Today neither the REST create-trip handler nor the web app inserts a participant row for the creator, which works because admins are treated as Owner of every trip. The PRD requires `create_trip` to make the caller the trip's Owner. `createTrip` therefore inserts a `participants` row with the creator's `userId`, `email`, `name` and role `Owner` in the same request as the trip insert. Without this, a non-admin creator would be a non-member of the trip they just created and, under the access rule in 4.2, could not read it back. This applies to REST as well once the route calls the service.

`normalizeFlightContent`, `validateContent` and `toViewerResponse` move from `routes/itineraries.ts` into `services/itineraries.ts` unchanged. `searchItineraries` is new. It joins `itineraries` to `participants` on `trip_id` and `user_id` (or skips the join for admins), filters on `type` and on the itinerary's stored date columns where present, and applies a case-insensitive `LIKE` on `content` and `notes`. Results are projected per trip role, so a user who is Viewer on one trip and Editor on another gets the right projection row by row.

### 4.4 Route refactor

Each route handler becomes: parse params and body with the existing Zod schemas, call the service, return the result, and map `ServiceError` to a status with one shared `onError` hook on the `OpenAPIHono` app. OpenAPI output must not change. The existing `security_review.md` findings are out of scope for this refactor.

## 5. Request Dispatch

The Worker export in `api/src/index.ts` becomes a host-based dispatcher.

```ts
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (env.MCP_HOST && url.hostname === env.MCP_HOST) {
      if (OAUTH_PATHS.has(url.pathname)) {                     // /authorize, /oauth/token, /oauth/register
        const limited = await rateLimit(env.OAUTH_RATE_LIMITER, request.headers.get("cf-connecting-ip") ?? "unknown");
        if (limited) return new Response("Too many requests", { status: 429 });
      }
      return getOAuthProvider(env).fetch(request, env, ctx);   // Stage 2
    }
    // existing behavior: strip /api prefix, then app.fetch
  },
};
```

The per-IP limit on the OAuth endpoints runs in the dispatcher because the library handles the token and registration endpoints internally, before `defaultHandler` is reached. The MCP endpoint is limited per user inside `apiHandler` (section 5.2) instead, since the user is only known after token validation.

`getOAuthProvider(env)` constructs the `OAuthProvider` once per isolate and memoizes it. It is constructed lazily because `resourceMetadata.resource` and the issuer come from `env`, which is not available at module scope without the `cloudflare:workers` env import.

### 5.1 Stage 1 route (main hostname)

```ts
// mcp/stage1.ts
app.all("/mcp", authMiddleware, perUserRateLimit, async (c) => {
  const user = c.get("user");
  const authInfo = {
    token: "",                       // not an OAuth token; never logged
    clientId: "cf-access",
    scopes: ["trips:read", "trips:write"],
    extra: { userId: user.id },
  };
  return createTripsMcpHandler(c.env, c.executionCtx).fetch(c.req.raw, { authInfo });
});
```

A Cloudflare Access service token resolves to a user through `service_identities` exactly as it does for REST today. Scopes are fixed to read and write because Access service tokens have no scope concept. Role checks still apply.

### 5.2 Stage 2 API handler (MCP hostname)

`OAuthProvider` routes requests under `apiRoute: "/mcp"` to `apiHandler` after validating the bearer token. The handler receives `ctx.props` (stored at `completeAuthorization`) and `ctx.auth` (the verified token, with `scope: string[]`). Unauthenticated requests get a `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` from the library, which satisfies Claude's discovery requirement.

```ts
// oauth/provider.ts
apiHandler: {
  async fetch(request, env, ctx) {
    const { userId } = ctx.props as { userId: string };
    const limited = await rateLimit(env.MCP_RATE_LIMITER, userId);
    if (limited) return new Response("Too many requests", { status: 429 });
    const authInfo = { token: "", clientId: ctx.auth.clientId, scopes: ctx.auth.scope, extra: { userId } };
    return createTripsMcpHandler(env, ctx).fetch(request, { authInfo });
  },
}
```

## 6. MCP Server

### 6.1 Handler construction

```ts
// mcp/handler.ts
import { createMcpHandler } from "@modelcontextprotocol/server";

export function createTripsMcpHandler(env: Bindings, ctx: ExecutionContext) {
  return createMcpHandler((reqCtx) => buildTripsServer({ env, ctx, authInfo: reqCtx.authInfo }));
}
```

The factory runs once per request and returns a fresh `McpServer`. Nothing is held between requests, so no Durable Object and no MCP session id. `authInfo` is passed by the caller; the SDK never reads it from headers.

### 6.2 Per-request context

```ts
// mcp/context.ts
export interface McpRequestContext {
  db: Db;
  user: AuthUser;            // reloaded from D1 by authInfo.extra.userId on every request
  scopes: string[];
  log: (event: string, fields: Record<string, unknown>) => void;
}
```

`buildTripsServer` loads the user with one `users` query before registering tools. If the user no longer exists, the factory throws and the SDK returns a JSON-RPC error. Tools therefore always see the current global role.

### 6.3 Tool registration

Tools use `registerTool` with `z.object` input schemas derived from the existing schemas in `api/src/schemas/`, an `outputSchema` where the result is structured, and annotations so clients can auto-approve read-only tools.

```ts
server.registerTool(
  "create_itinerary",
  {
    title: "Create itinerary item",
    description: "Add a flight, lodging, rail, car, restaurant, transport or activity item to a trip. "
      + "Requires edit access to the trip. Content must match the item type.",
    inputSchema: z.object({ tripId: z.string().uuid() }).extend(CreateItinerarySchema.shape),
    outputSchema: ItinerarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (args, ctx) => {
    const rc = requestContext(ctx);            // from ctx.http.authInfo
    requireScope(rc, "trips:write");
    const row = await createItinerary(rc.db, rc.user, args.tripId, args);
    rc.log("tool", { tool: "create_itinerary", tripId: args.tripId, ok: true });
    return { content: [{ type: "text", text: JSON.stringify(row) }], structuredContent: row };
  },
);
```

A `withTool` wrapper applies to every tool: it catches `ServiceError` and scope errors and returns `{ isError: true, content: [{ type: "text", text: message }] }`, logs the outcome, and rethrows anything else so the SDK reports an internal error without the stack.

The `.openapi()` metadata on the existing Zod schemas is harmless for MCP, and the `content: z.record(...)` field stays loose because the type-specific validation happens in `validateContent` inside the service.

### 6.4 Tool table

| Tool | Scope | Service call | readOnlyHint |
|---|---|---|---|
| `get_me` | read | none, returns `rc.user` | true |
| `list_trips` | read | `listTrips` | true |
| `get_trip` | read | `getTrip` + `listItineraries`, grouped by local date | true |
| `search_itineraries` | read | `searchItineraries` | true |
| `list_expenses` | read | `listExpenses` | true |
| `create_trip` | write | `createTrip` | false |
| `create_itinerary` | write | `createItinerary` | false |
| `update_itinerary` | write | `updateItinerary` | false |
| `add_expense` | write | `createExpense` | false |

`get_trip` grouping: for each itinerary, derive the grouping date from the type's primary time field (flight first-leg departure, lodging check-in, restaurant reservation time, and so on) in its stored timezone when present. This mirrors the timeline logic in the web app; the mapping lives in the service so both stay aligned.

## 7. OAuth Authorization Server (Stage 2)

### 7.1 Provider configuration

```ts
new OAuthProvider<Bindings>({
  apiRoute: "/mcp",
  apiHandler,                                  // section 5.2
  defaultHandler,                              // Hono app: /authorize, /callback, static assets
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["trips:read", "trips:write", "offline_access"],
  requiredScopes: ["trips:read"],
  resourceMetadata: {
    resource: env.MCP_PUBLIC_URL,             // must equal the URL users enter in Claude or Gemini, exactly
    authorization_servers: [new URL(env.MCP_PUBLIC_URL).origin],
    resource_name: "Trips",
  },
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30,
  clientIdMetadataDocumentEnabled: true,       // lets Claude Code use CIMD; DCR stays on
  clientRegistrationCallback,                  // section 7.4
  onError,                                     // log code and description, never the token
})
```

Library behavior relied on, as documented: PKCE S256 is mandatory for public clients; refresh tokens rotate on use with the previous token valid until the new one is first used; tokens are stored hashed; props are encrypted so KV never holds them in the clear; redirect URI matching is exact with RFC 8252 loopback port handling; authorization server metadata and protected resource metadata are served from `/.well-known/` on the MCP hostname.

**verify:** that the library's loopback matching accepts Claude Code's and Gemini CLI's DCR-registered `http://localhost:<port>/callback` across sessions where the port changes. If not, document `callbackPort` in the setup instructions.

### 7.2 Authorize flow

Order follows the library's documented sequence: parse, consent, upstream, callback, complete.

```
GET  /authorize   parseAuthRequest → describeConsent → beginConsent → render consent page
POST /authorize   decision=deny    → denyConsent → 302 to client with access_denied
                  decision=approve → approveConsent(scope) → beginUpstream(data: { verifier })
                                   → 302 to upstream authorization URL (state, S256 challenge)
GET  /callback    finishUpstream → exchange code at upstream token URL with client secret + verifier
                                   → verify id_token (jose, JWKS, issuer, audience = client id)
                                   → email → findUserByEmail → unknown: error page, no user created
                                   → completeAuthorization({ request, userId, scope, props: { userId } })
                                   → 302 to redirectTo with cleared headers
```

Consent is always shown in v1. `isConsentRemembered` is not used, because the user is not known until after the upstream sign-in, and remembering consent would require a session cookie that this design avoids.

The consent page uses the library's `ConsentDescription` fields: `clientName`, `clientDomain` (absent for self-registered clients, which the page says), `redirectHost`, `redirectIsLoopback` (shows the local-app warning), and the requested `scope` list as checkboxes with plain-language labels. Scopes default to `trips:read` and `offline_access` so unattended background agents (Gemini Spark) receive refresh tokens. `beginConsent` headers (anti-framing, handle binding) are returned with the page. The `handle` is single-use, ten-minute, and browser-bound, which covers CSRF.

### 7.3 Upstream identity provider

The upstream is a Cloudflare Access for SaaS OIDC application, so the identity source is the same one the web app uses. Configuration comes from `env`: `ACCESS_AUTHORIZATION_URL`, `ACCESS_TOKEN_URL`, `ACCESS_JWKS_URL`, `ACCESS_ISSUER`, and secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`. The Worker is a confidential client to Access and additionally sends PKCE. The ID token is verified with `jwtVerify` against a cached `createRemoteJWKSet`, with `issuer` and `audience` pinned. Only the `email` claim is used.

The Access for SaaS app carries the same External Evaluation rule as the main application, so unknown emails are rejected before they reach the callback. The callback rejects them again.

### 7.4 Client registration policy

`clientRegistrationCallback` validates redirect URIs during DCR. It accepts:
- Hosted Claude callback URL: `https://claude.ai/api/mcp/auth_callback`
- Google Gemini Spark callback URLs: `https://vertexaisearch.cloud.google.com/oauth-redirect` and `https://oauth-redirect.googleusercontent.com/*`
- Loopback `http` URIs (`http://localhost:<port>/...` or `http://127.0.0.1:<port>/...`)

Registrations with any other redirect target are rejected. `disallowPublicClientRegistration` stays off, because Claude and Gemini can register as public clients.

Additionally, for platforms where DCR is unsupported or where static credentials are required, pre-registered static clients can be seeded directly into `OAUTH_KV` via an admin script or endpoint.

### 7.5 Grants

Admin and self-service grant endpoints call the helper API from outside the provider's fetch path. The documented entry point is `getOAuthApi(env)`.

**verify:** the exact helper names for listing and revoking a user's grants in 1.2.x. The 1.x docs describe both operations but the current page does not name the methods.

Endpoints, all on the main hostname under the existing `authMiddleware`:

| Route | Guard | Behavior |
|---|---|---|
| `GET /admin/grants` | `requireAdmin` | All grants: user, client name, scopes, created time, grant id. |
| `DELETE /admin/grants/{grantId}` | `requireAdmin` | Revoke any grant. |
| `GET /auth/me/grants` | signed-in user | The caller's grants. |
| `DELETE /auth/me/grants/{grantId}` | signed-in user | Revoke one of the caller's grants; a grant id belonging to another user returns 404. |

The main-hostname Worker reaches the helper API through `getOAuthApi(env)` with the same `OAUTH_KV` binding, so no cross-hostname call is needed. Revocation deletes the grant and its tokens from KV, so the next bearer call fails validation and gets a `401`.

Web UI: the admin page gains a "Connected apps" table with a revoke action per row. The profile page gains the same table scoped to the signed-in user. Both read from the endpoints above through `web/src/lib/api.ts`.

## 8. Configuration

### 8.1 `wrangler.toml` additions

```toml
routes = [
  { pattern = "<app-host>/api/*", zone_name = "<zone>" },
  { pattern = "<mcp-host>/*",      zone_name = "<zone>" },
]

compatibility_flags = ["global_fetch_strictly_public"]   # required when CIMD is enabled

[vars]
MCP_HOST = "<mcp-host>"
MCP_PUBLIC_URL = "https://<mcp-host>/mcp"
ACCESS_AUTHORIZATION_URL = "..."
ACCESS_TOKEN_URL = "..."
ACCESS_JWKS_URL = "..."
ACCESS_ISSUER = "..."

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "OAUTH_KV_ID_PLACEHOLDER"

[[unsafe.bindings]]
name = "MCP_RATE_LIMITER"            # per user, keyed on userId
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 120, period = 60 }

[[unsafe.bindings]]
name = "OAUTH_RATE_LIMITER"          # per IP, on /authorize, /oauth/token, /oauth/register
type = "ratelimit"
namespace_id = "1003"
simple = { limit = 30, period = 60 }
```

Hostnames are deployment configuration and are not written into this document or the source. `MCP_HOST` and `MCP_PUBLIC_URL` are the only places the hostname appears, and the deploy workflow may inject them.

This adds two vars the PRD does not list: `MCP_HOST` (dispatch key) and `ACCESS_ISSUER` (ID token issuer check). The PRD's `COOKIE_ENCRYPTION_KEY` is not needed by this design (section 8.2).

### 8.2 Secrets

`ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`. The library's consent handle and upstream state are KV-backed and need no cookie secret in this design. If consent remembering is added later, a `CONSENT_SECRET` of at least 32 characters is required.

### 8.3 `Env` type

`api/src/db/index.ts` `Bindings` gains: `OAUTH_KV: KVNamespace`, `OAUTH_PROVIDER?: OAuthHelpers`, `MCP_RATE_LIMITER?: RateLimiter`, `OAUTH_RATE_LIMITER?: RateLimiter`, `MCP_HOST?`, `MCP_PUBLIC_URL?`, the Access URLs and issuer, and the two secrets.

### 8.4 Deploy workflow

`.github/workflows/deploy-api.yml` gains a step that replaces `OAUTH_KV_ID_PLACEHOLDER` from a new repository secret, mirroring the D1 injection.

### 8.5 Local development

`wrangler dev` serves both hostnames through a single local origin. For Stage 1 tools, `DEV_MODE` plus `X-Dev-User-Email` is enough. For Stage 2, add a `.dev.vars.local` entry pointing the Access URLs at a dev Access for SaaS app, and use the `resource` value of the local origin. The MCP Inspector and `claude mcp add --transport http` both work against the local origin.

## 9. Security Design

- **Single authorization path.** Every tool calls a service function that performs its own `requireTripRole`. There is no tool-level shortcut that reads tables directly.
- **Fresh identity.** Token props hold only `userId`. The user row is reloaded on every request.
- **Scope then role.** Write tools check `trips:write` first, then the service checks the trip role. Both failures are reported as tool errors, never as data.
- **Projection by role.** Viewer projection happens in the service, not in the tool, so `search_itineraries` cannot leak a sensitive field from a trip where the user is a Viewer.
- **No tokens in logs.** `authInfo.token` is left empty on purpose in both stages. `onError` logs `code` and `description` only.
- **Host checks.** The dispatcher routes on hostname. Requests to `/mcp` on the main hostname go only through `authMiddleware`. Requests to `/mcp` on the MCP hostname go only through the OAuth provider. There is no path that reaches the MCP handler without one of the two.
- **Registration policy.** DCR is limited to Claude, Google Gemini Spark, and loopback redirect targets (section 7.4).
- **Rate limits.** Per-user on `/mcp` (section 5.2). Per-IP on `/authorize`, `/oauth/token`, `/oauth/register` in the dispatcher (section 5).
- **Bearer header only.** The library validates the `Authorization: Bearer` header. The `apiHandler` additionally rejects any request whose query string contains `token`, `access_token` or `apiKey` with a `400`, so a token in a URL never reaches a log line. **verify:** that the library itself never reads a token from the query string.
- **No upstream calls on OAuth endpoints.** The token, registration and discovery endpoints are served by the library from KV only. The single upstream call in the whole flow is the code exchange with Access inside `/callback`, which is a browser redirect step and not subject to Claude's and Google's 10-second endpoint limits.
- **CORS.** The existing `cors` middleware is attached to the main-hostname Hono app only. The OAuth `defaultHandler` and `apiHandler` send no CORS headers, and the MCP origin is not added to the browser allow list.
- **Tightened read access.** Non-members get `not_found` from the itinerary services (section 4.2).

## 10. Observability

Structured `console.log` lines with a fixed prefix: `[mcp] tool=<name> user=<id> trip=<id|-> scopes=<a,b> ok=<bool> err=<code|-> ms=<n>` and `[oauth] event=<authorize|consent|upstream|token|register|error> client=<id> code=<code>`. Workers observability is already enabled in `wrangler.toml`.

## 11. Testing

The repository has no test runner today. Add `vitest` with `@cloudflare/vitest-pool-workers` to `api/` so tests run inside `workerd` with a local D1 and KV.

| Layer | Approach |
|---|---|
| Services | Unit tests against a migrated local D1: role ranking, non-member `not_found`, viewer projection, flight normalization, search filters. |
| MCP tools | Call `createTripsMcpHandler(env, ctx).fetch(request, { authInfo })` directly with JSON-RPC bodies, or use `@modelcontextprotocol/client` with a fetch transport. Assert scope errors, role errors, and projection. |
| REST parity | Existing route behavior snapshot: list and get responses before and after the refactor for the same seed data. |
| OAuth | Walk the flow in a test: register, authorize, approve, stub the upstream token endpoint, callback, exchange code, call `/mcp` with the access token, refresh, revoke. Assert PKCE rejection and redirect policy. |
| Manual | MCP Inspector locally. Claude Code via Stage 1 header and via Stage 2 sign-in. claude.ai and Gemini Spark custom app connectors end to end. |

## 12. Rollout

1. Service extraction with parity tests. Ship. Two REST behaviors change on purpose and must be announced: non-members get `404` from the itinerary list and get endpoints (section 4.2), and creating a trip now adds the creator as an Owner participant (section 4.3). Everything else is covered by parity tests.
2. Stage 1 endpoint, read tools, then write tools. Ship behind the existing Access gate.
3. Stage 2: KV namespace, provider, consent, upstream, grants. Ship on the MCP hostname. Stage 1 remains available.
4. Hardening and docs.

Rollback for each step is a redeploy of the previous commit. No migrations are required; the only new storage is KV, which is additive.

## 13. Open Items

- `nodejs_compat` requirement for `@modelcontextprotocol/server` on Workers (section 2).
- Loopback port matching across Claude Code sessions (section 7.1).
- Exact grant helper method names in `workers-oauth-provider` 1.2.x (section 7.5).
- `"type": "commonjs"` in `api/package.json`. Wrangler bundles ESM regardless, but if the SDK's conditional exports pick the CJS build and break, switch the package to `"type": "module"`.
- Whether `trips:write` should be pre-checked on the consent page or left unchecked by default. Default in this design: unchecked.

# Product Requirements Document: Trips MCP Server

## 1. Overview
Expose the Trips API as a remote Model Context Protocol (MCP) server so that AI clients—including Anthropic Claude (Claude Code, claude.ai, Claude Desktop, Claude mobile) and Google Gemini (Gemini Spark custom apps, Gemini CLI)—can read and manage a user's trips on their behalf. The server runs inside the existing Hono Worker (`api/`), reuses the existing identity and role model, and adds OAuth 2.1 so that hosted AI agents can connect as custom connectors.

Delivery is staged:

- **Stage 1** mounts the MCP endpoint behind the existing Cloudflare Access authentication. It serves CLI clients that can send custom request headers (Claude Code, curl, local dev scripts) with no new infrastructure.
- **Stage 2** adds an OAuth 2.1 authorization server on a dedicated MCP hostname, with Cloudflare Access as the upstream identity provider, enabling hosted cloud agents (claude.ai, Gemini Spark) and local clients using browser-based PKCE login to connect.

## 2. Goals
- Let Claude and Gemini Spark clients list, read, create, and update trips, itineraries, and expenses with the same permissions the user has in the web app.
- Never widen access: every tool call is authorized the same way the equivalent REST call is.
- Support both Dynamic Client Registration (DCR, RFC 7591) and pre-registered static OAuth 2.0 clients with PKCE to accommodate both claude.ai and Gemini Spark custom app connectors.
- Support unattended background execution for autonomous agents (Gemini Spark) via reliable `offline_access` refresh token rotation.
- Keep one implementation of business logic shared by the REST routes and the MCP tools.
- Keep all credentials in Worker secrets or environment variables, never in source.

## 3. Non-Goals
- Delete operations of any kind in v1 (trips, itineraries, expenses, participants). This is especially critical for autonomous background agents like Gemini Spark to prevent unintended data loss.
- Participant, invite, document, or admin management through MCP.
- A public listing in the Anthropic connector directory or Google Workspace Marketplace. This is a private connector for known users only.
- Machine-to-machine (`client_credentials`) grants. Cloud agent connectors operate under authorization code grants on behalf of users.

## 4. Background and Constraints

### 4.1 Existing auth model
- Authentication is Cloudflare Access. `authMiddleware` (`api/src/middleware/auth.ts`) verifies the Access JWT, maps service tokens through `service_identities`, and maps humans through `userEmails`. Unknown users are rejected.
- Global roles are `admin`, `editor`, `viewer`. Trip roles are `Owner`, `Editor`, `Viewer`, resolved by `getTripRole` (`api/src/middleware/tripRole.ts`).
- Viewer responses use dedicated view schemas (`ItineraryViewSchema` and related) that strip confirmation numbers, ticket numbers and seat assignments.
- The whole application hostname is behind an Access application with an External Evaluation rule. Anthropic and Google egress cannot present an Access JWT, so any endpoint called directly by cloud agents must not be covered by that application.

### 4.2 Client requirements (Claude and Gemini Spark)
- Transport: Streamable HTTP (`POST /mcp`). SSE is deprecated and unsupported by cloud agent connectors.
- Authentication: OAuth 2.1 with PKCE `S256` advertised in `code_challenge_methods_supported`.
- Client Registration:
  - Claude hosted apps use OAuth 2.0 with Dynamic Client Registration (DCR, RFC 7591) or a Client ID Metadata Document (CIMD).
  - Gemini Spark custom apps support standard OAuth 2.0 / 2.1 connectors and may use DCR or require entering pre-provisioned static Client IDs and Secrets in the Gemini Connected Apps settings.
- Discovery:
  - Sign-in starts from a `401 Unauthorized` response carrying `WWW-Authenticate: Bearer resource_metadata="<url>"`. A `WWW-Authenticate` header on a `200` is ignored.
  - The protected resource metadata (RFC 9728) `resource` field must exactly equal the public MCP endpoint URL as entered by the user.
  - The authorization server must serve RFC 8414 or OpenID Connect discovery metadata at its `/.well-known/` path, reachable from Anthropic and Google published egress IP ranges.
- Redirect URIs:
  - Claude: `https://claude.ai/api/mcp/auth_callback` for hosted apps.
  - Gemini Spark / Google: `https://vertexaisearch.cloud.google.com/oauth-redirect` and Google OAuth redirect relay domains (`https://oauth-redirect.googleusercontent.com/*`).
  - Local CLI clients (Claude Code, Gemini CLI): loopback redirect (`http://localhost:<port>/callback`, `http://127.0.0.1:<port>/callback`, or `/oauth/callback`) on an ephemeral port; matching must ignore the port.
- Token Endpoint: Accepts `application/x-www-form-urlencoded`. Registration accepts `application/json`.
- Latency: Discovery, registration, and token endpoints must respond within 10 seconds; refresh within 30 seconds.
- Background Execution & Offline Access: Gemini Spark executes recurring and scheduled tasks in the background without user presence. Public and confidential clients must be issued refresh tokens when `offline_access` is granted, with refresh token rotation stored reliably in KV.

## 5. Architecture

### 5.1 Components
| Component | Location | Responsibility |
|---|---|---|
| Service layer | `api/src/services/*.ts` | Trip, itinerary, expense and participant queries extracted from the route handlers. Shared by REST and MCP. |
| MCP handler | `api/src/mcp/server.ts` | Tool definitions and handlers using `@modelcontextprotocol/sdk` and the stateless `createMcpHandler` from the `agents` package. No Durable Objects. |
| OAuth provider (Stage 2) | `api/src/index.ts`, `api/src/mcp/oauth.ts` | `OAuthProvider` from `@cloudflare/workers-oauth-provider` wrapping the Worker export. Handles `/authorize`, `/token`, `/register`, discovery metadata, and token/client storage in KV. Supports both DCR and static pre-configured clients. |
| Upstream login (Stage 2) | `api/src/mcp/oauth.ts` | Consent screen, redirect to a Cloudflare Access for SaaS OIDC app, callback verification, user mapping. |
| Admin grant management (Stage 2) | `api/src/routes/admin.ts`, `web/` | List and revoke OAuth grants and manage static client credentials. |

### 5.2 Hostnames and routing
- **Stage 1:** the MCP endpoint lives under the existing API path prefix on the application hostname, covered by the existing Access application. Clients authenticate with a Cloudflare Access service token.
- **Stage 2:** the MCP endpoint lives on a dedicated MCP hostname, served by a new proxied DNS record and a Worker route pointing at the same Worker. This hostname must not be covered by any Access application, because the Worker's own OAuth layer is the gate. A dedicated hostname is required because the Worker only owns the API path prefix on the application hostname, and discovery metadata must be served at `/.well-known/*` on the origin root.
- The Worker's `fetch` handler dispatches on hostname: requests to the MCP hostname go to the OAuth provider; requests on the main hostname keep today's `/api` prefix stripping.

### 5.3 Identity flow (Stage 2)
1. Client (Claude or Gemini Spark) calls `POST /mcp` without a token. The Worker returns `401` with a `resource_metadata` pointer.
2. Client reads `/.well-known/oauth-protected-resource`, then the authorization server metadata.
3. Client registers dynamically through DCR (`/register`) or uses pre-provisioned static client credentials stored in `OAUTH_KV`.
4. Client opens `/authorize` with a PKCE challenge (or authorization code grant).
5. The consent screen shows the client name and the redirect URI host, with a warning when the redirect is loopback. Scopes default to `trips:read` and `offline_access` (ensuring background agents like Gemini Spark receive refresh tokens). User approves.
6. The Worker redirects the browser to the Access for SaaS authorization endpoint. The user signs in through their configured identity provider (e.g. Google).
7. The callback verifies the ID token against the Access JWKS, reads the email, and resolves the user through `findUserByEmail`. Unknown emails are rejected with an error page. No user is ever created by this flow.
8. The Worker completes the authorization with props `{ userId }` and the granted scopes, and redirects to the client's registered callback URI (Claude or Google).
9. Client exchanges the authorization code at `/token` for an access token and refresh token.
10. On every tool call the Worker reloads the user from D1 by `userId`. Deleted users and role changes take effect immediately. Autonomous background tasks refresh expired access tokens via `/token` without re-prompting the user.

## 6. Functional Requirements

### 6.1 Tools (v1)
All tools operate as the authenticated user. Read tools require `trips:read`. Write tools require `trips:write` and the appropriate trip role.

| Tool | Scope | Trip role | Behavior |
|---|---|---|---|
| `get_me` | read | n/a | Returns the user's id, name, email and global role. |
| `list_trips` | read | any | Trips the user participates in (all trips for admins), with the user's role on each. |
| `get_trip` | read | Viewer+ | Trip details, participants, and itineraries grouped by day in the trip's local dates. |
| `search_itineraries` | read | Viewer+ | Itineraries across the user's trips filtered by type, date range and free text. |
| `list_expenses` | read | Viewer+ | Expenses for a trip with payer and split details. |
| `create_trip` | write | n/a | Creates a trip and makes the user its Owner. |
| `create_itinerary` | write | Editor+ | Creates an itinerary item. Input validated against the existing Zod schemas per type. |
| `update_itinerary` | write | Editor+ | Partial update of an itinerary item. |
| `add_expense` | write | Editor+ | Creates an expense. |

Requirements:
- Tool input schemas are derived from the existing Zod schemas in `api/src/schemas/` so REST and MCP validation never drift.
- Tool parameter schemas should use concrete types and explicit property descriptions (avoiding ambiguous open-ended objects where possible) to ensure high reliability across different model function-calling engines (including Claude and Gemini).
- Viewer-role users receive the view-schema projections. Confirmation numbers, ticket numbers and seat assignments must never appear in a Viewer's tool results.
- Tool descriptions state clearly what each tool does and what it needs, since LLMs choose tools based primarily on their descriptions.
- Tool errors return structured MCP errors with a user-readable message and no stack traces or internal identifiers.

### 6.2 Stage 1 authentication
- The MCP route is mounted behind `authMiddleware`. No changes to how identity is resolved.
- This stage strictly targets developer tools and CLI clients (Claude Code, curl, local scripts) that can inject custom HTTP headers. Cloud-hosted agents (Gemini Spark, claude.ai) cannot pass custom request headers and require Stage 2.
- The Trips Access application has a Service Auth policy allowing the designated service token.
- The service token's subject is registered in `service_identities` and mapped to the human user it acts for, through the existing admin API.
- Claude Code connects with:

```bash
claude mcp add --transport http trips "${TRIPS_MCP_URL}" \
  --header "CF-Access-Client-Id: ${TRIPS_CF_ID}" \
  --header "CF-Access-Client-Secret: ${TRIPS_CF_SECRET}"
```

- Local development uses `DEV_MODE` and the `X-Dev-User-Email` header, so the MCP Inspector, Claude Code, and local Gemini CLI can target the local dev server without Access.

### 6.3 Stage 2 authentication
- OAuth 2.1 authorization code flow with PKCE `S256` only. No implicit flow, no password grant, no client credentials grant.
- Client Registration:
  - DCR enabled at `/register` (RFC 7591) for dynamic clients like Claude. Registered clients are public clients unless a secret is supplied.
  - Support pre-configured static clients in `OAUTH_KV` (via admin API / script) for platforms like Gemini Spark that may require manual entry of a static Client ID and Secret in their connected apps UI.
- Scopes advertised in `scopes_supported`: `trips:read`, `trips:write`, `offline_access`.
  - Default scopes granted on consent include `trips:read` and `offline_access`. Granting `offline_access` is mandatory for autonomous background agents like Gemini Spark to receive refresh tokens.
- Access tokens expire after one hour. Refresh tokens are issued when `offline_access` is granted and are rotated on each use.
- Accepted redirect URIs:
  - Claude: `https://claude.ai/api/mcp/auth_callback`
  - Gemini Spark / Google: `https://vertexaisearch.cloud.google.com/oauth-redirect` and Google OAuth redirect relay patterns (`https://oauth-redirect.googleusercontent.com/*`)
  - Local CLI clients (Claude Code, Gemini CLI): loopback `http://localhost:<port>/callback`, `http://127.0.0.1:<port>/callback`, or `/oauth/callback` with the port ignored.
- Tokens are accepted only in the `Authorization: Bearer` header. Tokens in query strings are rejected.
- The consent screen is served by the Worker and shows: the requesting client name, the redirect URI host, the scopes requested with plain-language descriptions, and a warning when the redirect is a loopback address.
- The Access for SaaS application carries the same External Evaluation rule as the main application so unknown users are blocked at the Access layer as well as in the callback.
- Token, registration and discovery endpoints make no upstream network calls. Only KV and D1 are touched, to stay well under Claude's and Google's 10-second limits.

### 6.4 Grant and client management
- Admin endpoints list active grants (user, client name, scopes, created time), revoke grants, and manage static OAuth client credentials.
- Users can list and revoke their own grants from a profile page.
- Revoking a grant invalidates its access and refresh tokens immediately.

## 7. Security Requirements
- **Least privilege.** The tool surface is the smallest set that supports the use cases. No delete tools. No participant or invite management.
- **Autonomous agent safety.** Gemini Spark acts proactively in the background without direct human intervention on every tool call. Confining the MCP surface strictly to read and non-destructive writes (no deletes, no invite manipulation) ensures that scheduled background routines cannot cause accidental data destruction.
- **Authorization parity.** A tool must never return or change anything the same user could not read or change through the REST API. Both paths call the same service functions.
- **Fresh identity.** User and role are reloaded from D1 on every call. Token props carry only `userId`.
- **Rate limiting.** A per-user rate limit on `/mcp` using a second `ratelimit` binding, mirroring `evalRateLimit`. A per-IP limit on `/authorize`, `/token` and `/register`.
- **Audit logging.** Every tool call logs user id, tool name, trip id (if any), scope and outcome. Tokens and secrets are never logged.
- **Untrusted content.** Itinerary and expense text is user-entered and may be read by the model. This is a reason to keep the write surface narrow and to avoid any tool that performs an irreversible action.
- **Secrets.** `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY` are Worker secrets. The KV namespace id is injected at deploy time from a GitHub Actions secret, like the D1 id. Nothing sensitive is committed.
- **CORS.** The MCP hostname does not need browser CORS. Do not add the MCP origin to the browser allow list.
- **Error hygiene.** OAuth errors follow RFC 6749 codes. Tool errors never leak stack traces, SQL, or internal ids the caller is not authorized to see.

## 8. Configuration

### 8.1 New Worker bindings and vars
| Name | Kind | Purpose |
|---|---|---|
| `OAUTH_KV` | KV namespace | Token, grant and client (DCR and static) storage for the OAuth provider. |
| `MCP_RATE_LIMITER` | ratelimit binding | Per-user limit on tool calls. |
| `ACCESS_AUTHORIZATION_URL` | var | Access for SaaS authorization endpoint. |
| `ACCESS_TOKEN_URL` | var | Access for SaaS token endpoint. |
| `ACCESS_JWKS_URL` | var | Access for SaaS JWKS endpoint. |
| `MCP_PUBLIC_URL` | var | The public MCP endpoint URL, used as the resource identifier in discovery metadata. |

### 8.2 New secrets
| Name | Purpose |
|---|---|
| `ACCESS_CLIENT_ID` | Client id of the Access for SaaS app. |
| `ACCESS_CLIENT_SECRET` | Client secret of the Access for SaaS app. |
| `COOKIE_ENCRYPTION_KEY` | Encrypts the consent-flow cookie. |

### 8.3 Cloudflare dashboard changes
- DNS: proxied record for the MCP hostname.
- Worker route: all paths on the MCP hostname, pointed at the API Worker.
- Access: Service Auth policy on the main Access application (Stage 1). New Access for SaaS OIDC application whose callback is the `/callback` path on the MCP hostname, carrying the External Evaluation rule (Stage 2).
- Verify no Access application pattern matches the new hostname.

### 8.4 Deployment
- `deploy-api.yml` injects the KV namespace id from a new `CLOUDFLARE_KV_OAUTH_ID` secret.
- README gains a section for connecting Claude Code, claude.ai, and Gemini Spark, and for the Access setup.

## 9. Client Connection

### 9.1 Claude Code
```bash
claude mcp add --transport http trips "${TRIPS_MCP_URL}"
```
Then run `/mcp` inside Claude Code to sign in. If the loopback redirect mismatches, pin `callbackPort` in the server config.

### 9.2 claude.ai, Claude Desktop, Claude mobile
Settings, Connectors, Add custom connector, enter the public MCP endpoint URL. Claude registers itself through DCR and opens the consent screen.

### 9.3 Gemini Spark
1. In `gemini.google.com`, navigate to **Settings & help** $\rightarrow$ **Connected Apps** $\rightarrow$ **Custom apps for Spark** $\rightarrow$ **Add a custom app**.
2. Enter the public MCP endpoint URL (`${MCP_PUBLIC_URL}`).
3. If prompted for client credentials, supply the pre-provisioned static Client ID and Secret (or proceed via DCR discovery if supported).
4. Authenticate via Cloudflare Access and approve permissions (defaulting to include `offline_access`).
5. Invoke tools in Gemini Spark via chat (`@trips`) or configure recurring background routines.

### 9.4 Local Gemini CLI (`gemini-cli`)
Point the CLI to the local dev server using `DEV_MODE` or configure loopback redirect port handling (`http://localhost:7777/oauth/callback` or ephemeral port).

## 10. Delivery Plan
1. **Service extraction.** Move query logic from `api/src/routes/{trips,itineraries,expenses,participants}.ts` into `api/src/services/`. REST behavior unchanged. Existing OpenAPI output unchanged.
2. **Stage 1 MCP endpoint.** Add dependencies, mount `/mcp` behind `authMiddleware`, implement the read tools, then the write tools. Verify with MCP Inspector in `DEV_MODE` and with Claude Code against production using a service token.
3. **Stage 2 OAuth.** Add the KV namespace, wrap the Worker in `OAuthProvider`, implement the consent screen and Access callback, add scope enforcement, add the `401` discovery response and protected resource metadata. Support both DCR and static client credentials.
4. **Cloudflare configuration.** DNS, route, Access for SaaS app, secrets, deploy workflow.
5. **Grant and client management.** Admin and self-service endpoints and UI for active grants and static clients.
6. **Hardening.** Rate limits, audit logging, background token refresh verification, error hygiene review, README.

## 11. Acceptance Criteria
- A Viewer on a trip calling `get_trip` through MCP receives no confirmation numbers, ticket numbers or seat assignments.
- A user with only `trips:read` calling `create_itinerary` receives a scope error and nothing is written.
- A Viewer with `trips:write` calling `update_itinerary` receives a role error and nothing is written.
- An email not present in `userEmails` cannot complete the OAuth flow and no user row is created.
- Deleting a user in the admin UI causes that user's existing MCP token to fail on the next call.
- claude.ai can add the server as a custom connector, complete sign-in, and call `list_trips`.
- Gemini Spark can add the server under Custom apps for Spark, complete sign-in via Google callback, and call `list_trips`.
- Gemini Spark unattended background routines can refresh expired access tokens using the refresh token without user intervention.
- Claude Code can connect through `/mcp` sign-in and through a service token header, and both resolve to the correct user.
- Revoking a grant causes the next call with that token to return `401`.
- Discovery, registration and token endpoints respond in under one second from Anthropic and Google egress ranges.
- The REST API test behavior is unchanged after the service extraction.

## 12. Open Questions
- Does the `agents` package bundle cleanly with `"type": "commonjs"` in `api/package.json`, or does the package need to move to ESM?
- Does the current `@cloudflare/workers-oauth-provider` release match loopback redirect URIs port-agnostically, or must Claude Code pin `callbackPort`?
- Does Gemini Spark's custom app flow consistently use DCR across all accounts, or should static client credentials in `OAUTH_KV` be seeded automatically via deploy workflow?
- Does the main Access application already have a Service Auth policy for the existing agent integration that Stage 1 can reuse?
- Should `trips:write` be granted by default on the consent screen, or opt-in per connection?

## 13. References
- Anthropic, Authentication for connectors: https://claude.com/docs/connectors/building/authentication
- Anthropic, Claude Code MCP: https://code.claude.com/docs/en/mcp
- Cloudflare, MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/authorization/
- Cloudflare, remote MCP with Access demo: https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access
- Cloudflare, workers-oauth-provider: https://github.com/cloudflare/workers-oauth-provider
- MCP authorization specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- RFC 7591, OAuth 2.0 Dynamic Client Registration Protocol: https://datatracker.ietf.org/doc/html/rfc7591
- RFC 9728, OAuth 2.0 Protected Resource Metadata: https://datatracker.ietf.org/doc/html/rfc9728


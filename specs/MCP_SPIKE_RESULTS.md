# MCP Spike Results

Phase 0, step 1. Date: 2026-10-27. Every verdict below comes from a build or run in this repo, or from code quoted out of `api/node_modules`. Spike sources are kept outside the repo, in the session scratchpad (`spike-src/`). `api/spike/` was deleted.

## 0. Installed versions

| Package | Range in `api/package.json` | Installed | Kind |
|---|---|---|---|
| `@modelcontextprotocol/server` | `^2.4.0` | 2.4.0 (pulls `@modelcontextprotocol/core` 2.4.0) | dependency |
| `@cloudflare/workers-oauth-provider` | `^1.2.4` | 1.2.4 | dependency |
| `@modelcontextprotocol/client` | `^2.4.0` | 2.4.0 | devDependency |
| `vitest` | `^4.1.12` | 4.1.12 | devDependency |
| `@cloudflare/vitest-pool-workers` | `^0.23.0` | 0.23.0 (bundles its own `wrangler` 4.124.0 and `miniflare` 5.20260815.0-alpha) | devDependency |

Side effects in the lockfile: the hoisted `zod` went from 4.3.6 to 4.4.3. That is still inside `^4.3.6`, and it is shared by `@hono/zod-openapi`, the MCP SDK and the pool. The project's own `wrangler` stays at 4.76.0.

Also added: `"test": "vitest run"` in `api/package.json`, `api/vitest.config.mts`, `api/test/env.d.ts` and `api/test/smoke.test.ts`.

---

## 1. Does `@modelcontextprotocol/server` run on Workers, with and without `nodejs_compat`?

**Verdict: yes, both ways. `nodejs_compat` is not needed.**

**Evidence.**
- The SDK's `package.json` maps `./_shims` to a `workerd` condition (`dist/shimsWorkerd.mjs`). The ESM entry imports `DefaultJsonSchemaValidator` from `@modelcontextprotocol/server/_shims`. On workerd that resolves to a cfworker JSON-schema validator that is bundled inline. The SDK lists `@cfworker/json-schema` only as a devDependency, but nothing imports it at runtime.
- `wrangler deploy --dry-run` of a throwaway Worker on `compatibility_date = "2025-01-01"` with no flags bundled `index.mjs`, `mcp-*.mjs`, `shimsWorkerd.mjs` and `cfWorkerProvider-*.mjs`. The bundle has zero `node:` imports.
- `wrangler dev` without flags answered a JSON-RPC `tools/list`:

```
$ curl -s -i -X POST http://127.0.0.1:8799/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: message
data: {"result":{"tools":[{"name":"echo_auth","title":"Echo auth",...,"inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"tripId":{"type":"string","format":"uuid",...}},"required":["tripId"]},"annotations":{"readOnlyHint":true},"outputSchema":{...}},{"name":"plain_zod",...}]},"jsonrpc":"2.0","id":1}
```

- `@modelcontextprotocol/client` 2.4.0 succeeded against the same server in both protocol eras, without flags and again with `compatibility_flags = ["nodejs_compat"]`:

```
$ node client.mjs http://127.0.0.1:8799/mcp              # default client, legacy era
negotiated: 2025-11-25
tools: echo_auth,plain_zod
call: {"tripId":"00000000-0000-4000-8000-000000000000","factoryUser":"u-123","handlerUser":"u-123","clientId":"spike-client"}
$ node client.mjs http://127.0.0.1:8799/mcp 2026-07-28   # versionNegotiation: { mode: { pin: "2026-07-28" } }
negotiated: 2026-07-28
tools: echo_auth,plain_zod
call: {...same...}
```

- `createMcpHandler` serves two protocol eras. Modern requests (2026-07-28, with a per-request `_meta` envelope) take the new path. 2025-era requests fall back to stateless serving by default (`legacy: 'stateless'`): `initialize` is accepted, GET/DELETE get 405, and a bare `tools/list` with no `initialize` works. On the legacy path the response is SSE (`text/event-stream`) even when `responseMode: "json"` is set, because `responseMode` applies only to modern exchanges (quoted from the type docs).

**Consequence for the TDD.** Section 2 and Open Item 1: no flag needed. Do not add `nodejs_compat`. Section 11: a JSON-RPC test must send `accept: application/json, text/event-stream`, and with the default legacy fallback it must parse SSE frames.

## 2. Does `"type": "commonjs"` break the SDK's conditional exports?

**Verdict: no for the Worker bundle. Yes for a `vitest.config.ts`. The fix is the file extension, not the package type. Do not switch `api/` to ESM.**

**Evidence.**
- With temporary imports of `McpServer`, `createMcpHandler`, `OAuthProvider` and `getOAuthApi` added to `api/src/index.ts` (since reverted), `wrangler deploy --dry-run` of the real `api/wrangler.toml` bundled the ESM `.mjs` builds and `shimsWorkerd.mjs`. Wrangler's esbuild resolves `import` statements with the `import` and `workerd` conditions whatever `"type"` says.
- With the same imports, `wrangler dev` served `GET /api/__spike` → `function,function,function,function` and `GET /api/trips` → `401 {"error":"Unauthorized"}`, which is the normal unauthenticated response.
- With the same imports, `npx tsc --noEmit` showed only the two pre-existing errors (`src/routes/documents.ts(32,3)`, `src/routes/expenses.ts(32,3)`). `moduleResolution: "bundler"` picks the `import` types.
- `@cloudflare/workers-oauth-provider` is ESM-only (`"type": "module"`, `main` only, no `exports`). Bundling it is fine.
- Breakage seen. Vite bundles a `vitest.config.ts` in a CommonJS package as CJS, and that cannot load the ESM-only pool:

```
failed to load config from /Users/prentice/code/trips/api/vitest.config.ts
Error: Failed to resolve "@cloudflare/vitest-pool-workers". This package is ESM only but it was tried to load by `require`.
```

  Renaming the file to `vitest.config.mts` fixes it with no other change.

**Consequence for the TDD.** Open Item 4 is closed: keep `"type": "commonjs"`. The test config must be `vitest.config.mts`, or `.mjs`. The orchestrator does not need to apply any package-level change.

## 3. `createMcpHandler`, `authInfo`, `registerTool` and zod

**Verdict: the TDD is correct about `ctx.http.authInfo`. The exact shapes are below.**

**Imports (all from the root of `@modelcontextprotocol/server`):** `McpServer`, `createMcpHandler`, and the types `AuthInfo`, `ServerContext`, `McpServerFactory`, `CreateMcpHandlerOptions`, `ToolCallback`. The package does not re-export `z`, so import zod yourself. `import { z } from "zod"`, `import * as z from "zod/v4"` and `import { z } from "@hono/zod-openapi"` all typecheck and run.

**Handler and factory (`dist/createMcpHandler-*.d.mts`):**

```ts
declare function createMcpHandler(factory: McpServerFactory, options?: CreateMcpHandlerOptions): McpHttpHandler;
type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;
interface McpRequestContext { era: 'legacy' | 'modern'; authInfo?: AuthInfo; requestInfo?: Request; }
interface McpHttpHandler { fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>; close: () => Promise<void>; notify: ServerNotifier; bus: ServerEventBus; }
interface McpHandlerRequestOptions {
  /** Validated authentication information for the request. Strictly pass-through: the handler never
   *  populates this from request headers and performs no token verification of its own. */
  authInfo?: AuthInfo;
  parsedBody?: unknown;
}
interface CreateMcpHandlerOptions { legacy?: 'stateless' | 'reject'; onerror?: (error: Error) => void; responseMode?: 'auto' | 'sse' | 'json'; bus?; maxSubscriptions?; keepAliveMs?; maxRequestBodySize?; }
```

**AuthInfo (`dist/mcp-*.d.mts`):**

```ts
interface AuthInfo { token: string; clientId: string; scopes: string[]; expiresAt?: number; resource?: URL; resourceMetadataUrl?: string; extra?: Record<string, unknown>; }
```

**Tool handler context:** the second callback argument is a `ServerContext`, and the auth lives at `ctx.http?.authInfo`:

```ts
type BaseContext = { sessionId?: string; mcpReq: { id; method; _meta?; signal: AbortSignal; send; notify; ... };
  http?: { /** Information about a validated access token, provided to request handlers. */ authInfo?: AuthInfo; }; };
type ServerContext = BaseContext & { mcpReq: { log; elicitInput; requestSampling }; http?: { req?: globalThis.Request; closeSSE?; closeStandaloneSSE? } };
```

At runtime, the same `authInfo` passed to `handler.fetch(req, { authInfo })` appeared both in the factory (`rc.authInfo`) and in the tool (`ctx.http?.authInfo`). The spike output shows `"factoryUser":"u-123","handlerUser":"u-123","clientId":"spike-client"`.

**registerTool (`McpServer`):**

```ts
registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(name: string, config: {
  title?: string; description?: string; inputSchema?: InputArgs; outputSchema?: OutputArgs; annotations?: ToolAnnotations;
  icons?: Icon[]; scopeChallenge?: ScopeChallengeHandler; _meta?: Record<string, unknown>;
}, cb: ToolCallback<InputArgs>): RegisteredTool;
/** @deprecated Wrap with `z.object({...})` instead. Raw-shape form ... auto-wrapped with `z.object()`. */
registerTool<InputArgs extends ZodRawShape, ...>(name, config, cb: LegacyToolCallback<InputArgs>): RegisteredTool;
type ToolCallback<Args> = Args extends StandardSchemaWithJSON ? (args: InferOutput<Args>, ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<...> : (ctx: ServerContext) => ...;
```

`inputSchema` takes a `z.object(...)`, or any Standard Schema with JSON Schema support. The raw-shape form still works but is deprecated. With no `inputSchema`, the callback's only argument is `ctx`.

**`@hono/zod-openapi` schemas:** accepted. A `z.object({ tripId: z.string().uuid().openapi({ example }) }).openapi("TripIdInput")` schema typechecked, listed and validated. Bad input returned `{"isError":true,"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool echo_auth: tripId: Invalid UUID"}]}`. The `.openapi()` metadata does not show up in `tools/list`. The TDD 6.3 pattern `z.object({ tripId }).extend(CreateItinerarySchema.shape)` with `outputSchema: <openapi schema>` typechecks, and a callback with the wrong argument type is rejected (checked with `@ts-expect-error`). Both run inside `@cloudflare/vitest-pool-workers` as well.

**Error behaviour (new finding, run in workerd):**
- A plain `Error` thrown from a tool callback becomes `{"result":{"content":[{"type":"text","text":"db exploded at /internal/path"}],"isError":true}}`. **The raw message goes to the client.**
- When the factory throws, the response is HTTP 500 with `{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"}}`. Nothing leaks.

**Consequence for the TDD.**
- 6.1 is correct as written.
- 6.3 is wrong where it says `withTool` "rethrows anything else so the SDK reports an internal error without the stack". The SDK sends the message to the client. `withTool` must catch everything and return a generic message for anything that is not a `ServiceError` or scope error.
- 6.2: a missing user gives HTTP 500 / -32603, which is acceptable.

## 4. OAuth helper names, `getOAuthApi` and `env.OAUTH_PROVIDER`

**Verdict: the methods are `listUserGrants` and `revokeGrant`. `getOAuthApi` takes `(options, env)`, not `(env)`. There is no helper that lists every user's grants.**

**Evidence (`dist/oauth-provider.d.ts`):**

```ts
interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  completeAuthorization(options: CompleteAuthorizationOptions): Promise<{ redirectTo: string }>;
  describeConsent(authRequest: AuthRequest): Promise<ConsentDescription>;
  isConsentRemembered(request: Request, authRequest: AuthRequest, remember: Pick<RememberConsentOptions, 'secret' | 'subject'>): Promise<boolean>;
  beginConsent(authRequest: AuthRequest): Promise<ConsentTransaction>;          // { handle, headers }
  approveConsent(request: Request, handle: string, options?: { scope?: string[]; remember?: RememberConsentOptions }): Promise<ApprovedConsent>;  // { request, headers }
  denyConsent(request: Request, handle: string, options?: { description?: string }): Promise<DeniedConsent>;  // { request, redirectTo, headers }
  beginUpstream(authRequest: AuthRequest, options?: { data?: unknown; headers?: Headers }): Promise<UpstreamTransaction>;  // { state, headers }
  finishUpstream<Data = unknown>(request: Request): Promise<ResumedUpstream<Data>>;  // { request, data, headers }
  createClient(clientInfo: Partial<ClientInfo>): Promise<ClientInfo>;
  listClients(options?: ListOptions): Promise<ListResult<ClientInfo>>;
  updateClient(clientId: string, updates: Partial<ClientInfo>): Promise<ClientInfo | null>;
  deleteClient(clientId: string): Promise<void>;
  listUserGrants(userId: string, options?: ListOptions): Promise<ListResult<GrantSummary>>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
  unwrapToken<T = any>(token: string): Promise<TokenSummary<T> | null>;
  exchangeToken(options: ExchangeTokenOptions): Promise<TokenResponse>;
  purgeExpiredData(options?: PurgeOptions): Promise<PurgeResult>;
}
declare function getOAuthApi<Env = Cloudflare.Env>(options: OAuthProviderOptions<Env>, env: Env): OAuthHelpers;
interface GrantSummary { id; clientId; userId; scope: string[]; metadata: any; createdAt: number; expiresAt?: number; redirectUri?: string; resource?: string | string[]; }
interface CompleteAuthorizationOptions { request: AuthRequest; userId: string /* non-empty, no ':' */; metadata: any; scope: string[]; props: any; revokeExistingGrants?: boolean /* default true */; }
```

Implementation (`dist/oauth-provider.js`):

```js
function getOAuthApi(options, env) { return new OAuthProviderImpl(options).createOAuthHelpers(env); }
// inside OAuthProvider.fetch, only on the defaultHandler and apiHandler paths:
if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env);
async revokeGrant(grantId, userId) { const grantKey = `grant:${userId}:${grantId}`; ... delete tokens under `token:${userId}:${grantId}:` ...; await this.env.OAUTH_KV.delete(grantKey); }
async listUserGrants(userId, options) { const listOptions = { prefix: `grant:${userId}:` }; ... }
```

Runtime: the spike's main-hostname-style route called `getOAuthApi(options(env), env).listUserGrants("spike-user-1")` and got one grant. `revokeGrant(gid, "someone-else")` returned normally without doing anything, and the token kept working (200). `revokeGrant(gid, owner)` made the next `/mcp` call return 401 `error="invalid_token"`, and a refresh returned `invalid_grant "Grant not found"`.

**Consequence for the TDD (7.5, 8.3).**
- Use `getOAuthApi(buildProviderOptions(env), env)`. The options object must be the same one the provider uses, so export a single options builder from `oauth/provider.ts`.
- `env.OAUTH_PROVIDER` is set only inside `OAuthProvider.fetch`, so it exists only on the MCP hostname. The `Bindings` entry stays optional.
- `GET /admin/grants` ("all grants") has no helper. Iterate `users` from D1, call `listUserGrants(user.id)` for each, and resolve client names with `lookupClient(clientId)`. `GrantSummary` has no client name.
- `revokeGrant` needs the userId, so the admin route becomes `DELETE /admin/grants/{userId}/{grantId}`.
- The self-service "someone else's grant returns 404" check must test membership in `listUserGrants(caller.id)` first, because `revokeGrant` succeeds without doing anything when the owner is wrong.
- `completeAuthorization` requires `metadata`. TDD 7.2 leaves it out.
- `revokeExistingGrants` defaults to true, so authorizing the same user and client again replaces the old grant.

## 5. TDD 7.2 flow names, `ConsentDescription`, `clientRegistrationCallback`

**Verdict: every name in TDD 7.2 exists and the whole sequence ran end to end.** Corrections: the signature of `beginUpstream`, the `metadata` field of `completeAuthorization`, and the fact that the helpers throw `AuthorizationError`.

**Evidence.** Spike run under `wrangler dev` with a local KV and `OAUTH_KV_ID_PLACEHOLDER`:

```
authorize GET (registered port 33418, used port 5555): {"status":200,"desc":{"clientId":"…","clientName":"Spike Code","redirectUri":"http://localhost:5555/callback","redirectHost":"localhost","redirectIsLoopback":true,"scope":["trips:read","trips:write","offline_access"]},"cookies":["__Host-oauth-consent-…"],"xfo":"DENY","csp":"frame-ancestors 'none'"}
authorize POST approve (scope trips:read only, no offline_access): 302 location=/callback
authorize POST replay same handle: 400 AuthorizationError code=invalid_request desc=This authorization was not started in this browser; start again
callback: {"status":302,"redirect":"http://localhost:5555/callback","params":["code","state","iss"],"state":"st-1","upstreamData":"{\"verifier\":\"spike-verifier\"}"}
callback replay same state: 400
token exchange wrong verifier: 400 {"error":"invalid_grant","error_description":"Invalid PKCE code_verifier"}
authorize public client without PKCE: 400   (AuthorizationError: "Public clients must use PKCE with the authorization code flow.")
```

- `ConsentDescription` fields are confirmed: `clientId, clientName, clientDomain?, clientUri?, logoUri?, redirectUri, redirectHost, redirectIsLoopback, scope`.
- `beginConsent` headers include `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and a `__Host-oauth-consent-*` binding cookie.
- `beginUpstream(authRequest, { data, headers })`: pass `approved.headers` as `headers` so both cookies are kept.
- `finishUpstream` returns `{ request, data, headers }`. Send `resumed.headers` on the final redirect to `redirectTo`.
- `parseAuthRequest`, `approveConsent`, `denyConsent` and `finishUpstream` **throw** `AuthorizationError` (exported, with `code`, `description` and `redirectUri`). `authorizationErrorRedirect` is exported for building the redirect. The defaultHandler must catch these errors and render a page or a redirect. Uncaught, they become a 500.
- `clientRegistrationCallback` exists under that name:

```ts
clientRegistrationCallback?: (options: { clientMetadata: Record<string, unknown>; request: Request }) =>
  Promise<ClientRegistrationCallbackResult | void> | ClientRegistrationCallbackResult | void;
interface ClientRegistrationCallbackResult { code?: string /* default invalid_client_metadata */; description?: string; status?: number /* default 400 */; }
```

  At runtime, `{ description: "redirect_uri not allowed" }` produced `400 {"error":"invalid_client_metadata","error_description":"redirect_uri not allowed"}`. It sees the raw `redirect_uris` (snake_case) from the request body. It runs on the DCR path only. Clients created with `createClient()` and CIMD clients skip it.
- The library separately checks every redirect URI: it must be `https`, or `http` on a loopback host. Private-use schemes are accepted only with `allowPrivateUseRedirectUris`.

**Consequence for the TDD.** Amend 7.2 (signatures and error handling) and 7.4 (callback shape, and the fact that it does not cover CIMD).

## 6. `apiHandler` context: `ctx.props` and `ctx.auth`

**Verdict: both exist. The TDD 5.2 assumption is correct, with two typing caveats.**

**Evidence (`dist/oauth-provider.js`, handleApiRequest):**

```js
ctx.props = await decryptProps(await unwrapKeyWithToken(accessToken, tokenData.wrappedEncryptionKey), tokenData.grant.encryptedProps);
ctx.auth = { token: accessToken, audience: configuredResource, expiresAt: tokenData.expiresAt,
  scope: [...tokenData.scope || tokenData.grant.scope], userId: tokenData.userId, clientId: tokenData.grant.clientId };
```

```ts
interface OAuthResourceAuth { token: string; audience: string; expiresAt?: number; scope: string[]; userId?: string; clientId?: string; }
type OAuthResourceContext<Props> = ExecutionContext<Props> & { readonly auth: OAuthResourceAuth };
```

Runtime: `{"props":{"userId":"spike-user-1"},"auth":{"audience":"http://127.0.0.1:8796/mcp","expiresAt":…,"scope":["trips:read"],"userId":"spike-user-1","clientId":"…","tokenPresent":true},"helpersOnEnv":"object"}`.

Caveats:
1. `apiHandler` is typed as `ExportedHandlerWithFetch<Env>`, so `ctx` is a plain `ExecutionContext`. Cast it: `const c = ctx as OAuthResourceContext<{ userId: string }>`.
2. `ctx.auth.clientId` is optional, but `AuthInfo.clientId` is a required `string`. Use `clientId: c.auth.clientId ?? ""`.

`requiredScopes` is advertised, not enforced. Quoted: "Advertised, not enforced: the handler decides whether a token is sufficient (`ctx.auth.scope`)". A user can approve a scope set without `trips:read`, for example only `offline_access`, so read tools must check `trips:read` too.

**Consequence for the TDD.** Amend 5.2 (cast, `?? ""`, and the read-scope check in 9).

## 7. Loopback redirect URIs: port-agnostic?

**Verdict: yes, any port is accepted. Scheme, hostname, path and query must match exactly. `localhost` and `127.0.0.1` are not interchangeable. No `callbackPort` is needed.**

**Evidence (`dist/oauth-provider.js`):**

```js
/**
* Validates a redirect URI against registered URIs with RFC 8252 loopback support.
* For loopback URIs (127.x.x.x, ::1, localhost), any port is allowed as long as scheme, host, path, and query match.
* For non-loopback URIs, exact match is required.
*/
function isValidRedirectUri(requestUri, registeredUris) {
	return registeredUris.some((registered) => {
		if (isLoopbackUri(requestUri) && isLoopbackUri(registered)) try {
			const reqUrl = new URL(requestUri);
			const regUrl = new URL(registered);
			return reqUrl.protocol === regUrl.protocol && reqUrl.hostname === regUrl.hostname && reqUrl.pathname === regUrl.pathname && reqUrl.search === regUrl.search;
		} catch { return false; }
		return requestUri === registered;
	});
}
```

The check is used in `parseAuthRequest`, `completeAuthorization` and the code exchange. Runtime, with `http://localhost:33418/callback` registered:
- `http://localhost:5555/callback` → 200, consent shown.
- `http://127.0.0.1:33418/callback` → `AuthorizationError invalid_request "Invalid redirect URI"`.
- `http://localhost:5555/other` → the same error.

Separately, DCR clients expire after `clientRegistrationTTL`, which defaults to 90 days and is renewed when the client successfully uses the token endpoint.

**Consequence for the TDD.** Close the 7.1 verify item and Open Item 2.

## 8. Does the library ever read a bearer token from the query string?

**Verdict: no. The token is read only from the `Authorization: Bearer` header.**

**Evidence.** The protected-resource path:

```js
const authHeader = request.headers.get("Authorization");
const bearerMatch = authHeader ? /^Bearer[\t ]+([^\s,]+)$/i.exec(authHeader) : null;
if (!bearerMatch) return new Response(null, { status: 401, headers: { ...NO_CACHE_HEADERS, "WWW-Authenticate": challenge() } });
```

No `searchParams` read in the library touches `access_token` or `token`. The only `searchParams` reads are the authorize-request parameters, `state`, and resource/endpoint URL matching. Protected resource metadata advertises `"bearer_methods_supported":["header"]`. Runtime, with a valid token and no header:

```
POST /mcp?access_token=<valid> no header: 401
POST /mcp?token=<valid> no header: 401
POST /mcp form-body access_token no header: 401
```

**Consequence for the TDD (9).** The library behaves as hoped. The planned `400` check inside `apiHandler` is only reached when a valid header is also present: a request that carries only a query token gets the library's 401 first. Put the check in the dispatcher, before `getOAuthProvider(env).fetch`, if the goal is to always reject. Neither location can keep the URL out of Cloudflare's own request logs, so the TDD claim that "a token in a URL never reaches a log line" goes too far.

## 9. Refresh tokens for public clients, `offline_access`, and rotation

**Verdict: refresh tokens are issued to every client, public included, whenever `refreshTokenTTL !== 0`. `offline_access` plays no part. Rotation happens on every use with a one-step grace window, and there is no reuse detection.**

**Evidence, issuance (handleAuthorizationCodeGrant):**

```js
const useRefreshToken = refreshTokenTTL !== 0;
...
if (useRefreshToken) {
	refreshToken = `${userId}:${grantId}:${generateRandomString(TOKEN_LENGTH)}`;
	...
	grantData.expiresAt = expiresAt;   // now + refreshTokenTTL: a fixed grant lifetime
}
...
if (refreshToken) tokenResponse.refresh_token = refreshToken;
```

`offline_access` appears only in a filter that strips it from the advertised required scopes: `return [...new Set(scopes)].filter((scope) => scope !== "offline_access");`. Runtime: a public (`none`) client whose granted scope was only `trips:read`, with no `offline_access`, received `has_refresh_token: true`.

**Evidence, rotation (handleRefreshTokenGrant):**

```js
const isCurrentToken = grantData.refreshTokenId === providedTokenHash;
const isPreviousToken = grantData.previousRefreshTokenId === providedTokenHash;
if (!isCurrentToken && !isPreviousToken) return this.createErrorResponse("invalid_grant", { description: "Invalid refresh token" }, ...);
...
grantData.previousRefreshTokenId = providedTokenHash;
grantData.refreshTokenId = newRefreshTokenId;
```

Runtime:

```
A: refresh RT1 → 200, rotated
A: refresh RT2 → 200, rotated
A: replay RT1 after RT2 was used → 400 invalid_grant "Invalid refresh token"
A: RT3 still valid after the RT1 replay → 200          (no reuse-detection revocation)
B: retry previous RT before the new one is used → 200    (grace for lost responses)
B: the first-issued RT after the retry displaced it → 400   (a retry replaces the unused new token)
B: refresh asking for broader scope than granted → 200, scope "trips:read"   (silently downscoped)
```

Also: when `refreshTokenIdleTTL` is unset, the grant expires `refreshTokenTTL` (30 days) after the code exchange however often it is refreshed. `refreshTokenIdleTTL` makes it a sliding window.

**Consequence for the TDD (7.1, 7.2).**
- The 7.1 description of rotation is accurate.
- 7.2's reason for checking `offline_access` by default ("so unattended background agents receive refresh tokens") is wrong: every client gets a refresh token. The checkbox is harmless, but it is not a gate.
- Decision needed: a background agent such as Gemini Spark will be forced to re-consent every 30 days unless `refreshTokenIdleTTL` is set (for example, 30 days idle) with a longer `refreshTokenTTL`.

## 10. Does `clientIdMetadataDocumentEnabled` require `global_fetch_strictly_public`?

**Verdict: yes, enforced at runtime.**

**Evidence.** Option docs: "Requires the 'global_fetch_strictly_public' compatibility flag." Code:

```js
hasGlobalFetchStrictlyPublic() { return !!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags ? Cloudflare.compatibilityFlags : null)?.global_fetch_strictly_public; }
const cimdSupported = !!this.options.clientIdMetadataDocumentEnabled && this.hasGlobalFetchStrictlyPublic();   // metadata
if (!this.hasGlobalFetchStrictlyPublic()) throw new Error(`CIMD is enabled but 'global_fetch_strictly_public' compatibility flag is not set.`);  // getClient
```

There is also a module-scope warning on every isolate start when the flag is missing, even if CIMD is never configured: `console.warn("CIMD (Client ID Metadata Document) is disabled: add ...")`.

Runtime, with the flag: `client_id_metadata_document_supported: true`. Without it, on the same options: `false`, and a URL `client_id` at `/authorize` throws `Error: CIMD is enabled but 'global_fetch_strictly_public' compatibility flag is not set.` The flag works on `compatibility_date = "2025-01-01"`.

Effect on the existing app: its only outbound `fetch` is jose's `createRemoteJWKSet` call to the Access team domain, which is public, so the flag does not change it.

**Consequence for the TDD.** 2 and 8.1 are correct. Adding the flag also silences the startup warning.

## 11. `@cloudflare/vitest-pool-workers` with `api/wrangler.toml`

**Verdict: works against the real `wrangler.toml`, with the D1 binding, the unsafe ratelimit binding, and migrations from `api/drizzle`. The package is deprecated.**

**Evidence.** `api/vitest.config.mts`:

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./drizzle", import.meta.url)));
  return { plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" }, miniflare: { bindings: { TEST_MIGRATIONS: migrations } } })],
           test: { include: ["test/**/*.test.ts"] } };
});
```

`api/test/smoke.test.ts` applies migrations with `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (`applyD1Migrations` from `cloudflare:test`, `env` from `cloudflare:workers`), calls `env.EVAL_RATE_LIMITER.limit(...)`, and calls the real Worker with `exports.default.fetch("https://example.test/api/trips")` from `cloudflare:workers`.

```
$ npm test
> api@1.0.0 test
> vitest run
=======================================================================================
WARNING: @cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin.
This package will not receive future updates.
Run `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` to migrate.
=======================================================================================
 RUN  v4.1.12 /Users/prentice/code/trips/api
▲ [WARNING] Processing wrangler.toml configuration:
    - "unsafe" fields are experimental and may change or break at any time.
Using secrets defined in .dev.vars
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Temporary tests, deleted after running, also proved that `createMcpHandler(...).fetch(req, { authInfo })` runs inside the pool. That is the TDD 11 approach.

Notes for QA:
- The package's README says it is deprecated: "`@cloudflare/vitest-pool-workers` has been renamed to `@cloudflare/vitest-plugin`. This package will not receive future updates." npm shows `@cloudflare/vitest-plugin` at 1.4.9. It was not evaluated here.
- `cloudflare:test`'s `env` and `SELF` are deprecated. Use `env` and `exports` from `cloudflare:workers`.
- The pool's type comment points to `@cloudflare/vitest-pool-workers/config` for `readD1Migrations`, but that subpath is not exported. Import it from the package root.
- `.dev.vars` is committed and sets `DEV_MODE`, and the pool loads it ("Using secrets defined in .dev.vars"), so tests run with `DEV_MODE` on.
- The `routes` entry with `zone_name` and `database_id = "PROD_DB_ID_PLACEHOLDER"` cause no problems. Everything runs locally.

**Consequence for the TDD.** Amend 11: config file name, migration pattern, deprecation.

## 12. CORS (found while reading the library)

**Verdict: the TDD 9 claim is wrong.** The library adds CORS headers to the responses it serves (API route, token, registration and metadata) whenever the request has an `Origin` header:

```js
function withCorsHeaders(response, request) {
	const origin = request.headers.get("Origin");
	if (!origin) return response;
	...
	setUnlessPresent("Access-Control-Allow-Origin", origin);
	setUnlessPresent("Access-Control-Allow-Methods", "*");
	setUnlessPresent("Access-Control-Allow-Headers", "Authorization, *");
```

`Access-Control-Allow-Credentials` is never set, and auth is a bearer header, so a reflected origin cannot ride on cookies. The defaultHandler response is not wrapped.

**Consequence for the TDD.** Amend 9: state the real behaviour. Overriding is possible with `setUnlessPresent` semantics (set your own header first), but it is not needed.

---

## Summary

| # | Item | Verdict | Confidence |
|---|---|---|---|
| 1 | SDK on Workers without `nodejs_compat` | Works, flag not needed | High (built and ran both ways, both eras) |
| 2 | `"type": "commonjs"` | Fine for the Worker. Use `vitest.config.mts` | High |
| 3 | `authInfo` path, `registerTool`, zod | `ctx.http?.authInfo`; `z.object`; hono `z` accepted; thrown messages leak | High |
| 4 | Grant helpers / entry point | `listUserGrants`, `revokeGrant(grantId, userId)`; `getOAuthApi(options, env)`; no list-all | High |
| 5 | 7.2 names, `clientRegistrationCallback` | All exist; signatures corrected | High |
| 6 | `ctx.props` / `ctx.auth` | Both set; cast needed; `clientId` optional | High |
| 7 | Loopback port matching | Port-agnostic; host, path and query exact | High |
| 8 | Query-string token | Never read | High |
| 9 | Refresh tokens / rotation | Always issued; rotation with one-step grace; no reuse detection; fixed 30-day lifetime | High |
| 10 | CIMD flag | Required, enforced | High |
| 11 | vitest-pool-workers | Works with real `wrangler.toml`; deprecated | High |
| 12 | CORS | Library reflects `Origin`; TDD wrong | High |

Unresolved, outside what a local spike can show: whether Claude Code and Gemini CLI really keep the same host and path across sessions. The library only tolerates port changes. Proving it needs a real `claude mcp add` sign-in against a deployed or tunnelled MCP host. The Gemini Spark DCR question (PRD 12) and the existing Access Service Auth policy (PRD 12) depend on the account and cannot be checked from code.

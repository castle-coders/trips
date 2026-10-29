/**
 * Stage 2 OAuth 2.1 authorization server on the MCP hostname (TDD 5, 5.2, 7.1).
 *
 * - `buildProviderOptions(env)`: the full `OAuthProviderOptions`, built from `env` alone and cheap.
 *   Main-hostname code (grant endpoints) uses it with `getOAuthApi(buildProviderOptions(env), env)`
 *   (MCP_SPIKE_RESULTS 4), so the helper API always sees the same configuration as the provider.
 * - `getOAuthProvider(env)`: the memoized `OAuthProvider` the dispatcher in `src/index.ts` calls.
 *
 * Library behavior relied on (MCP_SPIKE_RESULTS): PKCE is mandatory for public clients; tokens
 * are only read from the `Authorization: Bearer` header; `requiredScopes` (CHALLENGE_SCOPES) is
 * advertised but NOT enforced (each MCP tool checks `trips:read`/`trips:write` itself); refresh tokens are issued to
 * every client while `refreshTokenTTL !== 0`; CIMD needs `global_fetch_strictly_public`.
 *
 * CORS: the library reflects any request `Origin` on its API, token, registration and metadata
 * responses (`withCorsHeaders`, no `Allow-Credentials`). Accepted and documented (TDD 9 amended):
 * auth is a bearer header, so no cookie-authenticated data is exposed. Nothing in this module or
 * the defaultHandler adds CORS headers.
 */
import {
  OAuthProvider,
  type ClientRegistrationCallbackOptions,
  type ClientRegistrationCallbackResult,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../db/schema";
import { createTripsMcpHandler } from "../mcp/handler";
import { oauthDefaultApp } from "./default-handler";
import { logField, type Bindings } from "./http";
import { checkRedirectUris } from "./redirects";

export const MCP_API_ROUTE = "/mcp";
export const AUTHORIZE_ENDPOINT = "/authorize";
export const TOKEN_ENDPOINT = "/oauth/token";
export const REGISTRATION_ENDPOINT = "/oauth/register";
export const CALLBACK_ENDPOINT = "/callback";

/** Paths the dispatcher rate-limits per IP (TDD 5). */
export const OAUTH_RATE_LIMITED_PATHS: ReadonlySet<string> = new Set([
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  REGISTRATION_ENDPOINT,
  CALLBACK_ENDPOINT, // upstream (Access) return leg; same 30/min/IP bucket
]);

export const SCOPES_SUPPORTED = ["trips:read", "trips:write", "offline_access"];
/**
 * Scopes named in the 401 challenge and in the protected-resource metadata (`requiredScopes`).
 * MCP clients request exactly these, and Gemini offers no way to choose. Both are listed so the
 * consent page can offer write access; `trips:write` is unticked there by default, the user
 * decides, and a read-only token still works because the library does not enforce this list.
 */
export const CHALLENGE_SCOPES = ["trips:read", "trips:write"];

const ONE_HOUR = 60 * 60;
const THIRTY_DAYS = 60 * 60 * 24 * 30;

/** Props stored at `completeAuthorization` and decrypted into `ctx.props` for every API call. */
export interface TripsTokenProps {
  userId: string;
}

/** Per-user limit on `/mcp`, same response shape as `mcpRateLimit` on the main hostname. */
async function isUserRateLimited(env: Bindings, userId: string): Promise<boolean> {
  const limiter = env.MCP_RATE_LIMITER;
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: userId });
  return !success;
}

/** RFC 9728 metadata URL for the canonical resource, same derivation as the library's. */
function resourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * 401 invalid_token in the library's own format (`buildWwwAuthenticateHeader` and
 * `createErrorResponse` in workers-oauth-provider): `Bearer realm="OAuth", resource_metadata=...,
 * error="invalid_token", scope="<CHALLENGE_SCOPES>"`, JSON body, `no-store`. Carrying
 * `resource_metadata` lets the client restart discovery and re-authorize.
 */
function invalidTokenResponse(request: Request, env: Bindings): Response {
  let challenge = 'Bearer realm="OAuth"';
  const resource = env.MCP_PUBLIC_URL;
  if (resource && new URL(request.url).origin === new URL(resource).origin) {
    challenge += `, resource_metadata="${resourceMetadataUrl(resource)}"`;
  }
  challenge += `, error="invalid_token", scope="${CHALLENGE_SCOPES.join(" ")}"`;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "Invalid access token" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "WWW-Authenticate": challenge,
    },
  });
}

/** One indexed primary-key read. Second line of defense if a grant ever outlives its user (PRD 11). */
async function userExists(env: Bindings, userId: string): Promise<boolean> {
  const rows = await getDb(env.DB).select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return rows.length > 0;
}

/** API handler for `/mcp` on the MCP hostname. Only reached with a valid bearer token (TDD 5.2). */
const apiHandler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // apiHandler is typed with a plain ExecutionContext; the library sets props and auth.
    const c = ctx as unknown as OAuthResourceContext<TripsTokenProps>;
    const userId = c.props?.userId;
    if (typeof userId !== "string" || userId === "") {
      // A grant without our props shape cannot be served; treat it like an invalid token.
      return invalidTokenResponse(request, env);
    }
    // The token is valid at the library but its user may have been deleted since. Answer 401
    // here; loadRequestContext re-checks as a second line of defense.
    if (!(await userExists(env, userId))) {
      return invalidTokenResponse(request, env);
    }
    if (await isUserRateLimited(env, userId)) {
      return Response.json({ error: "Too many requests" }, { status: 429 });
    }
    const authInfo = {
      token: "", // never carry the bearer token into the MCP layer or its logs
      clientId: c.auth.clientId ?? "",
      scopes: [...c.auth.scope],
      extra: { userId },
    };
    return createTripsMcpHandler(env, ctx).fetch(request, { authInfo });
  },
};

/** DCR policy (TDD 7.4): every `redirect_uris` entry must be on the allow-list. */
function clientRegistrationCallback({
  clientMetadata,
}: ClientRegistrationCallbackOptions): ClientRegistrationCallbackResult | void {
  const problem = checkRedirectUris(clientMetadata.redirect_uris);
  if (problem) return { code: "invalid_redirect_uri", description: problem };
}

/** Logs the OAuth error code and description only; never tokens, codes, secrets or headers. */
function onError({ code, description }: { code: string; description: string }): void {
  console.log(`[oauth] event=error code=${logField(code, 60)} description=${logField(description, 200)}`);
}

/**
 * The full provider configuration, from `env` alone. Throws when `MCP_PUBLIC_URL` is unset,
 * because the library refuses to construct without a canonical resource URL.
 */
export function buildProviderOptions(env: Bindings): OAuthProviderOptions<Bindings> {
  const resource = env.MCP_PUBLIC_URL;
  if (!resource) throw new Error("MCP_PUBLIC_URL is not configured");
  return {
    apiRoute: MCP_API_ROUTE,
    apiHandler,
    defaultHandler: {
      fetch: (request, env, ctx) => oauthDefaultApp.fetch(request, env, ctx),
    },
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientRegistrationEndpoint: REGISTRATION_ENDPOINT,
    scopesSupported: [...SCOPES_SUPPORTED],
    requiredScopes: [...CHALLENGE_SCOPES],
    resourceMetadata: {
      resource, // must equal the URL users enter in Claude or Gemini, exactly
      authorization_servers: [new URL(resource).origin],
      resource_name: "Trips",
    },
    accessTokenTTL: ONE_HOUR,
    refreshTokenTTL: THIRTY_DAYS, // lifetime of a new grant
    refreshTokenIdleTTL: THIRTY_DAYS, // user decision: 30-day sliding idle window, no absolute cap
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationCallback,
    onError,
  };
}

let cached: { resource: string; provider: OAuthProvider<Bindings> } | undefined;

/**
 * One `OAuthProvider` per isolate, built lazily because the resource URL comes from `env`.
 * Rebuilt only if `MCP_PUBLIC_URL` changes (e.g. between test environments).
 */
export function getOAuthProvider(env: Bindings): OAuthProvider<Bindings> {
  const resource = env.MCP_PUBLIC_URL ?? "";
  if (!cached || cached.resource !== resource) {
    cached = { resource, provider: new OAuthProvider<Bindings>(buildProviderOptions(env)) };
  }
  return cached.provider;
}

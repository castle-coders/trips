/**
 * Upstream sign-in through the Cloudflare Access for SaaS OIDC app (TDD 7.2, 7.3).
 *
 *  POST /authorize (approved)  -> redirectToUpstream: PKCE + beginUpstream -> 302 to Access
 *  GET  /callback              -> finishUpstream -> code exchange (client secret + PKCE verifier)
 *                                 -> verify id_token (pinned issuer, audience, RS256, cached JWKS)
 *                                 -> email claim only -> findUserByEmail
 *                                 -> unknown: error page, nothing created
 *                                 -> completeAuthorization -> 302 to the client with the code
 *
 * Configuration comes only from `env` (ACCESS_* and MCP_PUBLIC_URL). The approved scope comes
 * from the AuthRequest that `finishUpstream` recovers (what the user ticked on the consent page),
 * never from the callback query string.
 *
 * Never logged: the authorization code, tokens, id_token, PKCE verifier, state, the client
 * secret, or the user's email. Responses carry no CORS headers.
 */
import type { Hono } from "hono";
import type { AuthRequest, ResumedUpstream } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb } from "../db";
import { findUserByEmail } from "../middleware/auth";
import {
  authorizationErrorRedirect,
  authorizationErrorResponse,
  errorPageResponse,
  getOAuthHelpers,
  logOAuth,
  redirectResponse,
  type Bindings,
  type OAuthAppEnv,
} from "./http";
import { isAllowedRedirect } from "./redirects";
import type { TripsTokenProps } from "./provider";

/** Data stored with the upstream transaction (sealed in OAUTH_KV by the library). */
interface UpstreamData {
  verifier: string;
}

interface UpstreamConfig {
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Access for SaaS signs OIDC ID tokens with RS256. Pinning it also rejects `alg: none`. */
const ID_TOKEN_ALGORITHMS = ["RS256"];
const TOKEN_EXCHANGE_TIMEOUT_MS = 8_000;
const UPSTREAM_SCOPE = "openid email";

const NOT_CONFIGURED_MESSAGE = "Sign-in is not configured for this server.";
const SIGN_IN_FAILED_MESSAGE = "Sign-in with your identity provider did not complete. Please try again.";
const NOT_REGISTERED_MESSAGE =
  "This account is not registered with Trips. Ask a Trips administrator to invite you, then try again.";

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/** Every value must be present; returns null (and logs which names are missing) otherwise. */
function readUpstreamConfig(env: Bindings): UpstreamConfig | null {
  const values = {
    ACCESS_AUTHORIZATION_URL: env.ACCESS_AUTHORIZATION_URL,
    ACCESS_TOKEN_URL: env.ACCESS_TOKEN_URL,
    ACCESS_JWKS_URL: env.ACCESS_JWKS_URL,
    ACCESS_ISSUER: env.ACCESS_ISSUER,
    ACCESS_CLIENT_ID: env.ACCESS_CLIENT_ID,
    ACCESS_CLIENT_SECRET: env.ACCESS_CLIENT_SECRET,
    MCP_PUBLIC_URL: env.MCP_PUBLIC_URL,
  };
  const missing = Object.entries(values)
    .filter(([, v]) => typeof v !== "string" || v.trim() === "")
    .map(([k]) => k);
  if (missing.length) {
    // Names only, never values.
    logOAuth("error", { code: "server_error", description: "upstream not configured", missing: missing.join(",") });
    return null;
  }
  let callbackUrl: string;
  try {
    // Same origin as the protected resource; the Access app must list exactly this URL.
    callbackUrl = `${new URL(values.MCP_PUBLIC_URL!).origin}/callback`;
    new URL(values.ACCESS_AUTHORIZATION_URL!);
    new URL(values.ACCESS_TOKEN_URL!);
    new URL(values.ACCESS_JWKS_URL!);
  } catch {
    logOAuth("error", { code: "server_error", description: "upstream URL config invalid" });
    return null;
  }
  return {
    authorizationUrl: values.ACCESS_AUTHORIZATION_URL!,
    tokenUrl: values.ACCESS_TOKEN_URL!,
    jwksUrl: values.ACCESS_JWKS_URL!,
    issuer: values.ACCESS_ISSUER!,
    clientId: values.ACCESS_CLIENT_ID!,
    clientSecret: values.ACCESS_CLIENT_SECRET!,
    callbackUrl,
  };
}

function notConfiguredResponse(headers?: Headers): Response {
  return errorPageResponse(NOT_CONFIGURED_MESSAGE, 500, headers);
}

// ---------------------------------------------------------------------------------------------
// PKCE and JWKS
// ---------------------------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: 32 random bytes -> 43-character base64url verifier. */
function createPkceVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** One remote JWKS per URL per isolate, as in middleware/auth.ts. jose caches and rotates keys. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(jwksUrl: string) {
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

// ---------------------------------------------------------------------------------------------
// Redirect to Access
// ---------------------------------------------------------------------------------------------

/**
 * Starts the upstream redirect after consent was approved. `authRequest` and `consentHeaders`
 * are `approved.request` and `approved.headers` from `approveConsent()`. `request` is the
 * incoming `POST /authorize`; the callback origin comes from `MCP_PUBLIC_URL`, not from it.
 */
export async function redirectToUpstream(
  env: Bindings,
  _request: Request,
  authRequest: AuthRequest,
  consentHeaders: Headers,
): Promise<Response> {
  const config = readUpstreamConfig(env);
  // Keep the consent cookie clear so a stale handle cookie does not linger.
  if (!config) return notConfiguredResponse(consentHeaders);

  const verifier = createPkceVerifier();
  const challenge = await s256Challenge(verifier);
  const data: UpstreamData = { verifier };
  const { state, headers } = await getOAuthHelpers(env).beginUpstream(authRequest, {
    data,
    headers: consentHeaders, // keeps the consent clear and adds the upstream binding cookie
  });

  const location = new URL(config.authorizationUrl);
  location.searchParams.set("response_type", "code");
  location.searchParams.set("client_id", config.clientId);
  location.searchParams.set("redirect_uri", config.callbackUrl);
  location.searchParams.set("scope", UPSTREAM_SCOPE);
  location.searchParams.set("state", state);
  location.searchParams.set("code_challenge", challenge);
  location.searchParams.set("code_challenge_method", "S256");

  logOAuth("upstream", { client: authRequest.clientId, step: "redirect" });
  return redirectResponse(location.toString(), headers);
}

// ---------------------------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------------------------

/** Error redirect to the client when its (library-validated) redirect URI is on our allow-list. */
function clientErrorRedirectOrPage(
  original: AuthRequest,
  code: "access_denied" | "server_error",
  pageMessage: string,
  headers: Headers,
): Response {
  if (isAllowedRedirect(original.redirectUri)) {
    return redirectResponse(authorizationErrorRedirect(original, code), headers);
  }
  return errorPageResponse(pageMessage, code === "server_error" ? 502 : 400, headers);
}

/** POSTs the code to Access. Returns the raw id_token or a short, safe failure reason. */
async function exchangeCode(
  config: UpstreamConfig,
  code: string,
  verifier: string,
): Promise<{ idToken: string } | { failure: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier,
  });
  let res: Response;
  try {
    res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { failure: name === "TimeoutError" ? "token exchange timeout" : "token exchange network error" };
  }
  if (!res.ok) {
    // The body may echo request details; it is discarded unread.
    await res.body?.cancel();
    return { failure: `token exchange status ${res.status}` };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { failure: "token response not json" };
  }
  const idToken = (json as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== "string" || idToken === "") return { failure: "no id_token" };
  return { idToken };
}

/** Verifies the ID token and returns its `email` claim, or null. Only the email is read. */
async function verifiedEmail(config: UpstreamConfig, idToken: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(idToken, getJWKS(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
      requiredClaims: ["exp"],
    });
    const email = payload.email;
    // Same lookup as middleware/auth.ts: the email exactly as the identity provider sends it.
    return typeof email === "string" && email.trim() !== "" ? email : null;
  } catch {
    return null;
  }
}

export function registerUpstreamRoutes(app: Hono<OAuthAppEnv>): void {
  app.get("/callback", async (c) => {
    const env = c.env;
    const url = new URL(c.req.url);
    const oauth = getOAuthHelpers(env);

    // Recovers the consent-approved request; throws AuthorizationError on a missing, unbound,
    // expired or replayed state. Single-use: this consumes it.
    let resumed: ResumedUpstream<UpstreamData>;
    try {
      resumed = await oauth.finishUpstream<UpstreamData>(c.req.raw);
    } catch (err) {
      return authorizationErrorResponse(err);
    }
    const { request: original, data, headers } = resumed;
    const client = original.clientId;

    // The user cancelled or Access refused. The upstream error_description is never echoed.
    const upstreamError = url.searchParams.get("error");
    if (upstreamError !== null) {
      logOAuth("upstream", { client, step: "callback", code: "access_denied" });
      return clientErrorRedirectOrPage(original, "access_denied", SIGN_IN_FAILED_MESSAGE, headers);
    }

    const config = readUpstreamConfig(env);
    if (!config) return notConfiguredResponse(headers);

    const code = url.searchParams.get("code");
    const verifier = data?.verifier;
    if (!code || typeof verifier !== "string" || verifier === "") {
      logOAuth("upstream", { client, step: "callback", code: "invalid_request", description: "missing code or verifier" });
      return errorPageResponse(SIGN_IN_FAILED_MESSAGE, 400, headers);
    }

    const exchanged = await exchangeCode(config, code, verifier);
    if ("failure" in exchanged) {
      logOAuth("upstream", { client, step: "exchange", code: "server_error", description: exchanged.failure });
      return errorPageResponse(SIGN_IN_FAILED_MESSAGE, 502, headers);
    }

    const email = await verifiedEmail(config, exchanged.idToken);
    if (!email) {
      logOAuth("upstream", { client, step: "verify", code: "access_denied", description: "id_token rejected" });
      return errorPageResponse(SIGN_IN_FAILED_MESSAGE, 401, headers);
    }

    const user = await findUserByEmail(getDb(env.DB), email);
    if (!user) {
      // Create nothing. The email is not logged.
      logOAuth("upstream", { client, step: "lookup", code: "access_denied", description: "unknown user" });
      return errorPageResponse(NOT_REGISTERED_MESSAGE, 403, headers, "Account not registered");
    }

    const props: TripsTokenProps = { userId: user.id };
    let redirectTo: string;
    try {
      ({ redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: user.id,
        metadata: {},
        scope: original.scope, // as approved on the consent page
        props,
      }));
    } catch (err) {
      return authorizationErrorResponse(err, headers);
    }

    logOAuth("upstream", { client, step: "complete", user: user.id, scopes: original.scope.join(",") });
    return redirectResponse(redirectTo, headers);
  });
}

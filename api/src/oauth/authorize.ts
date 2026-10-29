/**
 * Consent routes on the MCP hostname: `GET /authorize` and `POST /authorize` (TDD 7.2).
 *
 *  GET  /authorize  parseAuthRequest -> redirect allow-list -> describeConsent -> beginConsent
 *                   -> consent page, sent with the beginConsent headers (anti-framing, binding cookie)
 *  POST /authorize  deny:    denyConsent -> 302 to the client with error=access_denied
 *                   approve: approveConsent -> narrow to the ticked scopes -> redirectToUpstream
 *
 * The redirect allow-list (`isAllowedRedirect`) is enforced here for every client, because CIMD
 * clients and `createClient()` seeds never pass through `clientRegistrationCallback`
 * (MCP_SPIKE_RESULTS 5; TDD 7.4 orchestrator amendment). A failure renders a local page and
 * never redirects.
 *
 * Library helpers throw `AuthorizationError` (bad request, replayed or unbound handle); those
 * propagate to the defaultHandler's `onError` (`authorizationErrorResponse`).
 *
 * Never logged: the handle, state, code challenge, cookies. Only client id, decision, scopes.
 *
 * Owned by the consent target. `default-handler.ts` calls `registerAuthorizeRoutes(app)`.
 */
import type { Hono } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  authorizationErrorRedirect,
  errorPageResponse,
  getOAuthHelpers,
  htmlSecurityHeaders,
  logOAuth,
  redirectResponse,
  type OAuthAppEnv,
} from "./http";
import { isAllowedRedirect } from "./redirects";
import { offeredScopes, renderConsentPage } from "./consent-page";
import { redirectToUpstream } from "./upstream";

const REDIRECT_NOT_ALLOWED =
  "This app asked to send your sign-in to an address Trips does not allow, so the connection was stopped.";

/** Normalizes a multipart/urlencoded field to a list of strings (Files are dropped). */
function formStrings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter((v): v is string => typeof v === "string");
}

function formString(value: unknown): string {
  return formStrings(value)[0] ?? "";
}

/** Page headers: the shared HTML security headers plus every beginConsent header (cookie included). */
function consentPageHeaders(consentHeaders: Headers): Headers {
  const headers = htmlSecurityHeaders();
  consentHeaders.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") headers.append(key, value);
    // Keep the library's anti-framing headers; its CSP (frame-ancestors 'none') is a subset of ours,
    // so ours is kept for Content-Security-Policy.
    else if (key.toLowerCase() !== "content-security-policy") headers.set(key, value);
  });
  return headers;
}

/**
 * Error redirect back to the client for a request whose consent was already consumed, or a local
 * page when its redirect URI is outside the allow-list. `headers` carries the cookie clear.
 */
function deniedResponse(request: AuthRequest, headers: Headers, description: string): Response {
  if (!isAllowedRedirect(request.redirectUri)) {
    logOAuth("error", { client: request.clientId, code: "invalid_request", description: "redirect_uri not allowed" });
    return errorPageResponse(REDIRECT_NOT_ALLOWED, 400, headers);
  }
  return redirectResponse(authorizationErrorRedirect(request, "access_denied", description), headers);
}

export function registerAuthorizeRoutes(app: Hono<OAuthAppEnv>): void {
  app.get("/authorize", async (c) => {
    const oauth = getOAuthHelpers(c.env);
    const authRequest = await oauth.parseAuthRequest(c.req.raw);

    if (!isAllowedRedirect(authRequest.redirectUri)) {
      logOAuth("error", { client: authRequest.clientId, code: "invalid_request", description: "redirect_uri not allowed" });
      return errorPageResponse(REDIRECT_NOT_ALLOWED, 400);
    }

    logOAuth("authorize", { client: authRequest.clientId });

    const description = await oauth.describeConsent(authRequest);
    const { handle, headers } = await oauth.beginConsent(authRequest);
    const html = renderConsentPage({ description, handle, requestedScopes: authRequest.scope });
    return new Response(html, { status: 200, headers: consentPageHeaders(headers) });
  });

  app.post("/authorize", async (c) => {
    const oauth = getOAuthHelpers(c.env);
    const form = await c.req.parseBody({ all: true });
    const handle = formString(form.handle);
    const decision = formString(form.decision);
    const ticked = formStrings(form.scope);

    if (decision !== "approve" && decision !== "deny") {
      // Handle left unconsumed: the user can go back and submit the form again.
      return errorPageResponse("The consent form was not submitted correctly. Please try again.", 400);
    }

    // Deny, or approve with nothing ticked: an empty grant is pointless, so it is a refusal.
    if (decision === "deny" || ticked.length === 0) {
      const denied = await oauth.denyConsent(c.req.raw, handle, {
        description: decision === "deny" ? "The user denied access" : "The user approved no permissions",
      });
      logOAuth("consent", { client: denied.request.clientId, decision: "deny", scopes: "-" });
      if (!isAllowedRedirect(denied.request.redirectUri)) {
        logOAuth("error", { client: denied.request.clientId, code: "invalid_request", description: "redirect_uri not allowed" });
        return errorPageResponse(REDIRECT_NOT_ALLOWED, 400, denied.headers);
      }
      // denied.headers already holds Location (the client redirect with error=access_denied).
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // Approve without `scope`, so `approved.request.scope` is still what the client requested and
    // the ticked boxes can be checked against it. The library's `scope` option only replaces
    // `request.scope` (oauth-consent.ts approveConsent) and would accept any supported scope,
    // which would let a forged POST add scopes the client never asked for.
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const original = approved.request;
    const allowed = new Set(offeredScopes(original.scope));
    const scope = [...new Set(ticked)].filter((s) => allowed.has(s));

    if (!isAllowedRedirect(original.redirectUri)) {
      logOAuth("error", { client: original.clientId, code: "invalid_request", description: "redirect_uri not allowed" });
      return errorPageResponse(REDIRECT_NOT_ALLOWED, 400, approved.headers);
    }

    if (scope.length === 0) {
      // Only reachable with a forged form: every ticked value was outside the offered set.
      logOAuth("consent", { client: original.clientId, decision: "deny", scopes: "-" });
      return deniedResponse(original, approved.headers, "The user approved no permissions");
    }

    logOAuth("consent", { client: original.clientId, decision: "approve", scopes: scope.join(",") });
    return redirectToUpstream(c.env, c.req.raw, { ...original, scope }, approved.headers);
  });
}

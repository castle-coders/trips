/**
 * Shared helpers for the MCP-hostname defaultHandler (consent and upstream routes).
 *
 * Owned by the provider target. The consent (`authorize.ts`) and upstream (`upstream.ts`)
 * builders import from here; they do not edit it.
 *
 * Rules every route on the MCP hostname follows:
 *  - No CORS headers (TDD 9). The library adds CORS only to its own token, registration,
 *    metadata and API responses (MCP_SPIKE_RESULTS 12), never to defaultHandler responses.
 *  - Never log tokens, authorization codes, the upstream client secret, handles or state.
 *    Use `logOAuth()`; it only accepts short, sanitized fields.
 *  - Library helpers (`parseAuthRequest`, `approveConsent`, `denyConsent`, `finishUpstream`)
 *    throw `AuthorizationError`. Either catch and pass the error to `authorizationErrorResponse`,
 *    or let it propagate: the defaultHandler's `onError` does the same thing.
 */
import {
  AuthorizationError,
  CimdFetchError,
  type AuthorizationErrorCode,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../db";
import { isAllowedRedirect } from "./redirects";

export type Bindings = Env["Bindings"];

/** Hono env for the defaultHandler app. `OAUTH_PROVIDER` is set by the library before dispatch. */
export type OAuthAppEnv = { Bindings: Bindings };

/** The library's helper API, as set on `env` inside `OAuthProvider.fetch` (MCP hostname only). */
export function getOAuthHelpers(env: Bindings): OAuthHelpers {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) throw new Error("OAUTH_PROVIDER helpers are not available outside the OAuth provider");
  return helpers;
}

// ---------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------

/**
 * Formats one log value: control characters stripped, length capped, and JSON-quoted when it
 * contains whitespace, quotes or `=`, so a field cannot forge extra `k=v` pairs or lines.
 */
export function logField(value: unknown, max = 120): string {
  if (value === undefined || value === null || value === "") return "-";
  const s = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const clipped = s.length > max ? `${s.slice(0, max)}...` : s;
  if (clipped === "") return "-";
  return /[\s"=\\]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

/**
 * Structured OAuth log line, TDD 10: `[oauth] event=<event> k=v ...`.
 * Only pass identifiers that are safe to log (client id, user id, error code, description).
 * Never pass tokens, codes, secrets, handles, state or verifiers.
 */
export function logOAuth(
  event: "authorize" | "consent" | "upstream" | "token" | "register" | "error",
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const parts = [`[oauth] event=${event}`];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${logField(v)}`);
  console.log(parts.join(" "));
}

// ---------------------------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------------------------

/** Escapes text for HTML element content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Security headers for every HTML page served on the MCP hostname. No CORS.
 *
 * Note for the consent page: do NOT add `form-action 'self'` to its CSP. Chrome applies
 * `form-action` to the redirect that follows a form POST, which would block
 * `POST /authorize` -> 302 to the Access authorization URL. The `beginConsent()` headers already
 * carry `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
 */
export function htmlSecurityHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}

/** Minimal page shell with inline CSS. `bodyHtml` must already be escaped. */
export function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f7f9; color: #1f2328; margin: 0; }
  main { max-width: 32rem; margin: 3rem auto; background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 1.5rem 1.75rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { line-height: 1.5; }
  .muted { color: #57606a; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

/**
 * A local error page. `message` is plain text and is escaped here. Pass only wire-safe text:
 * an `AuthorizationError.description`, or a fixed string. Never an exception message.
 */
export function errorPageResponse(
  message: string,
  status = 400,
  extraHeaders?: Headers,
  title = "Sign-in could not continue",
): Response {
  const headers = htmlSecurityHeaders();
  // Keep cookie clears from library helpers (finishUpstream / denyConsent headers) if passed.
  extraHeaders?.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") headers.append(key, value);
  });
  const body = renderPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">You can close this window and start the connection again from your app.</p>`,
  );
  return new Response(body, { status, headers });
}

/** 302 to `location` with `Cache-Control: no-store`, keeping any headers (cookies) passed in. */
export function redirectResponse(location: string, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}

/**
 * Turns any error thrown inside a defaultHandler route into a safe response.
 *
 *  - `AuthorizationError` with `redirectTo` (library-validated redirect URI) whose `redirectUri`
 *    also passes `isAllowedRedirect`: 302 back to the client with `error`, `state` and `iss`.
 *    A library-validated URI outside the allow-list (CIMD or seeded client) gets a local page.
 *  - `AuthorizationError` without `redirectTo`: local page with the wire-safe description.
 *  - `CimdFetchError`: local page; the client's metadata document could not be loaded.
 *  - Anything else: generic 500 page. Only the error class name is logged.
 */
export function authorizationErrorResponse(err: unknown, headers?: Headers): Response {
  if (err instanceof AuthorizationError) {
    logOAuth("error", { code: err.code, description: err.description });
    if (err.redirectTo && err.redirectUri && isAllowedRedirect(err.redirectUri)) {
      return redirectResponse(err.redirectTo, headers);
    }
    return errorPageResponse(err.description, err.code === "server_error" ? 500 : 400, headers);
  }
  if (err instanceof CimdFetchError) {
    logOAuth("error", { code: "invalid_client", description: err.reason });
    return errorPageResponse("The app's client metadata could not be loaded.", 400, headers);
  }
  logOAuth("error", { code: "server_error", description: err instanceof Error ? err.name : "unknown" });
  return errorPageResponse("Something went wrong. Please try again.", 500, headers);
}

/**
 * Error redirect to a client for a request the library already validated (from
 * `parseAuthRequest`, `approveConsent` or `finishUpstream`). Re-export of the library helper so
 * route owners import everything from one place.
 */
export { authorizationErrorRedirect, AuthorizationError } from "@cloudflare/workers-oauth-provider";
export type { AuthorizationErrorCode };

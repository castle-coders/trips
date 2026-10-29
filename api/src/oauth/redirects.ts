/**
 * Redirect URI allow-list for OAuth clients on the MCP hostname (TDD 7.4).
 *
 * One function backs two checks:
 *  - `clientRegistrationCallback` (DCR, `/oauth/register`): every registered URI must pass.
 *  - `GET`/`POST /authorize` (consent builder): the parsed `authRequest.redirectUri` must pass,
 *    because CIMD clients and `createClient()` seeds never go through the registration callback
 *    (MCP_SPIKE_RESULTS 5; TDD 7.4 amended by orchestrator).
 *
 * These are fixed third-party callback targets named by the product spec (PRD 4.2, 6.3), not
 * deployment configuration, so they live in code rather than `env`.
 *
 * Allowed:
 *  - exactly `https://claude.ai/api/mcp/auth_callback`
 *  - exactly `https://vertexaisearch.cloud.google.com/oauth-redirect`
 *  - `https://oauth-redirect.googleusercontent.com/<any path>` (exact host, default port)
 *  - loopback `http://localhost[:port]/...` and `http://127.0.0.1[:port]/...` (any port)
 *
 * Never allowed: userinfo (`user@host`), fragments, non-default ports on the https targets,
 * look-alike hosts (`oauth-redirect.googleusercontent.com.evil.com`), the trusted host appearing
 * only in the path, `[::1]` and other loopback spellings, and any non-canonical spelling that the
 * URL parser would have to normalize (upper-case host, backslashes, missing slashes). The raw
 * string must already be in canonical form, because the library compares redirect URIs as exact
 * strings at `/authorize` and at the token endpoint (MCP_SPIKE_RESULTS 7).
 */

const EXACT_HTTPS_REDIRECTS: ReadonlySet<string> = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://vertexaisearch.cloud.google.com/oauth-redirect",
]);

/** Host whose every https path is allowed (Google OAuth redirect relay). */
const GOOGLE_RELAY_HOST = "oauth-redirect.googleusercontent.com";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** True when `uri` is an allowed OAuth redirect target for this server. */
export function isAllowedRedirect(uri: string): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return false;
  // No whitespace, control characters, backslashes or fragments anywhere in the raw string.
  if (/[\s\\#\u0000-\u001f\u007f]/.test(uri)) return false;

  const url = parse(uri);
  if (!url) return false;
  if (url.username !== "" || url.password !== "") return false;

  if (EXACT_HTTPS_REDIRECTS.has(uri)) return true;

  if (url.protocol === "https:") {
    return (
      url.hostname === GOOGLE_RELAY_HOST &&
      url.port === "" &&
      // Canonical spelling only: scheme, host and the first path slash exactly as written.
      uri.startsWith(`https://${GOOGLE_RELAY_HOST}/`)
    );
  }

  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
    const prefix = `http://${url.hostname}`;
    // Next char after the host must be ":" (port) or "/" (path); rejects "localhost.evil.com"
    // and any spelling the parser normalized (e.g. "http://LOCALHOST/").
    return uri.startsWith(`${prefix}:`) || uri.startsWith(`${prefix}/`);
  }

  return false;
}

/**
 * Validates the `redirect_uris` member of a raw DCR body. Returns `null` when every URI is
 * allowed, or a wire-safe description of the problem. The description never echoes the URI.
 */
export function checkRedirectUris(redirectUris: unknown): string | null {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return "redirect_uris must be a non-empty array";
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string") return "redirect_uris must contain only strings";
    if (!isAllowedRedirect(uri)) return "redirect_uri not allowed";
  }
  return null;
}

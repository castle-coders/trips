// Stage 2 OAuth test helpers: a Stage 2 env, a cookie jar, PKCE, an upstream (Access for SaaS)
// stub with a local RS256 JWKS, and a full browser-style sign-in through the real Worker export.
//
// Every request goes through `worker.fetch` (src/index.ts), so the dispatcher, the query-token
// check, the per-IP limiter and the OAuth provider all run exactly as deployed.
//
// All hostnames, ids and secrets here are obviously fake test values (example.test).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, vi } from "vitest";
import type { Env } from "../../src/db";
import worker from "../../src/index";
import { parseRpc, rpcBody, type RpcReply } from "./mcp";

export type Bindings = Env["Bindings"];

export const MCP_HOST = "mcp.example.test";
export const MCP_ORIGIN = `https://${MCP_HOST}`;
export const MCP_PUBLIC_URL = `${MCP_ORIGIN}/mcp`;
export const MAIN_ORIGIN = "https://example.test";

/** Fake Access for SaaS OIDC app. */
export const ACCESS_BASE = "https://team.access.example.test/cdn-cgi/access/sso/oidc/fake-app";
export const ACCESS_AUTHORIZATION_URL = `${ACCESS_BASE}/authorization`;
export const ACCESS_TOKEN_URL = `${ACCESS_BASE}/token`;
export const ACCESS_JWKS_URL = `${ACCESS_BASE}/jwks`;
export const ACCESS_ISSUER = ACCESS_BASE;
export const ACCESS_CLIENT_ID = "fake-upstream-client-id";
export const ACCESS_CLIENT_SECRET = "fake-upstream-client-secret-0000";

/** Fake values the upstream stub hands back; asserted absent from logs. */
export const UPSTREAM_CODE = "fake-upstream-auth-code";
export const UPSTREAM_ACCESS_TOKEN = "fake-upstream-access-token";

export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const VERTEX_REDIRECT = "https://vertexaisearch.cloud.google.com/oauth-redirect";
export const GOOGLE_RELAY_REDIRECT = "https://oauth-redirect.googleusercontent.com/r/fake-project";
export const LOOPBACK_REDIRECT = "http://127.0.0.1:5555/callback";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const JWK = { ...(await exportJWK(publicKey)), kid: "fake-kid-1", alg: "RS256", use: "sig" };

/** Stage 2 on: MCP_HOST, MCP_PUBLIC_URL and the fake upstream config over the test bindings. */
export function stage2Env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ...(env as unknown as Bindings),
    MCP_HOST,
    MCP_PUBLIC_URL,
    ACCESS_AUTHORIZATION_URL,
    ACCESS_TOKEN_URL,
    ACCESS_JWKS_URL,
    ACCESS_ISSUER,
    ACCESS_CLIENT_ID,
    ACCESS_CLIENT_SECRET,
    ...overrides,
  };
}

function randomTestIp(): string {
  const b = crypto.getRandomValues(new Uint8Array(2));
  return `198.51.${b[0]}.${b[1]}`; // TEST-NET-2-ish; unique per request so limits never collide
}

/**
 * Dispatch through the real Worker export. A random `cf-connecting-ip` is added unless the
 * request sets one, so the per-IP OAuth limiter only trips in the tests that aim at it.
 */
export async function send(req: Request, e: Bindings = stage2Env()): Promise<Response> {
  if (!req.headers.has("cf-connecting-ip")) {
    const headers = new Headers(req.headers);
    headers.set("cf-connecting-ip", randomTestIp());
    req = new Request(req, { headers });
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function mcpUrl(path: string): string {
  return `${MCP_ORIGIN}${path}`;
}

// ---------------------------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------------------------

/** Set-Cookie lines; workerd has getSetCookie(), the pinned workers-types do not declare it. */
export function setCookies(h: Headers): string[] {
  return (h as unknown as { getSetCookie(): string[] }).getSetCookie();
}

/** Minimal browser cookie jar: absorbs Set-Cookie, drops cleared cookies, emits a Cookie header. */
export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response): this {
    for (const line of setCookies(res.headers)) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const cleared = value === "" || attrs.some((a: string) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }
}

// ---------------------------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------------------------
// Upstream stub
// ---------------------------------------------------------------------------------------------

export function signIdToken(
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: JWK.kid })
    .setIssuer(opts.iss ?? ACCESS_ISSUER)
    .setAudience(opts.aud ?? ACCESS_CLIENT_ID)
    .setIssuedAt(now - 10)
    .setExpirationTime(opts.exp ?? now + 300)
    .sign(privateKey);
}

export interface UpstreamStub {
  /** Form bodies POSTed to the upstream token endpoint. */
  tokenCalls: URLSearchParams[];
  /** The id_tokens handed out, so tests can assert they never reach a log. */
  idTokens: string[];
  /** Every URL fetched by the Worker that is not the upstream (should stay empty). */
  otherFetches: string[];
}

/**
 * Spies on global fetch: the Access JWKS and token URLs are answered locally; the token
 * endpoint returns an id_token for `email` (or whatever `idToken` produces). Anything else is
 * recorded and passed through.
 */
export function stubUpstream(emailOrFactory: string | (() => Promise<string>)): UpstreamStub {
  const stub: UpstreamStub = { tokenCalls: [], idTokens: [], otherFetches: [] };
  const factory =
    typeof emailOrFactory === "string" ? () => signIdToken({ email: emailOrFactory, sub: "fake-sub" }) : emailOrFactory;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === ACCESS_JWKS_URL) return Response.json({ keys: [JWK] });
    if (url === ACCESS_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      stub.tokenCalls.push(body);
      const idToken = await factory();
      stub.idTokens.push(idToken);
      return Response.json({ access_token: UPSTREAM_ACCESS_TOKEN, token_type: "Bearer", id_token: idToken });
    }
    stub.otherFetches.push(url);
    return real(input, init);
  });
  return stub;
}

// ---------------------------------------------------------------------------------------------
// Client registration and the browser flow
// ---------------------------------------------------------------------------------------------

export function register(body: Record<string, unknown>, e?: Bindings, headers: Record<string, string> = {}): Promise<Response> {
  return send(
    new Request(mcpUrl("/oauth/register"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    e,
  );
}

export async function registerPublicClient(
  redirectUris: string[] = [LOOPBACK_REDIRECT],
  clientName = "Fake Test Client",
  e?: Bindings,
): Promise<string> {
  const res = await register({ redirect_uris: redirectUris, token_endpoint_auth_method: "none", client_name: clientName }, e);
  const json = (await res.json()) as { client_id?: string };
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json.client_id!;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  challenge?: string | null;
  method?: string | null;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? LOOPBACK_REDIRECT,
    scope: p.scope ?? "trips:read trips:write offline_access",
    state: p.state ?? "fake-client-state",
    resource: MCP_PUBLIC_URL,
  });
  if (p.challenge !== null && p.challenge !== undefined) q.set("code_challenge", p.challenge);
  if (p.method !== null && p.method !== undefined) q.set("code_challenge_method", p.method);
  return mcpUrl(`/authorize?${q}`);
}

/** Pulls the consent handle out of the consent page form. */
export function consentHandle(html: string): string {
  const m = /name="handle" value="([^"]+)"/.exec(html);
  expect(m, "consent page has a handle field").not.toBeNull();
  return m![1];
}

export function postConsent(
  jar: CookieJar,
  handle: string,
  decision: "approve" | "deny",
  scopes: string[],
  e?: Bindings,
): Promise<Response> {
  const form = new URLSearchParams({ handle, decision });
  for (const s of scopes) form.append("scope", s);
  return send(
    new Request(mcpUrl("/authorize"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: form,
    }),
    e,
  );
}

export function callback(jar: CookieJar, upstreamRedirect: Response, extra: Record<string, string> = { code: UPSTREAM_CODE }, e?: Bindings): Promise<Response> {
  const state = new URL(upstreamRedirect.headers.get("Location")!).searchParams.get("state")!;
  const q = new URLSearchParams({ ...extra, state });
  return send(new Request(mcpUrl(`/callback?${q}`), { headers: { cookie: jar.header() } }), e);
}

export function tokenRequest(params: Record<string, string>, e?: Bindings, headers: Record<string, string> = {}): Promise<Response> {
  return send(
    new Request(mcpUrl("/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(params),
    }),
    e,
  );
}

export function exchangeCode(clientId: string, code: string, verifier: string, redirectUri = LOOPBACK_REDIRECT, e?: Bindings) {
  return tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: MCP_PUBLIC_URL },
    e,
  );
}

export function refreshTokens(clientId: string, refreshToken: string, e?: Bindings) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, e);
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface SignInResult {
  clientId: string;
  verifier: string;
  code: string;
  /** The final redirect back to the client. */
  clientRedirect: URL;
  tokens: TokenResponse;
  upstream: UpstreamStub;
}

/**
 * The whole browser flow for an already-seeded `email`: DCR register, GET /authorize, approve
 * the given `ticked` scopes, follow the upstream redirect to /callback (stubbed Access), exchange
 * the code. Asserts each step's status.
 */
export async function signIn(
  email: string,
  opts: { ticked?: string[]; requested?: string; redirectUri?: string; clientName?: string; e?: Bindings } = {},
): Promise<SignInResult> {
  const e = opts.e ?? stage2Env();
  const redirectUri = opts.redirectUri ?? LOOPBACK_REDIRECT;
  const upstream = stubUpstream(email);
  const clientId = await registerPublicClient([redirectUri], opts.clientName, e);
  const { verifier, challenge } = await pkce();
  const jar = new CookieJar();

  const page = await send(
    new Request(authorizeUrl({ clientId, redirectUri, scope: opts.requested, challenge, method: "S256" })),
    e,
  );
  const html = await page.text();
  expect(page.status, html.slice(0, 500)).toBe(200);
  jar.absorb(page);

  const approved = await postConsent(jar, consentHandle(html), "approve", opts.ticked ?? ["trips:read", "offline_access"], e);
  expect(approved.status).toBe(302);
  expect(approved.headers.get("Location")!.startsWith(ACCESS_AUTHORIZATION_URL)).toBe(true);
  jar.absorb(approved);

  const cb = await callback(jar, approved, undefined, e);
  expect(cb.status, await cb.clone().text()).toBe(302);
  const clientRedirect = new URL(cb.headers.get("Location")!);
  const code = clientRedirect.searchParams.get("code")!;
  expect(code).toBeTruthy();

  const tokenRes = await exchangeCode(clientId, code, verifier, redirectUri, e);
  const tokens = (await tokenRes.json()) as TokenResponse;
  expect(tokenRes.status, JSON.stringify(tokens)).toBe(200);
  return { clientId, verifier, code, clientRedirect, tokens, upstream };
}

// ---------------------------------------------------------------------------------------------
// MCP over the bearer token
// ---------------------------------------------------------------------------------------------

export async function mcpRpc(
  accessToken: string | null,
  method: string,
  params?: unknown,
  opts: { e?: Bindings; path?: string; headers?: Record<string, string> } = {},
): Promise<RpcReply> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...opts.headers,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await send(
    new Request(mcpUrl(opts.path ?? "/mcp"), { method: "POST", headers, body: JSON.stringify(rpcBody(method, params)) }),
    opts.e,
  );
  return parseRpc(res);
}

export function mcpCall(accessToken: string, name: string, args: Record<string, unknown> = {}, e?: Bindings) {
  return mcpRpc(accessToken, "tools/call", { name, arguments: args }, { e });
}

/** Main-hostname request through the /api prefix, as `email` via the DEV_MODE header. */
export function asMain(email: string | null, path: string, init: RequestInit = {}, e: Bindings = stage2Env()): Promise<Response> {
  const headers = new Headers(init.headers);
  if (email) headers.set("X-Dev-User-Email", email);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return send(new Request(`${MAIN_ORIGIN}/api${path}`, { ...init, headers }), e);
}

/** Number of OAUTH_KV keys under `prefix`. */
export async function kvCount(prefix: string): Promise<number> {
  return (await (env as unknown as Bindings).OAUTH_KV.list({ prefix })).keys.length;
}

/** Captures every console.* line for the duration of a test (restored by vi.restoreAllMocks). */
export function captureConsole(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]) =>
    void lines.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : JSON.stringify(a))).join(" "));
  for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(push);
  return lines;
}

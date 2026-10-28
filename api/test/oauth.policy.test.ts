// Stage 2 OAuth policy on the MCP host (TDD 5, 5.2, 7.1, 7.4, 9; PRD 4.2, 6.3, 7):
// DCR redirect allow-list, allow-list at /authorize for seeded clients, PKCE, query-string
// tokens, discovery (401 challenge, RFC 9728 and RFC 8414 metadata), CORS, rate limits, and
// main-hostname behavior while MCP_HOST is set.
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderOptions } from "../src/oauth/provider";
import { seedUser } from "./helpers";
import {
  CLAUDE_REDIRECT,
  CookieJar,
  GOOGLE_RELAY_REDIRECT,
  LOOPBACK_REDIRECT,
  MAIN_ORIGIN,
  MCP_HOST,
  MCP_ORIGIN,
  MCP_PUBLIC_URL,
  VERTEX_REDIRECT,
  asMain,
  authorizeUrl,
  exchangeCode,
  kvCount,
  mcpCall,
  mcpRpc,
  pkce,
  postConsent,
  register,
  registerPublicClient,
  send,
  setCookies,
  signIn,
  stage2Env,
  stubUpstream,
  tokenRequest,
} from "./helpers/oauth";
import { RATE_LIMIT_TEST_TIMEOUT_MS, awaitFreshRateWindow } from "./helpers/ratelimit";

afterEach(() => vi.restoreAllMocks());

const MCP_RPC_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

describe("DCR redirect allow-list (/oauth/register)", () => {
  const allowed: Array<[string, string[]]> = [
    ["claude.ai", [CLAUDE_REDIRECT]],
    ["Vertex AI search", [VERTEX_REDIRECT]],
    ["Google redirect relay (any path)", [GOOGLE_RELAY_REDIRECT]],
    ["loopback localhost with port", ["http://localhost:33418/callback"]],
    ["loopback 127.0.0.1 with port", [LOOPBACK_REDIRECT]],
    ["loopback /oauth/callback", ["http://127.0.0.1:7777/oauth/callback"]],
    ["several allowed at once", [CLAUDE_REDIRECT, GOOGLE_RELAY_REDIRECT, "http://localhost:1/callback"]],
  ];
  for (const [name, uris] of allowed) {
    it(`accepts ${name} -> 201`, async () => {
      const res = await register({ redirect_uris: uris, token_endpoint_auth_method: "none", client_name: "Fake" });
      const body = (await res.json()) as any;
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(body.client_id).toBeTruthy();
      expect(body.redirect_uris).toEqual(uris);
      expect(body.client_secret).toBeUndefined();
      expect(await kvCount(`client:${body.client_id}`)).toBe(1);
    });
  }

  const rejected: Array<[string, unknown]> = [
    ["look-alike Google relay host", ["https://oauth-redirect.googleusercontent.com.evil.com/x"]],
    ["Google relay as a subdomain of evil", ["https://oauth-redirect.googleusercontent.com.evil.example.test/x"]],
    ["claude.ai with extra path", ["https://claude.ai/api/mcp/auth_callback/extra"]],
    ["claude.ai with a query", ["https://claude.ai/api/mcp/auth_callback?x=1"]],
    ["claude.ai with a non-default port", ["https://claude.ai:8443/api/mcp/auth_callback"]],
    ["upper-case host", ["https://CLAUDE.AI/api/mcp/auth_callback"]],
    ["trusted URL only in the query of an evil host", ["https://evil.example.test/?r=https://claude.ai/api/mcp/auth_callback"]],
    ["arbitrary https host", ["https://evil.example.test/callback"]],
    ["IPv6 loopback", ["http://[::1]:5555/callback"]],
    ["mixed good and bad list", [CLAUDE_REDIRECT, "https://evil.example.test/cb"]],
    ["mixed bad then good list", ["https://oauth-redirect.googleusercontent.com.evil.com/x", LOOPBACK_REDIRECT]],
  ];
  for (const [name, uris] of rejected) {
    it(`rejects ${name} with invalid_redirect_uri and stores nothing`, async () => {
      const before = await kvCount("client:");
      const res = await register({ redirect_uris: uris, token_endpoint_auth_method: "none", client_name: "Evil" });
      const body = (await res.json()) as any;
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
      expect(body.client_id).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("evil");
      expect(await kvCount("client:")).toBe(before);
    });
  }

  // The library validates redirect URIs (https or loopback http, no userinfo, no fragment) before
  // clientRegistrationCallback runs, so these come back as 400 invalid_client_metadata, not
  // invalid_redirect_uri. Still rejected and nothing stored.
  const libraryRejected: Array<[string, unknown]> = [
    ["plain http non-loopback", ["http://evil.example.test/callback"]],
    ["userinfo before claude.ai", ["https://evil.example.test@claude.ai/api/mcp/auth_callback"]],
    ["claude.ai as userinfo of evil host", ["https://claude.ai@evil.example.test/api/mcp/auth_callback"]],
    ["userinfo on the Google relay", ["https://user:pw@oauth-redirect.googleusercontent.com/x"]],
    ["claude.ai with a fragment", ["https://claude.ai/api/mcp/auth_callback#f"]],
    ["http Google relay", ["http://oauth-redirect.googleusercontent.com/x"]],
    ["localhost look-alike", ["http://localhost.evil.example.test/callback"]],
    ["javascript: scheme", ["javascript:alert(1)"]],
    ["empty list", []],
    ["missing redirect_uris", undefined],
  ];
  for (const [name, uris] of libraryRejected) {
    it(`rejects ${name} (400, library or callback) and stores nothing`, async () => {
      const before = await kvCount("client:");
      const body: Record<string, unknown> = { token_endpoint_auth_method: "none", client_name: "Evil" };
      if (uris !== undefined) body.redirect_uris = uris;
      const res = await register(body);
      const json = (await res.json()) as any;
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(["invalid_redirect_uri", "invalid_client_metadata"]).toContain(json.error);
      expect(await kvCount("client:")).toBe(before);
    });
  }
});

describe("redirect allow-list at /authorize for clients that bypass DCR", () => {
  const BAD = "https://evil.example.test/cb";

  async function seededClient(redirectUris: string[]) {
    const e = stage2Env();
    const api = getOAuthApi(buildProviderOptions(e), e);
    const client = await api.createClient({ clientName: "Seeded", redirectUris, tokenEndpointAuthMethod: "none" });
    return { api, clientId: client.clientId };
  }

  it("GET /authorize for a seeded client with a non-allow-listed redirect -> local 400 page, no redirect, no consent handle", async () => {
    const { clientId } = await seededClient([BAD]);
    const { challenge } = await pkce();
    const res = await send(new Request(authorizeUrl({ clientId, redirectUri: BAD, challenge, method: "S256" })));
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(html).not.toContain('name="handle"');
    expect(html).toContain("does not allow");
    expect(setCookies(res.headers)).toEqual([]);
    expect(await kvCount("consent:")).toBe(0);
  });

  for (const decision of ["approve", "deny"] as const) {
    it(`POST /authorize (${decision}) for a handle minted for a non-allow-listed redirect -> local 400 page, no redirect`, async () => {
      const upstream = stubUpstream("nobody@example.test");
      const { api, clientId } = await seededClient([BAD]);
      const { challenge } = await pkce();
      const authReq = await api.parseAuthRequest(new Request(authorizeUrl({ clientId, redirectUri: BAD, challenge, method: "S256" })));
      const { handle, headers } = await api.beginConsent(authReq);
      const jar = new CookieJar().absorb(new Response(null, { headers }));
      const res = await postConsent(jar, handle, decision, ["trips:read"]);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(upstream.tokenCalls).toHaveLength(0);
    });
  }

  it("a redirect_uri not registered for the client -> local 400 page, never redirected", async () => {
    const clientId = await registerPublicClient([CLAUDE_REDIRECT]);
    const { challenge } = await pkce();
    const res = await send(new Request(authorizeUrl({ clientId, redirectUri: "https://evil.example.test/cb", challenge, method: "S256" })));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("loopback port changes are accepted, but localhost and 127.0.0.1 are not interchangeable", async () => {
    const clientId = await registerPublicClient(["http://localhost:33418/callback"]);
    const { challenge } = await pkce();
    const otherPort = await send(new Request(authorizeUrl({ clientId, redirectUri: "http://localhost:5555/callback", challenge, method: "S256" })));
    expect(otherPort.status).toBe(200);
    const otherHost = await send(new Request(authorizeUrl({ clientId, redirectUri: "http://127.0.0.1:33418/callback", challenge, method: "S256" })));
    expect(otherHost.status).toBe(400);
    expect(otherHost.headers.get("Location")).toBeNull();
  });
});

describe("PKCE", () => {
  async function authorizeError(params: { challenge: string | null; method: string | null }) {
    const clientId = await registerPublicClient();
    const res = await send(new Request(authorizeUrl({ clientId, state: "pkce-state", ...params })));
    return res;
  }

  it("missing code_challenge for a public client -> error redirect invalid_request, no consent page", async () => {
    const res = await authorizeError({ challenge: null, method: null });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("pkce-state");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(await kvCount("consent:")).toBe(0);
  });

  it("code_challenge_method=plain -> error redirect invalid_request", async () => {
    const { verifier } = await pkce();
    const res = await authorizeError({ challenge: verifier, method: "plain" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("code_challenge without a method defaults to plain and is rejected", async () => {
    const { challenge } = await pkce();
    const res = await authorizeError({ challenge, method: null });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("method without a challenge -> invalid_request", async () => {
    const res = await authorizeError({ challenge: null, method: "S256" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("wrong code_verifier -> invalid_grant; missing code_verifier -> rejected; no tokens issued", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, code, verifier } = await signInUpToCode(alice.email);
    const wrong = await exchangeCode(clientId, code, "x".repeat(43));
    expect(wrong.status).toBe(400);
    const wrongBody = (await wrong.json()) as any;
    expect(wrongBody.error).toBe("invalid_grant");
    expect(wrongBody.access_token).toBeUndefined();

    const missing = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: LOOPBACK_REDIRECT, client_id: clientId });
    expect(missing.status).toBe(400);
    expect(["invalid_grant", "invalid_request"]).toContain(((await missing.json()) as any).error);

    // Documented: after failed PKCE attempts, the right verifier still redeems the code.
    const right = await exchangeCode(clientId, code, verifier);
    expect(right.status).toBe(200);
  });
});

/** The flow up to the client redirect, without exchanging the code. */
async function signInUpToCode(email: string) {
  stubUpstream(email);
  const clientId = await registerPublicClient();
  const { verifier, challenge } = await pkce();
  const page = await send(new Request(authorizeUrl({ clientId, challenge, method: "S256" })));
  const html = await page.text();
  const jar = new CookieJar().absorb(page);
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const approved = await postConsent(jar, handle, "approve", ["trips:read"]);
  jar.absorb(approved);
  const state = new URL(approved.headers.get("Location")!).searchParams.get("state")!;
  const cb = await send(new Request(`${MCP_ORIGIN}/callback?code=fake-upstream-auth-code&state=${state}`, { headers: { cookie: jar.header() } }));
  expect(cb.status).toBe(302);
  return { clientId, verifier, code: new URL(cb.headers.get("Location")!).searchParams.get("code")! };
}

describe("bearer header only: credentials in the query string -> 400", () => {
  for (const q of ["access_token=fake", "token=fake", "apiKey=fake", "APIKEY=fake", "apikey=fake", "Access_Token=fake", "x=1&Token=fake"]) {
    it(`POST /mcp?${q} -> 400 invalid_request even with a valid bearer header`, async () => {
      const alice = await seedUser("alice@example.test", "viewer");
      const { tokens } = await signIn(alice.email);
      const res = await mcpRpc(tokens.access_token, "tools/list", {}, { path: `/mcp?${q}` });
      expect(res.status).toBe(400);
      expect(res.message.error).toBe("invalid_request");
      expect(res.raw).not.toContain("fake");
    });
  }

  it("query token without a header -> 400 (not the library's 401)", async () => {
    const res = await mcpRpc(null, "tools/list", {}, { path: "/mcp?access_token=fake" });
    expect(res.status).toBe(400);
  });

  it("applies to every MCP-host path, e.g. /oauth/token?token=", async () => {
    const res = await send(new Request(`${MCP_ORIGIN}/oauth/token?token=fake`, { method: "POST", body: "" }));
    expect(res.status).toBe(400);
  });

  it("a form-body access_token is not accepted as a credential (401)", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { tokens } = await signIn(alice.email);
    const res = await send(
      new Request(`${MCP_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: MCP_RPC_HEADERS.accept },
        body: new URLSearchParams({ access_token: tokens.access_token }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("discovery", () => {
  const RESOURCE_METADATA = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  it("POST /mcp without a token -> 401 with WWW-Authenticate Bearer resource_metadata", async () => {
    const res = await send(new Request(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: MCP_RPC_HEADERS, body: "{}" }));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate")!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
  });

  it("an invalid bearer token -> 401 with the same challenge", async () => {
    const res = await mcpRpc("fake-not-a-real-token", "tools/list");
    expect(res.status).toBe(401);
  });

  it("/.well-known/oauth-protected-resource/mcp resource equals MCP_PUBLIC_URL exactly", async () => {
    const res = await send(new Request(RESOURCE_METADATA));
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.resource).toBe(MCP_PUBLIC_URL);
    expect(meta.authorization_servers).toEqual([MCP_ORIGIN]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta.resource_name).toBe("Trips");
  });

  it("authorization-server metadata advertises S256 only, the three scopes, code flow and our endpoints", async () => {
    const res = await send(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.issuer).toBe(MCP_ORIGIN);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.scopes_supported).toEqual(["trips:read", "trips:write", "offline_access"]);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).not.toContain("implicit");
    expect(meta.grant_types_supported).not.toContain("password");
    expect(meta.grant_types_supported).not.toContain("client_credentials");
    expect(meta.authorization_endpoint).toBe(`${MCP_ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${MCP_ORIGIN}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${MCP_ORIGIN}/oauth/register`);
    expect(meta.client_id_metadata_document_supported).toBe(true);
  });

  it("token endpoint parses form-encoded bodies: unknown client -> 401 invalid_client (RFC 6749 code)", async () => {
    const res = await tokenRequest({ grant_type: "authorization_code", code: "fake", client_id: "fake" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("invalid_client");
  });
});

describe("CORS on the MCP host", () => {
  const ORIGIN = "https://evil.example.test";

  it("defaultHandler pages (/authorize error, /callback error, 404) carry no CORS headers", async () => {
    for (const path of ["/authorize?client_id=nope", "/callback?state=nope", "/some/unknown/path"]) {
      const res = await send(new Request(`${MCP_ORIGIN}${path}`, { headers: { origin: ORIGIN } }));
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
      expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
    }
  });

  // Documented library behavior (TDD 9 amended): token, registration, metadata and API responses
  // reflect any Origin, never with Allow-Credentials. Auth is a bearer header, so no cookie data is exposed.
  it("documents: library reflects Origin on metadata, token, register and /mcp, without Allow-Credentials", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { tokens } = await signIn(alice.email);
    const responses = [
      await send(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`, { headers: { origin: ORIGIN } })),
      await send(new Request(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`, { headers: { origin: ORIGIN } })),
      await tokenRequest({ grant_type: "refresh_token", refresh_token: "fake", client_id: "fake" }, undefined, { origin: ORIGIN }),
      await register({ redirect_uris: [LOOPBACK_REDIRECT], token_endpoint_auth_method: "none" }, undefined, { origin: ORIGIN }),
      await send(
        new Request(`${MCP_ORIGIN}/mcp`, {
          method: "POST",
          headers: { ...MCP_RPC_HEADERS, origin: ORIGIN, authorization: `Bearer ${tokens.access_token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      ),
    ];
    for (const res of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("rate limits", () => {
  // OAUTH_RATE_LIMITER: 30 per 60 s per cf-connecting-ip (wrangler.toml), enforced in the dispatcher.
  const cases: Array<[string, (ip: string) => Promise<Response>]> = [
    ["/authorize", (ip) => send(new Request(`${MCP_ORIGIN}/authorize?client_id=nope`, { headers: { "cf-connecting-ip": ip } }))],
    ["/oauth/token", (ip) => tokenRequest({ grant_type: "refresh_token", refresh_token: "fake", client_id: "fake" }, undefined, { "cf-connecting-ip": ip })],
    ["/oauth/register", (ip) => register({ redirect_uris: ["https://evil.example.test/cb"] }, undefined, { "cf-connecting-ip": ip })],
    // Upstream return leg: no state cookie, so each hit is an error page until the limit trips.
    ["/callback", (ip) => send(new Request(`${MCP_ORIGIN}/callback?code=nope&state=nope`, { headers: { "cf-connecting-ip": ip } }))],
  ];
  cases.forEach(([path, hit], i) => {
    it(`per-IP 429 on ${path} after 30 requests; another IP is not limited`, async () => {
      const ip = `203.0.113.${10 + i}`;
      const statuses: number[] = [];
      await awaitFreshRateWindow(8_000);
      for (let n = 0; n < 32; n++) statuses.push((await hit(ip)).status);
      expect(statuses.slice(0, 30)).not.toContain(429);
      expect(statuses.slice(30)).toContain(429);
      const limited = await hit(ip);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "Too many requests" });
      expect((await hit(`203.0.113.${100 + i}`)).status).not.toBe(429);
    }, RATE_LIMIT_TEST_TIMEOUT_MS);
  });

  it("discovery metadata is not under the per-IP OAuth limit", async () => {
    const ip = "203.0.113.50";
    for (let n = 0; n < 35; n++) {
      const res = await send(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`, { headers: { "cf-connecting-ip": ip } }));
      expect(res.status).toBe(200);
    }
  });

  it("per-user 429 on /mcp after 120 calls (MCP_RATE_LIMITER keyed on userId); another user is not limited", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const bob = await seedUser("bob@example.test", "viewer");
    const a = await signIn(alice.email);
    const b = await signIn(bob.email);
    const statuses: number[] = [];
    await awaitFreshRateWindow(15_000);
    for (let n = 0; n < 122; n++) statuses.push((await mcpRpc(a.tokens.access_token, "tools/list", {})).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120)).toContain(429);
    const limited = await mcpRpc(a.tokens.access_token, "tools/list", {});
    expect(limited.status).toBe(429);
    expect(limited.message).toEqual({ error: "Too many requests" });
    expect((await mcpRpc(b.tokens.access_token, "tools/list", {})).status).toBe(200);
  }, RATE_LIMIT_TEST_TIMEOUT_MS);
});

describe("main hostname while MCP_HOST is set", () => {
  it("REST still answers on the main host (/api/trips with the dev header)", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const res = await asMain(alice.email, "/trips");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("/api/mcp on the main host still needs authMiddleware: no auth -> 401; an OAuth bearer token is not accepted", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { tokens } = await signIn(alice.email);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const anon = await send(new Request(`${MAIN_ORIGIN}/api/mcp`, { method: "POST", headers: MCP_RPC_HEADERS, body }));
    expect(anon.status).toBe(401);
    const bearer = await send(
      new Request(`${MAIN_ORIGIN}/api/mcp`, { method: "POST", headers: { ...MCP_RPC_HEADERS, authorization: `Bearer ${tokens.access_token}` }, body }),
    );
    expect(bearer.status).toBe(401);
    // And with the Stage 1 credential it works as before.
    const dev = await asMain(alice.email, "/mcp", { method: "POST", headers: MCP_RPC_HEADERS, body });
    expect(dev.status).toBe(200);
  });

  it("OAuth endpoints are not served on the main host", async () => {
    for (const path of ["/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/callback"]) {
      const res = await send(new Request(`${MAIN_ORIGIN}${path}`, { method: path.startsWith("/oauth") ? "POST" : "GET" }));
      expect(res.status, path).toBe(404);
    }
  });

  it("REST is not reachable on the MCP host, even with the dev header", async () => {
    const alice = await seedUser("alice@example.test", "admin");
    for (const path of ["/api/trips", "/trips", "/api/admin/users", "/api/mcp"]) {
      const res = await send(new Request(`${MCP_ORIGIN}${path}`, { headers: { "X-Dev-User-Email": alice.email } }));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("main-host CORS is unchanged (allowed origin reflected with credentials)", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const res = await asMain(alice.email, "/trips", { headers: { origin: "https://trips.prenticew.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://trips.prenticew.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("an MCP_HOST that differs from the request host never enters the provider", async () => {
    const e = stage2Env({ MCP_HOST: "other.example.test" });
    const res = await send(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`), e);
    expect(res.status).toBe(404);
    expect(MCP_HOST).not.toBe("other.example.test");
  });
});

describe("tools over OAuth return the right user", () => {
  it("get_me via the token identifies the signed-in user, not another seeded user", async () => {
    await seedUser("bob@example.test", "admin");
    const alice = await seedUser("alice@example.test", "viewer");
    const { tokens } = await signIn(alice.email);
    const me = await mcpCall(tokens.access_token, "get_me");
    expect(me.message.result.structuredContent.id).toBe(alice.id);
    expect(me.message.result.structuredContent.email).toBe(alice.email);
  });
});

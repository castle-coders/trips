// Stage 2 OAuth, end to end over real HTTP on the MCP host (TDD 7.1-7.5, 11; PRD 6.3, 11).
//
// Register (DCR) -> GET /authorize (consent page) -> POST /authorize (approve or deny) ->
// 302 to the stubbed Access for SaaS app -> GET /callback (stubbed token endpoint, locally
// signed RS256 id_token) -> 302 to the client with a code -> POST /oauth/token -> POST /mcp.
// Cookies are carried between steps the way a browser would.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedTrip, seedUser } from "./helpers";
import {
  ACCESS_AUTHORIZATION_URL,
  ACCESS_CLIENT_ID,
  ACCESS_CLIENT_SECRET,
  ACCESS_ISSUER,
  CookieJar,
  LOOPBACK_REDIRECT,
  MCP_ORIGIN,
  UPSTREAM_ACCESS_TOKEN,
  UPSTREAM_CODE,
  asMain,
  authorizeUrl,
  callback,
  captureConsole,
  consentHandle,
  exchangeCode,
  kvCount,
  mcpCall,
  mcpRpc,
  pkce,
  postConsent,
  refreshTokens,
  registerPublicClient,
  send,
  signIdToken,
  signIn,
  stubUpstream,
  type TokenResponse,
} from "./helpers/oauth";

afterEach(() => vi.restoreAllMocks());

async function userCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;
}

async function tripCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM trips").first<{ n: number }>())!.n;
}

/** Register + GET /authorize; returns the consent page, its cookies and the PKCE pair. */
async function openConsent(opts: { clientName?: string; scope?: string; state?: string } = {}) {
  const clientId = await registerPublicClient([LOOPBACK_REDIRECT], opts.clientName);
  const { verifier, challenge } = await pkce();
  const res = await send(
    new Request(authorizeUrl({ clientId, scope: opts.scope, state: opts.state, challenge, method: "S256" }), {
      headers: { origin: "https://evil.example.test" },
    }),
  );
  const html = await res.text();
  const jar = new CookieJar().absorb(res);
  return { clientId, verifier, res, html, jar };
}

describe("consent page", () => {
  it("GET /authorize (S256) renders consent: read+offline checked, write unchecked, client name escaped, no CORS", async () => {
    const { res, html, jar } = await openConsent({ clientName: `<script>alert("x")</script> & 'Tool'` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(jar.size).toBeGreaterThan(0); // browser-bound consent cookie

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Tool&#39;");

    const box = (scope: string) => new RegExp(`<input type="checkbox" name="scope" value="${scope}"( checked)?>`).exec(html);
    expect(box("trips:read")?.[1]).toBe(" checked");
    expect(box("offline_access")?.[1]).toBe(" checked");
    expect(box("trips:write")).not.toBeNull();
    expect(box("trips:write")?.[1]).toBeUndefined();
    expect(html).toContain("program running on your computer"); // loopback warning
    expect(consentHandle(html)).toBeTruthy();
  });

  it("deny -> 302 to the client with error=access_denied and the client's state; no upstream call", async () => {
    const upstream = stubUpstream("nobody@example.test");
    const { html, jar } = await openConsent({ state: "deny-state" });
    const res = await postConsent(jar, consentHandle(html), "deny", []);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("deny-state");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(upstream.tokenCalls).toHaveLength(0);
  });

  it("approve with nothing ticked is a refusal (access_denied)", async () => {
    const { html, jar } = await openConsent();
    const res = await postConsent(jar, consentHandle(html), "approve", []);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("POST /authorize without the browser-bound cookie is rejected and never reaches upstream", async () => {
    const { html } = await openConsent();
    const res = await postConsent(new CookieJar(), consentHandle(html), "approve", ["trips:read"]);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("a consent handle is single-use", async () => {
    const { html, jar } = await openConsent();
    const handle = consentHandle(html);
    expect((await postConsent(jar, handle, "approve", ["trips:read"])).status).toBe(302);
    const again = await postConsent(jar, handle, "approve", ["trips:read"]);
    expect(again.status).toBe(400);
    expect(again.headers.get("Location")).toBeNull();
  });

  it("approve -> 302 to Access with PKCE S256, state, upstream client id and the MCP-origin callback", async () => {
    const { html, jar } = await openConsent();
    const res = await postConsent(jar, consentHandle(html), "approve", ["trips:read", "offline_access"]);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(ACCESS_AUTHORIZATION_URL);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe(ACCESS_CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${MCP_ORIGIN}/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid email");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("state")).not.toBe("fake-client-state"); // our own upstream state, not the client's
    expect(loc.toString()).not.toContain(ACCESS_CLIENT_SECRET);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("callback, code exchange and /mcp", () => {
  it("full flow for a seeded user: code redirect with state, token exchange, get_me returns that user", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const { clientRedirect, tokens, upstream } = await signIn(alice.email);

    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(clientRedirect.searchParams.get("state")).toBe("fake-client-state");
    expect(clientRedirect.searchParams.get("iss")).toBe(MCP_ORIGIN);

    // Upstream exchange: confidential client + PKCE verifier, to the MCP-origin callback.
    expect(upstream.tokenCalls).toHaveLength(1);
    const sent = upstream.tokenCalls[0];
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe(UPSTREAM_CODE);
    expect(sent.get("client_id")).toBe(ACCESS_CLIENT_ID);
    expect(sent.get("client_secret")).toBe(ACCESS_CLIENT_SECRET);
    expect(sent.get("redirect_uri")).toBe(`${MCP_ORIGIN}/callback`);
    expect(sent.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect(upstream.otherFetches).toEqual([]);

    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("trips:read offline_access");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const me = await mcpCall(tokens.access_token, "get_me");
    expect(me.status, me.raw).toBe(200);
    expect(me.message.result.isError).toBeFalsy();
    expect(me.message.result.structuredContent).toMatchObject({ id: alice.id, email: alice.email });
  });

  it("the code is single-use", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, code, verifier } = await signIn(alice.email);
    const again = await exchangeCode(clientId, code, verifier);
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("invalid_grant");
  });

  it("granted scopes are enforced: read-only approval -> create_trip scope error, nothing written; list_trips works", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const { tokens } = await signIn(alice.email, { ticked: ["trips:read"] });
    expect(tokens.scope).toBe("trips:read");

    const before = await tripCount();
    const res = await mcpCall(tokens.access_token, "create_trip", { name: "Should not exist" });
    expect(res.status).toBe(200);
    expect(res.message.result.isError).toBe(true);
    expect(res.message.result.content[0].text).toBe("Missing required scope: trips:write");
    expect(await tripCount()).toBe(before);

    const list = await mcpCall(tokens.access_token, "list_trips");
    expect(list.message.result.isError).toBeFalsy();
  });

  it("write approval lets create_trip through (positive control)", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const { tokens } = await signIn(alice.email, { ticked: ["trips:read", "trips:write"] });
    expect(tokens.scope).toBe("trips:read trips:write");
    const res = await mcpCall(tokens.access_token, "create_trip", { name: "Allowed" });
    expect(res.message.result.isError, res.raw).toBeFalsy();
    expect(await tripCount()).toBe(1);
  });

  it("a forged consent POST cannot add a scope the client did not request", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const { tokens } = await signIn(alice.email, { requested: "trips:read", ticked: ["trips:read", "trips:write"] });
    expect(tokens.scope).toBe("trips:read");
  });

  it("offline_access only (trips:read unticked): read tools return a scope error", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Hidden" });
    const { tokens } = await signIn(alice.email, { ticked: ["offline_access"] });
    expect(tokens.scope).toBe("offline_access");
    const res = await mcpCall(tokens.access_token, "list_trips");
    expect(res.message.result.isError).toBe(true);
    expect(res.message.result.content[0].text).toBe("Missing required scope: trips:read");
    expect(res.raw).not.toContain("Hidden");
  });

  it("scope comes from consent, never from the callback query string", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    stubUpstream(alice.email);
    const { clientId, verifier, html, jar } = await openConsent();
    const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read"]);
    jar.absorb(approved);
    const cb = await callback(jar, approved, { code: UPSTREAM_CODE, scope: "trips:read trips:write" });
    expect(cb.status).toBe(302);
    const code = new URL(cb.headers.get("Location")!).searchParams.get("code")!;
    const tok = (await (await exchangeCode(clientId, code, verifier)).json()) as TokenResponse;
    expect(tok.scope).toBe("trips:read");
  });

  it("an upstream state replayed at /callback is rejected without a second upstream exchange", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const upstream = stubUpstream(alice.email);
    const { html, jar } = await openConsent();
    const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read"]);
    jar.absorb(approved);
    const replayJar = new CookieJar().absorb(approved);
    expect((await callback(jar, approved)).status).toBe(302);
    const second = await callback(replayJar, approved);
    expect(second.status).toBe(400);
    expect(second.headers.get("Location")).toBeNull();
    expect(upstream.tokenCalls).toHaveLength(1);
  });

  it("/callback without the upstream binding cookie is rejected without an upstream exchange", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const upstream = stubUpstream(alice.email);
    const { html, jar } = await openConsent();
    const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read"]);
    const res = await callback(new CookieJar(), approved);
    expect(res.status).toBe(400);
    expect(upstream.tokenCalls).toHaveLength(0);
  });
});

describe("id_token verification at /callback", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const cases: Array<[string, () => Promise<string>]> = [
    ["wrong issuer", () => signIdToken({ email: "alice@example.test" }, { iss: "https://evil.example.test" })],
    ["wrong audience", () => signIdToken({ email: "alice@example.test" }, { aud: "other-client" })],
    ["expired", () => signIdToken({ email: "alice@example.test" }, { exp: now() - 3600 })],
    ["alg none", async () => `${enc({ alg: "none" })}.${enc({ iss: ACCESS_ISSUER, aud: ACCESS_CLIENT_ID, exp: now() + 300, email: "alice@example.test" })}.`],
    ["no email claim", () => signIdToken({ sub: "fake-sub" })],
  ];
  for (const [name, factory] of cases) {
    it(`${name} -> 401 error page, no code, no grant`, async () => {
      await seedUser("alice@example.test", "editor");
      stubUpstream(factory);
      const { html, jar } = await openConsent();
      const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read"]);
      jar.absorb(approved);
      const cb = await callback(jar, approved);
      expect(cb.status).toBe(401);
      expect(cb.headers.get("Location")).toBeNull();
      expect(await cb.text()).toContain("did not complete");
      expect(await kvCount("grant:")).toBe(0);
    });
  }

  it("upstream error at /callback -> access_denied to the client, upstream description not echoed, no exchange", async () => {
    const upstream = stubUpstream("alice@example.test");
    const { html, jar } = await openConsent({ state: "up-err" });
    const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read"]);
    jar.absorb(approved);
    const cb = await callback(jar, approved, { error: "access_denied", error_description: "<script>x</script>" });
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get("Location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("up-err");
    expect(loc.toString()).not.toContain("script");
    expect(upstream.tokenCalls).toHaveLength(0);
  });
});

describe("PRD 11: unknown email cannot complete the flow", () => {
  it("callback with a verified id_token for an unregistered email -> error page, no code, no user row, no grant", async () => {
    await seedUser("alice@example.test", "editor");
    const users = await userCount();
    const upstream = stubUpstream("mallory@example.test");
    const { html, jar } = await openConsent();
    const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read", "offline_access"]);
    jar.absorb(approved);
    const logs = captureConsole();
    const cb = await callback(jar, approved);
    const body = await cb.text();

    expect(upstream.tokenCalls).toHaveLength(1); // it did reach the upstream and verify the token
    expect(cb.status).toBe(403);
    expect(cb.headers.get("Location")).toBeNull();
    expect(body).toContain("This account is not registered with Trips");
    expect(body).not.toContain("mallory");
    expect(await userCount()).toBe(users);
    expect(await kvCount("grant:")).toBe(0);
    expect(logs.join("\n")).not.toContain("mallory");
  });
});

describe("refresh and rotation", () => {
  it("refresh issues new tokens; the old refresh token stays valid until the new one is used, then invalid_grant", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email);
    const r1 = tokens.refresh_token!;

    const first = await refreshTokens(clientId, r1);
    const t2 = (await first.json()) as TokenResponse;
    expect(first.status, JSON.stringify(t2)).toBe(200);
    expect(t2.access_token).not.toBe(tokens.access_token);
    expect(t2.refresh_token).toBeTruthy();
    expect(t2.refresh_token).not.toBe(r1);
    expect(t2.scope).toBe("trips:read offline_access");
    expect((await mcpCall(t2.access_token, "get_me")).message.result.structuredContent.id).toBe(alice.id);

    // Using the new refresh token retires the old one.
    const second = await refreshTokens(clientId, t2.refresh_token!);
    const t3 = (await second.json()) as TokenResponse;
    expect(second.status, JSON.stringify(t3)).toBe(200);

    const old = await refreshTokens(clientId, r1);
    expect(old.status).toBe(400);
    expect(((await old.json()) as any).error).toBe("invalid_grant");

    // No reuse detection (library behavior, TDD 7.1 note): the newest token still works.
    const third = await refreshTokens(clientId, t3.refresh_token!);
    expect(third.status).toBe(200);
  });

  it("the previous refresh token works again before its successor is used (grace window)", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email);
    const r1 = tokens.refresh_token!;
    const a = await refreshTokens(clientId, r1);
    expect(a.status).toBe(200);
    const b = await refreshTokens(clientId, r1);
    expect(b.status).toBe(200);
    expect(((await b.json()) as TokenResponse).refresh_token).toBeTruthy();
  });

  it("documents library behavior: offline_access unticked still yields a refresh token that works", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email, { ticked: ["trips:read"] });
    expect(tokens.scope).toBe("trips:read");
    expect(tokens.refresh_token).toBeTruthy();
    const r = await refreshTokens(clientId, tokens.refresh_token!);
    const t2 = (await r.json()) as TokenResponse;
    expect(r.status).toBe(200);
    expect(t2.scope).toBe("trips:read");
  });

  it("a refresh asking for wider scope is downscoped to the grant", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const { clientId, tokens } = await signIn(alice.email, { ticked: ["trips:read"] });
    const r = await send(
      new Request(`${MCP_ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
          scope: "trips:read trips:write",
        }),
      }),
    );
    const body = (await r.json()) as TokenResponse;
    // Library behavior (spike, TDD 7.1 note): silently downscoped, not rejected.
    expect(r.status, JSON.stringify(body)).toBe(200);
    expect(body.scope).toBe("trips:read");
    const w = await mcpCall(body.access_token, "create_trip", { name: "nope" });
    expect(w.message.result.isError).toBe(true);
    expect(await tripCount()).toBe(0);
  });
});

describe("revocation and user deletion", () => {
  it("revoke via /auth/me/grants -> next /mcp call 401 and refresh invalid_grant", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email);
    expect((await mcpCall(tokens.access_token, "get_me")).status).toBe(200);

    const list = (await (await asMain(alice.email, "/auth/me/grants")).json()) as Array<{ id: string; clientId: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].clientId).toBe(clientId);
    expect((await asMain(alice.email, `/auth/me/grants/${list[0].id}`, { method: "DELETE" })).status).toBe(204);

    const after = await mcpCall(tokens.access_token, "get_me");
    expect(after.status).toBe(401);
    const r = await refreshTokens(clientId, tokens.refresh_token!);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  // PRD 11: "Deleting a user in the admin UI causes that user's existing MCP token to fail on the next call."
  // DELETE /admin/users/:id revokes the user's OAuth grants, so the library itself rejects the
  // token with 401 invalid_token. (apiHandler's user-row check answers the same 401 if a grant
  // ever outlives its user; covered in Phase 4 acceptance tests.)
  it("deleting the user in admin makes the existing token fail on the next call (401 invalid_token, no data)", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Secret Trip" });
    const { tokens } = await signIn(alice.email);
    expect((await mcpCall(tokens.access_token, "list_trips")).raw).toContain("Alice Secret Trip");

    expect((await asMain(admin.email, `/admin/users/${alice.id}`, { method: "DELETE" })).status).toBe(204);

    const logs = captureConsole();
    const listTrips = (token: string) =>
      send(
        new Request(`${MCP_ORIGIN}/mcp`, {
          method: "POST",
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_trips", arguments: {} } }),
        }),
      );
    const httpRes = await listTrips(tokens.access_token);
    const res = { status: httpRes.status, headers: httpRes.headers, raw: await httpRes.text() };
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(res.raw)).toEqual({ error: "invalid_token", error_description: "Invalid access token" });
    const challenge = res.headers.get("WWW-Authenticate")!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    // Same challenge the library itself sends for an unknown token.
    expect(challenge).toBe((await listTrips("fake-not-a-real-token")).headers.get("WWW-Authenticate"));
    expect(res.raw).not.toContain("Alice Secret Trip");
    expect(res.raw).not.toContain(alice.email);
    expect(res.raw).not.toMatch(/at \S+ \(|\.ts:\d+/); // no stack trace
    expect(logs.join("\n")).not.toContain(tokens.access_token);

    // User deletion revokes the user's OAuth grants and tokens before the row is removed.
    expect(await kvCount(`grant:${alice.id}:`)).toBe(0);
    expect(await kvCount(`token:${alice.id}:`)).toBe(0);
  });
});

describe("log hygiene across the whole flow", () => {
  it("no token, code, secret, verifier, state, handle, id_token or email appears in any console line", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    const logs = captureConsole();
    const upstream = stubUpstream(alice.email);

    const clientId = await registerPublicClient([LOOPBACK_REDIRECT], "Log Test Client");
    const { verifier, challenge } = await pkce();
    const page = await send(new Request(authorizeUrl({ clientId, challenge, method: "S256", state: "fake-state-xyz" })));
    const html = await page.text();
    const jar = new CookieJar().absorb(page);
    const handle = consentHandle(html);
    const approved = await postConsent(jar, handle, "approve", ["trips:read", "trips:write", "offline_access"]);
    jar.absorb(approved);
    const upstreamState = new URL(approved.headers.get("Location")!).searchParams.get("state")!;
    const upstreamChallenge = new URL(approved.headers.get("Location")!).searchParams.get("code_challenge")!;
    const cb = await callback(jar, approved);
    jar.absorb(cb);
    const code = new URL(cb.headers.get("Location")!).searchParams.get("code")!;
    const tok = (await (await exchangeCode(clientId, code, verifier)).json()) as TokenResponse;
    await mcpCall(tok.access_token, "get_me");
    await mcpCall(tok.access_token, "create_trip", { name: "Logged trip" });
    const ref = (await (await refreshTokens(clientId, tok.refresh_token!)).json()) as TokenResponse;
    await mcpCall(ref.access_token, "list_trips");
    // Error paths too: bad verifier, bad refresh token, bad bearer.
    await exchangeCode(clientId, code, "wrong-verifier-wrong-verifier-wrong-verifier-00");
    await refreshTokens(clientId, "fake-bogus-refresh-token");
    await mcpRpc("fake-bogus-access-token", "tools/list");

    const all = logs.join("\n");
    expect(logs.some((l) => l.startsWith("[oauth]"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[mcp]"))).toBe(true);
    const secrets: Record<string, string> = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token!,
      refreshed_access: ref.access_token,
      refreshed_refresh: ref.refresh_token!,
      code,
      verifier,
      challenge,
      handle,
      client_state: "fake-state-xyz",
      upstream_state: upstreamState,
      upstream_challenge: upstreamChallenge,
      upstream_code: UPSTREAM_CODE,
      upstream_verifier: upstream.tokenCalls[0].get("code_verifier")!,
      upstream_access: UPSTREAM_ACCESS_TOKEN,
      upstream_secret: ACCESS_CLIENT_SECRET,
      id_token: upstream.idTokens[0],
      email: alice.email,
      cookie: jar.header() || "-no-cookie-left-",
      bogus_refresh: "fake-bogus-refresh-token",
      bogus_access: "fake-bogus-access-token",
    };
    for (const [name, value] of Object.entries(secrets)) {
      expect(all.includes(value), `${name} leaked into logs`).toBe(false);
    }
    // Token parts: the library's tokens are userId:grantId:secret; the secret part must not leak either.
    for (const t of [tok.access_token, tok.refresh_token!]) {
      const secretPart = t.split(":").pop()!;
      expect(all.includes(secretPart)).toBe(false);
    }
  });
});

// PRD section 11 (Acceptance Criteria) as one traceable list, end to end through the real Worker.
//
// - Stage 1: the main hostname, /api/mcp behind authMiddleware (DEV_MODE + X-Dev-User-Email, or a
//   locally signed Cloudflare Access JWT with the JWKS fetch stubbed).
// - Stage 2: the MCP hostname through the OAuth provider (DCR, consent, stubbed Access for SaaS
//   upstream, code exchange, bearer calls), via test/helpers/oauth.ts.
//
// Each test is named after its PRD 11 bullet. Many restate, end to end, something covered in more
// depth elsewhere; the deeper suite is named in a comment on each test. Bullets that need a live
// client are listed in the comment block at the bottom of this file.
//
// All emails, hosts, ids and secrets here are obviously fake test values.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceIdentities, userEmails, users } from "../src/db/schema";
import { dbState, normalize, byId, itLabels, read, seedTrip, seedUser, testDb } from "./helpers";
import {
  HIDDEN_VALUES,
  IDS,
  IT,
  LEAK_RE,
  expectNoHiddenFields,
  mcpStage1,
  parseRpc,
  rpcBody,
  seedMcpWorld,
  validArgs,
  type RpcReply,
  type ToolResult,
} from "./helpers/mcp";
import {
  CLAUDE_REDIRECT,
  CookieJar,
  GOOGLE_RELAY_REDIRECT,
  LOOPBACK_REDIRECT,
  MAIN_ORIGIN,
  MCP_ORIGIN,
  MCP_PUBLIC_URL,
  VERTEX_REDIRECT,
  asMain,
  authorizeUrl,
  callback,
  consentHandle,
  kvCount,
  mcpCall,
  pkce,
  postConsent,
  refreshTokens,
  register,
  registerPublicClient,
  send,
  signIn,
  stage2Env,
  stubUpstream,
  type TokenResponse,
} from "./helpers/oauth";
import itinerariesSnap from "./__snapshots__/itineraries.test.ts.snap?raw";
import tripsSnap from "./__snapshots__/trips.test.ts.snap?raw";
import expensesSnap from "./__snapshots__/expenses.test.ts.snap?raw";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RESOURCE_METADATA_URL = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const RPC_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

/** A Stage 2 bearer reply as the ToolResult shape the shared MCP assertions take. */
function toolResult(reply: RpcReply): ToolResult {
  expect(reply.status, reply.raw).toBe(200);
  expect(reply.message?.error, reply.raw).toBeUndefined();
  const result = reply.message.result;
  const text = (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  return { isError: result.isError === true, text, structured: result.structuredContent, result, reply };
}

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return toolResult(await mcpCall(token, name, args));
}

/** Raw POST /mcp on the MCP host, so status, headers and body can all be asserted. */
async function rawMcp(token: string, name = "list_trips"): Promise<{ status: number; headers: Headers; raw: string }> {
  const res = await send(
    new Request(`${MCP_ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...RPC_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    }),
  );
  return { status: res.status, headers: res.headers, raw: await res.text() };
}

/** The library's own 401 for a token it has never seen: the reference challenge format. */
async function libraryChallenge(): Promise<string> {
  return (await rawMcp("fake-not-a-real-token")).headers.get("WWW-Authenticate")!;
}

/** 401 invalid_token, the library's JSON body and challenge, and nothing else. */
async function expectInvalidToken(res: { status: number; headers: Headers; raw: string }, mustNotContain: string[] = []) {
  expect(res.status, res.raw).toBe(401);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(JSON.parse(res.raw)).toEqual({ error: "invalid_token", error_description: "Invalid access token" });
  const challenge = res.headers.get("WWW-Authenticate")!;
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
  expect(challenge).toBe(await libraryChallenge());
  expect(res.raw).not.toMatch(LEAK_RE);
  for (const s of mustNotContain) expect(res.raw).not.toContain(s);
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

/**
 * Pull one entry out of a committed vitest .snap file and parse it back to data. Snapshot bodies
 * are pretty-format output of plain JSON values (sorted keys, trailing commas, no escapes needed
 * for these fixtures), so dropping the trailing commas yields JSON.
 */
function committedSnapshot(snapFile: string, key: string): unknown {
  const marker = `exports[\`${key}\`] = \``;
  const start = snapFile.indexOf(marker);
  expect(start, `committed snapshot entry "${key}"`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = snapFile.indexOf("`;\n", bodyStart);
  const body = snapFile.slice(bodyStart, end).trim();
  return JSON.parse(body.replace(/,(\s*[}\]])/g, "$1"));
}

function snapshotKeys(snapFile: string): string[] {
  return [...snapFile.matchAll(/^exports\[`([^`]+)`\]/gm)].map((m) => m[1]);
}

// --- Cloudflare Access JWT (Stage 1 service-token path) ----------------------------------------
// authMiddleware verifies Cf-Access-Jwt-Assertion against https://<team>/cdn-cgi/access/certs via
// jose's createRemoteJWKSet, which calls the global fetch. The test stubs that one URL with a
// local RS256 key, so the real verification and the service_identities lookup both run.
const FAKE_TEAM_DOMAIN = "fake-team.access.example.test";
const FAKE_AUDIENCE = "fake-access-audience-tag-0000";
const FAKE_CERTS_URL = `https://${FAKE_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const FAKE_SERVICE_COMMON_NAME = "fake-service-token-id.access";
const accessKeys = await generateKeyPair("RS256");
const ACCESS_JWK = { ...(await exportJWK(accessKeys.publicKey)), kid: "fake-access-kid-1", alg: "RS256", use: "sig" };

function stubAccessCerts(): string[] {
  const other: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FAKE_CERTS_URL) return Response.json({ keys: [ACCESS_JWK] });
    other.push(url);
    return real(input, init);
  });
  return other;
}

/** A service-token Access JWT: CF Access sets sub to "" and carries common_name instead. */
function serviceTokenJwt(commonName = FAKE_SERVICE_COMMON_NAME, aud = FAKE_AUDIENCE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "", common_name: commonName, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: ACCESS_JWK.kid })
    .setIssuer(`https://${FAKE_TEAM_DOMAIN}`)
    .setAudience(aud)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

/** Main-host env with the fake Access team, and DEV_MODE off so only the JWT can authenticate. */
const accessEnv = () => stage2Env({ CF_ACCESS_TEAM_DOMAIN: FAKE_TEAM_DOMAIN, CF_ACCESS_AUDIENCE: FAKE_AUDIENCE, DEV_MODE: "" });

async function stage1WithAccessJwt(jwt: string, method: string, params: unknown): Promise<RpcReply> {
  const res = await send(
    new Request(`${MAIN_ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { ...RPC_HEADERS, "Cf-Access-Jwt-Assertion": jwt },
      body: JSON.stringify(rpcBody(method, params)),
    }),
    accessEnv(),
  );
  return parseRpc(res);
}

// ------------------------------------------------------------------------------------------------

describe("PRD 11 acceptance", () => {
  // PRD 11 bullet 1 (amended 2026-10-27: seat assignments stay visible to Viewers; the criterion is
  // confirmation numbers and ticket numbers). Deeper: mcp.roles.test.ts "Viewer projection".
  it("A Viewer on a trip calling get_trip through MCP receives no confirmation numbers or ticket numbers (Stage 1, /api/mcp)", async () => {
    const w = await seedMcpWorld();
    const r = await mcpStage1(w.users.viewer.email).call("get_trip", { tripId: IDS.trip });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.role).toBe("Viewer");
    expect(r.structured.itineraries).toHaveLength(5); // projected, not filtered out
    expectNoHiddenFields(r, HIDDEN_VALUES);
    // Amendment: seat assignments are intentionally visible.
    expect(r.reply.raw).toContain("seatAssignments");
    // Control: the same call as the trip Editor does carry them, so the projection is role-based.
    const e = await mcpStage1(w.users.editor.email).call("get_trip", { tripId: IDS.trip });
    expect(e.reply.raw).toContain("CONF-FAKE-FLT");
    expect(e.reply.raw).toContain("TKT-FAKE-0001");
  });

  it("A Viewer on a trip calling get_trip through MCP receives no confirmation numbers or ticket numbers (Stage 2, OAuth bearer)", async () => {
    const w = await seedMcpWorld();
    const { tokens } = await signIn(w.users.viewer.email);
    const r = await call(tokens.access_token, "get_trip", { tripId: IDS.trip });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.role).toBe("Viewer");
    expect(r.structured.itineraries).toHaveLength(5);
    expectNoHiddenFields(r, HIDDEN_VALUES);
    expect(r.reply.raw).toContain("seatAssignments");
  });

  // Deeper: mcp.scopes.test.ts, oauth.flow.test.ts "granted scopes are enforced".
  it("A user with only trips:read calling create_itinerary receives a scope error and nothing is written", async () => {
    const w = await seedMcpWorld();
    // The trip Editor, so the only thing missing is the scope (not the role).
    const { tokens } = await signIn(w.users.editor.email, { ticked: ["trips:read", "offline_access"] });
    expect(tokens.scope).toBe("trips:read offline_access");

    const before = await dbState();
    const r = await call(tokens.access_token, "create_itinerary", validArgs().create_itinerary);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Missing required scope: trips:write");
    expect(r.structured).toBeUndefined();
    expect(r.reply.raw).not.toMatch(LEAK_RE);
    expect(await dbState()).toEqual(before);

    // Positive control: the same user with trips:write consented can create it.
    const rw = await signIn(w.users.editor.email, { ticked: ["trips:read", "trips:write", "offline_access"] });
    const ok = await call(rw.tokens.access_token, "create_itinerary", validArgs().create_itinerary);
    expect(ok.isError, ok.text).toBe(false);
    expect((await dbState()).itineraries.length).toBe(before.itineraries.length + 1);
  });

  // Deeper: mcp.roles.test.ts "Viewer with trips:write: role errors, nothing written".
  it("A Viewer with trips:write calling update_itinerary receives a role error and nothing is written (Stage 2, OAuth bearer)", async () => {
    const w = await seedMcpWorld();
    const { tokens } = await signIn(w.users.viewer.email, { ticked: ["trips:read", "trips:write", "offline_access"] });
    expect(tokens.scope.split(" ")).toContain("trips:write");

    const before = await dbState();
    const r = await call(tokens.access_token, "update_itinerary", validArgs().update_itinerary);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden");
    expect(r.structured).toBeUndefined();
    expect(r.reply.raw).not.toMatch(LEAK_RE);
    expect(await dbState()).toEqual(before);
  });

  it("A Viewer with trips:write calling update_itinerary receives a role error and nothing is written (Stage 1, /api/mcp grants trips:write)", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await mcpStage1(w.users.viewer.email).call("update_itinerary", {
      tripId: IDS.trip,
      itineraryId: IT.flight,
      confirmationNumber: null,
      notes: "viewer edit",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden");
    expect(await dbState()).toEqual(before);
  });

  // Deeper: oauth.flow.test.ts "PRD 11: unknown email cannot complete the flow".
  it("An email not present in userEmails cannot complete the OAuth flow and no user row is created", async () => {
    await seedUser("alice@example.test", "editor");
    // A users row whose email is NOT in user_emails: the lookup is by user_emails only.
    const orphan = await seedUser("orphan@example.test", "editor");
    await testDb().delete(userEmails).where(eq(userEmails.userId, orphan.id));
    const usersBefore = await count("users");
    const emailsBefore = await count("user_emails");

    for (const email of ["mallory@example.test", "orphan@example.test"]) {
      const upstream = stubUpstream(email);
      const clientId = await registerPublicClient([LOOPBACK_REDIRECT]);
      const { challenge } = await pkce();
      const page = await send(new Request(authorizeUrl({ clientId, challenge, method: "S256" })));
      const html = await page.text();
      expect(page.status).toBe(200);
      const jar = new CookieJar().absorb(page);
      const approved = await postConsent(jar, consentHandle(html), "approve", ["trips:read", "offline_access"]);
      jar.absorb(approved);
      const cb = await callback(jar, approved);
      const body = await cb.text();

      expect(upstream.tokenCalls, email).toHaveLength(1); // the id_token was issued and verified
      expect(cb.status, email).toBe(403);
      expect(cb.headers.get("Location"), email).toBeNull(); // no code goes back to the client
      expect(body).toContain("This account is not registered with Trips");
      expect(body).not.toContain(email);
      vi.restoreAllMocks();
    }

    expect(await count("users")).toBe(usersBefore);
    expect(await count("user_emails")).toBe(emailsBefore);
    expect(await testDb().select().from(users).where(eq(users.email, "mallory@example.test"))).toEqual([]);
    expect(await kvCount("grant:")).toBe(0);
    expect(await kvCount("token:")).toBe(0);
  });

  // Deeper: oauth.flow.test.ts "revocation and user deletion", grants.test.ts user deletion.
  it("Deleting a user in the admin UI causes that user's existing MCP token to fail on the next call (DELETE /admin/users/:id, Stage 2 and Stage 1)", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Secret Trip" });
    const { clientId, tokens } = await signIn(alice.email);
    expect((await call(tokens.access_token, "list_trips")).reply.raw).toContain("Alice Secret Trip");
    expect((await mcpStage1(alice.email).call("get_me")).structured.id).toBe(alice.id);

    const del = await asMain(admin.email, `/admin/users/${alice.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    await expectInvalidToken(await rawMcp(tokens.access_token), ["Alice Secret Trip", alice.email]);
    const r = await refreshTokens(clientId, tokens.refresh_token!);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");
    // Stage 1 (Access identity) is refused too.
    expect((await mcpStage1(alice.email).rpc("tools/list", {})).status).toBe(401);
  });

  // The provider's second line of defense: if a grant ever outlives its users row (row removed
  // outside DELETE /admin/users, which revokes grants first), apiHandler's own user-row check
  // must answer 401 invalid_token in the library's challenge format, before any tool runs.
  it("Deleting a user in the admin UI causes that user's existing MCP token to fail on the next call (users row removed directly in D1, grant still in KV: apiHandler answers 401 invalid_token)", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Secret Trip" });
    const { clientId, tokens } = await signIn(alice.email);
    expect((await call(tokens.access_token, "list_trips")).reply.raw).toContain("Alice Secret Trip");

    await testDb().delete(users).where(eq(users.id, alice.id));
    expect(await kvCount(`grant:${alice.id}:`)).toBe(1); // the library still holds a valid grant
    expect(await kvCount(`token:${alice.id}:`)).toBeGreaterThan(0);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    await expectInvalidToken(await rawMcp(tokens.access_token), ["Alice Secret Trip", alice.email]);
    await expectInvalidToken(await rawMcp(tokens.access_token, "get_me"), [alice.email]);
    expect(logs.filter((l) => l.startsWith("[mcp] tool="))).toEqual([]); // no tool was reached

    // The library will still refresh the orphaned grant, but every token it mints is refused too.
    const r = await refreshTokens(clientId, tokens.refresh_token!);
    if (r.status === 200) {
      const t2 = (await r.json()) as TokenResponse;
      await expectInvalidToken(await rawMcp(t2.access_token), [alice.email]);
    } else {
      expect(r.status).toBe(400);
    }
    expect(logs.join("\n")).not.toContain(tokens.access_token);
  });

  // Deeper: grants.test.ts self-service and admin revoke, oauth.flow.test.ts.
  it("Revoking a grant causes the next call with that token to return 401", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email);
    expect((await call(tokens.access_token, "list_trips")).isError).toBe(false);

    const list = (await (await asMain(alice.email, "/auth/me/grants")).json()) as Array<{ id: string; clientId: string }>;
    expect(list.map((g) => g.clientId)).toEqual([clientId]);
    expect((await asMain(alice.email, `/auth/me/grants/${list[0].id}`, { method: "DELETE" })).status).toBe(204);

    await expectInvalidToken(await rawMcp(tokens.access_token));
    const r = await refreshTokens(clientId, tokens.refresh_token!);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  // Stage 1 offline: DEV_MODE header (stands in for the Access identity) and a locally signed
  // Access service-token JWT resolved through service_identities. Stage 2: the OAuth sign-in a
  // real `/mcp` sign-in performs. All three must land on the same users.id.
  it("Claude Code can connect through /mcp sign-in and through a service token header, and both resolve to the correct user", async () => {
    const decoy = await seedUser("decoy@example.test", "editor");
    const alice = await seedUser("alice@example.test", "editor", { name: "Alice" });
    await testDb().insert(serviceIdentities).values({
      id: crypto.randomUUID(),
      cfAccessSubject: FAKE_SERVICE_COMMON_NAME,
      commonName: FAKE_SERVICE_COMMON_NAME,
      userId: alice.id,
      createdAt: new Date().toISOString(),
    });

    // (a) Stage 1, DEV_MODE header.
    const viaDevHeader = await mcpStage1(alice.email).call("get_me");
    expect(viaDevHeader.isError, viaDevHeader.text).toBe(false);

    // (b) Stage 1, Access service token (JWT verified against the stubbed team JWKS; DEV_MODE off).
    const otherFetches = stubAccessCerts();
    const svc = await stage1WithAccessJwt(await serviceTokenJwt(), "tools/call", { name: "get_me", arguments: {} });
    expect(svc.status, svc.raw).toBe(200);
    const viaServiceToken = svc.message.result.structuredContent;
    // Negative controls: unmapped service token, and a token for another Access app.
    expect((await stage1WithAccessJwt(await serviceTokenJwt("fake-unmapped.access"), "tools/list", {})).status).toBe(401);
    expect((await stage1WithAccessJwt(await serviceTokenJwt(undefined, "fake-other-aud"), "tools/list", {})).status).toBe(401);
    expect(otherFetches).toEqual([]);
    vi.restoreAllMocks();

    // (c) Stage 2, OAuth sign-in (Claude Code registers a loopback redirect).
    const { tokens } = await signIn(alice.email, { redirectUri: LOOPBACK_REDIRECT, clientName: "Claude Code" });
    const viaOAuth = (await call(tokens.access_token, "get_me")).structured;

    const expected = { id: alice.id, email: alice.email, name: "Alice", role: "editor" };
    expect(viaDevHeader.structured).toEqual(expected);
    expect(viaServiceToken).toEqual(expected);
    expect(viaOAuth).toEqual(expected);
    expect(viaOAuth.id).not.toBe(decoy.id);
  });

  // Offline protocol simulation of the claude.ai connector: DCR with claude.ai's redirect URI,
  // consent, stubbed Access, code exchange at that redirect, then list_trips. The real
  // claude.ai UI and its network path are manual (see the bottom of this file).
  it("claude.ai can add the server as a custom connector, complete sign-in, and call list_trips (simulated DCR client with the claude.ai redirect URI)", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Trip" });
    const { tokens, clientRedirect } = await signIn(alice.email, { redirectUri: CLAUDE_REDIRECT, clientName: "Claude" });
    expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(CLAUDE_REDIRECT);
    const r = await call(tokens.access_token, "list_trips");
    expect(r.isError, r.text).toBe(false);
    expect(r.reply.raw).toContain("Alice Trip");
  });

  it("Gemini Spark can add the server under Custom apps for Spark, complete sign-in via Google callback, and call list_trips (simulated DCR client with Google redirect URIs)", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Trip" });
    for (const redirect of [GOOGLE_RELAY_REDIRECT, VERTEX_REDIRECT]) {
      const { tokens, clientRedirect } = await signIn(alice.email, { redirectUri: redirect, clientName: "Gemini Spark" });
      expect(`${clientRedirect.origin}${clientRedirect.pathname}`).toBe(redirect);
      const r = await call(tokens.access_token, "list_trips");
      expect(r.isError, r.text).toBe(false);
      expect(r.reply.raw).toContain("Alice Trip");
      vi.restoreAllMocks();
    }
  });

  // Deeper: oauth.flow.test.ts "refresh and rotation".
  it("Gemini Spark unattended background routines can refresh expired access tokens using the refresh token without user intervention", async () => {
    const alice = await seedUser("alice@example.test", "editor");
    await seedTrip(alice.id, { name: "Alice Trip" });
    const { clientId, tokens, upstream } = await signIn(alice.email, { redirectUri: GOOGLE_RELAY_REDIRECT });
    expect(tokens.scope.split(" ")).toContain("offline_access");
    expect(tokens.expires_in).toBe(3600);
    expect((await call(tokens.access_token, "list_trips")).isError).toBe(false);

    // Move the clock past the access token's lifetime; only Date is faked.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (tokens.expires_in + 60) * 1000);
    expect((await rawMcp(tokens.access_token)).status).toBe(401); // expired

    // Background refresh: one form POST to the token endpoint. No /authorize, no consent, no upstream.
    const upstreamCallsBefore = upstream.tokenCalls.length;
    const r1 = await refreshTokens(clientId, tokens.refresh_token!);
    const t2 = (await r1.json()) as TokenResponse;
    expect(r1.status, JSON.stringify(t2)).toBe(200);
    expect(t2.access_token).not.toBe(tokens.access_token);
    expect(t2.refresh_token).toBeTruthy();
    expect(t2.refresh_token).not.toBe(tokens.refresh_token); // rotation
    expect(t2.scope).toBe(tokens.scope);
    const list = await call(t2.access_token, "list_trips");
    expect(list.isError, list.text).toBe(false);
    expect(list.reply.raw).toContain("Alice Trip");
    expect(upstream.tokenCalls.length).toBe(upstreamCallsBefore);

    // Rotation: once the successor is used, the original refresh token is retired.
    const r2 = await refreshTokens(clientId, t2.refresh_token!);
    const t3 = (await r2.json()) as TokenResponse;
    expect(r2.status).toBe(200);
    const old = await refreshTokens(clientId, tokens.refresh_token!);
    expect(old.status).toBe(400);
    expect(((await old.json()) as any).error).toBe("invalid_grant");
    expect((await call(t3.access_token, "list_trips")).isError).toBe(false);
  });

  // SANITY BOUND ONLY. This measures in-process handling inside local workerd (no network) and
  // says nothing about latency from Anthropic or Google egress ranges, which is a manual check.
  it("Discovery, registration and token endpoints respond in under one second (in-process sanity bound only; does NOT prove the production egress requirement)", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const { clientId, tokens } = await signIn(alice.email);
    const BOUND_MS = 1000;
    const timed = async (label: string, run: () => Promise<Response>, expectStatus: number) => {
      const t0 = Date.now();
      const res = await run();
      await res.arrayBuffer();
      const ms = Date.now() - t0;
      expect(res.status, label).toBe(expectStatus);
      expect(ms, `${label} took ${ms} ms in-process`).toBeLessThan(BOUND_MS);
    };

    await timed("protected resource metadata", () => send(new Request(RESOURCE_METADATA_URL)), 200);
    await timed("authorization server metadata", () => send(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`)), 200);
    await timed("401 discovery challenge", () => send(new Request(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: RPC_HEADERS, body: "{}" })), 401);
    await timed("dynamic client registration", () => register({ redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none", client_name: "Latency Probe" }), 201);
    await timed("token endpoint (refresh grant)", () => refreshTokens(clientId, tokens.refresh_token!), 200);

    const meta = (await (await send(new Request(RESOURCE_METADATA_URL))).json()) as { resource: string };
    expect(meta.resource).toBe(MCP_PUBLIC_URL);
  });

  // Deeper: the parity-baseline suites trips.test.ts, itineraries.test.ts, expenses.test.ts
  // (snapshots in __snapshots__/), the two planned flips in trips.behavior-change.test.ts and
  // itineraries.behavior-change.test.ts, and openapi.test.ts.
  it("The REST API test behavior is unchanged after the service extraction (committed parity snapshots re-checked end to end)", async () => {
    // The committed baselines exist and cover list/get/create/update for every domain.
    for (const [name, snap, prefixes] of [
      ["trips", tripsSnap, ["GET /trips >", "GET /trips/:tripId >", "POST /trips", "PUT /trips/:tripId"]],
      ["itineraries", itinerariesSnap, ["GET /trips/:tripId/itineraries >", "GET /trips/:tripId/itineraries/:itineraryId", "POST /trips/:tripId/itineraries", "PUT /trips/:tripId/itineraries/:itineraryId"]],
      ["expenses", expensesSnap, ["GET /trips/:tripId/expenses", "POST /trips/:tripId/expenses", "PUT /trips/:tripId/expenses/:expenseId"]],
    ] as const) {
      const keys = snapshotKeys(snap);
      for (const p of prefixes) expect(keys.some((k) => k.startsWith(p)), `${name}: snapshot for ${p}`).toBe(true);
    }

    // Re-run representative parity requests through the real Worker and compare with the
    // committed snapshot data (not a fresh snapshot).
    const w = await seedMcpWorld();
    const base = `/api/trips/${IDS.trip}/itineraries`;
    const viewerList = await read(await w.as.viewer.get(base));
    expect(viewerList.status).toBe(200);
    expect(normalize(byId(viewerList.body), itLabels(w))).toEqual(
      committedSnapshot(itinerariesSnap, "GET /trips/:tripId/itineraries > viewer gets the viewer projection: no confirmationNumber, no ticketNumber (snapshot) 1"),
    );
    const editorList = await read(await w.as.editor.get(base));
    expect(normalize(byId(editorList.body), itLabels(w))).toEqual(
      committedSnapshot(itinerariesSnap, "GET /trips/:tripId/itineraries > editor gets the full projection (snapshot) 1"),
    );
    const viewerFlight = await read(await w.as.viewer.get(`${base}/${IT.flight}`));
    expect(normalize(viewerFlight.body, itLabels(w))).toEqual(
      committedSnapshot(itinerariesSnap, "GET /trips/:tripId/itineraries/:itineraryId > viewer: new-format flight (snapshot) 1"),
    );

    // Role gates are unchanged: Viewer writes 403, non-member writes 403 (requireTripEditor).
    const before = await dbState();
    expect((await w.as.viewer.put(`${base}/${IT.activity}`, { notes: "x" })).status).toBe(403);
    expect((await w.as.outsider.post(base, { type: "Activity", content: { name: "x", startTime: "2090-03-02T10:00" } })).status).toBe(403);
    expect(await dbState()).toEqual(before);

    // The documented REST contract: identical to the committed OpenAPI document.
    const doc = await (await send(new Request(`${MAIN_ORIGIN}/api/openapi.json`))).json();
    await expect(JSON.stringify(doc, null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/openapi.json");
  });
});

/*
 * PRD 11 bullets that need a live client and cannot be automated offline
 * ----------------------------------------------------------------------
 * The tests above simulate each client's protocol steps against the real Worker with the
 * Access for SaaS upstream stubbed. What they cannot prove, and the manual step that does:
 *
 * 1. "claude.ai can add the server as a custom connector, complete sign-in, and call list_trips."
 *    Live: claude.ai Settings > Connectors > Add custom connector > the production MCP_PUBLIC_URL.
 *    Verify claude.ai self-registers through DCR (a new client appears under /admin/oauth-clients
 *    or the user's grants after approval), the consent page and real Access sign-in complete, and
 *    a chat asking for "my trips" invokes list_trips and returns the user's trips. Repeat once in
 *    Claude Desktop and Claude mobile (same connector).
 *
 * 2. "Gemini Spark can add the server under Custom apps for Spark, complete sign-in via Google
 *    callback, and call list_trips."
 *    Live: gemini.google.com > Settings & help > Connected Apps > Custom apps for Spark > Add a
 *    custom app > MCP_PUBLIC_URL (DCR, or the static client from /admin/oauth-clients if Spark
 *    asks for credentials). Verify the redirect lands on Google's real callback
 *    (oauth-redirect.googleusercontent.com or vertexaisearch.cloud.google.com) and that
 *    "@trips list my trips" returns data. Confirms which redirect URI Google actually registers.
 *
 * 3. "Gemini Spark unattended background routines can refresh expired access tokens using the
 *    refresh token without user intervention."
 *    Live: create a recurring Spark routine that calls list_trips, leave it for more than one
 *    access-token lifetime (1 hour; ideally a day), and confirm later runs succeed with no
 *    re-consent prompt, and that the Worker logs show refresh_token grants for that client and
 *    no new /authorize for that user. Offline coverage proves the server side only.
 *
 * 4. "Claude Code can connect through /mcp sign-in and through a service token header, and both
 *    resolve to the correct user."
 *    Live (OAuth): `claude mcp add --transport http trips "$TRIPS_MCP_URL"`, run /mcp, complete the
 *    browser sign-in on the loopback redirect, then ask for get_me and check the id and email.
 *    Live (service token): against production /api/mcp with a real Access service token
 *    (CF-Access-Client-Id / CF-Access-Client-Secret headers in the Claude Code server config),
 *    so Cloudflare Access itself issues the Cf-Access-Jwt-Assertion; check get_me returns the user
 *    mapped in service_identities, the same id as the OAuth connection. Offline, the JWT is signed
 *    locally and the team JWKS is stubbed; the Access edge (service-auth policy, header to JWT
 *    exchange) is not exercised.
 *
 * 5. "Discovery, registration and token endpoints respond in under one second from Anthropic and
 *    Google egress ranges."
 *    Live: from hosts in (or proxied through) Anthropic and Google egress, time
 *    GET /.well-known/oauth-protected-resource/mcp, GET /.well-known/oauth-authorization-server,
 *    POST /oauth/register and POST /oauth/token against production (e.g. `curl -w
 *    "%{time_total}"`, several samples, p95 < 1 s). Practically, the connector flows in 1 to 3
 *    completing without client timeouts, plus the Worker's own request duration metrics. The
 *    in-process timing test above is a sanity bound only.
 */

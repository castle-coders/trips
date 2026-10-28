// OAuth grant management (TDD 7.5, PRD 6.3, 6.4): admin and self-service list/revoke on the main
// hostname, static client seeding, and proof that revocation kills the bearer token (401).
//
// Stage 2 vars are "" in wrangler.toml, so every request goes through the real Worker default
// export with MCP_HOST / MCP_PUBLIC_URL supplied as an env override. A grant is seeded through
// the library helpers (createClient, parseAuthRequest, completeAuthorization) and the code is
// exchanged at the real token endpoint on the MCP host, so the tokens are genuine.
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/db";
import worker from "../src/index";
import { buildProviderOptions } from "../src/oauth/provider";
import { seedUser } from "./helpers";
import { parseRpc, rpcBody } from "./helpers/mcp";

type Bindings = Env["Bindings"];

const MCP_HOST = "mcp.example.test";
const MCP_PUBLIC_URL = `https://${MCP_HOST}/mcp`;
const MAIN = "https://example.test";
const LOOPBACK_REDIRECT = "http://localhost:5555/callback";

function stage2Env(): Bindings {
  return { ...(env as unknown as Bindings), MCP_HOST, MCP_PUBLIC_URL };
}

function stage2OffEnv(): Bindings {
  return { ...(env as unknown as Bindings), MCP_HOST: "", MCP_PUBLIC_URL: "" };
}

async function send(req: Request, e: Bindings = stage2Env()): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Main-hostname REST call as `email` (DEV_MODE header), through the /api prefix. */
function asMain(email: string | null, path: string, init: RequestInit = {}, e?: Bindings): Promise<Response> {
  const headers = new Headers(init.headers);
  if (email) headers.set("X-Dev-User-Email", email);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return send(new Request(`${MAIN}/api${path}`, { ...init, headers }), e);
}

/** POST /mcp on the MCP host with a bearer token: tools/call get_me. */
async function mcpGetMe(accessToken: string) {
  const res = await send(
    new Request(`https://${MCP_HOST}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(rpcBody("tools/call", { name: "get_me", arguments: {} })),
    }),
  );
  return parseRpc(res);
}

async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return send(
    new Request(`https://${MCP_HOST}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    }),
  );
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Connected {
  clientId: string;
  grantId: string;
  accessToken: string;
  refreshToken: string;
}

/** A full authorization for `userId` with a public loopback client: real grant and tokens. */
async function connectApp(userId: string, clientName: string, scope = ["trips:read"]): Promise<Connected> {
  const e = stage2Env();
  const api = getOAuthApi(buildProviderOptions(e), e);
  const before = new Set((await api.listUserGrants(userId)).items.map((g) => g.id));
  const client = await api.createClient({ clientName, redirectUris: [LOOPBACK_REDIRECT], tokenEndpointAuthMethod: "none" });

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    scope: scope.join(" "),
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_PUBLIC_URL,
  });
  const authRequest = await api.parseAuthRequest(new Request(`https://${MCP_HOST}/authorize?${q}`));
  const { redirectTo } = await api.completeAuthorization({ request: authRequest, userId, metadata: {}, scope, props: { userId } });
  const code = new URL(redirectTo).searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await send(
    new Request(`https://${MCP_HOST}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: LOOPBACK_REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    }),
  );
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  expect(tokenRes.status, JSON.stringify(tokens)).toBe(200);

  const grant = (await api.listUserGrants(userId)).items.find((g) => !before.has(g.id));
  expect(grant).toBeDefined();
  return { clientId: client.clientId, grantId: grant!.id, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** Number of KV keys whose name starts with `prefix`. */
async function kvCount(prefix: string): Promise<number> {
  return (await (env as unknown as Bindings).OAUTH_KV.list({ prefix })).keys.length;
}

afterEach(() => vi.restoreAllMocks());

describe("self-service grants: /auth/me/grants", () => {
  it("lists only the caller's grants with client name, scopes and ISO created time", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const bob = await seedUser("bob@example.test", "viewer");
    const a = await connectApp(alice.id, "Alice Tool", ["trips:read", "offline_access"]);
    await connectApp(bob.id, "Bob Tool");

    const res = await asMain(alice.email, "/auth/me/grants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: a.grantId,
      clientId: a.clientId,
      clientName: "Alice Tool",
      scopes: ["trips:read", "offline_access"],
    });
    expect(new Date(body[0].createdAt).toISOString()).toBe(body[0].createdAt);
    expect(typeof body[0].expiresAt).toBe("string");
    expect(Object.keys(body[0]).sort()).toEqual(["clientId", "clientName", "createdAt", "expiresAt", "id", "scopes"]);
  });

  it("revoking deletes the grant and its tokens: the next bearer call is 401 and refresh fails", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const a = await connectApp(alice.id, "Alice Tool");

    const ok = await mcpGetMe(a.accessToken);
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.message.result.structuredContent.id).toBe(alice.id);
    expect(await kvCount(`token:${alice.id}:${a.grantId}:`)).toBeGreaterThan(0);

    const del = await asMain(alice.email, `/auth/me/grants/${a.grantId}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const after = await mcpGetMe(a.accessToken);
    expect(after.status).toBe(401);
    expect(await kvCount(`token:${alice.id}:${a.grantId}:`)).toBe(0);
    expect(await kvCount(`grant:${alice.id}:${a.grantId}`)).toBe(0);
    const r = await refresh(a.clientId, a.refreshToken);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");

    const list = await asMain(alice.email, "/auth/me/grants");
    expect(await list.json()).toEqual([]);
  });

  it("another user's grant id returns 404 and the grant keeps working", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const bob = await seedUser("bob@example.test", "viewer");
    const b = await connectApp(bob.id, "Bob Tool");

    const del = await asMain(alice.email, `/auth/me/grants/${b.grantId}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    expect((await mcpGetMe(b.accessToken)).status).toBe(200);

    expect((await asMain(alice.email, "/auth/me/grants/doesnotexist", { method: "DELETE" })).status).toBe(404);
  });

  it("requires a signed-in user", async () => {
    expect((await asMain(null, "/auth/me/grants")).status).toBe(401);
    expect((await asMain(null, "/auth/me/grants/abc", { method: "DELETE" })).status).toBe(401);
    expect((await asMain("nobody@example.test", "/auth/me/grants")).status).toBe(401);
  });

  it("rejects malformed grant ids", async () => {
    const alice = await seedUser("alice@example.test", "viewer");
    const res = await asMain(alice.email, `/auth/me/grants/${encodeURIComponent("a:b")}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

describe("admin grants: /admin/grants", () => {
  it("lists every user's grants with user id and email; non-admins get 403", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "editor");
    const bob = await seedUser("bob@example.test", "viewer");
    const a = await connectApp(alice.id, "Alice Tool");
    const b = await connectApp(bob.id, "Bob Tool", ["trips:read", "trips:write"]);

    const res = await asMain(admin.email, "/admin/grants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(2);
    const byId = Object.fromEntries(body.map((g) => [g.id, g]));
    expect(byId[a.grantId]).toMatchObject({ userId: alice.id, userEmail: alice.email, clientId: a.clientId, clientName: "Alice Tool", scopes: ["trips:read"] });
    expect(byId[b.grantId]).toMatchObject({ userId: bob.id, userEmail: bob.email, clientName: "Bob Tool", scopes: ["trips:read", "trips:write"] });

    for (const email of [alice.email, bob.email]) {
      expect((await asMain(email, "/admin/grants")).status).toBe(403);
      expect((await asMain(email, `/admin/grants/${bob.id}/${b.grantId}`, { method: "DELETE" })).status).toBe(403);
    }
    expect((await mcpGetMe(b.accessToken)).status).toBe(200);
  });

  it("admin revoke needs the owner's userId: wrong user 404 (grant intact), right user 204 then bearer 401", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "viewer");
    const a = await connectApp(alice.id, "Alice Tool");

    const wrong = await asMain(admin.email, `/admin/grants/${admin.id}/${a.grantId}`, { method: "DELETE" });
    expect(wrong.status).toBe(404);
    expect((await mcpGetMe(a.accessToken)).status).toBe(200);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    const del = await asMain(admin.email, `/admin/grants/${alice.id}/${a.grantId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await mcpGetMe(a.accessToken)).status).toBe(401);
    expect(await kvCount(`token:${alice.id}:${a.grantId}:`)).toBe(0);
    expect(logs.join("\n")).not.toContain(a.accessToken);

    expect(await (await asMain(admin.email, "/admin/grants")).json()).toEqual([]);
  });
});

describe("static OAuth clients: /admin/oauth-clients", () => {
  it("creates a confidential client, returns the secret once, stores only its hash", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));

    const res = await asMain(admin.email, "/admin/oauth-clients", {
      method: "POST",
      body: JSON.stringify({ clientName: "Gemini Spark", redirectUris: ["https://vertexaisearch.cloud.google.com/oauth-redirect"] }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = (await res.json()) as any;
    expect(created).toMatchObject({
      clientName: "Gemini Spark",
      redirectUris: ["https://vertexaisearch.cloud.google.com/oauth-redirect"],
      tokenEndpointAuthMethod: "client_secret_basic",
      confidential: true,
    });
    expect(created.clientSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(logs.join("\n")).not.toContain(created.clientSecret);

    const raw = await (env as unknown as Bindings).OAUTH_KV.get(`client:${created.clientId}`);
    expect(raw).not.toContain(created.clientSecret);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(created.clientSecret)));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(JSON.parse(raw!).clientSecret).toBe(hex);

    const list = await asMain(admin.email, "/admin/oauth-clients");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(created.clientSecret);
    expect(text).not.toContain(hex);
    const items = JSON.parse(text) as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("clientSecret");
    expect(items[0]).toMatchObject({ clientId: created.clientId, clientName: "Gemini Spark", confidential: true });
  });

  it("the seeded client authenticates at the token endpoint with its secret", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const created = (await (
      await asMain(admin.email, "/admin/oauth-clients", {
        method: "POST",
        body: JSON.stringify({ clientName: "Static", redirectUris: [LOOPBACK_REDIRECT], tokenEndpointAuthMethod: "client_secret_post" }),
      })
    ).json()) as any;

    const e = stage2Env();
    const api = getOAuthApi(buildProviderOptions(e), e);
    const q = new URLSearchParams({ response_type: "code", client_id: created.clientId, redirect_uri: LOOPBACK_REDIRECT, scope: "trips:read", state: "s", resource: MCP_PUBLIC_URL });
    const authRequest = await api.parseAuthRequest(new Request(`https://${MCP_HOST}/authorize?${q}`));
    const { redirectTo } = await api.completeAuthorization({ request: authRequest, userId: admin.id, metadata: {}, scope: ["trips:read"], props: { userId: admin.id } });
    const code = new URL(redirectTo).searchParams.get("code")!;
    const exchange = (secret: string) =>
      send(
        new Request(`https://${MCP_HOST}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: LOOPBACK_REDIRECT, client_id: created.clientId, client_secret: secret }),
        }),
      );
    expect((await exchange("wrong-secret")).status).toBe(401);
    const ok = await exchange(created.clientSecret);
    expect(ok.status).toBe(200);
  });

  it("rejects redirect URIs off the allow-list and non-admins", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const viewer = await seedUser("viewer@example.test", "viewer");
    for (const redirectUris of [["https://evil.example.test/cb"], [LOOPBACK_REDIRECT, "https://evil.example.test/cb"], []]) {
      const res = await asMain(admin.email, "/admin/oauth-clients", { method: "POST", body: JSON.stringify({ clientName: "X", redirectUris }) });
      expect(res.status, JSON.stringify(redirectUris)).toBe(400);
    }
    const pub = await asMain(admin.email, "/admin/oauth-clients", {
      method: "POST",
      body: JSON.stringify({ clientName: "X", redirectUris: [LOOPBACK_REDIRECT], tokenEndpointAuthMethod: "none" }),
    });
    expect(pub.status).toBe(400);
    expect(await kvCount("client:")).toBe(0);

    const ok = { method: "POST", body: JSON.stringify({ clientName: "X", redirectUris: [LOOPBACK_REDIRECT] }) };
    expect((await asMain(viewer.email, "/admin/oauth-clients", ok)).status).toBe(403);
    expect((await asMain(viewer.email, "/admin/oauth-clients")).status).toBe(403);
    expect((await asMain(viewer.email, "/admin/oauth-clients/abc", { method: "DELETE" })).status).toBe(403);
    expect(await kvCount("client:")).toBe(0);
  });

  it("deleting a client removes it and revokes its grants (bearer 401); unknown id 404", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "viewer");
    const a = await connectApp(alice.id, "Alice Tool");
    expect((await mcpGetMe(a.accessToken)).status).toBe(200);

    expect((await asMain(admin.email, "/admin/oauth-clients/nosuchclient", { method: "DELETE" })).status).toBe(404);
    const del = await asMain(admin.email, `/admin/oauth-clients/${a.clientId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await mcpGetMe(a.accessToken)).status).toBe(401);
    expect(await kvCount(`client:${a.clientId}`)).toBe(0);
    expect(await (await asMain(alice.email, "/auth/me/grants")).json()).toEqual([]);
  });
});

describe("Stage 2 off (MCP_PUBLIC_URL empty)", () => {
  it("lists return [] and mutations return 503", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const off = stage2OffEnv();
    for (const path of ["/auth/me/grants", "/admin/grants", "/admin/oauth-clients"]) {
      const res = await asMain(admin.email, path, {}, off);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual([]);
    }
    const mutations: [string, RequestInit][] = [
      ["/auth/me/grants/abc", { method: "DELETE" }],
      [`/admin/grants/${admin.id}/abc`, { method: "DELETE" }],
      ["/admin/oauth-clients/abc", { method: "DELETE" }],
      ["/admin/oauth-clients", { method: "POST", body: JSON.stringify({ clientName: "X", redirectUris: [LOOPBACK_REDIRECT] }) }],
    ];
    for (const [path, init] of mutations) {
      const res = await asMain(admin.email, path, init, off);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: "OAuth is not configured" });
    }
  });
});

// Security review (Medium): deleting or merging away a user must not leave live OAuth grants in
// KV keyed to an id no listing can reach. Revocation runs before the D1 row is removed.
describe("user deletion and account merge revoke the removed user's grants", () => {
  async function expectDead(userId: string, c: Connected) {
    expect(await kvCount(`grant:${userId}:`)).toBe(0);
    expect(await kvCount(`token:${userId}:`)).toBe(0);
    expect((await mcpGetMe(c.accessToken)).status).not.toBe(200);
    const r = await refresh(c.clientId, c.refreshToken);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  }

  it("DELETE /admin/users/{id} revokes every grant and token of that user (204 unchanged)", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "editor");
    const bob = await seedUser("bob@example.test", "viewer");
    const a1 = await connectApp(alice.id, "Alice Tool 1");
    const a2 = await connectApp(alice.id, "Alice Tool 2", ["trips:read", "offline_access"]);
    const b = await connectApp(bob.id, "Bob Tool");
    expect((await mcpGetMe(a1.accessToken)).status).toBe(200);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    const del = await asMain(admin.email, `/admin/users/${alice.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    await expectDead(alice.id, a1);
    await expectDead(alice.id, a2);
    expect(logs.join("\n")).toContain(`[oauth] event=revoke scope=user user=${alice.id} count=2`);
    expect(logs.join("\n")).not.toContain(a1.accessToken);
    expect(logs.join("\n")).not.toContain(a1.refreshToken);

    // Other users are untouched.
    expect((await mcpGetMe(b.accessToken)).status).toBe(200);
    const all = (await (await asMain(admin.email, "/admin/grants")).json()) as any[];
    expect(all.map((g) => g.id)).toEqual([b.grantId]);
  });

  it("a revocation failure aborts the delete: 500 and the user row survives", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const alice = await seedUser("alice@example.test", "editor");
    await connectApp(alice.id, "Alice Tool");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const base = stage2Env();
    const brokenKv = new Proxy(base.OAUTH_KV, {
      get(target, prop, receiver) {
        if (prop === "list") return () => Promise.reject(new Error("kv down"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await asMain(admin.email, `/admin/users/${alice.id}`, { method: "DELETE" }, { ...base, OAUTH_KV: brokenKv });
    expect(res.status).toBe(500);

    const users = (await (await asMain(admin.email, "/admin/users")).json()) as any[];
    expect(users.map((u) => u.id)).toContain(alice.id);
    expect(await kvCount(`grant:${alice.id}:`)).toBe(1);
  });

  it("POST /admin/users/merge revokes the merged-away user's grants and leaves the keep user's", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const keep = await seedUser("keep@example.test", "editor");
    const gone = await seedUser("gone@example.test", "viewer");
    const k = await connectApp(keep.id, "Keep Tool");
    const g = await connectApp(gone.id, "Gone Tool");

    const res = await asMain(admin.email, "/admin/users/merge", {
      method: "POST",
      body: JSON.stringify({ keepUserId: keep.id, mergeUserId: gone.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(keep.id);
    expect(body.emails.map((e: any) => e.email).sort()).toEqual(["gone@example.test", "keep@example.test"]);

    await expectDead(gone.id, g);
    const ok = await mcpGetMe(k.accessToken);
    expect(ok.status).toBe(200);
    expect(ok.message.result.structuredContent.id).toBe(keep.id);
    expect(await kvCount(`grant:${keep.id}:`)).toBe(1);
  });

  it("a merge that 404s revokes nothing", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const gone = await seedUser("gone@example.test", "viewer");
    const g = await connectApp(gone.id, "Gone Tool");

    const res = await asMain(admin.email, "/admin/users/merge", {
      method: "POST",
      body: JSON.stringify({ keepUserId: crypto.randomUUID(), mergeUserId: gone.id }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Keep user not found" });
    expect((await mcpGetMe(g.accessToken)).status).toBe(200);
  });

  it("POST /auth/me/link (self-service merge) revokes the caller's grants, not the keep user's", async () => {
    const keep = await seedUser("keep@example.test", "editor");
    const gone = await seedUser("gone@example.test", "viewer");
    const k = await connectApp(keep.id, "Keep Tool");
    const g = await connectApp(gone.id, "Gone Tool");

    const { token } = (await (await asMain(keep.email, "/auth/me/link-token", { method: "POST" })).json()) as any;
    const res = await asMain(gone.email, "/auth/me/link", { method: "POST", body: JSON.stringify({ token }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe(keep.id);

    await expectDead(gone.id, g);
    expect((await mcpGetMe(k.accessToken)).status).toBe(200);
  });

  it("Stage 2 off: delete and merge behave exactly as before", async () => {
    const admin = await seedUser("admin@example.test", "admin");
    const keep = await seedUser("keep@example.test", "editor");
    const gone = await seedUser("gone@example.test", "viewer");
    const doomed = await seedUser("doomed@example.test", "viewer");
    const off = stage2OffEnv();

    const merge = await asMain(admin.email, "/admin/users/merge", {
      method: "POST",
      body: JSON.stringify({ keepUserId: keep.id, mergeUserId: gone.id }),
    }, off);
    expect(merge.status).toBe(200);
    expect(((await merge.json()) as any).id).toBe(keep.id);

    expect((await asMain(admin.email, `/admin/users/${doomed.id}`, { method: "DELETE" }, off)).status).toBe(204);
    expect((await asMain(admin.email, `/admin/users/${doomed.id}`, { method: "DELETE" }, off)).status).toBe(404);
  });
});

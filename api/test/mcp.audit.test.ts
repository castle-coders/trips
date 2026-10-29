// Audit attribution for MCP writes (AUDIT_TDD 4.3 channel table, 11 "mcp.*.test.ts"; AUDIT_PRD 6.2,
// 6.7, acceptance criterion 2).
//
// Three entry points are exercised end to end:
//  - Stage 1, DEV_MODE header:          /api/mcp on the main host through authMiddleware -> mcp_stage1, clientId null
//  - Stage 1, Access service token:     same route with a locally signed Access JWT resolved through
//                                       service_identities -> mcp_stage1, clientId = common name
//  - Stage 2, OAuth bearer token:       /mcp on the MCP host through the provider's apiHandler -> mcp_oauth,
//                                       clientId = the DCR client id from the sign-in flow
// In every case the actor is the human user, never the client or service identity, and requestId
// is the request's cf-ray header. All ids, hostnames and secrets here are obviously fake.
import { eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { itineraries, serviceIdentities } from "../src/db/schema";
import { loadRequestContext } from "../src/mcp/context";
import { flightContent, seedItinerary, testDb } from "./helpers";
import { auditRows, type AuditRow } from "./helpers/audit";
import {
  IDS,
  IT,
  READ_TOOLS,
  WRITE_TOOLS,
  authFor,
  mcpDirect,
  mcpStage1,
  parseRpc,
  rpcBody,
  seedMcpWorld,
  validArgs,
  type McpClient,
  type ToolResult,
} from "./helpers/mcp";
import { MAIN_ORIGIN, mcpRpc, send, signIn, stage2Env } from "./helpers/oauth";

afterEach(() => vi.restoreAllMocks());

const RPC_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

/** entityType / action each write tool must record (exactly one event per call). */
const WRITE_EVENT: Record<(typeof WRITE_TOOLS)[number], { entityType: string; action: string }> = {
  create_trip: { entityType: "trip", action: "create" },
  create_itinerary: { entityType: "itinerary", action: "create" },
  update_itinerary: { entityType: "itinerary", action: "update" },
  add_expense: { entityType: "expense", action: "create" },
};

/** The actor snapshot an event must carry for `u` (PRD 6.2: name, email and global role at the time). */
function actorSnapshot(u: { id: string; email: string; name: string; role: string }) {
  return { actorUserId: u.id, actorName: u.name, actorEmail: u.email, actorRole: u.role };
}

/** Rows added since `before` (by seq), oldest first. */
function since(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const last = before.length ? before[before.length - 1].seq : -1;
  return after.filter((r) => r.seq > last);
}

/** The stored row for `itineraryId`. */
async function storedItinerary(itineraryId: string) {
  const [row] = await testDb().select().from(itineraries).where(eq(itineraries.id, itineraryId));
  return row;
}

/** A no-op patch for the seeded Activity: every value equals what seedItineraries() stored. */
const ACTIVITY_NOOP_PATCH = {
  tripId: IDS.trip,
  itineraryId: IT.activity,
  type: "Activity",
  status: "Confirmed",
  content: { name: "Museum", location: "Testville", startTime: "2090-03-02T10:00", startTimeTz: "Europe/Paris" },
  confirmationNumber: "CONF-FAKE-ACT",
  totalCost: 25,
  currency: "EUR",
  notes: "Bring ID",
};

// --- Cloudflare Access service token (Stage 1 with a service identity) -------------------------
// Same technique as acceptance.test.ts: authMiddleware verifies Cf-Access-Jwt-Assertion against
// https://<team>/cdn-cgi/access/certs through jose's createRemoteJWKSet (global fetch), so the
// test answers that one URL with a local RS256 key. DEV_MODE is off so only the JWT authenticates.
const FAKE_TEAM_DOMAIN = "fake-team.access.example.test";
const FAKE_AUDIENCE = "fake-access-audience-tag-0000";
const FAKE_CERTS_URL = `https://${FAKE_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const FAKE_SERVICE_COMMON_NAME = "fake-audit-service-token.access";
const accessKeys = await generateKeyPair("RS256");
const ACCESS_JWK = { ...(await exportJWK(accessKeys.publicKey)), kid: "fake-access-kid-audit", alg: "RS256", use: "sig" };

function stubAccessCerts(): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === FAKE_CERTS_URL) return Response.json({ keys: [ACCESS_JWK] });
    return real(input, init);
  });
}

function serviceTokenJwt(commonName = FAKE_SERVICE_COMMON_NAME): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "", common_name: commonName, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: ACCESS_JWK.kid })
    .setIssuer(`https://${FAKE_TEAM_DOMAIN}`)
    .setAudience(FAKE_AUDIENCE)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

const accessEnv = () => stage2Env({ CF_ACCESS_TEAM_DOMAIN: FAKE_TEAM_DOMAIN, CF_ACCESS_AUDIENCE: FAKE_AUDIENCE, DEV_MODE: "" });

/** Stage 1 client authenticated by an Access service-token JWT, with extra headers (cf-ray). */
function mcpServiceToken(jwt: string, extraHeaders: Record<string, string> = {}): McpClient {
  const sendRpc = async (body: unknown) =>
    send(
      new Request(`${MAIN_ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { ...RPC_HEADERS, "Cf-Access-Jwt-Assertion": jwt, ...extraHeaders },
        body: JSON.stringify(body),
      }),
      accessEnv(),
    );
  return {
    rpc: async (method, params) => parseRpc(await sendRpc(rpcBody(method, params))),
    async listTools() {
      const r = await parseRpc(await sendRpc(rpcBody("tools/list", {})));
      return r.message.result.tools;
    },
    async call(name, args = {}) {
      const r = await parseRpc(await sendRpc(rpcBody("tools/call", { name, arguments: args })));
      expect(r.status, r.raw).toBe(200);
      expect(r.message?.error, r.raw).toBeUndefined();
      const result = r.message.result;
      const text = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      return { isError: result.isError === true, text, structured: result.structuredContent, result, reply: r };
    },
  };
}

/** Stage 2 tools/call over the bearer token, returning a ToolResult like the other clients. */
async function stage2Call(token: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<ToolResult> {
  const r = await mcpRpc(token, "tools/call", { name, arguments: args }, { headers });
  expect(r.status, r.raw).toBe(200);
  expect(r.message?.error, r.raw).toBeUndefined();
  const result = r.message.result;
  const text = (result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  return { isError: result.isError === true, text, structured: result.structuredContent, result, reply: r };
}

// ------------------------------------------------------------------------------------------------

describe("Stage 1 (dev header): every write tool records one mcp_stage1 event for the human user", () => {
  for (const tool of WRITE_TOOLS) {
    it(`${tool}: channel mcp_stage1, actor = user, clientId null, requestId = cf-ray`, async () => {
      const w = await seedMcpWorld();
      const ray = `ray-stage1-${tool}-0001`;
      const r = await mcpStage1(w.users.owner.email, { "cf-ray": ray }).call(tool, validArgs()[tool]);
      expect(r.isError, r.text).toBe(false);

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ...WRITE_EVENT[tool],
        ...actorSnapshot(w.users.owner),
        channel: "mcp_stage1",
        clientId: null,
        requestId: ray,
      });
      // The event points at the row the tool created or changed.
      const entityId: string =
        tool === "create_trip" ? r.structured.trip.id : tool === "add_expense" ? r.structured.expense.id : r.structured.itinerary.id;
      expect(rows[0].entityId).toBe(entityId);
      expect(rows[0].tripId).toBe(tool === "create_trip" ? entityId : IDS.trip);
    });
  }

  it("update_itinerary: changes carry only the patched fields (status, notes), nothing re-sent", async () => {
    const w = await seedMcpWorld();
    const r = await mcpStage1(w.users.editor.email).call("update_itinerary", validArgs().update_itinerary);
    expect(r.isError, r.text).toBe(false);
    const [ev] = await auditRows();
    expect(ev.action).toBe("update");
    expect(ev.changes).toEqual({
      status: { from: "Confirmed", to: "Cancelled" },
      notes: { from: "Bring ID", to: "changed" },
    });
    expect(ev.channel).toBe("mcp_stage1");
    expect(ev.actorUserId).toBe(w.users.editor.id);
  });

  it("requestId is null when the request has no cf-ray header", async () => {
    const w = await seedMcpWorld();
    await mcpStage1(w.users.owner.email).call("create_trip", { name: "No ray trip" });
    const [ev] = await auditRows();
    expect(ev.channel).toBe("mcp_stage1");
    expect(ev.requestId).toBeNull();
  });
});

describe("Stage 1 (Access service token): clientId is the service identity common name, actor is the mapped human", () => {
  it("create_trip and update_itinerary through a service-token JWT record mcp_stage1 with clientId = commonName", async () => {
    const w = await seedMcpWorld();
    await testDb().insert(serviceIdentities).values({
      id: crypto.randomUUID(),
      cfAccessSubject: FAKE_SERVICE_COMMON_NAME,
      commonName: FAKE_SERVICE_COMMON_NAME,
      userId: w.users.owner.id,
      createdAt: new Date().toISOString(),
    });
    stubAccessCerts();
    const jwt = await serviceTokenJwt();
    const c = mcpServiceToken(jwt, { "cf-ray": "ray-svc-0001" });

    const t = await c.call("create_trip", { name: "Service token trip" });
    expect(t.isError, t.text).toBe(false);
    const u = await c.call("update_itinerary", validArgs().update_itinerary);
    expect(u.isError, u.text).toBe(false);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    for (const ev of rows) {
      expect(ev).toMatchObject({
        ...actorSnapshot(w.users.owner),
        channel: "mcp_stage1",
        clientId: FAKE_SERVICE_COMMON_NAME,
        requestId: "ray-svc-0001",
      });
    }
    expect(rows.map((r) => `${r.entityType}.${r.action}`)).toEqual(["trip.create", "itinerary.update"]);
    // The service identity row id never stands in for the human.
    const [ident] = await testDb().select().from(serviceIdentities);
    expect(rows.every((r) => r.actorUserId !== ident.id)).toBe(true);
    // Negative control: the JWT itself is not in any snapshot.
    expect(JSON.stringify(rows)).not.toContain(jwt);
  });
});

describe("Stage 2 (OAuth bearer token): mcp_oauth with the flow's client id, attributed to the human", () => {
  it("update_itinerary records channel mcp_oauth, clientId = registered client id, actor = user, requestId = cf-ray", async () => {
    const w = await seedMcpWorld();
    const { clientId, tokens } = await signIn(w.users.editor.email, { ticked: ["trips:read", "trips:write"] });
    const before = await auditRows(); // the sign-in may record OAuth administration events; exclude them
    const ray = "ray-stage2-0001";

    const r = await stage2Call(tokens.access_token, "update_itinerary", validArgs().update_itinerary, { "cf-ray": ray });
    expect(r.isError, r.text).toBe(false);

    const added = since(before, await auditRows());
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      ...actorSnapshot(w.users.editor),
      entityType: "itinerary",
      entityId: IT.activity,
      tripId: IDS.trip,
      action: "update",
      channel: "mcp_oauth",
      clientId,
      requestId: ray,
    });
    expect(added[0].changes).toEqual({
      status: { from: "Confirmed", to: "Cancelled" },
      notes: { from: "Bring ID", to: "changed" },
    });
    // The bearer token is never read for attribution and never stored (PRD 6.2).
    expect(JSON.stringify(added)).not.toContain(tokens.access_token);
    expect(JSON.stringify(added)).not.toContain(tokens.refresh_token!);
  });

  it("every write tool over Stage 2 records exactly one mcp_oauth event", async () => {
    const w = await seedMcpWorld();
    const { clientId, tokens } = await signIn(w.users.owner.email, { ticked: ["trips:read", "trips:write"] });
    const before = await auditRows();
    for (const tool of WRITE_TOOLS) {
      const r = await stage2Call(tokens.access_token, tool, validArgs()[tool], { "cf-ray": `ray-stage2-${tool}` });
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
    }
    const added = since(before, await auditRows());
    expect(added.map((r) => `${r.entityType}.${r.action}`)).toEqual(WRITE_TOOLS.map((t) => `${WRITE_EVENT[t].entityType}.${WRITE_EVENT[t].action}`));
    for (const [i, ev] of added.entries()) {
      expect(ev).toMatchObject({
        ...actorSnapshot(w.users.owner),
        channel: "mcp_oauth",
        clientId,
        requestId: `ray-stage2-${WRITE_TOOLS[i]}`,
      });
    }
  });

  it("PRD acceptance 2: a flight departure-time change over Stage 2 is the same event as over REST, except channel and clientId", async () => {
    const w = await seedMcpWorld();
    const p = w.participants.editor.id;
    // Two flights with identical content so the same patch can go through both paths.
    const twin = await seedItinerary(IDS.trip, { type: "Flight", content: flightContent(p), confirmationNumber: "CONF-FAKE-FLT" });
    const patchedContent = flightContent(p);
    (patchedContent.legs[0] as Record<string, unknown>).departureTime = "2030-01-10T09:45";

    // REST PUT as the editor (dev header -> channel "dev"; the web app's Access session would be "web").
    const rest = await w.as.editor.put(`/trips/${IDS.trip}/itineraries/${IT.flight}`, { content: patchedContent });
    expect(rest.status, await rest.clone().text()).toBe(200);
    const [restEvent] = await auditRows();

    const { clientId, tokens } = await signIn(w.users.editor.email, { ticked: ["trips:read", "trips:write"] });
    const before = await auditRows();
    const r = await stage2Call(tokens.access_token, "update_itinerary", { tripId: IDS.trip, itineraryId: twin.id, content: patchedContent });
    expect(r.isError, r.text).toBe(false);
    const [mcpEvent] = since(before, await auditRows());

    const expectedChanges = { "content.legs[0].departureTime": { from: "2030-01-10T09:00", to: "2030-01-10T09:45" } };
    expect(restEvent.changes).toEqual(expectedChanges);
    expect(mcpEvent.changes).toEqual(expectedChanges);
    expect(mcpEvent).toMatchObject({ ...actorSnapshot(w.users.editor), channel: "mcp_oauth", clientId, action: "update", entityType: "itinerary" });
    expect(restEvent).toMatchObject({ ...actorSnapshot(w.users.editor), channel: "dev", clientId: null, action: "update", entityType: "itinerary" });

    // Identical apart from the per-row identity and the channel attribution.
    const strip = (e: AuditRow) => {
      const { id, seq, createdAt, entityId, channel, clientId, requestId, before, after, ...rest } = e;
      return rest;
    };
    expect(strip(mcpEvent)).toEqual(strip(restEvent));
    expect(mcpEvent.before).toEqual({ ...(restEvent.before as object), id: twin.id });
    expect(mcpEvent.after).toEqual({ ...(restEvent.after as object), id: twin.id });
  });
});

describe("Reads and refused writes record nothing", () => {
  for (const tool of READ_TOOLS) {
    it(`${tool} over Stage 1 and the direct handler leaves audit_events empty`, async () => {
      const w = await seedMcpWorld();
      const s1 = await mcpStage1(w.users.owner.email, { "cf-ray": "ray-read" }).call(tool, validArgs()[tool]);
      expect(s1.isError, s1.text).toBe(false);
      const direct = await mcpDirect(authFor(w.users.owner.id)).call(tool, validArgs()[tool]);
      expect(direct.isError, direct.text).toBe(false);
      expect(await auditRows()).toEqual([]);
    });
  }

  it("read tools over Stage 2 record nothing", async () => {
    const w = await seedMcpWorld();
    const { tokens } = await signIn(w.users.owner.email, { ticked: ["trips:read"] });
    const before = await auditRows();
    for (const tool of READ_TOOLS) {
      const r = await stage2Call(tokens.access_token, tool, validArgs()[tool]);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
    }
    expect(since(before, await auditRows())).toEqual([]);
  });

  for (const tool of WRITE_TOOLS) {
    it(`${tool} refused for scope (trips:read only) records nothing`, async () => {
      const w = await seedMcpWorld();
      const r = await mcpDirect(authFor(w.users.admin.id, ["trips:read"])).call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Missing required scope: trips:write");
      expect(await auditRows()).toEqual([]);
    });
  }

  it("write tools refused for scope over Stage 2 (read-only grant) record nothing", async () => {
    const w = await seedMcpWorld();
    const { tokens } = await signIn(w.users.owner.email, { ticked: ["trips:read"] });
    const before = await auditRows();
    for (const tool of WRITE_TOOLS) {
      const r = await stage2Call(tokens.access_token, tool, validArgs()[tool]);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toBe("Missing required scope: trips:write");
    }
    expect(since(before, await auditRows())).toEqual([]);
  });

  for (const tool of ["create_itinerary", "update_itinerary", "add_expense"] as const) {
    it(`${tool} refused for role (trip Viewer) over Stage 1 records nothing`, async () => {
      const w = await seedMcpWorld();
      const r = await mcpStage1(w.users.viewer.email).call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Forbidden");
      expect(await auditRows()).toEqual([]);
    });
  }

  it("create_trip refused for a global viewer records nothing", async () => {
    const w = await seedMcpWorld();
    const r = await mcpStage1(w.users.viewer.email).call("create_trip", { name: "Viewer trip" });
    expect(r.isError).toBe(true);
    expect(await auditRows()).toEqual([]);
  });

  it("a non-member's write (not_found) records nothing", async () => {
    const w = await seedMcpWorld();
    const r = await mcpStage1(w.users.outsider.email).call("update_itinerary", validArgs().update_itinerary);
    expect(r.isError).toBe(true);
    expect(await auditRows()).toEqual([]);
  });
});

describe("No-op update_itinerary", () => {
  it("Stage 1: re-sending every stored value records nothing and leaves updatedAt", async () => {
    const w = await seedMcpWorld();
    const stored = await storedItinerary(IT.activity);
    const r = await mcpStage1(w.users.editor.email).call("update_itinerary", ACTIVITY_NOOP_PATCH);
    expect(r.isError, r.text).toBe(false);
    expect(await storedItinerary(IT.activity)).toEqual(stored);
    expect(await auditRows()).toEqual([]);
    expect(r.structured.itinerary.updatedAt).toBe(stored.updatedAt);
  });

  it("Stage 2: the same no-op records nothing and leaves updatedAt", async () => {
    const w = await seedMcpWorld();
    const { tokens } = await signIn(w.users.editor.email, { ticked: ["trips:read", "trips:write"] });
    const stored = await storedItinerary(IT.activity);
    const before = await auditRows();
    const r = await stage2Call(tokens.access_token, "update_itinerary", ACTIVITY_NOOP_PATCH);
    expect(r.isError, r.text).toBe(false);
    expect(await storedItinerary(IT.activity)).toEqual(stored);
    expect(since(before, await auditRows())).toEqual([]);
  });

  it("a partial patch that only re-sends one unchanged field is also a no-op", async () => {
    const w = await seedMcpWorld();
    const stored = await storedItinerary(IT.activity);
    const r = await mcpStage1(w.users.editor.email).call("update_itinerary", { tripId: IDS.trip, itineraryId: IT.activity, status: "Confirmed" });
    expect(r.isError, r.text).toBe(false);
    expect(await storedItinerary(IT.activity)).toEqual(stored);
    expect(await auditRows()).toEqual([]);
  });
});

describe("loadRequestContext attribution fields", () => {
  const env = () => stage2Env();

  it("copies channel, clientId and requestId from authInfo.extra onto the Actor", async () => {
    const w = await seedMcpWorld();
    const rc = await loadRequestContext(env(), {
      token: "",
      clientId: "svc",
      scopes: ["trips:read"],
      extra: { userId: w.users.owner.id, channel: "mcp_stage1", clientId: "svc-name", requestId: "ray-unit" },
    });
    expect(rc.user).toEqual({
      id: w.users.owner.id,
      email: w.users.owner.email,
      name: w.users.owner.name,
      role: "editor",
      channel: "mcp_stage1",
      clientId: "svc-name",
      requestId: "ray-unit",
    });
  });

  it("defaults to mcp_oauth with null clientId and requestId when extra carries only userId", async () => {
    const w = await seedMcpWorld();
    const rc = await loadRequestContext(env(), authFor(w.users.owner.id));
    expect(rc.user).toMatchObject({ channel: "mcp_oauth", clientId: null, requestId: null });
  });

  it("rejects an unknown channel string", async () => {
    const w = await seedMcpWorld();
    const bad: AuthInfo = { token: "", clientId: "x", scopes: [], extra: { userId: w.users.owner.id, channel: "carrier_pigeon" } };
    await expect(loadRequestContext(env(), bad)).rejects.toThrow("MCP request has an invalid channel");
  });

  for (const [field, value] of [
    ["channel", 42],
    ["clientId", { id: "x" }],
    ["requestId", ["ray"]],
  ] as const) {
    it(`rejects a non-string ${field}`, async () => {
      const w = await seedMcpWorld();
      const bad: AuthInfo = { token: "", clientId: "x", scopes: [], extra: { userId: w.users.owner.id, [field]: value } };
      await expect(loadRequestContext(env(), bad)).rejects.toThrow(`MCP request has an invalid ${field}`);
    });
  }

  it("never reads authInfo.token (a throwing getter is not triggered) and the token is not on the Actor", async () => {
    const w = await seedMcpWorld();
    const authInfo = { clientId: "x", scopes: ["trips:read"], extra: { userId: w.users.owner.id, channel: "mcp_oauth", clientId: "cid" } } as unknown as AuthInfo;
    Object.defineProperty(authInfo, "token", {
      enumerable: true,
      get() {
        throw new Error("authInfo.token was read");
      },
    });
    const rc = await loadRequestContext(env(), authInfo);
    expect(rc.user.channel).toBe("mcp_oauth");
    expect(rc.user.clientId).toBe("cid");
    expect("token" in rc.user).toBe(false);
  });

  it("the handler also never reads authInfo.token on a write (end to end through the direct handler)", async () => {
    const w = await seedMcpWorld();
    const authInfo = { clientId: "cid", scopes: ["trips:read", "trips:write"], extra: { userId: w.users.owner.id, clientId: "cid", requestId: "ray-direct" } } as unknown as AuthInfo;
    Object.defineProperty(authInfo, "token", {
      enumerable: true,
      get() {
        throw new Error("authInfo.token was read");
      },
    });
    const r = await mcpDirect(authInfo).call("create_trip", { name: "Direct trip" });
    expect(r.isError, r.text).toBe(false);
    const [ev] = await auditRows();
    expect(ev).toMatchObject({ channel: "mcp_oauth", clientId: "cid", requestId: "ray-direct", actorUserId: w.users.owner.id });
  });
});

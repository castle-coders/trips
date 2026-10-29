// Stage 1: /api/mcp on the main hostname, behind authMiddleware (DEV_MODE + X-Dev-User-Email here).
// authInfo is fixed: clientId "cf-access", scopes trips:read + trips:write, extra.userId = resolved user.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { users } from "../src/db/schema";
import { dbState, testDb } from "./helpers";
import { HIDDEN_VALUES, IDS, expectNoHiddenFields, mcpStage1, seedMcpWorld, validArgs } from "./helpers/mcp";

afterEach(() => vi.restoreAllMocks());

describe("Stage 1 /api/mcp", () => {
  it("401 without any auth header, and the MCP handler is never reached", async () => {
    await seedMcpWorld();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    for (const method of ["tools/list", "tools/call"]) {
      const r = await mcpStage1(null).rpc(method, method === "tools/call" ? { name: "list_trips", arguments: {} } : {});
      expect(r.status, method).toBe(401);
      expect(r.raw).not.toContain("Parity Trip");
    }
    expect(logs.filter((l) => l.startsWith("[mcp]"))).toEqual([]);
  });

  it("401 for an email with no user (no user row is created)", async () => {
    await seedMcpWorld();
    const before = await testDb().select().from(users);
    const r = await mcpStage1("nobody@example.test").rpc("tools/list", {});
    expect(r.status).toBe(401);
    expect(await testDb().select().from(users)).toEqual(before);
  });

  it("401 once the user is deleted", async () => {
    const w = await seedMcpWorld();
    const c = mcpStage1(w.users.editor.email);
    expect((await c.call("get_me")).structured.id).toBe(w.users.editor.id);
    await testDb().delete(users).where(eq(users.id, w.users.editor.id));
    expect((await c.rpc("tools/list", {})).status).toBe(401);
  });

  it("GET /api/mcp without auth is 401 too", async () => {
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(new Request("https://example.test/api/mcp", { headers: { accept: "text/event-stream" } }));
    expect(res.status).toBe(401);
  });

  it("resolves the dev-header user and grants both scopes (reads and writes work)", async () => {
    const w = await seedMcpWorld();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    const c = mcpStage1(w.users.owner.email);
    const me = await c.call("get_me");
    expect(me.structured).toEqual({ id: w.users.owner.id, email: w.users.owner.email, name: w.users.owner.name, role: "editor" });
    const t = await c.call("create_trip", { name: "Stage 1 trip" });
    expect(t.isError, t.text).toBe(false);
    const e = await c.call("add_expense", validArgs().add_expense);
    expect(e.isError, e.text).toBe(false);
    const lines = logs.filter((l) => l.startsWith("[mcp] tool="));
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toContain(`user=${w.users.owner.id}`);
      expect(l).toContain("scopes=trips:read,trips:write");
      expect(l).not.toMatch(/X-Dev-User-Email|owner@example\.test/i);
    }
  });

  it("trip role still applies: a Viewer gets projection and Forbidden on writes, nothing written", async () => {
    const w = await seedMcpWorld();
    const c = mcpStage1(w.users.viewer.email);
    const g = await c.call("get_trip", { tripId: IDS.trip });
    expect(g.isError, g.text).toBe(false);
    expectNoHiddenFields(g, HIDDEN_VALUES);
    const before = await dbState();
    for (const tool of ["create_itinerary", "update_itinerary", "add_expense"] as const) {
      const r = await c.call(tool, validArgs()[tool]);
      expect(r.text, tool).toBe("Forbidden");
    }
    expect(await dbState()).toEqual(before);
  });

  it("a non-member gets not_found through Stage 1", async () => {
    const w = await seedMcpWorld();
    const r = await mcpStage1(w.users.outsider.email).call("get_trip", { tripId: IDS.trip });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Trip not found");
  });
});

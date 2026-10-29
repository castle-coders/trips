// Scope enforcement (TDD 9 "scope then role", amended: read tools check trips:read too).
// Scopes come from authInfo.scopes on the direct handler, as Stage 2 passes them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbState } from "./helpers";
import {
  ALL_TOOLS,
  LEAK_RE,
  READ_TOOLS,
  WRITE_TOOLS,
  authFor,
  mcpDirect,
  seedMcpWorld,
  validArgs,
} from "./helpers/mcp";

afterEach(() => vi.restoreAllMocks());

describe("MCP scopes", () => {
  // Use the admin (Owner everywhere) so only the scope can be the reason for a refusal.
  for (const tool of WRITE_TOOLS) {
    it(`trips:read only: ${tool} returns a scope error and writes nothing`, async () => {
      const w = await seedMcpWorld();
      const before = await dbState();
      const r = await mcpDirect(authFor(w.users.admin.id, ["trips:read"])).call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Missing required scope: trips:write");
      expect(r.structured).toBeUndefined();
      expect(r.text).not.toMatch(LEAK_RE);
      expect(await dbState()).toEqual(before);
    });
  }

  for (const tool of ALL_TOOLS) {
    it(`empty scopes: ${tool} returns a scope error and no data`, async () => {
      const w = await seedMcpWorld();
      const before = await dbState();
      const r = await mcpDirect(authFor(w.users.admin.id, [])).call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      const needed = (WRITE_TOOLS as readonly string[]).includes(tool) ? "trips:write" : "trips:read";
      expect(r.text).toBe(`Missing required scope: ${needed}`);
      expect(r.structured).toBeUndefined();
      expect(r.reply.raw).not.toContain("Parity Trip");
      expect(await dbState()).toEqual(before);
    });
  }

  for (const tool of READ_TOOLS) {
    it(`trips:write without trips:read: ${tool} is refused`, async () => {
      const w = await seedMcpWorld();
      const r = await mcpDirect(authFor(w.users.admin.id, ["trips:write"])).call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Missing required scope: trips:read");
      expect(r.structured).toBeUndefined();
    });
  }

  it("unknown scopes (offline_access only) grant nothing", async () => {
    const w = await seedMcpWorld();
    const c = mcpDirect(authFor(w.users.owner.id, ["offline_access", "trips:admin"]));
    expect((await c.call("list_trips")).text).toBe("Missing required scope: trips:read");
    expect((await c.call("create_trip", { name: "x" })).text).toBe("Missing required scope: trips:write");
  });

  it("scope is checked before role: a Viewer with trips:read only gets the scope error, not Forbidden", async () => {
    const w = await seedMcpWorld();
    const r = await mcpDirect(authFor(w.users.viewer.id, ["trips:read"])).call("create_itinerary", validArgs().create_itinerary);
    expect(r.text).toBe("Missing required scope: trips:write");
  });

  it("scope is checked before membership: a non-member with no write scope learns nothing about the trip", async () => {
    const w = await seedMcpWorld();
    const r = await mcpDirect(authFor(w.users.outsider.id, ["trips:read"])).call("add_expense", validArgs().add_expense);
    expect(r.text).toBe("Missing required scope: trips:write");
  });

  it("both scopes: every tool succeeds for the admin", async () => {
    const w = await seedMcpWorld();
    const args = validArgs();
    for (const tool of ALL_TOOLS) {
      const r = await w.mcp.admin.call(tool, args[tool]);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
    }
  });

  it("log lines record tool, user, trip, scopes and outcome, and never the bearer token", async () => {
    const w = await seedMcpWorld();
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const token = "fake-bearer-token-must-not-be-logged";
    const auth = { ...authFor(w.users.owner.id, ["trips:read"]), token };
    const c = mcpDirect(auth);
    await c.call("get_trip", { tripId: w.trip.id });
    await c.call("create_trip", { name: "nope" });

    const lines = logs.filter((l) => l.startsWith("[mcp] tool="));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(`^\\[mcp\\] tool=get_trip user=${w.users.owner.id} trip=${w.trip.id} scopes=trips:read ok=true err=- ms=\\d+$`),
    );
    expect(lines[1]).toMatch(
      new RegExp(`^\\[mcp\\] tool=create_trip user=${w.users.owner.id} trip=- scopes=trips:read ok=false err=scope ms=\\d+$`),
    );
    for (const l of logs) {
      expect(l).not.toContain(token);
      expect(l).not.toContain("CONF-FAKE");
      expect(l).not.toContain("TKT-FAKE");
    }
  });
});

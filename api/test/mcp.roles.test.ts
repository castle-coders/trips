// Role enforcement and Viewer projection through MCP tools (PRD 6.1, PRD 11, TDD 9).
// Viewers may see seatAssignments (user decision 2026-10-27); only confirmationNumber and
// ticketNumber are asserted absent.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { users } from "../src/db/schema";
import { addParticipant, byId, dbState, seedItinerary, seedTrip, seedUser, testDb } from "./helpers";
import {
  EXP,
  HIDDEN_VALUES,
  IDS,
  IT,
  LEAK_RE,
  READ_TOOLS,
  authFor,
  expectNoHiddenFields,
  mcpDirect,
  seedMcpWorld,
  validArgs,
} from "./helpers/mcp";

afterEach(() => vi.restoreAllMocks());

describe("Viewer projection", () => {
  for (const tool of READ_TOOLS) {
    it(`${tool}: a Viewer sees no confirmationNumber or ticketNumber (by key or by value)`, async () => {
      const w = await seedMcpWorld();
      const r = await w.mcp.viewer.call(tool, validArgs()[tool]);
      expect(r.isError, r.text).toBe(false);
      expectNoHiddenFields(r, HIDDEN_VALUES);
    });
  }

  it("get_trip: a Viewer still gets every itinerary (projected, not filtered out)", async () => {
    const w = await seedMcpWorld();
    const r = await w.mcp.viewer.call("get_trip", { tripId: IDS.trip });
    expect(r.structured.role).toBe("Viewer");
    expect(r.structured.itineraries.map((i: any) => i.id).sort()).toEqual(
      [IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging].sort(),
    );
  });

  it("get_trip: an Editor does see confirmation and ticket numbers (projection is role-based)", async () => {
    const w = await seedMcpWorld();
    const r = await w.mcp.editor.call("get_trip", { tripId: IDS.trip });
    expect(r.isError, r.text).toBe(false);
    expect(r.reply.raw).toContain("CONF-FAKE-FLT");
    expect(r.reply.raw).toContain("TKT-FAKE-0001");
  });

  it("get_trip itineraries equal REST GET /trips/:id/itineraries for the same Viewer (and Editor)", async () => {
    const w = await seedMcpWorld();
    for (const actor of ["viewer", "editor"] as const) {
      const rest = await (await w.as[actor].get(`/api/trips/${IDS.trip}/itineraries`)).json();
      const mcp = await w.mcp[actor].call("get_trip", { tripId: IDS.trip });
      expect(byId(mcp.structured.itineraries), actor).toEqual(byId(rest as any));
    }
  });

  it("search_itineraries across trips projects row by row: Viewer rows hidden, Editor rows full", async () => {
    const w = await seedMcpWorld();
    // viewer becomes Editor of a second trip that has a confirmation number and ticket.
    const { trip: t2 } = await seedTrip(null, { name: "Viewer's Own Trip" });
    const p = await addParticipant(t2.id, w.users.viewer.id, "Editor");
    await seedItinerary(t2.id, {
      type: "Rail",
      confirmationNumber: "CONF-FAKE-MINE",
      content: {
        trainOperator: "Fake Rail",
        trainNumber: "FR1",
        departureStation: "A",
        departureTime: "2090-04-01T09:00",
        arrivalStation: "B",
        arrivalTime: "2090-04-01T10:00",
        travelers: [{ participantId: p.id, name: "Me", ticketNumber: "TKT-FAKE-MINE" }],
      },
    });
    const r = await w.mcp.viewer.call("search_itineraries", {});
    expect(r.isError, r.text).toBe(false);
    const own = r.structured.itineraries.filter((i: any) => i.tripId === t2.id);
    const viewed = r.structured.itineraries.filter((i: any) => i.tripId === IDS.trip);
    expect(own).toHaveLength(1);
    expect(own[0].confirmationNumber).toBe("CONF-FAKE-MINE");
    expect(JSON.stringify(own[0])).toContain("TKT-FAKE-MINE");
    expect(viewed).toHaveLength(5);
    for (const v of HIDDEN_VALUES) expect(JSON.stringify(viewed)).not.toContain(v);
    expect(JSON.stringify(viewed)).not.toMatch(/confirmationNumber|ticketNumber/);
  });

  it("search_itineraries: a Viewer cannot probe hidden values through the text filter", async () => {
    const w = await seedMcpWorld();
    for (const text of ["TKT-FAKE", "CONF-FAKE", "ticketNumber"]) {
      const r = await w.mcp.viewer.call("search_itineraries", { text });
      expect(r.isError, r.text).toBe(false);
      expect(r.structured, text).toMatchObject({ itineraries: [], returned: 0, total: 0, truncated: false });
    }
    // The Editor's search does find them, so the filter itself works.
    const e = await w.mcp.editor.call("search_itineraries", { text: "TKT-FAKE" });
    expect(e.structured.total).toBeGreaterThan(0);
  });

  it("a global editor who is a Viewer on the trip is projected as a Viewer (trip role decides)", async () => {
    const w = await seedMcpWorld();
    const u = await seedUser("trip-viewer@example.test", "editor");
    await addParticipant(IDS.trip, u.id, "Viewer");
    const r = await mcpDirect(authFor(u.id)).call("get_trip", { tripId: IDS.trip });
    expect(r.structured.role).toBe("Viewer");
    expectNoHiddenFields(r, HIDDEN_VALUES);
  });
});

describe("Viewer with trips:write: role errors, nothing written", () => {
  for (const tool of ["create_itinerary", "update_itinerary", "add_expense"] as const) {
    it(`${tool}: Forbidden, database unchanged`, async () => {
      const w = await seedMcpWorld();
      const before = await dbState();
      const r = await w.mcp.viewer.call(tool, validArgs()[tool]);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Forbidden");
      expect(r.structured).toBeUndefined();
      expect(await dbState()).toEqual(before);
    });
  }

  it("update_itinerary (PRD 11 bullet): a Viewer cannot change content, and the stored row is untouched", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await w.mcp.viewer.call("update_itinerary", {
      tripId: IDS.trip,
      itineraryId: IT.flight,
      confirmationNumber: null,
      content: { legs: [{ airline: "X", flightNumber: "X1", departureAirport: "A", departureTime: "2090-01-01T00:00", arrivalAirport: "B", arrivalTime: "2090-01-01T01:00" }] },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("create_trip: a global viewer is refused and no trip or participant is written", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await w.mcp.viewer.call("create_trip", { name: "Viewer trip" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden: Viewers cannot create trips");
    expect(await dbState()).toEqual(before);
  });

  it("an Editor can do all three writes (the refusal above is role, not a broken tool)", async () => {
    const w = await seedMcpWorld();
    const args = validArgs();
    for (const tool of ["create_itinerary", "update_itinerary", "add_expense"] as const) {
      const r = await w.mcp.editor.call(tool, args[tool]);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
    }
  });
});

describe("Non-member: not_found, no data", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["get_trip", { tripId: IDS.trip }, "Trip not found"],
    ["search_itineraries", { tripId: IDS.trip }, "Trip not found"],
    ["list_expenses", { tripId: IDS.trip }, "Trip not found"],
    ["create_itinerary", validArgs().create_itinerary, "Trip not found"],
    ["update_itinerary", validArgs().update_itinerary, "Not found"],
    ["add_expense", validArgs().add_expense, "Trip not found"],
  ];
  for (const [tool, args, message] of cases) {
    it(`${tool}: "${message}" and nothing about the trip leaks or is written`, async () => {
      const w = await seedMcpWorld();
      const before = await dbState();
      const r = await w.mcp.outsider.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe(message);
      expect(r.structured).toBeUndefined();
      for (const s of ["Parity Trip", "Museum", "Dinner", ...HIDDEN_VALUES]) expect(r.reply.raw).not.toContain(s);
      expect(await dbState()).toEqual(before);
    });
  }

  it("a missing trip id gives the same error as a trip the caller is not on (no existence oracle)", async () => {
    const w = await seedMcpWorld();
    for (const tool of ["get_trip", "list_expenses", "search_itineraries"]) {
      const a = await w.mcp.outsider.call(tool, { tripId: IDS.trip });
      const b = await w.mcp.outsider.call(tool, { tripId: IDS.missing });
      expect(b.text, tool).toBe(a.text);
    }
  });

  it("list_trips and unscoped search_itineraries omit trips the caller is not on", async () => {
    const w = await seedMcpWorld();
    const trips = await w.mcp.outsider.call("list_trips");
    expect(trips.structured.trips.map((t: any) => t.id)).toEqual([IDS.otherTrip]);
    const search = await w.mcp.outsider.call("search_itineraries", {});
    expect(search.structured.itineraries.map((i: any) => i.id)).toEqual([IT.otherTripActivity]);
    const exp = await w.mcp.outsider.call("list_expenses", { tripId: IDS.otherTrip });
    expect(exp.structured.expenses.map((e: any) => e.id)).toEqual([EXP.other]);
  });

  it("update_itinerary cannot move across trips: an Editor of trip A addressing trip B's item gets not_found", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await w.mcp.editor.call("update_itinerary", { tripId: IDS.trip, itineraryId: IT.otherTripActivity, notes: "hijack" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Not found");
    expect(await dbState()).toEqual(before);
  });
});

describe("Admin", () => {
  it("is Owner on every trip without a participant row", async () => {
    const w = await seedMcpWorld();
    const r = await w.mcp.admin.call("get_trip", { tripId: IDS.trip });
    expect(r.structured.role).toBe("Owner");
    expect(r.reply.raw).toContain("CONF-FAKE-FLT");
    const trips = await w.mcp.admin.call("list_trips");
    expect(trips.structured.trips.map((t: any) => [t.id, t.role]).sort()).toEqual(
      [[IDS.trip, "Owner"], [IDS.otherTrip, "Owner"]].sort(),
    );
  });
});

describe("Deleted user", () => {
  it("the same authInfo works, then fails on the next call once the user row is deleted (500 -32603, no data)", async () => {
    const w = await seedMcpWorld();
    const c = mcpDirect(authFor(w.users.editor.id));
    expect((await c.call("get_me")).structured.id).toBe(w.users.editor.id);

    await testDb().delete(users).where(eq(users.id, w.users.editor.id));
    const before = await dbState();
    for (const [method, params] of [
      ["tools/call", { name: "get_trip", arguments: { tripId: IDS.trip } }],
      ["tools/call", { name: "add_expense", arguments: validArgs().add_expense }],
      ["tools/list", {}],
    ] as const) {
      const r = await c.rpc(method, params);
      expect(r.status, method).toBe(500);
      expect(r.message).toMatchObject({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" } });
      expect(r.message.result).toBeUndefined();
      expect(r.raw).not.toMatch(/Parity Trip|no longer exists|editor@example\.test/);
      expect(r.raw).not.toMatch(LEAK_RE);
    }
    expect(await dbState()).toEqual(before);
  });

  it("a global role change is seen on the next request (user reloaded per request)", async () => {
    const w = await seedMcpWorld();
    const c = mcpDirect(authFor(w.users.owner.id));
    expect((await c.call("create_trip", { name: "Before demotion" })).isError).toBe(false);
    await testDb().update(users).set({ role: "viewer" }).where(eq(users.id, w.users.owner.id));
    const r = await c.call("create_trip", { name: "After demotion" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden: Viewers cannot create trips");
    expect((await c.call("get_me")).structured.role).toBe("viewer");
  });

  it("authInfo without extra.userId is refused (500 -32603)", async () => {
    await seedMcpWorld();
    const r = await mcpDirect({ token: "", clientId: "x", scopes: ["trips:read"] }).rpc("tools/list", {});
    expect(r.status).toBe(500);
    expect(r.message.error.code).toBe(-32603);
    const none = await mcpDirect(undefined).rpc("tools/list", {});
    expect(none.status).toBe(500);
    expect(none.message.error).toEqual({ code: -32603, message: "Internal server error" });
  });
});

// Output schema conformance and error hygiene.
// The SDK validates structuredContent against each tool's outputSchema and turns a mismatch into
// isError "Output validation error: ..." (see @modelcontextprotocol/server validateToolOutput),
// so `isError === false` on a success path proves conformance. Any such failure is a bug.
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itineraries, participants } from "../src/db/schema";
import { addParticipant, dbState, oldFormatFlight, seedExpense, seedItinerary, seedTrip, seedUser, testDb } from "./helpers";
import {
  ALL_TOOLS,
  HIDDEN_VALUES,
  IDS,
  IT,
  LEAK_RE,
  authFor,
  mcpDirect,
  seedMcpWorld,
  validArgs,
  type ToolResult,
} from "./helpers/mcp";

afterEach(() => vi.restoreAllMocks());

function expectOk(r: ToolResult, label: string) {
  expect(r.isError, `${label}: ${r.text}`).toBe(false);
  expect(r.text, label).not.toMatch(/Output validation error/);
  expect(r.structured, label).toBeTypeOf("object");
  // text content mirrors structuredContent
  expect(JSON.parse(r.text), label).toEqual(r.structured);
}

/** A trip whose every nullable column is null, with sparse rows of every kind. */
async function seedSparse() {
  const u = await seedUser("sparse@example.test", "editor", { id: "00000000-0000-4000-8000-0000000051a1" });
  const v = await seedUser("sparse-viewer@example.test", "viewer");
  const { trip } = await seedTrip(null, { name: "Sparse", destination: null, startDate: null, endDate: null, description: null });
  const owner = await addParticipant(trip.id, u.id, "Owner");
  await addParticipant(trip.id, v.id, "Viewer", { traveling: false });
  await addParticipant(trip.id, null, "Viewer", { name: "No-email guest", email: null });
  const { trip: elsewhere, owner: elsewhereP } = await seedTrip(u.id, { name: "Elsewhere" });

  await seedItinerary(trip.id, { type: "Flight", content: oldFormatFlight(owner.id), confirmationNumber: null });
  await seedItinerary(trip.id, { type: "Activity", content: { name: "Bare", startTime: "not a time" }, confirmationNumber: null, status: "Cancelled" });
  await seedItinerary(trip.id, {
    type: "Lodging",
    content: { propertyName: "Only times", checkInTime: "15:00", checkOutTime: "11:00" },
    confirmationNumber: null,
    totalCost: null,
    currency: null,
    notes: null,
  });
  await seedItinerary(trip.id, {
    type: "Car",
    content: { rentalCompany: "Fake Cars", pickUpLocation: "A", pickUpTime: "2090-01-01T09:00", dropOffLocation: "B", dropOffTime: "2090-01-02T09:00" },
    totalCost: 0,
    currency: "JPY",
  });
  await seedExpense(trip.id, { payerId: null, amount: 1 });
  await seedExpense(trip.id, { payerId: owner.id, amount: 1000000 });
  // Payer that belongs to another trip: payerName must be null, not a cross-trip name.
  await seedExpense(trip.id, { payerId: elsewhereP!.id, description: "Odd payer" });
  return { u, v, trip, elsewhere, owner };
}

describe("outputSchema conformance", () => {
  for (const actor of ["admin", "owner", "editor", "viewer"] as const) {
    it(`every read tool conforms for ${actor} on the fixture world (new and old-format flights, rail, lodging)`, async () => {
      const w = await seedMcpWorld();
      const args = validArgs();
      for (const tool of ["get_me", "list_trips", "get_trip", "search_itineraries", "list_expenses"] as const) {
        expectOk(await w.mcp[actor].call(tool, args[tool]), `${actor}/${tool}`);
      }
      expectOk(await w.mcp[actor].call("search_itineraries", {}), `${actor}/search all`);
    });
  }

  it("read tools conform when every nullable column is null (Owner and Viewer)", async () => {
    const { u, v, trip } = await seedSparse();
    for (const [who, id] of [["owner", u.id], ["viewer", v.id]] as const) {
      const c = mcpDirect(authFor(id));
      expectOk(await c.call("list_trips"), `${who}/list_trips`);
      const t = await c.call("get_trip", { tripId: trip.id });
      expectOk(t, `${who}/get_trip`);
      expect(t.structured.trip).toMatchObject({ destination: null, startDate: null, endDate: null, description: null, splitwiseGroupId: null });
      expectOk(await c.call("search_itineraries", { tripId: trip.id }), `${who}/search`);
      const e = await c.call("list_expenses", { tripId: trip.id });
      expectOk(e, `${who}/list_expenses`);
      const odd = e.structured.expenses.find((x: any) => x.description === "Odd payer");
      expect(odd.payerName).toBeNull();
      expect(e.structured.expenses.filter((x: any) => x.payerName === u.name)).toHaveLength(1);
      expect(e.structured.expenses.filter((x: any) => x.payerId === null)[0].payerName).toBeNull();
    }
  });

  it("old-format flight is normalized to legs[] for Owner and Viewer", async () => {
    const { u, v, trip } = await seedSparse();
    for (const id of [u.id, v.id]) {
      const r = await mcpDirect(authFor(id)).call("search_itineraries", { tripId: trip.id, types: ["Flight"] });
      expectOk(r, "flight");
      const content = r.structured.itineraries[0].content;
      expect(content.airline).toBeUndefined();
      expect(content.legs.map((l: any) => l.flightNumber)).toEqual(["LA1", "LA2"]);
    }
  });

  it("every write tool conforms, with minimal input (nulls in the returned rows)", async () => {
    const { u, trip, owner } = await seedSparse();
    const c = mcpDirect(authFor(u.id));
    const t = await c.call("create_trip", { name: "Minimal" });
    expectOk(t, "create_trip");
    expect(t.structured).toMatchObject({ role: "Owner", trip: { name: "Minimal", destination: null, startDate: null } });

    const ci = await c.call("create_itinerary", { tripId: trip.id, type: "Activity", content: { name: "Min", startTime: "2090-01-01T10:00" } });
    expectOk(ci, "create_itinerary");
    expect(ci.structured.itinerary).toMatchObject({ status: "Pending", confirmationNumber: null, totalCost: null, currency: null, notes: null });

    const ae = await c.call("add_expense", { tripId: trip.id, description: "Min", amount: 0.01, currency: "EUR", category: "Food", splitType: "EXACT" });
    expectOk(ae, "add_expense");
    expect(ae.structured.expense.payerId).toBeNull();

    const withPayer = await c.call("add_expense", {
      tripId: trip.id, description: "Paid", amount: 3, currency: "EUR", category: "Shopping", splitType: "PERCENTAGE", payerId: owner.id,
    });
    expectOk(withPayer, "add_expense payer");
    expect(withPayer.structured.expense.payerId).toBe(owner.id);
  });

  it("update_itinerary conforms for a status-only patch, a null-clearing patch, and on an old-format flight row", async () => {
    const w = await seedMcpWorld();
    const c = w.mcp.editor;
    const s = await c.call("update_itinerary", { tripId: IDS.trip, itineraryId: IT.activity, status: "Cancelled" });
    expectOk(s, "status only");
    // Untouched fields keep their values in the response.
    expect(s.structured.itinerary).toMatchObject({ status: "Cancelled", confirmationNumber: "CONF-FAKE-ACT", totalCost: 25, currency: "EUR", notes: "Bring ID" });

    const n = await c.call("update_itinerary", {
      tripId: IDS.trip, itineraryId: IT.activity, confirmationNumber: null, totalCost: null, currency: null, notes: null,
    });
    expectOk(n, "null clear");
    expect(n.structured.itinerary).toMatchObject({ confirmationNumber: null, totalCost: null, currency: null, notes: null });
    const [row] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    expect(row).toMatchObject({ status: "Cancelled", confirmationNumber: null, totalCost: null, currency: null, notes: null });

    const o = await c.call("update_itinerary", { tripId: IDS.trip, itineraryId: IT.oldFlight, notes: "touch old row" });
    expectOk(o, "old flight");
  });

  it("create_itinerary writes the row; create_trip writes an Owner participant", async () => {
    const w = await seedMcpWorld();
    const ci = await w.mcp.editor.call("create_itinerary", validArgs().create_itinerary);
    expectOk(ci, "create_itinerary");
    const [row] = await testDb().select().from(itineraries).where(eq(itineraries.id, ci.structured.itinerary.id));
    expect(row).toMatchObject({ tripId: IDS.trip, type: "Activity", confirmationNumber: "CONF-FAKE-NEW" });

    const ct = await w.mcp.owner.call("create_trip", { name: "Owned" });
    const ps = await testDb().select().from(participants).where(and(eq(participants.tripId, ct.structured.trip.id)));
    expect(ps).toEqual([expect.objectContaining({ userId: w.users.owner.id, role: "Owner" })]);
    const listed = await w.mcp.owner.call("list_trips");
    expect(listed.structured.trips.find((t: any) => t.id === ct.structured.trip.id).role).toBe("Owner");
  });

  it("every tool advertises an outputSchema and every success result carries structuredContent", async () => {
    const w = await seedMcpWorld();
    const tools: any[] = await w.mcp.admin.listTools();
    expect(tools.filter((t) => t.outputSchema).map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
  });
});

describe("error hygiene", () => {
  it("validation errors give a readable hint without stacks, SQL or zod dumps, and write nothing", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await w.mcp.editor.call("create_itinerary", { tripId: IDS.trip, type: "Flight", content: { legs: [] } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Invalid content for type/);
    expect(r.text).not.toMatch(LEAK_RE);
    expect(r.text.length).toBeLessThan(700);
    expect(await dbState()).toEqual(before);
  });

  it("add_expense with a non-positive amount is an input validation error and writes nothing", async () => {
    const w = await seedMcpWorld();
    const before = await dbState();
    const r = await w.mcp.editor.call("add_expense", { ...validArgs().add_expense, amount: -1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Input validation error/);
    expect(r.text).not.toMatch(LEAK_RE);
    expect(await dbState()).toEqual(before);
  });

  it("an unexpected internal failure returns the fixed text 'Internal error' and logs no hidden content", async () => {
    const w = await seedMcpWorld();
    // A stored Flight with no legs does not fit the Viewer schema: projection throws a plain Error.
    await seedItinerary(IDS.trip, {
      type: "Flight",
      content: { travelers: [{ participantId: IDS.viewerP, name: "Broken", ticketNumber: "TKT-FAKE-BROKEN" }], legs: [] },
      confirmationNumber: "CONF-FAKE-BROKEN",
    });
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message} ${x.stack}` : String(x))).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);

    const r = await w.mcp.viewer.call("get_trip", { tripId: IDS.trip });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Internal error");
    expect(r.structured).toBeUndefined();
    for (const v of [...HIDDEN_VALUES, "TKT-FAKE-BROKEN", "CONF-FAKE-BROKEN"]) expect(r.reply.raw).not.toContain(v);
    expect(logs.some((l) => /^\[mcp\] tool=get_trip .* ok=false err=internal /.test(l))).toBe(true);
    for (const l of logs) expect(l).not.toMatch(/TKT-FAKE|CONF-FAKE/);

    // The cross-trip search skips the broken row instead of failing (fail closed).
    const s = await w.mcp.viewer.call("search_itineraries", { tripId: IDS.trip });
    expect(s.isError, s.text).toBe(false);
    expect(s.structured.total).toBe(5);
  });

  it("calling an unknown tool is an error without internals", async () => {
    const w = await seedMcpWorld();
    const r = await w.mcp.editor.rpc("tools/call", { name: "drop_tables", arguments: {} });
    const text = JSON.stringify(r.message);
    expect(text).toMatch(/drop_tables/);
    expect(text).not.toMatch(LEAK_RE);
  });

  it("no error result from any tool and actor contains a stack trace or SQL", async () => {
    const w = await seedMcpWorld();
    const args = validArgs();
    const scopeSets = [[], ["trips:read"], ["trips:write"], ["trips:read", "trips:write"]];
    const actors = ["viewer", "outsider", "editor"] as const;
    let errors = 0;
    for (const actor of actors) {
      for (const scopes of scopeSets) {
        const c = mcpDirect(authFor(w.users[actor].id, scopes));
        for (const tool of ALL_TOOLS) {
          for (const a of [args[tool], { ...args[tool], tripId: IDS.missing }]) {
            const r = await c.call(tool, a);
            if (!r.isError) continue;
            errors++;
            expect(r.text, `${actor}/${scopes}/${tool}`).not.toMatch(LEAK_RE);
            expect(r.structured).toBeUndefined();
          }
        }
      }
    }
    expect(errors).toBeGreaterThan(50);
  });
});

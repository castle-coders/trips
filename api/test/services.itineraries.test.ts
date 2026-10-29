// services/itineraries.ts gaps not covered by test/itineraries.service.test.ts: viewer projection
// per type and role, flight normalization of legacy rows, Editor-required writes with DB-state
// assertions, non-member not_found on every function, and cross-trip search projection.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor as DbActor } from "../src/db";
import { itineraries } from "../src/db/schema";
import { SNAPSHOT_COLUMNS } from "../src/services/audit";
import { ServiceError } from "../src/services/errors";
import {
  createItinerary,
  deleteItinerary,
  getItinerary,
  listItineraries,
  normalizeFlightContent,
  SEARCH_HARD_CAP,
  SEARCH_TEXT_MAX_PATTERN_BYTES,
  searchItineraries,
  searchItinerariesWithMeta,
  toViewerResponse,
  updateItinerary,
  type CreateItineraryInput,
} from "../src/services/itineraries";
import {
  IDS,
  IT,
  addParticipant,
  allKeys,
  dbState,
  errorOf,
  expectServiceError,
  flightContent,
  oldFormatFlight,
  railContent,
  seedItineraries,
  seedItinerary,
  seedRoleWorld,
  testDb,
  toAuth,
  type Actor,
  type RoleWorld,
} from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

let w: RoleWorld;
// An Actor satisfies AuthUser, so the same value serves reads and (audited) writes.
const auth = (a: Actor): DbActor => toActor(toAuth(w.users[a]));
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const SENSITIVE = ["confirmationNumber", "ticketNumber"];

const TRANSPORT = "00000000-0000-4000-8000-00000000e010";
const CAR = "00000000-0000-4000-8000-00000000e011";
const RESTAURANT = "00000000-0000-4000-8000-00000000e012";

beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
  const p = IDS.editorP;
  await seedItinerary(IDS.trip, {
    id: TRANSPORT,
    type: "Transport",
    content: {
      transportType: "Ferry",
      operator: "Fake Ferries",
      departureLocation: "Pier 1",
      departureTime: "2090-03-04T08:00",
      arrivalLocation: "Pier 2",
      arrivalTime: "2090-03-04T09:00",
      travelers: [{ participantId: p, name: "Ferry Traveler", ticketNumber: "TKT-FAKE-FERRY" }],
      seatAssignments: [{ participantId: p, seatNumber: "D4" }],
    },
    confirmationNumber: "CONF-FAKE-FERRY",
  });
  await seedItinerary(IDS.trip, {
    id: CAR,
    type: "Car",
    content: {
      rentalCompany: "Fake Cars",
      pickUpLocation: "Lot A",
      pickUpTime: "2090-03-05T10:00",
      dropOffLocation: "Lot B",
      dropOffTime: "2090-03-06T10:00",
      travelers: [{ participantId: p, name: "Driver", driverRole: "Primary Driver" }],
    },
    confirmationNumber: "CONF-FAKE-CAR",
  });
  await seedItinerary(IDS.trip, {
    id: RESTAURANT,
    type: "Restaurant",
    content: { restaurantName: "Fake Bistro", reservationTime: "2090-03-06T19:00", partySize: 2 },
    confirmationNumber: "CONF-FAKE-REST",
  });
});

const ALL_TRIP_ITEMS = [IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging, TRANSPORT, CAR, RESTAURANT];

describe("viewer projection", () => {
  it("Viewer list has no confirmationNumber or ticketNumber anywhere, for every type", async () => {
    const rows = await listItineraries(testDb(), auth("viewer"), IDS.trip);
    expect(ids(rows).sort()).toEqual([...ALL_TRIP_ITEMS].sort());
    for (const row of rows) {
      const keys = allKeys(row);
      for (const k of SENSITIVE) expect(keys.has(k), `${row.id} has ${k}`).toBe(false);
      expect(JSON.stringify(row)).not.toMatch(/TKT-FAKE|CONF-FAKE/);
    }
  });

  it("Viewer get has no confirmationNumber or ticketNumber, for every item", async () => {
    for (const id of ALL_TRIP_ITEMS) {
      const row = await getItinerary(testDb(), auth("viewer"), IDS.trip, id);
      expect(JSON.stringify(row), id).not.toMatch(/TKT-FAKE|CONF-FAKE|confirmationNumber|ticketNumber/);
    }
  });

  it("Viewers keep seatAssignments (flight legs, legacy flight legs, rail, transport)", async () => {
    const get = (id: string) => getItinerary(testDb(), auth("viewer"), IDS.trip, id) as Promise<any>;
    expect((await get(IT.flight)).content.legs[0].seatAssignments).toEqual([{ participantId: IDS.editorP, seatNumber: "12A" }]);
    const old = await get(IT.oldFlight);
    expect(old.content.legs.map((l: any) => l.seatAssignments)).toEqual([
      [{ participantId: IDS.editorP, seatNumber: "3C" }],
      [{ participantId: IDS.editorP, seatNumber: "1A" }],
    ]);
    expect((await get(IT.rail)).content.seatAssignments).toEqual([{ participantId: IDS.editorP, seatNumber: "44", carriageNumber: "7" }]);
    expect((await get(TRANSPORT)).content.seatAssignments).toEqual([{ participantId: IDS.editorP, seatNumber: "D4" }]);
  });

  it("Viewers keep non-sensitive traveler fields (participantId, name, driverRole)", async () => {
    const flight = (await getItinerary(testDb(), auth("viewer"), IDS.trip, IT.flight)) as any;
    expect(flight.content.travelers).toEqual([{ participantId: IDS.editorP, name: "Test Traveler" }]);
    const car = (await getItinerary(testDb(), auth("viewer"), IDS.trip, CAR)) as any;
    expect(car.content.travelers).toEqual([{ participantId: IDS.editorP, name: "Driver", driverRole: "Primary Driver" }]);
  });

  it("Owner, Editor and admin get the full row including confirmationNumber and ticketNumber", async () => {
    for (const a of ["owner", "editor", "admin"] as const) {
      const flight = (await getItinerary(testDb(), auth(a), IDS.trip, IT.flight)) as any;
      expect(flight.confirmationNumber, a).toBe("CONF-FAKE-FLT");
      expect(flight.content.travelers[0].ticketNumber, a).toBe("TKT-FAKE-0001");
      const rows = await listItineraries(testDb(), auth(a), IDS.trip);
      const rail = rows.find((r) => r.id === IT.rail) as any;
      expect(rail.confirmationNumber).toBe("CONF-FAKE-RAIL");
      expect(rail.content.travelers[0].ticketNumber).toBe("TKT-FAKE-RAIL");
    }
  });

  it("an unknown stored participant role reads the Viewer projection", async () => {
    const u = toAuth(w.users.outsider);
    await addParticipant(IDS.trip, u.id, "Admin" as never);
    const row = await getItinerary(testDb(), u, IDS.trip, IT.flight);
    expect(row).not.toHaveProperty("confirmationNumber");
    expect(JSON.stringify(row)).not.toContain("TKT-FAKE");
  });

  it("toViewerResponse throws a ZodError for content outside the view schema (wrapped by the services)", () => {
    expect(() => toViewerResponse({ id: IT.activity, type: "Activity", content: {} })).toThrow();
  });
});

describe("flight normalization of legacy rows", () => {
  it("Owner read: top-level fields become leg 0, extra legs follow with cabinClass renamed to fareClass", async () => {
    const row = (await getItinerary(testDb(), auth("owner"), IDS.trip, IT.oldFlight)) as any;
    const c = row.content;
    expect(Object.keys(c).sort()).toEqual(["legs", "travelers"]);
    expect(c.travelers).toEqual([{ participantId: IDS.editorP, name: "Legacy Traveler", ticketNumber: "TKT-FAKE-OLD1" }]);
    expect(c.legs).toHaveLength(2);
    expect(c.legs[0]).toMatchObject({
      airline: "Legacy Air",
      flightNumber: "LA1",
      departureAirport: "CCC",
      departureTime: "2090-03-01T08:00",
      departureTimeTz: "Europe/London",
      arrivalAirport: "DDD",
      arrivalTime: "2090-03-01T11:00",
      arrivalTimeTz: "Europe/Paris",
      fareClass: "Economy",
      seatAssignments: [{ participantId: IDS.editorP, seatNumber: "3C" }],
    });
    expect(c.legs[1]).toMatchObject({ flightNumber: "LA2", fareClass: "Business" });
    expect(c.legs[1].cabinClass).toBeUndefined();
  });

  it("Viewer read of a legacy row is normalized and then projected", async () => {
    const row = (await getItinerary(testDb(), auth("viewer"), IDS.trip, IT.oldFlight)) as any;
    expect(row.content.legs.map((l: any) => l.flightNumber)).toEqual(["LA1", "LA2"]);
    expect(row.content.legs[1].fareClass).toBe("Business");
    expect(row.content.travelers).toEqual([{ participantId: IDS.editorP, name: "Legacy Traveler" }]);
    expect(row).not.toHaveProperty("confirmationNumber");
  });

  it("normalization is read-time only: the stored row keeps its legacy shape", async () => {
    await listItineraries(testDb(), auth("owner"), IDS.trip);
    await getItinerary(testDb(), auth("viewer"), IDS.trip, IT.oldFlight);
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.oldFlight));
    expect(stored.content).toEqual(oldFormatFlight(IDS.editorP));
  });

  it("normalizeFlightContent passes through non-flights, new-format flights and content-less rows unchanged", () => {
    const activity = { type: "Activity", content: { airline: "not a flight" } };
    expect(normalizeFlightContent(activity)).toBe(activity);
    const modern = { type: "Flight", content: flightContent(IDS.editorP) };
    expect(normalizeFlightContent(modern)).toBe(modern);
    const empty = { type: "Flight" };
    expect(normalizeFlightContent(empty)).toBe(empty);
  });

  it("normalizeFlightContent keeps an extra leg's own fareClass over cabinClass, and handles no extra legs", () => {
    const out = normalizeFlightContent({
      type: "Flight",
      content: {
        airline: "A",
        flightNumber: "1",
        legs: [{ flightNumber: "2", fareClass: "First", cabinClass: "Economy" }],
      },
    }) as any;
    expect(out.content.legs[1].fareClass).toBe("First");
    const single = normalizeFlightContent({ type: "Flight", content: { airline: "A", flightNumber: "1" } }) as any;
    expect(single.content.legs).toHaveLength(1);
    expect(single.content.legs[0]).toMatchObject({ airline: "A", flightNumber: "1" });
  });
});

describe("non-member not_found on every itinerary service", () => {
  const create: CreateItineraryInput = { type: "Activity", status: "Pending", content: { name: "Sneaky", startTime: "2090-03-02T10:00" } };

  it("reads: list, get, search(tripId)", async () => {
    await expectServiceError(listItineraries(testDb(), auth("outsider"), IDS.trip), "not_found", "Trip not found");
    await expectServiceError(getItinerary(testDb(), auth("outsider"), IDS.trip, IT.flight), "not_found", "Not found");
    await expectServiceError(searchItineraries(testDb(), auth("outsider"), { tripId: IDS.trip }), "not_found", "Trip not found");
  });

  it("writes: create, update, delete are not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createItinerary(testDb(), auth("outsider"), IDS.trip, create), "not_found", "Trip not found");
    await expectServiceError(updateItinerary(testDb(), auth("outsider"), IDS.trip, IT.flight, { notes: "pwned" }), "not_found", "Not found");
    await expectServiceError(deleteItinerary(testDb(), auth("outsider"), IDS.trip, IT.flight), "not_found", "Not found");
    expect(await dbState()).toEqual(before);
  });

  it("a member cannot reach another trip's itinerary through their own trip id", async () => {
    // outsider is Owner of otherTrip; IT.flight belongs to trip.
    const before = await dbState();
    await expectServiceError(getItinerary(testDb(), auth("outsider"), IDS.otherTrip, IT.flight), "not_found", "Not found");
    await expectServiceError(updateItinerary(testDb(), auth("outsider"), IDS.otherTrip, IT.flight, { notes: "x" }), "not_found", "Not found");
    await expectServiceError(deleteItinerary(testDb(), auth("outsider"), IDS.otherTrip, IT.flight), "not_found", "Not found");
    expect(await dbState()).toEqual(before);
  });

  it("non-member errors are ServiceErrors with no projection or zod detail", async () => {
    const err = (await errorOf(getItinerary(testDb(), auth("outsider"), IDS.trip, IT.flight))) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.details).toBeUndefined();
  });
});

describe("Editor-required writes", () => {
  const create: CreateItineraryInput = {
    type: "Activity",
    status: "Pending",
    content: { name: "Kayak", startTime: "2090-03-03T14:00" },
    confirmationNumber: "CONF-FAKE-NEW",
    notes: "fake",
  };

  it("Viewer create, update and delete are forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createItinerary(testDb(), auth("viewer"), IDS.trip, create), "forbidden", "Forbidden");
    await expectServiceError(updateItinerary(testDb(), auth("viewer"), IDS.trip, IT.flight, { notes: "x" }), "forbidden", "Forbidden");
    await expectServiceError(deleteItinerary(testDb(), auth("viewer"), IDS.trip, IT.flight), "forbidden", "Forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("Editor, Owner and admin create; the stored row equals the returned full row", async () => {
    for (const a of ["editor", "owner", "admin"] as const) {
      const row = await createItinerary(testDb(), auth(a), IDS.trip, create);
      expect(row).toMatchObject({ tripId: IDS.trip, type: "Activity", status: "Pending", schemaVersion: 1, confirmationNumber: "CONF-FAKE-NEW", notes: "fake" });
      const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, row.id));
      expect(stored).toEqual(row);
    }
  });

  it("a created item is projected for Viewers on read", async () => {
    const row = await createItinerary(testDb(), auth("editor"), IDS.trip, {
      type: "Flight",
      status: "Confirmed",
      content: flightContent(IDS.viewerP),
      confirmationNumber: "CONF-FAKE-NEW",
    });
    const seen = (await getItinerary(testDb(), auth("viewer"), IDS.trip, row.id)) as any;
    expect(seen).not.toHaveProperty("confirmationNumber");
    expect(seen.content.travelers[0]).not.toHaveProperty("ticketNumber");
    expect(seen.content.legs[0].seatAssignments).toHaveLength(1);
  });

  it("admin create on a missing trip is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createItinerary(testDb(), auth("admin"), IDS.missing, create), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("invalid content is a validation error with details and nothing is written", async () => {
    const before = await dbState();
    const err = await expectServiceError(
      createItinerary(testDb(), auth("editor"), IDS.trip, { type: "Flight", status: "Pending", content: { legs: [] } }),
      "validation",
      "Invalid content for type"
    );
    expect(err.details).toBeTruthy();
    await expectServiceError(
      updateItinerary(testDb(), auth("editor"), IDS.trip, IT.activity, { type: "Rail", content: { name: "not rail" } }),
      "validation",
      "Invalid content for type"
    );
    expect(await dbState()).toEqual(before);
  });

  it("Editor update merges and stores; delete removes", async () => {
    const updated = await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.activity, { notes: "changed", confirmationNumber: null });
    expect(updated).toMatchObject({ id: IT.activity, notes: "changed", confirmationNumber: null, totalCost: 25 });
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    expect(stored).toEqual(updated);
    await deleteItinerary(testDb(), auth("editor"), IDS.trip, IT.activity);
    expect(await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity))).toEqual([]);
  });

  it("missing itinerary on a member trip is not_found 'Not found' for get, update and delete", async () => {
    const missing = "00000000-0000-4000-8000-00000000eeee";
    await expectServiceError(getItinerary(testDb(), auth("viewer"), IDS.trip, missing), "not_found", "Not found");
    await expectServiceError(updateItinerary(testDb(), auth("editor"), IDS.trip, missing, { notes: "x" }), "not_found", "Not found");
    await expectServiceError(deleteItinerary(testDb(), auth("editor"), IDS.trip, missing), "not_found", "Not found");
  });
});

describe("audit events on writes", () => {
  const LEG_TIME = "2030-01-10T09:00";
  const NEW_LEG_TIME = "2030-01-10T10:30";

  it("create records exactly one itinerary.create with the stored (validated) row as after", async () => {
    const row = await createItinerary(testDb(), auth("editor"), IDS.trip, {
      type: "Flight",
      status: "Confirmed",
      content: flightContent(IDS.viewerP),
      confirmationNumber: "CONF-FAKE-NEW",
      notes: "fake",
    });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      tripId: IDS.trip,
      entityType: "itinerary",
      entityId: row.id,
      action: "create",
      entityLabel: "Test Air TA100 AAA to BBB",
      actorUserId: w.users.editor.id,
      actorEmail: w.users.editor.email,
      channel: "web",
      before: null,
      changes: null,
    });
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, row.id));
    const { createdAt: _c, updatedAt: _u, ...snapshot } = stored;
    expect(e.after).toEqual(snapshot);
    expect(e.after).not.toHaveProperty("createdAt");
    expect(e.after).not.toHaveProperty("updatedAt");
  });

  it("update changing one flight leg's departure time records exactly that JSON path", async () => {
    const content = flightContent(IDS.editorP);
    expect(content.legs[0].departureTime).toBe(LEG_TIME);
    const patched = { ...content, legs: [{ ...content.legs[0], departureTime: NEW_LEG_TIME }] };
    const updated = await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.flight, { content: patched });
    expect((updated.content as any).legs[0].departureTime).toBe(NEW_LEG_TIME);

    const events = await auditRows();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ tripId: IDS.trip, entityType: "itinerary", entityId: IT.flight, action: "update" });
    expect(e.changes).toEqual({ "content.legs[0].departureTime": { from: LEG_TIME, to: NEW_LEG_TIME } });
    expect((e.before as any).content.legs[0].departureTime).toBe(LEG_TIME);
    expect((e.after as any).content.legs[0].departureTime).toBe(NEW_LEG_TIME);
  });

  it("a content-only update has no top-level column keys in changes", async () => {
    await updateItinerary(testDb(), auth("owner"), IDS.trip, IT.activity, {
      content: { name: "Kayak (moved)", startTime: "2030-01-11T10:00" },
    });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    const keys = Object.keys(events[0].changes as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("content."))).toBe(true);
    expect(keys).not.toContain("content");
  });

  it("a column-only update records the column and nothing under content", async () => {
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.activity, { notes: "changed" });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0].changes).toEqual({ notes: { from: stored.notes, to: "changed" } });
  });

  it("a no-op update records nothing, writes nothing and returns the stored row with updatedAt untouched", async () => {
    const [before] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.flight));
    const state = await dbState();
    const result = await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.flight, {
      content: flightContent(IDS.editorP),
      confirmationNumber: before.confirmationNumber,
      notes: before.notes,
    });
    expect(result).toEqual(before);
    const [after] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.flight));
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await dbState()).toEqual(state);
    expect(await auditRows()).toEqual([]);
  });

  it("delete records exactly one itinerary.delete with before and no after", async () => {
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.flight));
    await deleteItinerary(testDb(), auth("admin"), IDS.trip, IT.flight);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    const { createdAt: _c, updatedAt: _u, ...snapshot } = stored;
    expect(events[0]).toMatchObject({
      tripId: IDS.trip,
      entityType: "itinerary",
      entityId: IT.flight,
      action: "delete",
      entityLabel: "Test Air TA100 AAA to BBB",
      actorUserId: w.users.admin.id,
      after: null,
      changes: null,
    });
    expect(events[0].before).toEqual(snapshot);
  });

  it("rejected writes (forbidden, validation, not_found) record no event", async () => {
    await expectServiceError(createItinerary(testDb(), auth("viewer"), IDS.trip, { type: "Activity", status: "Pending", content: { name: "x" } }), "forbidden");
    await expectServiceError(updateItinerary(testDb(), auth("editor"), IDS.trip, IT.flight, { content: { legs: [] } }), "validation");
    await expectServiceError(deleteItinerary(testDb(), auth("editor"), IDS.trip, "00000000-0000-4000-8000-00000000eeee"), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("update snapshots carry exactly the allow-listed itinerary columns and the event carries every actor column", async () => {
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.lodging));
    const actor = auth("owner");
    await updateItinerary(testDb(), actor, IDS.trip, IT.lodging, { notes: "late check-in" });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    const [e] = events;
    const keys = [...SNAPSHOT_COLUMNS.itinerary].sort();
    expect(Object.keys(e.before as object).sort()).toEqual(keys);
    expect(Object.keys(e.after as object).sort()).toEqual(keys);
    expect(e.before).not.toHaveProperty("updatedAt");
    expect(e.after).not.toHaveProperty("createdAt");
    const { createdAt: _c, updatedAt: _u, ...beforeSnapshot } = stored;
    expect(e.before).toEqual(beforeSnapshot);
    expect(e).toMatchObject({
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      channel: "web",
      clientId: null,
      requestId: "ray-test",
      tripId: IDS.trip,
      entityLabel: "Fake Inn",
      metadata: null,
    });
  });

  it("a partial patch that re-sends identical values alongside one change records only that change", async () => {
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    expect(stored.status).toBe("Confirmed");
    await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.activity, {
      status: "Cancelled",
      notes: stored.notes,
      confirmationNumber: stored.confirmationNumber,
      content: stored.content as Record<string, unknown>,
    });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0].changes).toEqual({ status: { from: "Confirmed", to: "Cancelled" } });
    expect(events[0].entityLabel).toBe("Museum");
  });

  it("a partial patch that only re-sends identical values is a no-op: no event, updatedAt untouched", async () => {
    const [stored] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    const result = await updateItinerary(testDb(), auth("editor"), IDS.trip, IT.activity, { notes: stored.notes });
    expect(result).toEqual(stored);
    const [after] = await testDb().select().from(itineraries).where(eq(itineraries.id, IT.activity));
    expect(after.updatedAt).toBe(stored.updatedAt);
    expect(await auditRows()).toEqual([]);
  });

  it("every itinerary write is one event per write across a create, update, no-op and delete sequence", async () => {
    const row = await createItinerary(testDb(), auth("owner"), IDS.trip, { type: "Activity", status: "Pending", content: { name: "Seq", startTime: "2090-03-03T10:00" } });
    expect(await auditRows()).toHaveLength(1);
    await updateItinerary(testDb(), auth("owner"), IDS.trip, row.id, { status: "Confirmed" });
    expect(await auditRows()).toHaveLength(2);
    await updateItinerary(testDb(), auth("owner"), IDS.trip, row.id, { status: "Confirmed" });
    expect(await auditRows()).toHaveLength(2);
    await deleteItinerary(testDb(), auth("owner"), IDS.trip, row.id);
    const events = await auditRows();
    expect(events).toHaveLength(3);
    expect(events.map((e) => [e.action, e.entityId, e.entityLabel])).toEqual([
      ["create", row.id, "Seq"],
      ["update", row.id, "Seq"],
      ["delete", row.id, "Seq"],
    ]);
  });

  it("MCP channel actor fields are copied onto the event", async () => {
    const actor = toActor(toAuth(w.users.editor), { channel: "mcp_oauth", clientId: "client-fake", requestId: "ray-fake" });
    await deleteItinerary(testDb(), actor, IDS.trip, IT.activity);
    const [e] = await auditRows();
    expect(e).toMatchObject({ channel: "mcp_oauth", clientId: "client-fake", requestId: "ray-fake", action: "delete" });
  });
});

describe("searchItineraries: cross-trip projection and hidden fields", () => {
  const SHARED_A = "00000000-0000-4000-8000-00000000e0b1";
  const SHARED_B = "00000000-0000-4000-8000-00000000e0b2";
  const BROKEN = "00000000-0000-4000-8000-00000000e0b3";

  beforeEach(async () => {
    // viewer: Viewer on trip, Editor on otherTrip. Both trips carry a rail item with the same ticket.
    await addParticipant(IDS.otherTrip, w.users.viewer.id, "Editor");
    const shared = (pid: string) => ({ ...railContent(pid), travelers: [{ participantId: pid, name: "Shared", ticketNumber: "TKT-FAKE-SHARED" }] });
    await seedItinerary(IDS.trip, { id: SHARED_A, type: "Rail", content: shared(IDS.viewerP), confirmationNumber: "CONF-FAKE-A" });
    await seedItinerary(IDS.otherTrip, { id: SHARED_B, type: "Rail", content: shared(IDS.outsiderP), confirmationNumber: "CONF-FAKE-B" });
  });

  it("Viewer-on-A / Editor-on-B: a hidden-ticket search hits only the Editor trip, with full fields", async () => {
    const rows = (await searchItineraries(testDb(), auth("viewer"), { text: "tkt-fake-shared" })) as any[];
    expect(ids(rows)).toEqual([SHARED_B]);
    expect(rows[0].confirmationNumber).toBe("CONF-FAKE-B");
    expect(rows[0].content.travelers[0].ticketNumber).toBe("TKT-FAKE-SHARED");
    // An Editor on both trips (admin) sees both.
    expect(ids(await searchItineraries(testDb(), auth("admin"), { text: "TKT-FAKE-SHARED" })).sort()).toEqual([SHARED_A, SHARED_B].sort());
  });

  it("Viewer-on-A / Editor-on-B: unfiltered results are projected row by row", async () => {
    const rows = (await searchItineraries(testDb(), auth("viewer"), { types: ["Rail"] })) as any[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([IT.rail, SHARED_A, SHARED_B].sort());
    for (const id of [IT.rail, SHARED_A]) {
      expect(JSON.stringify(byId[id]), id).not.toMatch(/confirmationNumber|ticketNumber/);
      expect(byId[id].content.seatAssignments).toHaveLength(1);
    }
    expect(byId[SHARED_B].confirmationNumber).toBe("CONF-FAKE-B");
  });

  it("a Viewer searching for a hidden flight ticketNumber, legacy ticketNumber or the key name gets no hit", async () => {
    for (const text of ["TKT-FAKE-0001", "TKT-FAKE-OLD1", "TKT-FAKE-FERRY", "ticketNumber"]) {
      const rows = await searchItineraries(testDb(), auth("viewer"), { tripId: IDS.trip, text });
      expect(rows, text).toEqual([]);
    }
    // Editors on the same trip do get the hits.
    expect(ids(await searchItineraries(testDb(), auth("editor"), { text: "TKT-FAKE-0001" }))).toEqual([IT.flight]);
    expect(ids(await searchItineraries(testDb(), auth("editor"), { text: "TKT-FAKE-OLD1" }))).toEqual([IT.oldFlight]);
    expect(ids(await searchItineraries(testDb(), auth("editor"), { text: "TKT-FAKE-FERRY" }))).toEqual([TRANSPORT]);
  });

  it("a Viewer can still find a row by its visible content (seat number, traveler name)", async () => {
    expect(ids(await searchItineraries(testDb(), auth("viewer"), { tripId: IDS.trip, text: "12A" }))).toEqual([IT.flight]);
    expect(ids(await searchItineraries(testDb(), auth("viewer"), { tripId: IDS.trip, text: "legacy traveler" }))).toEqual([IT.oldFlight]);
  });

  it("one unprojectable Viewer-trip row is skipped, not returned and does not fail the search", async () => {
    // An Editor retypes the lodging item to Flight without content (allowed today), so its stored
    // content no longer fits the Flight view schema. viewer is Viewer on IDS.trip, Editor on otherTrip.
    await seedItinerary(IDS.trip, {
      id: BROKEN,
      type: "Lodging",
      content: { propertyName: "Broken Lodge", travelers: [{ participantId: IDS.viewerP, name: "Broken", ticketNumber: "TKT-FAKE-BROKEN" }] },
      confirmationNumber: "CONF-FAKE-BROKEN",
    });
    await updateItinerary(testDb(), auth("editor"), IDS.trip, BROKEN, { type: "Flight" });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
    try {
      for (const filter of [{}, { types: ["Flight" as const, "Rail" as const] }, { text: "Broken" }]) {
        const rows = await searchItineraries(testDb(), auth("viewer"), filter);
        const got = ids(rows);
        expect(got, JSON.stringify(filter)).not.toContain(BROKEN);
        expect(JSON.stringify(rows)).not.toMatch(/CONF-FAKE-BROKEN|TKT-FAKE-BROKEN|Broken Lodge/);
        if (!("text" in filter)) {
          // Valid rows on both the Viewer trip and the Editor trip still come back.
          expect(got).toEqual(expect.arrayContaining([IT.flight, SHARED_A, SHARED_B]));
        }
      }
      // The Editor on the same trip still gets the row unprojected, as today.
      expect(ids(await searchItineraries(testDb(), auth("editor"), { tripId: IDS.trip }))).toContain(BROKEN);
    } finally {
      spy.mockRestore();
    }
    // Server-side log names the id and nothing from the content.
    expect(errors.length).toBeGreaterThan(0);
    for (const args of errors) {
      const line = args.map(String).join(" ");
      expect(line).toContain(BROKEN);
      expect(line).not.toMatch(/CONF-FAKE-BROKEN|TKT-FAKE-BROKEN|Broken Lodge|\[mcp\]/);
    }
  });

  it("no Viewer-trip row in any search result carries confirmationNumber or ticketNumber", async () => {
    const rows = await searchItineraries(testDb(), auth("viewer"));
    for (const r of rows.filter((x) => x.tripId === IDS.trip)) {
      for (const k of SENSITIVE) expect(allKeys(r).has(k), `${r.id} ${k}`).toBe(false);
    }
  });
});

describe("searchItineraries: filters", () => {
  it("type filter returns only those types, each type independently", async () => {
    for (const t of ["Flight", "Lodging", "Rail", "Car", "Restaurant", "Transport", "Activity"] as const) {
      const rows = await searchItineraries(testDb(), auth("owner"), { tripId: IDS.trip, types: [t] });
      expect(rows.length, t).toBeGreaterThan(0);
      expect(rows.every((r) => r.type === t), t).toBe(true);
    }
  });

  it("type, date range and text combine with AND", async () => {
    // Car pickUp 03-05, Restaurant 03-06, Transport 03-04, Rail 03-03.
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: ["Car", "Restaurant", "Transport"], from: "2090-03-05", to: "2090-03-06" }))).toEqual([CAR, RESTAURANT]);
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: ["Car", "Restaurant"], from: "2090-03-05", text: "bistro" }))).toEqual([RESTAURANT]);
    expect(await searchItineraries(testDb(), auth("owner"), { types: ["Flight"], text: "bistro" })).toEqual([]);
    expect(await searchItineraries(testDb(), auth("owner"), { types: ["Restaurant"], to: "2090-03-05" })).toEqual([]);
  });

  it("date range applies to multi-leg flights by any leg date", async () => {
    // flight is 2030-01-10; oldFlight legs are both 2090-03-01.
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: ["Flight"], from: "2090-03-01", to: "2090-03-01" }))).toEqual([IT.oldFlight]);
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: ["Flight"], to: "2030-12-31" }))).toEqual([IT.flight]);
  });

  it("an invalid 'to' bound is a validation error", async () => {
    await expectServiceError(searchItineraries(testDb(), auth("owner"), { to: "soon" }), "validation", "Invalid to date; expected YYYY-MM-DD");
  });

  it("text filter respects membership: a non-member's text match on another trip is not returned", async () => {
    expect(await searchItineraries(testDb(), auth("outsider"), { text: "Museum" })).toEqual([]);
  });
});

describe("searchItineraries: hard cap", () => {
  const BULK = 1000;
  // Sorts after every fixture id ("...-8000-..."), so the fixture rows are inside the first-N-by-id window.
  const bulkId = (i: number) => `00000000-0000-4000-8001-${String(i).padStart(12, "0")}`;

  async function seedBulk(n: number): Promise<void> {
    const ts = new Date().toISOString();
    const stmt = env.DB.prepare(
      "INSERT INTO itineraries (id, trip_id, type, status, schema_version, content, confirmation_number, total_cost, currency, notes, created_at, updated_at) " +
        "VALUES (?, ?, 'Activity', 'Confirmed', 1, ?, 'CONF-FAKE-BULK', NULL, NULL, NULL, ?, ?)"
    );
    const all = Array.from({ length: n }, (_, i) =>
      stmt.bind(bulkId(i), IDS.trip, JSON.stringify({ name: `Bulk ${i}`, startTime: "2095-01-01T10:00" }), ts, ts)
    );
    for (let i = 0; i < all.length; i += 250) await env.DB.batch(all.slice(i, i + 250));
  }

  it("exports a cap of 1000", () => {
    expect(SEARCH_HARD_CAP).toBe(1000);
  });

  it("over the cap: truncated, at most SEARCH_HARD_CAP rows, first N by id, still time-ordered and projected per row", async () => {
    await seedBulk(BULK); // trip now has 8 + 1000 rows, otherTrip 1: 1009 candidates for admin
    await addParticipant(IDS.otherTrip, w.users.viewer.id, "Editor");

    const admin = await searchItinerariesWithMeta(testDb(), auth("admin"));
    expect(admin.truncated).toBe(true);
    expect(admin.items).toHaveLength(SEARCH_HARD_CAP);
    const got = new Set(ids(admin.items));
    for (const id of [...ALL_TRIP_ITEMS, IT.otherTripActivity]) expect(got.has(id), id).toBe(true);
    // The 9 highest ids fall outside the cap.
    for (let i = BULK - 9; i < BULK; i++) expect(got.has(bulkId(i)), bulkId(i)).toBe(false);
    expect(got.has(bulkId(BULK - 10))).toBe(true);
    // Output order is still by time: bulk rows (2095) after every fixture row.
    expect(ids(admin.items).slice(-991).every((id) => id.includes("-8001-"))).toBe(true);
    // The array form returns the same items.
    expect(ids(await searchItineraries(testDb(), auth("admin")))).toEqual(ids(admin.items));

    // Viewer on trip, Editor on otherTrip: capped path still projects row by row.
    const viewer = await searchItinerariesWithMeta(testDb(), auth("viewer"));
    expect(viewer.truncated).toBe(true);
    expect(viewer.items.length).toBeLessThanOrEqual(SEARCH_HARD_CAP);
    for (const r of viewer.items.filter((x) => x.tripId === IDS.trip)) {
      for (const k of SENSITIVE) expect(allKeys(r).has(k), `${r.id} ${k}`).toBe(false);
    }
    const other = viewer.items.find((r) => r.id === IT.otherTripActivity) as any;
    expect(other).toBeDefined();
    expect(other.confirmationNumber).toBe("CONF-FAKE-0001");

    // Filters that narrow the SQL candidate set below the cap are not truncated.
    const rail = await searchItinerariesWithMeta(testDb(), auth("admin"), { types: ["Rail"] });
    expect(rail.truncated).toBe(false);
    expect(ids(rail.items)).toEqual([IT.rail]);
  });

  it("under the cap: not truncated, same items as searchItineraries", async () => {
    const r = await searchItinerariesWithMeta(testDb(), auth("owner"));
    expect(r.truncated).toBe(false);
    expect(ids(r.items)).toEqual(ids(await searchItineraries(testDb(), auth("owner"))));
    expect(ids(r.items).sort()).toEqual([...ALL_TRIP_ITEMS].sort());
  });

  it("an injected lower cap truncates to the first N by id; exactly N candidates is not truncated", async () => {
    const byId = [...ALL_TRIP_ITEMS].sort();
    const r = await searchItinerariesWithMeta(testDb(), auth("owner"), {}, { cap: 3 });
    expect(r.truncated).toBe(true);
    expect(ids(r.items).sort()).toEqual(byId.slice(0, 3));
    const exact = await searchItinerariesWithMeta(testDb(), auth("owner"), {}, { cap: ALL_TRIP_ITEMS.length });
    expect(exact.truncated).toBe(false);
    expect(exact.items).toHaveLength(ALL_TRIP_ITEMS.length);
    // The cap can only be lowered, never raised past SEARCH_HARD_CAP; non-positive clamps to 1.
    expect((await searchItinerariesWithMeta(testDb(), auth("owner"), {}, { cap: 0 })).items).toHaveLength(1);
  });

  it("an injected cap above SEARCH_HARD_CAP is clamped", async () => {
    await seedBulk(BULK);
    const r = await searchItinerariesWithMeta(testDb(), auth("admin"), {}, { cap: 5000 });
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(SEARCH_HARD_CAP);
  });

  it("batched role lookup keeps getMembership rules: unknown stored role is Viewer", async () => {
    await addParticipant(IDS.otherTrip, w.users.editor.id, "Weird" as never);
    const rows = await searchItineraries(testDb(), auth("editor"));
    const other = rows.find((r) => r.id === IT.otherTripActivity);
    expect(other).toBeDefined();
    for (const k of SENSITIVE) expect(allKeys(other).has(k)).toBe(false);
    // Editor on the main trip still gets full rows there.
    expect((rows.find((r) => r.id === IT.flight) as any).confirmationNumber).toBeDefined();
  });
});

describe("searchItineraries: text pattern length (D1 LIKE limit)", () => {
  const TOO_LONG = "Search text is too long; use a shorter phrase";
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  // Pattern = "%" + escaped text + "%", so the text budget is the limit minus the two wrappers.
  const BUDGET = () => SEARCH_TEXT_MAX_PATTERN_BYTES - 2;

  async function expectTooLong(text: string): Promise<void> {
    const err = await errorOf(searchItinerariesWithMeta(testDb(), auth("owner"), { text }));
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("validation");
    expect((err as ServiceError).message).toBe(TOO_LONG);
    expect((err as Error).message).not.toContain(text.slice(0, 5));
    expect(String((err as Error).message)).not.toMatch(/D1_ERROR|SQLITE/);
  }

  it("exports the measured D1 limit of 50 bytes", () => {
    expect(SEARCH_TEXT_MAX_PATTERN_BYTES).toBe(50);
  });

  it("a needle at the boundary reaches D1 and succeeds, for every role and with tripId", async () => {
    const needle = "a".repeat(BUDGET());
    for (const a of ["owner", "viewer", "admin", "outsider"] as const) {
      expect(await searchItineraries(testDb(), auth(a), { text: needle }), a).toEqual([]);
    }
    expect(await searchItineraries(testDb(), auth("owner"), { tripId: IDS.trip, text: needle })).toEqual([]);
  });

  it("a boundary-length needle still matches: stored notes containing it are found", async () => {
    // 44 letters + "%_" (escaped to 4 bytes) = 48 bytes, 50 with the wrappers: exactly the limit.
    const needle = "N".repeat(BUDGET() - 4) + "%_";
    expect(bytes(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)).toBe(SEARCH_TEXT_MAX_PATTERN_BYTES);
    await testDb().update(itineraries).set({ notes: `before ${needle} after` }).where(eq(itineraries.id, IT.rail));
    expect(ids(await searchItineraries(testDb(), auth("owner"), { text: needle }))).toEqual([IT.rail]);
  });

  it("boundary + 1 is a validation ServiceError, not a D1 error", async () => {
    await expectTooLong("a".repeat(BUDGET() + 1));
  });

  it("a needle of % and _ that is short in characters but long once escaped is rejected", async () => {
    // 25 chars, 50 bytes escaped, 52 with wrappers.
    const needle = "%_".repeat(12) + "%";
    expect(needle.length).toBeLessThan(BUDGET());
    await expectTooLong(needle);
    await expectTooLong("\\".repeat(25));
    // 24 wildcards escape to 48 bytes: exactly the limit, accepted.
    expect(await searchItineraries(testDb(), auth("owner"), { text: "%_".repeat(12) })).toEqual([]);
  });

  it("a multi-byte needle over the byte limit is rejected though short in characters", async () => {
    const needle = "\u20ac".repeat(17); // 17 chars, 51 bytes
    expect(needle.length).toBeLessThan(BUDGET());
    await expectTooLong(needle);
    // 16 x 3 bytes = 48: exactly the limit, accepted.
    expect(await searchItineraries(testDb(), auth("owner"), { text: "\u20ac".repeat(16) })).toEqual([]);
  });

  it("is checked before membership: a non-member with an over-long needle on a foreign trip gets validation", async () => {
    const err = await errorOf(searchItineraries(testDb(), auth("outsider"), { tripId: IDS.trip, text: "x".repeat(60) }));
    expect((err as ServiceError).code).toBe("validation");
  });

  it("empty text is still no filter", async () => {
    expect(ids(await searchItineraries(testDb(), auth("owner"), { tripId: IDS.trip, text: "" })).sort()).toEqual(
      ids(await searchItineraries(testDb(), auth("owner"), { tripId: IDS.trip })).sort()
    );
  });
});

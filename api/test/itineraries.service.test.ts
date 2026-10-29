// Unit coverage for services/itineraries.ts beyond REST parity: searchItineraries (membership,
// per-row projection, filters) and groupItinerariesByLocalDate (mirrors the web timeline).
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "../src/db";
import { ServiceError } from "../src/services/errors";
import {
  getItinerary,
  groupItinerariesByLocalDate,
  listItineraries,
  searchItineraries,
} from "../src/services/itineraries";
import { IDS, IT, addParticipant, seedItineraries, seedItinerary, seedRoleWorld, testDb, type Actor, type RoleWorld } from "./helpers";

let w: RoleWorld;
const auth = (a: Actor): AuthUser => {
  const u = w.users[a];
  return { id: u.id, email: u.email, name: u.name, role: u.role };
};
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

async function errorOf(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: unknown) => e
  );
}

beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
});

describe("service access", () => {
  it("non-member list is not_found 'Trip not found'; get is not_found 'Not found'", async () => {
    const list = await errorOf(listItineraries(testDb(), auth("outsider"), IDS.trip));
    expect(list).toBeInstanceOf(ServiceError);
    expect(list).toMatchObject({ code: "not_found", message: "Trip not found" });
    const one = await errorOf(getItinerary(testDb(), auth("outsider"), IDS.trip, IT.flight));
    expect(one).toMatchObject({ code: "not_found", message: "Not found" });
  });

  it("viewer projection failure is a plain Error, not a ServiceError", async () => {
    await seedItinerary(IDS.trip, { id: "00000000-0000-4000-8000-00000000e0fe", type: "Activity", content: { name: "No start" } });
    const err = await errorOf(listItineraries(testDb(), auth("viewer"), IDS.trip));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ServiceError);
    expect((err as Error).message).toBe("Itinerary content does not match the viewer schema");
  });
});

describe("searchItineraries", () => {
  const TRIP_ITEMS = [IT.flight, IT.oldFlight, IT.lodging, IT.activity, IT.rail];

  it("non-admin sees only member trips; admin sees every trip", async () => {
    expect(ids(await searchItineraries(testDb(), auth("outsider")))).toEqual([IT.otherTripActivity]);
    expect(ids(await searchItineraries(testDb(), auth("owner")))).toEqual(TRIP_ITEMS);
    expect(ids(await searchItineraries(testDb(), auth("admin")))).toEqual([...TRIP_ITEMS, IT.otherTripActivity]);
  });

  it("orders by earliest entry time", async () => {
    // flight 2030-01-10, oldFlight 2090-03-01T08:00, lodging check-in 2090-03-01T15:00, activity 03-02, rail 03-03
    expect(ids(await searchItineraries(testDb(), auth("editor")))).toEqual(TRIP_ITEMS);
  });

  it("projects row by row by that row's trip role", async () => {
    // viewer is Viewer on trip; make them Editor on otherTrip.
    await addParticipant(IDS.otherTrip, w.users.viewer.id, "Editor");
    const rows = await searchItineraries(testDb(), auth("viewer"));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r as Record<string, any>]));
    expect(Object.keys(byId).sort()).toEqual([...TRIP_ITEMS, IT.otherTripActivity].sort());
    expect(byId[IT.activity]).not.toHaveProperty("confirmationNumber");
    expect(byId[IT.flight].content.travelers[0]).not.toHaveProperty("ticketNumber");
    expect(byId[IT.otherTripActivity].confirmationNumber).toBe("CONF-FAKE-0001");
  });

  it("legacy flights are normalized in results", async () => {
    const [old] = (await searchItineraries(testDb(), auth("owner"), { text: "LA1" })) as any[];
    expect(old.id).toBe(IT.oldFlight);
    expect(old.content.legs).toHaveLength(2);
    expect(old.content).not.toHaveProperty("airline");
  });

  it("tripId: non-member is not_found; member and admin are scoped to the trip", async () => {
    const err = await errorOf(searchItineraries(testDb(), auth("outsider"), { tripId: IDS.trip }));
    expect(err).toMatchObject({ code: "not_found", message: "Trip not found" });
    expect(ids(await searchItineraries(testDb(), auth("viewer"), { tripId: IDS.trip }))).toEqual(TRIP_ITEMS);
    expect(ids(await searchItineraries(testDb(), auth("admin"), { tripId: IDS.otherTrip }))).toEqual([IT.otherTripActivity]);
    expect(await searchItineraries(testDb(), auth("admin"), { tripId: IDS.missing })).toEqual([]);
  });

  it("types filter; empty types means all", async () => {
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: ["Flight", "Rail"] }))).toEqual([IT.flight, IT.oldFlight, IT.rail]);
    expect(ids(await searchItineraries(testDb(), auth("owner"), { types: [] }))).toEqual(TRIP_ITEMS);
  });

  it("text is case-insensitive over content and notes", async () => {
    expect(ids(await searchItineraries(testDb(), auth("owner"), { text: "mUsEuM" }))).toEqual([IT.activity]);
    expect(ids(await searchItineraries(testDb(), auth("owner"), { text: "bring id" }))).toEqual([IT.activity]);
  });

  it("text escapes LIKE wildcards", async () => {
    expect(await searchItineraries(testDb(), auth("owner"), { text: "%" })).toEqual([]);
    // Unescaped, "Test_Air" and "Mus_um" would match "Test Air" / "Museum".
    expect(await searchItineraries(testDb(), auth("owner"), { text: "Test_Air" })).toEqual([]);
    expect(await searchItineraries(testDb(), auth("owner"), { text: "Mus_um" })).toEqual([]);
    // A literal underscore still matches.
    expect(ids(await searchItineraries(testDb(), auth("owner"), { text: "Los_Angeles" }))).toEqual([IT.flight]);
    await seedItinerary(IDS.trip, { id: "00000000-0000-4000-8000-00000000e0a1", notes: "100% refundable_ok" });
    expect(ids(await searchItineraries(testDb(), auth("owner"), { text: "0% refundable_" }))).toEqual(["00000000-0000-4000-8000-00000000e0a1"]);
  });

  it("text cannot match fields hidden from a Viewer", async () => {
    expect(ids(await searchItineraries(testDb(), auth("editor"), { text: "TKT-FAKE-RAIL" }))).toEqual([IT.rail]);
    expect(await searchItineraries(testDb(), auth("viewer"), { text: "TKT-FAKE-RAIL" })).toEqual([]);
    // confirmationNumber is a column and is never searched.
    expect(await searchItineraries(testDb(), auth("editor"), { text: "CONF-FAKE-RAIL" })).toEqual([]);
  });

  it("from/to are inclusive and match on overlap with the item's entry-date span", async () => {
    // Lodging spans 2090-03-01 (check-in) .. 2090-03-08 (check-out).
    const s = (from?: string, to?: string) => searchItineraries(testDb(), auth("owner"), { from, to }).then(ids);
    expect(await s("2090-03-05", "2090-03-05")).toEqual([IT.lodging]);
    expect(await s("2090-03-02", "2090-03-03")).toEqual([IT.lodging, IT.activity, IT.rail]);
    expect(await s("2090-03-03")).toEqual([IT.lodging, IT.rail]);
    expect(await s(undefined, "2030-01-10")).toEqual([IT.flight]);
    expect(await s("2090-03-02T23:59", "2090-03-02")).toEqual([IT.lodging, IT.activity]);
  });

  it("from/to exclude unscheduled items; a malformed bound is a validation error", async () => {
    await seedItinerary(IDS.trip, { id: "00000000-0000-4000-8000-00000000e0a2", content: { name: "Someday" } });
    const all = ids(await searchItineraries(testDb(), auth("owner")));
    expect(all[all.length - 1]).toBe("00000000-0000-4000-8000-00000000e0a2");
    expect(ids(await searchItineraries(testDb(), auth("owner"), { from: "2000-01-01" }))).not.toContain("00000000-0000-4000-8000-00000000e0a2");
    const err = await errorOf(searchItineraries(testDb(), auth("owner"), { from: "March 1" }));
    expect(err).toMatchObject({ code: "validation" });
  });
});

describe("groupItinerariesByLocalDate", () => {
  const summary = (groups: ReturnType<typeof groupItinerariesByLocalDate<any>>) =>
    groups.map((g) => [g.date, g.entries.map((e) => `${e.itinerary.id}:${e.kind}${e.legIndex !== undefined ? `#${e.legIndex}` : ""}`)]);

  it("mirrors the web timeline: flight legs, lodging check-in/out, other types by primary time", async () => {
    const rows = await listItineraries(testDb(), auth("owner"), IDS.trip);
    expect(summary(groupItinerariesByLocalDate(rows))).toEqual([
      ["2030-01-10", [`${IT.flight}:Flight#0`]],
      ["2090-03-01", [`${IT.oldFlight}:Flight#0`, `${IT.oldFlight}:Flight#1`, `${IT.lodging}:Lodging-arrival`]],
      ["2090-03-02", [`${IT.activity}:Activity`]],
      ["2090-03-03", [`${IT.rail}:Rail`]],
      ["2090-03-08", [`${IT.lodging}:Lodging-departure`]],
    ]);
  });

  it("reports the stored time and timezone of each entry", async () => {
    const rows = await listItineraries(testDb(), auth("owner"), IDS.trip);
    const groups = groupItinerariesByLocalDate(rows);
    const flight = groups[0].entries[0];
    expect(flight).toMatchObject({ time: "2030-01-10T09:00", timeZone: "America/Los_Angeles", legIndex: 0 });
    const lodgingIn = groups[1].entries[2];
    expect(lodgingIn).toMatchObject({ time: "2090-03-01T15:00", timeZone: null });
  });

  it("uses the wall-clock date in the stored timezone (late-evening times west of UTC stay on their day)", () => {
    const groups = groupItinerariesByLocalDate([
      { id: "a", type: "Restaurant", content: { reservationTime: "2030-05-01T23:30", reservationTimeTz: "America/Los_Angeles" } },
      { id: "b", type: "Car", content: { pickUpTime: "2030-05-02T00:15", pickUpTimeTz: "Pacific/Auckland" } },
    ]);
    expect(summary(groups)).toEqual([
      ["2030-05-01", ["a:Restaurant"]],
      ["2030-05-02", ["b:Car"]],
    ]);
  });

  it("prefers planned arrival/departure over check-in/out for lodging and uses their timezones", () => {
    const [g1, g2] = groupItinerariesByLocalDate([
      {
        id: "l",
        type: "Lodging",
        content: {
          checkInDate: "2030-06-01", checkInTime: "15:00", checkInTimeTz: "Europe/Rome",
          checkOutDate: "2030-06-04", checkOutTime: "10:00",
          arrivalDateTime: "2030-05-31T22:00", arrivalDateTimeTz: "Europe/Paris",
        },
      },
    ]);
    expect(g1).toMatchObject({ date: "2030-05-31", entries: [{ kind: "Lodging-arrival", time: "2030-05-31T22:00", timeZone: "Europe/Paris" }] });
    expect(g2).toMatchObject({ date: "2030-06-04", entries: [{ kind: "Lodging-departure", time: "2030-06-04T10:00" }] });
  });

  it("puts undated items in a trailing date:null group, never dropping them", () => {
    const groups = groupItinerariesByLocalDate([
      { id: "x", type: "Activity", content: { name: "Someday" } },
      { id: "y", type: "Lodging", content: { propertyName: "Bare", checkInTime: "15:00", checkOutTime: "11:00" } },
      { id: "z", type: "Flight", content: { legs: [] } },
      { id: "d", type: "Activity", content: { startTime: "2030-01-01T09:00" } },
    ]);
    expect(summary(groups)).toEqual([
      ["2030-01-01", ["d:Activity"]],
      [null, ["x:Activity", "y:Lodging-arrival", "y:Lodging-departure", "z:Flight"]],
    ]);
  });
});

// get_trip: trip, role, participants, itineraries and days grouped by local date (TDD 6.4).
import { describe, expect, it } from "vitest";
import { addParticipant, flightContent, seedItinerary, seedTrip, seedUser } from "./helpers";
import { authFor, mcpDirect } from "./helpers/mcp";

async function ownerTrip() {
  const u = await seedUser("grouper@example.test", "editor");
  const { trip, owner } = await seedTrip(u.id, { name: "Grouping Trip" });
  return { u, trip, owner: owner!, c: mcpDirect(authFor(u.id)) };
}

describe("get_trip grouping by local date", () => {
  it("a late-evening local departure that is next-day in UTC groups under the local date", async () => {
    const { trip, owner, c } = await ownerTrip();
    // 23:30 in Los Angeles is 07:30Z the next day; it must group under 2090-03-01.
    const red = await seedItinerary(trip.id, {
      type: "Flight",
      content: flightContent(owner.id, {
        legs: [
          {
            airline: "Test Air",
            flightNumber: "TA9",
            departureAirport: "LAX",
            departureTime: "2090-03-01T23:30",
            departureTimeTz: "America/Los_Angeles",
            arrivalAirport: "JFK",
            arrivalTime: "2090-03-02T07:55",
            arrivalTimeTz: "America/New_York",
          },
        ],
      }),
    });
    // Early-morning Tokyo time (previous day in UTC) must group under its local date too.
    const early = await seedItinerary(trip.id, {
      type: "Activity",
      content: { name: "Fish market", startTime: "2090-03-03T05:00", startTimeTz: "Asia/Tokyo" },
    });

    const r = await c.call("get_trip", { tripId: trip.id });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.days).toEqual([
      {
        date: "2090-03-01",
        entries: [{ itineraryId: red.id, kind: "Flight", legIndex: 0, time: "2090-03-01T23:30", timeZone: "America/Los_Angeles" }],
      },
      {
        date: "2090-03-03",
        entries: [{ itineraryId: early.id, kind: "Activity", time: "2090-03-03T05:00", timeZone: "Asia/Tokyo" }],
      },
    ]);
  });

  it("multi-leg flights give one entry per leg; lodging gives arrival and departure; undated items go last under date null", async () => {
    const { trip, owner, c } = await ownerTrip();
    const flight = await seedItinerary(trip.id, {
      type: "Flight",
      content: flightContent(owner.id, {
        legs: [
          { airline: "A", flightNumber: "A1", departureAirport: "X", departureTime: "2090-05-01T08:00", arrivalAirport: "Y", arrivalTime: "2090-05-01T10:00" },
          { airline: "A", flightNumber: "A2", departureAirport: "Y", departureTime: "2090-05-02T09:00", arrivalAirport: "Z", arrivalTime: "2090-05-02T11:00" },
        ],
      }),
    });
    const lodging = await seedItinerary(trip.id, {
      type: "Lodging",
      content: { propertyName: "Fake Inn", checkInDate: "2090-05-01", checkInTime: "15:00", checkOutDate: "2090-05-03", checkOutTime: "11:00" },
    });
    const dinner = await seedItinerary(trip.id, {
      type: "Restaurant",
      content: { restaurantName: "Fake Bistro", reservationTime: "2090-05-01T19:30", reservationTimeTz: "Europe/Paris" },
    });
    const someday = await seedItinerary(trip.id, { type: "Activity", content: { name: "Someday" } });

    const r = await c.call("get_trip", { tripId: trip.id });
    expect(r.isError, r.text).toBe(false);
    const compact = r.structured.days.map((d: any) => [d.date, d.entries.map((e: any) => [e.itineraryId, e.kind, e.legIndex, e.time])]);
    expect(compact).toEqual([
      [
        "2090-05-01",
        [
          [flight.id, "Flight", 0, "2090-05-01T08:00"],
          [lodging.id, "Lodging-arrival", undefined, "2090-05-01T15:00"],
          [dinner.id, "Restaurant", undefined, "2090-05-01T19:30"],
        ],
      ],
      ["2090-05-02", [[flight.id, "Flight", 1, "2090-05-02T09:00"]]],
      ["2090-05-03", [[lodging.id, "Lodging-departure", undefined, "2090-05-03T11:00"]]],
      [null, [[someday.id, "Activity", undefined, null]]],
    ]);
    // Each itinerary appears once in `itineraries`, and every entry references one of them.
    const ids = r.structured.itineraries.map((i: any) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([flight.id, lodging.id, dinner.id, someday.id].sort());
    for (const d of r.structured.days) for (const e of d.entries) expect(ids).toContain(e.itineraryId);
    // Entries carry no embedded itinerary copy.
    for (const d of r.structured.days) for (const e of d.entries) expect(Object.keys(e).sort()).toEqual(
      e.legIndex === undefined ? ["itineraryId", "kind", "time", "timeZone"] : ["itineraryId", "kind", "legIndex", "time", "timeZone"],
    );
  });

  it("returns the trip, the caller's role and all participants (including non-user travelers)", async () => {
    const { u, trip, c } = await ownerTrip();
    await addParticipant(trip.id, null, "Viewer", { name: "Guest Traveler", email: null });
    const r = await c.call("get_trip", { tripId: trip.id });
    expect(r.structured.trip).toMatchObject({ id: trip.id, name: "Grouping Trip" });
    expect(r.structured.role).toBe("Owner");
    const ps = r.structured.participants.map((p: any) => [p.userId, p.name, p.role, p.email]).sort();
    expect(ps).toEqual([
      [null, "Guest Traveler", "Viewer", null],
      [u.id, u.name, "Owner", u.email],
    ].sort());
    expect(r.structured.days).toEqual([]);
    expect(r.structured.itineraries).toEqual([]);
  });

  it("an invalid tripId is an input validation error, not a crash", async () => {
    const { c } = await ownerTrip();
    const r = await c.call("get_trip", { tripId: "not-a-uuid" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Input validation error/);
    expect(r.text).toMatch(/tripId/);
  });
});

describe("search_itineraries limit and truncation", () => {
  async function tripWith(n: number) {
    const { trip, c } = await ownerTrip();
    for (let i = 0; i < n; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      await seedItinerary(trip.id, { content: { name: `Item ${i}`, startTime: `2090-06-${day}T${String(i % 24).padStart(2, "0")}:00` } });
    }
    return { trip, c };
  }

  it("limit caps the result and reports total and truncated", async () => {
    const { trip, c } = await tripWith(5);
    const r = await c.call("search_itineraries", { tripId: trip.id, limit: 2 });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.itineraries).toHaveLength(2);
    expect(r.structured).toMatchObject({ returned: 2, total: 5, truncated: true });
    const all = await c.call("search_itineraries", { tripId: trip.id, limit: 5 });
    expect(all.structured).toMatchObject({ returned: 5, total: 5, truncated: false });
    // The first page is a prefix of the full ordering.
    expect(r.structured.itineraries.map((i: any) => i.id)).toEqual(all.structured.itineraries.slice(0, 2).map((i: any) => i.id));
  });

  it("defaults to 50", async () => {
    const { trip, c } = await tripWith(55);
    const r = await c.call("search_itineraries", { tripId: trip.id });
    expect(r.structured).toMatchObject({ returned: 50, total: 55, truncated: true });
    expect(r.structured.itineraries).toHaveLength(50);
  });

  it("rejects limit 0, 201 and non-integers with an input validation error", async () => {
    const { trip, c } = await tripWith(1);
    for (const limit of [0, 201, 2.5]) {
      const r = await c.call("search_itineraries", { tripId: trip.id, limit });
      expect(r.isError, String(limit)).toBe(true);
      expect(r.text, String(limit)).toMatch(/^Input validation error/);
    }
    const max = await c.call("search_itineraries", { tripId: trip.id, limit: 200 });
    expect(max.isError).toBe(false);
  });

  it("rejects text longer than 40 characters with an input validation error", async () => {
    const { trip, c } = await tripWith(1);
    const bad = await c.call("search_itineraries", { tripId: trip.id, text: "x".repeat(41) });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Input validation error/);
  });

  it("accepts exactly 40 plain ASCII characters", async () => {
    const { trip, c } = await tripWith(1);
    const ok = await c.call("search_itineraries", { tripId: trip.id, text: "x".repeat(40) });
    expect(ok.isError).toBe(false);
  });

  it("reports an escaped LIKE pattern that is too long as a validation message, not an internal error", async () => {
    const { trip, c } = await tripWith(1);
    const res = await c.call("search_itineraries", { tripId: trip.id, text: "%_".repeat(15) });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Search text is too long/);
    expect(res.text).not.toMatch(/Internal error/);
  });

  it("filters by type, date range and text", async () => {
    const { trip, owner, c } = await ownerTrip();
    const a = await seedItinerary(trip.id, { content: { name: "Louvre visit", startTime: "2090-07-01T10:00" } });
    const f = await seedItinerary(trip.id, { type: "Flight", content: flightContent(owner.id) }); // 2030-01-10
    await seedItinerary(trip.id, { content: { name: "Later thing", startTime: "2090-07-10T10:00" } });
    const ids = async (args: Record<string, unknown>) =>
      (await c.call("search_itineraries", { tripId: trip.id, ...args })).structured.itineraries.map((i: any) => i.id);
    expect(await ids({ types: ["Flight"] })).toEqual([f.id]);
    expect(await ids({ from: "2090-07-01", to: "2090-07-02" })).toEqual([a.id]);
    expect(await ids({ text: "louvre" })).toEqual([a.id]);
    const bad = await c.call("search_itineraries", { from: "July" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("Invalid from date; expected YYYY-MM-DD");
  });
});

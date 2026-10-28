// REST parity baseline: /trips/:tripId/itineraries (list, get, create, update, delete).
// Encodes TODAY's behavior. The Phase 1 itineraries extractor must keep every test here green
// and every snapshot unchanged. Non-member READS are the deliberate change and live in
// itineraries.behavior-change.test.ts; non-member WRITES (403 from requireTripEditor) stay here.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IDS,
  IT,
  allKeys,
  byId,
  flightContent,
  itLabels,
  normalize,
  oldFormatFlight,
  read,
  seedItineraries,
  seedItinerary,
  seedRoleWorld,
  type Actor,
  type RoleWorld,
} from "./helpers";

let w: RoleWorld;
beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
});

const base = `/api/trips/${IDS.trip}/itineraries`;
const MEMBERS = ["admin", "owner", "editor", "viewer"] as const;
const FULL = ["admin", "owner", "editor"] as const;
const SENSITIVE = ["confirmationNumber", "ticketNumber"];

const dbRow = (id: string) =>
  env.DB.prepare("SELECT * FROM itineraries WHERE id = ?").bind(id).first<Record<string, unknown>>();
const count = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM itineraries").first<{ n: number }>())!.n;

describe("GET /trips/:tripId/itineraries", () => {
  it.each(MEMBERS)("%s gets 200 with the trip's itineraries only", async (actor) => {
    const { status, body } = await read(await w.as[actor].get(base));
    expect(status).toBe(200);
    expect(byId(body).map((r: { id: string }) => r.id)).toEqual([IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging]);
  });

  it.each(FULL)("%s gets the full projection (snapshot)", async (actor) => {
    const { body } = await read(await w.as[actor].get(base));
    const keys = allKeys(body);
    for (const k of [...SENSITIVE, "seatAssignments"]) expect(keys.has(k), k).toBe(true);
    expect(normalize(byId(body), itLabels(w))).toMatchSnapshot();
  });

  it("viewer gets the viewer projection: no confirmationNumber, no ticketNumber (snapshot)", async () => {
    const { body } = await read(await w.as.viewer.get(base));
    const keys = allKeys(body);
    for (const k of SENSITIVE) expect(keys.has(k), k).toBe(false);
    expect(normalize(byId(body), itLabels(w))).toMatchSnapshot();
  });

  it("KNOWN GAP vs PRD (not a planned flip): viewer projection still includes seatAssignments on flight legs and rail", async () => {
    // schemas/itinerary.ts FlightLegView re-adds seatAssignments; RailContentView/TransportContentView keep them.
    // PRD 5.x says seat assignments must never appear in a Viewer's tool results.
    const { body } = await read(await w.as.viewer.get(base));
    const byKey = Object.fromEntries(body.map((r: any) => [r.id, r]));
    expect(byKey[IT.flight].content.legs[0].seatAssignments).toEqual([{ participantId: w.participants.editor.id, seatNumber: "12A" }]);
    expect(byKey[IT.rail].content.seatAssignments).toEqual([{ participantId: w.participants.editor.id, seatNumber: "44", carriageNumber: "7" }]);
  });

  it("old-format flight is normalized to legs[] on read; the stored row is not rewritten", async () => {
    const { body } = await read(await w.as.owner.get(base));
    const old = body.find((r: { id: string }) => r.id === IT.oldFlight);
    expect(old.content).toEqual({
      travelers: [{ participantId: w.participants.editor.id, name: "Legacy Traveler", ticketNumber: "TKT-FAKE-OLD1" }],
      legs: [
        {
          airline: "Legacy Air",
          flightNumber: "LA1",
          departureAirport: "CCC",
          departureTime: "2090-03-01T08:00",
          departureTimeTz: "Europe/London",
          arrivalAirport: "DDD",
          arrivalTime: "2090-03-01T11:00",
          arrivalTimeTz: "Europe/Paris",
          fareClass: "Economy",
          seatAssignments: [{ participantId: w.participants.editor.id, seatNumber: "3C" }],
        },
        {
          airline: "Legacy Air",
          flightNumber: "LA2",
          departureAirport: "DDD",
          departureTime: "2090-03-01T13:00",
          arrivalAirport: "EEE",
          arrivalTime: "2090-03-01T15:00",
          fareClass: "Business", // renamed from cabinClass
          seatAssignments: [{ participantId: w.participants.editor.id, seatNumber: "1A" }],
        },
      ],
    });
    const stored = JSON.parse((await dbRow(IT.oldFlight))!.content as string);
    expect(stored).toEqual(oldFormatFlight(w.participants.editor.id));
  });

  it("viewer projection of content that fails the view schema is a 500 (full projection returns it as-is)", async () => {
    // Activity without the required startTime: full readers get the raw row, the viewer path throws in zod.parse.
    const broken = "00000000-0000-4000-8000-00000000e0ff";
    await seedItinerary(IDS.trip, { id: broken, type: "Activity", content: { name: "No start time" } });
    expect((await w.as.owner.get(base)).status).toBe(200);
    const res = await read(await w.as.viewer.get(base));
    expect(res.status).toBe(500);
    expect(res.body).toMatchSnapshot();
  });
});

describe("GET /trips/:tripId/itineraries/:itineraryId", () => {
  it.each(MEMBERS)("%s: new-format flight (snapshot)", async (actor) => {
    const { status, body } = await read(await w.as[actor].get(`${base}/${IT.flight}`));
    expect(status).toBe(200);
    expect(normalize(body, itLabels(w))).toMatchSnapshot();
  });

  it.each(["owner", "viewer"] as const)("%s: old-format flight is normalized (snapshot)", async (actor) => {
    const { status, body } = await read(await w.as[actor].get(`${base}/${IT.oldFlight}`));
    expect(status).toBe(200);
    expect(body.content.legs).toHaveLength(2);
    expect(body.content).not.toHaveProperty("airline");
    expect(normalize(body, itLabels(w))).toMatchSnapshot();
  });

  it("viewer: activity has no confirmationNumber key at all", async () => {
    const { body } = await read(await w.as.viewer.get(`${base}/${IT.activity}`));
    expect(body).not.toHaveProperty("confirmationNumber");
    expect(body.notes).toBe("Bring ID");
  });

  it.each(MEMBERS)("%s gets 404 for a missing itinerary", async (actor) => {
    const res = await read(await w.as[actor].get(`${base}/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("an itinerary from another trip is 404 through this trip's path (admin)", async () => {
    const res = await read(await w.as.admin.get(`${base}/${IT.otherTripActivity}`));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("non-uuid itineraryId is 400", async () => {
    expect((await w.as.owner.get(`${base}/nope`)).status).toBe(400);
  });
});

describe("POST /trips/:tripId/itineraries", () => {
  const input = () => ({
    type: "Flight",
    content: { ...flightContent(w.participants.owner.id), unknownTopLevel: "stripped" },
    confirmationNumber: "CONF-FAKE-NEW",
    totalCost: 199.99,
    currency: "USD",
    notes: "Window please",
  });
  const expected: Record<Actor, number> = { admin: 201, owner: 201, editor: 201, viewer: 403, outsider: 403 };

  it.each(Object.keys(expected) as Actor[])("%s", async (actor) => {
    const before = await count();
    const { status, body } = await read(await w.as[actor].post(base, input()));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, itLabels(w))).toMatchSnapshot();
    expect(await count()).toBe(status === 201 ? before + 1 : before);
    if (status === 201) {
      const stored = await dbRow(body.id);
      expect(stored).toMatchObject({ trip_id: IDS.trip, type: "Flight", status: "Pending", schema_version: 1, confirmation_number: "CONF-FAKE-NEW" });
      expect(JSON.parse(stored!.content as string)).not.toHaveProperty("unknownTopLevel");
    }
  });

  it("status defaults to Pending; omitted optionals are null", async () => {
    const { status, body } = await read(
      await w.as.owner.post(base, { type: "Activity", content: { name: "Walk", startTime: "2090-03-04T08:00" } })
    );
    expect(status).toBe(201);
    expect(normalize(body, itLabels(w))).toMatchSnapshot();
  });

  it("content invalid for its type is 400 with flattened zod details", async () => {
    const before = await count();
    const res = await read(await w.as.owner.post(base, { type: "Flight", content: { airline: "Old style only" } }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
    expect(await count()).toBe(before);
  });

  it("old-format flight content is ACCEPTED on create: top-level leg silently dropped, cabinClass stripped", async () => {
    const p = w.participants.owner.id;
    const res = await read(await w.as.owner.post(base, { type: "Flight", content: oldFormatFlight(p) }));
    expect(res.status).toBe(201);
    const expectedContent = {
      travelers: [{ participantId: p, name: "Legacy Traveler", ticketNumber: "TKT-FAKE-OLD1" }],
      legs: [
        {
          airline: "Legacy Air",
          flightNumber: "LA2",
          departureAirport: "DDD",
          departureTime: "2090-03-01T13:00",
          arrivalAirport: "EEE",
          arrivalTime: "2090-03-01T15:00",
          seatAssignments: [{ participantId: p, seatNumber: "1A" }],
        },
      ],
    };
    expect(res.body.content).toEqual(expectedContent);
    expect(JSON.parse((await dbRow(res.body.id))!.content as string)).toEqual(expectedContent);
  });

  it("invalid envelope (bad type enum) is a 400 zod error", async () => {
    const res = await read(await w.as.owner.post(base, { type: "Spaceship", content: {} }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("admin gets 404 for a missing trip", async () => {
    const res = await read(
      await w.as.admin.post(`/api/trips/${IDS.missing}/itineraries`, { type: "Activity", content: { name: "x", startTime: "t" } })
    );
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("non-admin gets 403 (not 404) for a missing trip", async () => {
    const res = await read(
      await w.as.owner.post(`/api/trips/${IDS.missing}/itineraries`, { type: "Activity", content: { name: "x", startTime: "t" } })
    );
    expect(res).toEqual({ status: 403, body: { error: "Forbidden" } });
  });
});

describe("PUT /trips/:tripId/itineraries/:itineraryId", () => {
  const patch = { status: "Cancelled", notes: "Changed plans", confirmationNumber: null };
  const expected: Record<Actor, number> = { admin: 200, owner: 200, editor: 200, viewer: 403, outsider: 403 };

  it.each(Object.keys(expected) as Actor[])("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].put(`${base}/${IT.activity}`, patch));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, itLabels(w))).toMatchSnapshot();
    const stored = await dbRow(IT.activity);
    if (status === 200) expect(stored).toMatchObject({ status: "Cancelled", notes: "Changed plans", confirmation_number: null });
    else expect(stored).toMatchObject({ status: "Confirmed", notes: "Bring ID", confirmation_number: "CONF-FAKE-ACT" });
  });

  it("content is validated against the type and stripped of unknown keys", async () => {
    const { status, body } = await read(
      await w.as.editor.put(`${base}/${IT.activity}`, { content: { name: "Gallery", startTime: "2090-03-02T11:00", extra: 1 } })
    );
    expect(status).toBe(200);
    expect(body.content).toEqual({ name: "Gallery", startTime: "2090-03-02T11:00" });
  });

  it("invalid content is 400 and nothing is written", async () => {
    const res = await read(await w.as.editor.put(`${base}/${IT.activity}`, { content: { location: "no name" } }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
    expect(JSON.parse((await dbRow(IT.activity))!.content as string).name).toBe("Museum");
  });

  it("changing type without content does NOT revalidate existing content", async () => {
    const { status, body } = await read(await w.as.editor.put(`${base}/${IT.activity}`, { type: "Flight" }));
    expect(status).toBe(200);
    expect(body.type).toBe("Flight");
    expect(body.content).toEqual({ name: "Museum", location: "Testville", startTime: "2090-03-02T10:00", startTimeTz: "Europe/Paris" });
  });

  it("updating an old-format flight without content returns (and keeps) the old-format content un-normalized", async () => {
    const { status, body } = await read(await w.as.editor.put(`${base}/${IT.oldFlight}`, { notes: "n" }));
    expect(status).toBe(200);
    expect(body.content).toEqual(oldFormatFlight(w.participants.editor.id));
  });

  it("missing itinerary is 404", async () => {
    const res = await read(await w.as.owner.put(`${base}/${IDS.missing}`, patch));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("itinerary from another trip is 404 through this trip's path (admin)", async () => {
    const res = await read(await w.as.admin.put(`${base}/${IT.otherTripActivity}`, patch));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });
});

describe("DELETE /trips/:tripId/itineraries/:itineraryId", () => {
  const expected: Record<Actor, number> = { admin: 204, owner: 204, editor: 204, viewer: 403, outsider: 403 };

  it.each(Object.keys(expected) as Actor[])("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].delete(`${base}/${IT.activity}`));
    expect(status).toBe(expected[actor]);
    expect(body).toMatchSnapshot();
    expect(await dbRow(IT.activity)).toEqual(status === 204 ? null : expect.objectContaining({ id: IT.activity }));
  });

  it("missing itinerary is 404", async () => {
    const res = await read(await w.as.owner.delete(`${base}/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });
});

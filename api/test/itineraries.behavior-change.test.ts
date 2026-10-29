// Deliberate REST behavior change (a), MCP_TDD 4.2 / 12 step 1:
//   non-members get 404 from the itinerary list and get endpoints.
// Before Phase 1, getTripRole() returned "Viewer" for a non-participant and the itinerary GET handlers
// did no membership check, so a non-member who knew a trip id read its itineraries (viewer-projected).
// The handlers now call services/itineraries.ts, whose requireTripRole throws not_found for
// non-members; the shared onError maps it to 404. Messages: list -> "Trip not found",
// single -> "Not found" (identical to a missing itinerary, so existence is not revealed).
import { beforeEach, describe, expect, it } from "vitest";
import { IDS, IT, allKeys, byId, itLabels, normalize, read, seedItineraries, seedRoleWorld, type RoleWorld } from "./helpers";

let w: RoleWorld;
beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
});

const base = `/api/trips/${IDS.trip}/itineraries`;

describe("non-member (outsider) itinerary reads", () => {
  it("PHASE 1: non-member GET /trips/:tripId/itineraries returns 404 (ServiceError not_found via the shared onError) and no itinerary data", async () => {
    const res = await read(await w.as.outsider.get(base));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("PHASE 1: non-member GET /trips/:tripId/itineraries/:itineraryId returns 404 for an EXISTING itinerary (same response as a missing one)", async () => {
    const existing = await read(await w.as.outsider.get(`${base}/${IT.flight}`));
    const missing = await read(await w.as.outsider.get(`${base}/${IDS.missing}`));
    expect(existing).toEqual({ status: 404, body: { error: "Not found" } });
    expect(missing).toEqual(existing);
  });

  it("non-member GET single of a missing itinerary is still 404 'Not found'", async () => {
    const res = await read(await w.as.outsider.get(`${base}/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("PHASE 1: non-admin GET /trips/:missingTripId/itineraries returns 404 instead of 200 []", async () => {
    const res = await read(await w.as.owner.get(`/api/trips/${IDS.missing}/itineraries`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("DECIDED (unchanged): admin GET list for a trip id that does not exist is 200 []", async () => {
    // requireTripRole treats admins as Owner with no trip-existence check (orchestrator decision).
    const res = await read(await w.as.admin.get(`/api/trips/${IDS.missing}/itineraries`));
    expect(res).toEqual({ status: 200, body: [] });
  });

  it("non-member of THIS trip still reads their own trip's itineraries (unchanged by Phase 1)", async () => {
    const res = await read(await w.as.outsider.get(`/api/trips/${IDS.otherTrip}/itineraries`));
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([IT.otherTripActivity]);
  });

  it("PHASE 1: admin (not a participant) still gets 200 with the full projection for list and get", async () => {
    const list = await read(await w.as.admin.get(base));
    expect(list.status).toBe(200);
    expect(byId(list.body).map((r: { id: string }) => r.id)).toEqual([IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging]);
    expect(allKeys(list.body).has("confirmationNumber")).toBe(true);
    expect(allKeys(list.body).has("ticketNumber")).toBe(true);
    const one = await read(await w.as.admin.get(`${base}/${IT.flight}`));
    expect(one.status).toBe(200);
    expect(one.body.confirmationNumber).toBe("CONF-FAKE-FLT");
    expect(one.body.content.travelers[0].ticketNumber).toBe("TKT-FAKE-0001");
  });

  it("PHASE 1: Viewer member still gets 200 with the viewer projection (snapshots in itineraries.test.ts unchanged)", async () => {
    const list = await read(await w.as.viewer.get(base));
    expect(list.status).toBe(200);
    expect(byId(list.body).map((r: { id: string }) => r.id)).toEqual([IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging]);
    const keys = allKeys(list.body);
    expect(keys.has("confirmationNumber")).toBe(false);
    expect(keys.has("ticketNumber")).toBe(false);
    const one = await read(await w.as.viewer.get(`${base}/${IT.flight}`));
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty("confirmationNumber");
    expect(normalize(one.body, itLabels(w))).toEqual(normalize(byId(list.body).find((r: { id: string }) => r.id === IT.flight), itLabels(w)));
  });
});

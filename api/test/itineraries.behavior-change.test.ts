// Deliberate REST behavior change (a), MCP_TDD 4.2 / 12 step 1:
//   non-members get 404 from the itinerary list and get endpoints.
// Today getTripRole() returns "Viewer" for a non-participant and the itinerary GET handlers do no
// membership check, so a non-member who knows a trip id reads its itineraries (viewer-projected).
// The tests labelled "CURRENT BEHAVIOR — flips in Phase 1" pass today. When the itineraries
// extractor routes these GETs through services (requireTripRole -> not_found), it must delete
// (or invert) each of them and turn the matching it.todo into a real test.
import { beforeEach, describe, expect, it } from "vitest";
import { IDS, IT, allKeys, byId, itLabels, normalize, read, seedItineraries, seedRoleWorld, type RoleWorld } from "./helpers";

let w: RoleWorld;
beforeEach(async () => {
  w = await seedRoleWorld();
  await seedItineraries(w);
});

const base = `/api/trips/${IDS.trip}/itineraries`;

describe("non-member (outsider) itinerary reads", () => {
  it("CURRENT BEHAVIOR — flips in Phase 1: non-member GET list is 200 with the viewer projection", async () => {
    const { status, body } = await read(await w.as.outsider.get(base));
    expect(status).toBe(200);
    expect(byId(body).map((r: { id: string }) => r.id)).toEqual([IT.activity, IT.flight, IT.oldFlight, IT.rail, IT.lodging]);
    const keys = allKeys(body);
    expect(keys.has("confirmationNumber")).toBe(false);
    expect(keys.has("ticketNumber")).toBe(false);
    // Identical to what a real Viewer member gets.
    const asViewer = await read(await w.as.viewer.get(base));
    expect(normalize(byId(body), itLabels(w))).toEqual(normalize(byId(asViewer.body), itLabels(w)));
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-member GET single is 200 with the viewer projection", async () => {
    const { status, body } = await read(await w.as.outsider.get(`${base}/${IT.flight}`));
    expect(status).toBe(200);
    expect(body.id).toBe(IT.flight);
    expect(body).not.toHaveProperty("confirmationNumber");
    expect(body.content.travelers[0]).not.toHaveProperty("ticketNumber");
  });

  it("CURRENT BEHAVIOR — status stays 404 in Phase 1, body may change: non-member GET single of a missing itinerary is 404 'Not found'", async () => {
    // Same status as after Phase 1, but today it is reached only because the row is missing.
    const res = await read(await w.as.outsider.get(`${base}/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin GET list for a trip id that does not exist is 200 []", async () => {
    const res = await read(await w.as.owner.get(`/api/trips/${IDS.missing}/itineraries`));
    expect(res).toEqual({ status: 200, body: [] });
  });

  it("CURRENT BEHAVIOR — may flip in Phase 1: admin GET list for a trip id that does not exist is 200 []", async () => {
    // Flips to 404 only if requireTripRole checks trip existence for admins (TDD 4.2 does not say). Decide, then update.
    const res = await read(await w.as.admin.get(`/api/trips/${IDS.missing}/itineraries`));
    expect(res).toEqual({ status: 200, body: [] });
  });

  it("non-member of THIS trip still reads their own trip's itineraries (unchanged by Phase 1)", async () => {
    const res = await read(await w.as.outsider.get(`/api/trips/${IDS.otherTrip}/itineraries`));
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([IT.otherTripActivity]);
  });

  it.todo("PHASE 1: non-member GET /trips/:tripId/itineraries returns 404 (ServiceError not_found via the shared onError) and no itinerary data");
  it.todo("PHASE 1: non-member GET /trips/:tripId/itineraries/:itineraryId returns 404 for an EXISTING itinerary (same response as a missing one)");
  it.todo("PHASE 1: non-admin GET /trips/:missingTripId/itineraries returns 404 instead of 200 []");
  it.todo("PHASE 1: admin (not a participant) still gets 200 with the full projection for list and get");
  it.todo("PHASE 1: Viewer member still gets 200 with the viewer projection (snapshots in itineraries.test.ts unchanged)");
});

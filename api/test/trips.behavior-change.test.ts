// Deliberate REST behavior change (b), MCP_TDD 4.3 / 12 step 1:
//   POST /trips will insert an Owner participant row for the creator.
// The tests labelled "CURRENT BEHAVIOR — flips in Phase 1" pass today. When the trips extractor
// routes POST /trips through services.createTrip, it must delete (or invert) each of them and
// turn the matching it.todo below into a real test.
// Trips are created via REST POST /trips here, never via seedTrip (which always adds an Owner row).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { read, seedRoleWorld, type RoleWorld } from "./helpers";

let w: RoleWorld;
beforeEach(async () => {
  w = await seedRoleWorld();
});

const participantRows = (tripId: string) =>
  env.DB.prepare("SELECT user_id, email, name, role FROM participants WHERE trip_id = ?")
    .bind(tripId)
    .all<{ user_id: string | null; email: string | null; name: string; role: string }>()
    .then((r) => r.results);

async function createAs(actor: "owner" | "admin") {
  const res = await read(await w.as[actor].post("/api/trips", { name: "Mine", startDate: "2096-01-01", endDate: "2096-01-02" }));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("POST /trips creator membership", () => {
  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin creator gets NO participant row", async () => {
    const id = await createAs("owner");
    expect(await participantRows(id)).toEqual([]);
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: admin creator gets NO participant row", async () => {
    const id = await createAs("admin");
    expect(await participantRows(id)).toEqual([]);
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin creator does not see the new trip in GET /trips", async () => {
    const id = await createAs("owner");
    const { status, body } = await read(await w.as.owner.get("/api/trips"));
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin creator gets 404 from GET /trips/:id on their new trip", async () => {
    const id = await createAs("owner");
    const res = await read(await w.as.owner.get(`/api/trips/${id}`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin creator gets 403 from PUT /trips/:id on their new trip", async () => {
    const id = await createAs("owner");
    const res = await read(await w.as.owner.put(`/api/trips/${id}`, { name: "Renamed" }));
    expect(res).toEqual({ status: 403, body: { error: "Forbidden" } });
  });

  it("CURRENT BEHAVIOR — flips in Phase 1: non-admin creator does not see the new trip in GET /trips/upcoming", async () => {
    const id = await createAs("owner");
    const { body } = await read(await w.as.owner.get("/api/trips/upcoming"));
    expect(body.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it.todo(
    "PHASE 1: POST /trips inserts exactly one participants row for the creator { user_id: creator.id, email: creator.email, name: creator.name, role: 'Owner' } in the same request (non-admin creator)"
  );
  it.todo("PHASE 1: POST /trips by an admin also inserts an Owner participant row for the admin");
  it.todo("PHASE 1: non-admin creator sees the new trip in GET /trips (200, includes id)");
  it.todo("PHASE 1: non-admin creator gets 200 from GET /trips/:id on the new trip");
  it.todo("PHASE 1: non-admin creator gets 200 from PUT /trips/:id on the new trip (and 204 from DELETE, being Owner)");
  it.todo("PHASE 1: non-admin creator sees the new dated trip in GET /trips/upcoming with themselves in participants");
  it.todo("PHASE 1: POST /trips response body is still the bare trip row (201, same keys as today; snapshot in trips.test.ts unchanged)");
  it.todo("PHASE 1: global viewer POST /trips is still 403 and writes neither a trip nor a participant row");
});

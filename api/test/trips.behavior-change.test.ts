// Deliberate REST behavior change (b), MCP_TDD 4.3 / 12 step 1:
//   POST /trips inserts an Owner participant row for the creator (flipped in Phase 1 by the
//   trips extractor; routes/trips.ts now calls services/trips.createTrip).
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
  it("PHASE 1: POST /trips inserts exactly one participants row for the creator { user_id: creator.id, email: creator.email, name: creator.name, role: 'Owner' } in the same request (non-admin creator)", async () => {
    const id = await createAs("owner");
    expect(await participantRows(id)).toEqual([
      { user_id: w.users.owner.id, email: w.users.owner.email, name: w.users.owner.name, role: "Owner" },
    ]);
  });

  it("PHASE 1: POST /trips by an admin also inserts an Owner participant row for the admin", async () => {
    const id = await createAs("admin");
    expect(await participantRows(id)).toEqual([
      { user_id: w.users.admin.id, email: w.users.admin.email, name: w.users.admin.name, role: "Owner" },
    ]);
  });

  it("PHASE 1: the creator's participant row is not traveling and has the trip's timestamps", async () => {
    const id = await createAs("owner");
    const trip = await env.DB.prepare("SELECT created_at, updated_at FROM trips WHERE id = ?")
      .bind(id)
      .first<{ created_at: string; updated_at: string }>();
    const p = await env.DB.prepare("SELECT traveling, created_at, updated_at FROM participants WHERE trip_id = ?")
      .bind(id)
      .first<{ traveling: number; created_at: string; updated_at: string }>();
    expect(p).toEqual({ traveling: 0, created_at: trip!.created_at, updated_at: trip!.updated_at });
  });

  it("PHASE 1: non-admin creator sees the new trip in GET /trips (200, includes id)", async () => {
    const id = await createAs("owner");
    const { status, body } = await read(await w.as.owner.get("/api/trips"));
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id)).toContain(id);
    const listed = body.find((t: { id: string }) => t.id === id);
    expect(Object.keys(listed).sort()).toEqual(
      ["createdAt", "description", "destination", "endDate", "id", "name", "splitwiseGroupId", "startDate", "updatedAt"]
    );
  });

  it("PHASE 1: non-admin creator gets 200 from GET /trips/:id on the new trip", async () => {
    const id = await createAs("owner");
    const res = await read(await w.as.owner.get(`/api/trips/${id}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: "Mine", startDate: "2096-01-01", endDate: "2096-01-02" });
  });

  it("PHASE 1: non-admin creator gets 200 from PUT /trips/:id on the new trip (and 204 from DELETE, being Owner)", async () => {
    const id = await createAs("owner");
    const put = await read(await w.as.owner.put(`/api/trips/${id}`, { name: "Renamed" }));
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ id, name: "Renamed" });
    const del = await w.as.owner.delete(`/api/trips/${id}`);
    expect(del.status).toBe(204);
    expect(await participantRows(id)).toEqual([]);
    const gone = await read(await w.as.owner.get(`/api/trips/${id}`));
    expect(gone).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("PHASE 1: non-admin creator sees the new dated trip in GET /trips/upcoming with themselves in participants", async () => {
    // The seeded world's trips may occupy the 3 upcoming slots; make this trip the earliest.
    const res = await read(
      await w.as.owner.post("/api/trips", { name: "Soon", startDate: "2000-01-01", endDate: "2999-12-31" })
    );
    expect(res.status).toBe(201);
    const { status, body } = await read(await w.as.owner.get("/api/trips/upcoming"));
    expect(status).toBe(200);
    const found = body.find((t: { id: string }) => t.id === res.body.id);
    expect(found).toEqual({
      id: res.body.id,
      name: "Soon",
      startDate: "2000-01-01",
      endDate: "2999-12-31",
      participants: [{ name: w.users.owner.name, email: w.users.owner.email, traveling: false }],
    });
  });

  it("PHASE 1: another non-member still cannot see the new trip", async () => {
    const id = await createAs("owner");
    const res = await read(await w.as.outsider.get(`/api/trips/${id}`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
    const list = await read(await w.as.outsider.get("/api/trips"));
    expect(list.body.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it("PHASE 1: POST /trips response body is still the bare trip row (201, same keys as today; snapshot in trips.test.ts unchanged)", async () => {
    const res = await read(await w.as.owner.post("/api/trips", { name: "Bare" }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual([
      "id",
      "name",
      "destination",
      "startDate",
      "endDate",
      "description",
      "splitwiseGroupId",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("PHASE 1: global viewer POST /trips is still 403 and writes neither a trip nor a participant row", async () => {
    const count = async (table: "trips" | "participants") =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const before = { trips: await count("trips"), participants: await count("participants") };
    const res = await read(await w.as.viewer.post("/api/trips", { name: "Nope" }));
    expect(res).toEqual({ status: 403, body: { error: "Forbidden: Viewers cannot create trips" } });
    expect({ trips: await count("trips"), participants: await count("participants") }).toEqual(before);
  });
});

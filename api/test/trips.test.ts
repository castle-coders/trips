// REST parity baseline: /trips (list, upcoming, get, create, update, delete).
// Encodes TODAY's behavior (pre service extraction). The Phase 1 trips extractor must keep
// every test here green and every snapshot unchanged. The deliberate create-trip change lives
// in trips.behavior-change.test.ts.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTORS,
  IDS,
  addParticipant,
  anonymous,
  asUser,
  byId,
  normalize,
  read,
  seedRoleWorld,
  seedTrip,
  seedUser,
  type Actor,
  type RoleWorld,
} from "./helpers";

let w: RoleWorld;
beforeEach(async () => {
  w = await seedRoleWorld();
});

const tripRow = async (id: string) =>
  env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(id).first<Record<string, unknown>>();

describe("GET /trips", () => {
  const expected: Record<Actor, string[]> = {
    admin: [IDS.trip, IDS.otherTrip],
    owner: [IDS.trip],
    editor: [IDS.trip],
    viewer: [IDS.trip],
    outsider: [IDS.otherTrip],
  };

  it.each(ACTORS)("%s gets 200 with only the trips they may see", async (actor) => {
    const { status, body } = await read(await w.as[actor].get("/api/trips"));
    expect(status).toBe(200);
    expect(byId(body).map((t: { id: string }) => t.id)).toEqual([...expected[actor]].sort());
  });

  it("body shape (admin, all trips)", async () => {
    const { body } = await read(await w.as.admin.get("/api/trips"));
    expect(normalize(byId(body), w.labels)).toMatchSnapshot();
  });

  it("member body is the bare trip row (no role, no participants)", async () => {
    const { body } = await read(await w.as.viewer.get("/api/trips"));
    expect(normalize(body, w.labels)).toMatchSnapshot();
  });

  it("anonymous is 401", async () => {
    const { status, body } = await read(await anonymous().get("/api/trips"));
    expect({ status, body }).toEqual({ status: 401, body: { error: "Unauthorized" } });
  });
});

describe("GET /trips/upcoming", () => {
  const extra = {
    past: "00000000-0000-4000-8000-00000000b101",
    undated: "00000000-0000-4000-8000-00000000b102",
    f2092: "00000000-0000-4000-8000-00000000b192",
    f2093: "00000000-0000-4000-8000-00000000b193",
    f2094: "00000000-0000-4000-8000-00000000b194",
  };
  const labels = () => ({ ...w.labels, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [v, k])) });

  beforeEach(async () => {
    // All owned by `owner` (Owner participant row via seedTrip).
    await seedTrip(w.users.owner.id, { id: extra.past, name: "Past", startDate: "2000-01-01", endDate: "2000-01-05" });
    await seedTrip(w.users.owner.id, { id: extra.undated, name: "Undated", startDate: null, endDate: null });
    // Inserted out of date order to prove ORDER BY startDate.
    await seedTrip(w.users.owner.id, { id: extra.f2094, name: "F2094", startDate: "2094-01-01", endDate: "2094-01-02" });
    await seedTrip(w.users.owner.id, { id: extra.f2092, name: "F2092", startDate: "2092-01-01", endDate: "2092-01-02" });
    await seedTrip(w.users.owner.id, { id: extra.f2093, name: "F2093", startDate: "2093-01-01", endDate: "2093-01-02" });
  });

  const expected: Record<Actor, string[]> = {
    // next 3 by startDate across all dated, not-ended trips
    admin: [IDS.trip, IDS.otherTrip, extra.f2092],
    owner: [IDS.trip, extra.f2092, extra.f2093],
    editor: [IDS.trip],
    viewer: [IDS.trip],
    outsider: [IDS.otherTrip],
  };

  it.each(ACTORS)("%s gets the next (max 3) member trips ordered by startDate", async (actor) => {
    const { status, body } = await read(await w.as[actor].get("/api/trips/upcoming"));
    expect(status).toBe(200);
    expect(body.map((t: { id: string }) => t.id)).toEqual(expected[actor]);
  });

  it("body shape includes every participant's name/email/traveling (owner)", async () => {
    const { body } = await read(await w.as.owner.get("/api/trips/upcoming"));
    expect(normalize(body, labels())).toMatchSnapshot();
  });

  it("viewer sees the same participant list (including emails) as the owner", async () => {
    const { body } = await read(await w.as.viewer.get("/api/trips/upcoming"));
    expect(normalize(body, labels())).toMatchSnapshot();
  });
});

describe("GET /trips/:tripId", () => {
  const expected: Record<Actor, number> = { admin: 200, owner: 200, editor: 200, viewer: 200, outsider: 404 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].get(`/api/trips/${IDS.trip}`));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, w.labels)).toMatchSnapshot();
  });

  it("admin gets 404 for a missing trip", async () => {
    const res = await read(await w.as.admin.get(`/api/trips/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("non-admin gets the same 404 for a missing trip as for a non-member trip", async () => {
    const res = await read(await w.as.owner.get(`/api/trips/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("non-uuid tripId is a 400 zod validation error", async () => {
    const res = await read(await w.as.owner.get("/api/trips/not-a-uuid"));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });
});

describe("POST /trips", () => {
  const input = {
    name: "Created Trip",
    destination: "Newville",
    startDate: "2095-02-01",
    endDate: "2095-02-04",
    description: "Created via REST",
  };

  it.each(["admin", "owner", "outsider"] as const)("%s (global admin or editor) gets 201 with the trip row", async (actor) => {
    const { status, body } = await read(await w.as[actor].post("/api/trips", input));
    expect(status).toBe(201);
    expect(normalize(body, w.labels)).toMatchSnapshot();
    expect(await tripRow(body.id)).toMatchObject({ name: "Created Trip", destination: "Newville" });
  });

  it("only name is required; missing optionals are stored as null", async () => {
    const { status, body } = await read(await w.as.owner.post("/api/trips", { name: "Minimal" }));
    expect(status).toBe(201);
    expect(normalize(body)).toMatchSnapshot();
  });

  it("global viewer gets 403 and nothing is written", async () => {
    const res = await read(await w.as.viewer.post("/api/trips", input));
    expect(res).toEqual({ status: 403, body: { error: "Forbidden: Viewers cannot create trips" } });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM trips").first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("global viewer is 403 even with an invalid body (middleware runs before validation)", async () => {
    const res = await read(await w.as.viewer.post("/api/trips", {}));
    expect(res.status).toBe(403);
  });

  it("missing name is a 400 zod validation error", async () => {
    const res = await read(await w.as.owner.post("/api/trips", { destination: "x" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  it("empty name is a 400", async () => {
    const res = await read(await w.as.owner.post("/api/trips", { name: "" }));
    expect(res.status).toBe(400);
  });

  it("anonymous is 401", async () => {
    expect((await anonymous().post("/api/trips", input)).status).toBe(401);
  });
});

describe("PUT /trips/:tripId", () => {
  const patch = { name: "Renamed Trip", description: null };
  const expected: Record<Actor, number> = { admin: 200, owner: 200, editor: 200, viewer: 403, outsider: 403 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].put(`/api/trips/${IDS.trip}`, patch));
    expect(status).toBe(expected[actor]);
    expect(normalize(body, w.labels)).toMatchSnapshot();
    const row = await tripRow(IDS.trip);
    if (status === 200) {
      expect(row).toMatchObject({ name: "Renamed Trip", description: null, destination: "Testville" });
      expect(row?.created_at).toBe(w.trip.createdAt);
    } else {
      expect(row).toMatchObject({ name: "Parity Trip", description: "Fake trip for parity tests", updated_at: w.trip.updatedAt });
    }
  });

  it("admin gets 404 for a missing trip", async () => {
    const res = await read(await w.as.admin.put(`/api/trips/${IDS.missing}`, patch));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("non-admin gets 403 (not 404) for a missing trip: middleware treats them as Viewer", async () => {
    const res = await read(await w.as.owner.put(`/api/trips/${IDS.missing}`, patch));
    expect(res).toEqual({ status: 403, body: { error: "Forbidden" } });
  });

  it("empty body is accepted and leaves the row unchanged", async () => {
    const { status, body } = await read(await w.as.owner.put(`/api/trips/${IDS.trip}`, {}));
    expect(status).toBe(200);
    expect(normalize(body, w.labels)).toMatchSnapshot();
  });

  it("unknown fields are stripped, not stored", async () => {
    const { status, body } = await read(
      await w.as.owner.put(`/api/trips/${IDS.trip}`, { name: "X", id: IDS.otherTrip, bogus: 1 })
    );
    expect(status).toBe(200);
    expect(body.id).toBe(IDS.trip);
    expect(body).not.toHaveProperty("bogus");
    expect(await tripRow(IDS.otherTrip)).toMatchObject({ name: "Other Trip" });
  });

  it("empty name is a 400", async () => {
    const res = await read(await w.as.owner.put(`/api/trips/${IDS.trip}`, { name: "" }));
    expect(res.status).toBe(400);
  });

  it("global viewer who is an Editor participant may update (trip role wins over global role)", async () => {
    const gv = await seedUser("globalviewer@example.test", "viewer");
    await addParticipant(IDS.trip, gv.id, "Editor");
    const res = await read(await asUser(gv.email).put(`/api/trips/${IDS.trip}`, { name: "By global viewer" }));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /trips/:tripId", () => {
  const expected: Record<Actor, number> = { admin: 204, owner: 204, editor: 403, viewer: 403, outsider: 403 };

  it.each(ACTORS)("%s", async (actor) => {
    const { status, body } = await read(await w.as[actor].delete(`/api/trips/${IDS.trip}`));
    expect(status).toBe(expected[actor]);
    expect(body).toMatchSnapshot();
    const row = await tripRow(IDS.trip);
    if (status === 204) {
      expect(row).toBeNull();
      const p = await env.DB.prepare("SELECT count(*) AS n FROM participants WHERE trip_id = ?").bind(IDS.trip).first<{ n: number }>();
      expect(p?.n).toBe(0); // cascade
    } else {
      expect(row).not.toBeNull();
    }
  });

  it("admin gets 404 for a missing trip", async () => {
    const res = await read(await w.as.admin.delete(`/api/trips/${IDS.missing}`));
    expect(res).toEqual({ status: 404, body: { error: "Trip not found" } });
  });
});

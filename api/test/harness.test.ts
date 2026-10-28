import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addParticipant, anonymous, asUser, seedExpense, seedItinerary, seedTrip, seedUser } from "./helpers";

describe("test harness", () => {
  it("GET /api/trips returns the seeded member's trip", async () => {
    const user = await seedUser("owner@example.test", "editor");
    const { trip } = await seedTrip(user.id, { name: "Harness Trip" });
    await seedTrip(null, { name: "Someone Else's Trip" });

    const res = await asUser(user.email).get("/api/trips");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(body.map((t) => t.id)).toEqual([trip.id]);
    expect(body[0].name).toBe("Harness Trip");
  });

  it("also works without the /api prefix", async () => {
    const user = await seedUser("noprefix@example.test", "admin");
    await seedTrip(null);
    const res = await asUser(user.email).get("/trips");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
  });

  it("an unseeded email is 401 (dev mode does not auto-create users)", async () => {
    const res = await asUser("ghost@example.test").get("/api/trips");
    expect(res.status).toBe(401);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("no header is 401", async () => {
    expect((await anonymous().get("/api/trips")).status).toBe(401);
  });

  it("storage is wiped between tests in the same file", async () => {
    // Earlier tests in this file seeded users and trips; none survive.
    for (const t of ["users", "user_emails", "trips", "participants", "itineraries", "expenses"]) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(row?.n, t).toBe(0);
    }
  });

  it("seed helpers produce rows the REST API reads back", async () => {
    const owner = await seedUser("o@example.test", "editor");
    const viewer = await seedUser("v@example.test", "viewer");
    const { trip, owner: ownerP } = await seedTrip(owner.id);
    await addParticipant(trip.id, viewer.id, "Viewer");
    const it1 = await seedItinerary(trip.id);
    const ex = await seedExpense(trip.id, { payerId: ownerP!.id });

    const itRes = await asUser(owner.email).get(`/api/trips/${trip.id}/itineraries/${it1.id}`);
    expect(itRes.status).toBe(200);
    expect(((await itRes.json()) as { id: string }).id).toBe(it1.id);

    const exRes = await asUser(viewer.email).get(`/api/trips/${trip.id}/expenses`);
    expect(exRes.status).toBe(200);
    expect(((await exRes.json()) as Array<{ id: string }>).map((e) => e.id)).toEqual([ex.id]);

    const write = await asUser(viewer.email).post(`/api/trips/${trip.id}/expenses`, {
      description: "x", amount: 1, currency: "USD", category: "Food", splitType: "EQUAL",
    });
    expect(write.status).toBe(403);
  });
});

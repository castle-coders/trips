// services/trips.ts: listTrips, listUpcomingTrips, getTrip, createTrip, updateTrip, deleteTrip.
// Called directly (no requireTripEditor middleware in front), as the MCP tools call them.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "../src/db";
import { participants, trips } from "../src/db/schema";
import { createTrip, deleteTrip, getTrip, listTrips, listUpcomingTrips, updateTrip } from "../src/services/trips";
import {
  IDS,
  addParticipant,
  dbState,
  expectServiceError,
  seedRoleWorld,
  seedTrip,
  seedUser,
  testDb,
  toAuth,
  type Actor,
  type RoleWorld,
} from "./helpers";

let w: RoleWorld;
const auth = (a: Actor): AuthUser => toAuth(w.users[a]);

beforeEach(async () => {
  w = await seedRoleWorld();
});

describe("listTrips", () => {
  it("admin sees every trip as Owner", async () => {
    const rows = await listTrips(testDb(), auth("admin"));
    expect(rows.map((r) => [r.id, r.role]).sort()).toEqual([
      [IDS.trip, "Owner"],
      [IDS.otherTrip, "Owner"],
    ].sort());
  });

  it("members see only their trips, each with their own trip role", async () => {
    expect((await listTrips(testDb(), auth("owner"))).map((r) => [r.id, r.role])).toEqual([[IDS.trip, "Owner"]]);
    expect((await listTrips(testDb(), auth("editor"))).map((r) => [r.id, r.role])).toEqual([[IDS.trip, "Editor"]]);
    expect((await listTrips(testDb(), auth("viewer"))).map((r) => [r.id, r.role])).toEqual([[IDS.trip, "Viewer"]]);
    expect((await listTrips(testDb(), auth("outsider"))).map((r) => [r.id, r.role])).toEqual([[IDS.otherTrip, "Owner"]]);
  });

  it("a user with no participant rows gets []", async () => {
    const loner = toAuth(await seedUser("loner@example.test", "editor"));
    expect(await listTrips(testDb(), loner)).toEqual([]);
  });

  it("different roles on different trips are reported per trip; unknown stored role is Viewer", async () => {
    await addParticipant(IDS.otherTrip, w.users.viewer.id, "Editor");
    const { trip: third } = await seedTrip(null, { name: "Third" });
    await addParticipant(third.id, w.users.viewer.id, "Superuser" as never);
    const roles = Object.fromEntries((await listTrips(testDb(), auth("viewer"))).map((r) => [r.id, r.role]));
    expect(roles).toEqual({ [IDS.trip]: "Viewer", [IDS.otherTrip]: "Editor", [third.id]: "Viewer" });
  });

  it("rows carry the full trip columns", async () => {
    const [row] = await listTrips(testDb(), auth("owner"));
    expect(row).toMatchObject({ id: IDS.trip, name: "Parity Trip", destination: "Testville", startDate: "2090-03-01", endDate: "2090-03-08" });
  });
});

describe("listUpcomingTrips", () => {
  it("non-members do not see a trip; members and admin do", async () => {
    expect((await listUpcomingTrips(testDb(), auth("outsider"))).map((t) => t.id)).toEqual([IDS.otherTrip]);
    expect((await listUpcomingTrips(testDb(), auth("viewer"))).map((t) => t.id)).toEqual([IDS.trip]);
    expect((await listUpcomingTrips(testDb(), auth("admin"))).map((t) => t.id)).toEqual([IDS.trip, IDS.otherTrip]);
  });

  it("excludes past and undated trips and caps at 3, ordered by start date", async () => {
    const u = toAuth(await seedUser("planner@example.test", "editor"));
    await seedTrip(u.id, { name: "Past", startDate: "2000-01-01", endDate: "2000-01-02" });
    await seedTrip(u.id, { name: "Undated", startDate: null, endDate: null });
    for (const [name, d] of [["D", "2095-01-01"], ["B", "2093-01-01"], ["A", "2092-01-01"], ["C", "2094-01-01"]] as const) {
      await seedTrip(u.id, { name, startDate: d, endDate: d });
    }
    expect((await listUpcomingTrips(testDb(), u)).map((t) => t.name)).toEqual(["A", "B", "C"]);
  });
});

describe("getTrip", () => {
  it("returns the trip, the caller's role and every participant (including non-user guests)", async () => {
    for (const [actor, role] of [["owner", "Owner"], ["editor", "Editor"], ["viewer", "Viewer"], ["admin", "Owner"]] as const) {
      const res = await getTrip(testDb(), auth(actor), IDS.trip);
      expect(res.role, actor).toBe(role);
      expect(res.trip.id).toBe(IDS.trip);
      const ps = [...res.participants].sort((a, b) => a.id.localeCompare(b.id));
      expect(ps).toEqual([
        { id: IDS.ownerP, userId: IDS.owner, name: "Owner User", email: "owner@example.test", role: "Owner", traveling: true },
        { id: IDS.editorP, userId: IDS.editor, name: "Editor User", email: "editor@example.test", role: "Editor", traveling: true },
        { id: IDS.viewerP, userId: IDS.viewer, name: "Viewer User", email: "viewer@example.test", role: "Viewer", traveling: false },
        { id: IDS.guestP, userId: null, name: "Guest Traveler", email: null, role: "Viewer", traveling: true },
      ]);
    }
  });

  it("participant summaries map an unknown stored role to Viewer", async () => {
    const p = await addParticipant(IDS.trip, null, "co-owner" as never, { name: "Odd Role" });
    const { participants: ps } = await getTrip(testDb(), auth("owner"), IDS.trip);
    expect(ps.find((x) => x.id === p.id)?.role).toBe("Viewer");
  });

  it("non-member is not_found; admin on a missing trip is not_found", async () => {
    await expectServiceError(getTrip(testDb(), auth("outsider"), IDS.trip), "not_found", "Trip not found");
    await expectServiceError(getTrip(testDb(), auth("viewer"), IDS.missing), "not_found", "Trip not found");
    await expectServiceError(getTrip(testDb(), auth("admin"), IDS.missing), "not_found", "Trip not found");
  });
});

describe("createTrip", () => {
  it("inserts the trip and an Owner participant row for the creator", async () => {
    const before = await dbState();
    const trip = await createTrip(testDb(), auth("editor"), { name: "New Trip", destination: "Nowhere", startDate: "2099-01-01" });
    expect(trip).toMatchObject({ name: "New Trip", destination: "Nowhere", startDate: "2099-01-01", endDate: null, description: null, splitwiseGroupId: null });
    const [stored] = await testDb().select().from(trips).where(eq(trips.id, trip.id));
    expect(stored).toEqual(trip);

    const ps = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ userId: IDS.editor, email: "editor@example.test", name: "Editor User", role: "Owner" });

    const after = await dbState();
    expect(after.trips).toHaveLength(before.trips.length + 1);
    expect(after.participants).toHaveLength(before.participants.length + 1);
  });

  it("the non-admin creator can read the trip back as Owner and sees it in listTrips", async () => {
    const trip = await createTrip(testDb(), auth("outsider"), { name: "Mine" });
    const got = await getTrip(testDb(), auth("outsider"), trip.id);
    expect(got.role).toBe("Owner");
    expect(got.participants.map((p) => [p.userId, p.role])).toEqual([[IDS.outsider, "Owner"]]);
    expect((await listTrips(testDb(), auth("outsider"))).map((t) => [t.id, t.role])).toContainEqual([trip.id, "Owner"]);
    // Other users are still non-members.
    await expectServiceError(getTrip(testDb(), auth("editor"), trip.id), "not_found");
  });

  it("admin creators also get an Owner row", async () => {
    const trip = await createTrip(testDb(), auth("admin"), { name: "Admin Trip" });
    const ps = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(ps.map((p) => [p.userId, p.role])).toEqual([[IDS.admin, "Owner"]]);
  });

  it("global viewer is forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createTrip(testDb(), auth("viewer"), { name: "Nope" }), "forbidden", "Forbidden: Viewers cannot create trips");
    expect(await dbState()).toEqual(before);
  });

  it("is atomic: when the Owner row cannot be inserted, no trip row is left behind", async () => {
    const before = await dbState();
    // participants.name is NOT NULL; a user with a null name makes the second batch statement fail.
    const broken = { ...auth("editor"), name: null as unknown as string };
    const err = await createTrip(testDb(), broken, { name: "Half" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await dbState()).toEqual(before);
  });
});

describe("updateTrip", () => {
  it("Editor and Owner can patch; returned row is stored", async () => {
    const t = await updateTrip(testDb(), auth("editor"), IDS.trip, { name: "Renamed", description: null });
    expect(t).toMatchObject({ id: IDS.trip, name: "Renamed", description: null, destination: "Testville" });
    const [stored] = await testDb().select().from(trips).where(eq(trips.id, IDS.trip));
    expect(stored).toEqual(t);
    expect((await updateTrip(testDb(), auth("owner"), IDS.trip, { destination: "Elsewhere" })).destination).toBe("Elsewhere");
  });

  it("Viewer is forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), auth("viewer"), IDS.trip, { name: "X" }), "forbidden", "Forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("non-member is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), auth("outsider"), IDS.trip, { name: "X" }), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("admin on a missing trip is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), auth("admin"), IDS.missing, { name: "X" }), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });
});

describe("deleteTrip", () => {
  it("Editor and Viewer are forbidden (Owner required) and nothing is deleted", async () => {
    const before = await dbState();
    await expectServiceError(deleteTrip(testDb(), auth("editor"), IDS.trip), "forbidden", "Forbidden: only trip Owners can delete trips");
    await expectServiceError(deleteTrip(testDb(), auth("viewer"), IDS.trip), "forbidden", "Forbidden: only trip Owners can delete trips");
    expect(await dbState()).toEqual(before);
  });

  it("non-member is not_found and nothing is deleted", async () => {
    const before = await dbState();
    await expectServiceError(deleteTrip(testDb(), auth("outsider"), IDS.trip), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("Owner deletes the trip and its participants cascade", async () => {
    await deleteTrip(testDb(), auth("owner"), IDS.trip);
    expect(await testDb().select().from(trips).where(eq(trips.id, IDS.trip))).toEqual([]);
    expect(await testDb().select().from(participants).where(eq(participants.tripId, IDS.trip))).toEqual([]);
    // other trip untouched
    expect(await testDb().select().from(trips).where(eq(trips.id, IDS.otherTrip))).toHaveLength(1);
  });

  it("admin on a missing trip is not_found", async () => {
    await expectServiceError(deleteTrip(testDb(), auth("admin"), IDS.missing), "not_found", "Trip not found");
  });
});

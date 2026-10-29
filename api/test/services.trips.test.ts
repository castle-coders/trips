// services/trips.ts: listTrips, listUpcomingTrips, getTrip, createTrip, updateTrip, deleteTrip.
// Called directly (no requireTripEditor middleware in front), as the MCP tools call them.
// Writes take an Actor and record exactly one audit event in the same batch (AUDIT_TDD 7.1 / 7.2).
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as DbActor, AuthUser } from "../src/db";
import { documents, invites, participants, trips } from "../src/db/schema";
import { SNAPSHOT_COLUMNS } from "../src/services/audit";
import { createTrip, deleteTrip, getTrip, listTrips, listUpcomingTrips, updateTrip } from "../src/services/trips";
import {
  IDS,
  addParticipant,
  dbState,
  expectServiceError,
  seedExpense,
  seedItinerary,
  seedRoleWorld,
  seedTrip,
  seedUser,
  testDb,
  toAuth,
  type Actor,
  type RoleWorld,
} from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

let w: RoleWorld;
const auth = (a: Actor): AuthUser => toAuth(w.users[a]);
/** Actor for writes: web channel, no client id, a fake request id. */
const act = (a: Actor): DbActor => toActor(w.users[a]);

/** The actor columns an event must carry for `a`. */
const actorColumns = (a: Actor) => ({
  actorUserId: w.users[a].id,
  actorName: w.users[a].name,
  actorEmail: w.users[a].email,
  actorRole: w.users[a].role,
  channel: "web",
  clientId: null,
  requestId: "ray-test",
});

/** Trip snapshot as the allow-list stores it (no createdAt / updatedAt). */
const tripSnapshot = (t: typeof trips.$inferSelect) => ({
  id: t.id,
  name: t.name,
  destination: t.destination,
  startDate: t.startDate,
  endDate: t.endDate,
  description: t.description,
  splitwiseGroupId: t.splitwiseGroupId,
});

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
    const trip = await createTrip(testDb(), act("editor"), { name: "New Trip", destination: "Nowhere", startDate: "2099-01-01" });
    expect(trip).toMatchObject({ name: "New Trip", destination: "Nowhere", startDate: "2099-01-01", endDate: null, description: null, splitwiseGroupId: null });
    const [stored] = await testDb().select().from(trips).where(eq(trips.id, trip.id));
    expect(stored).toEqual(trip);

    const ps = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ userId: IDS.editor, email: "editor@example.test", name: "Editor User", role: "Owner" });

    const after = await dbState();
    expect(after.trips).toHaveLength(before.trips.length + 1);
    expect(after.participants).toHaveLength(before.participants.length + 1);

    // Exactly one event: trip.create with the owner participant id; no participant.create.
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...actorColumns("editor"),
      tripId: trip.id,
      entityType: "trip",
      entityId: trip.id,
      entityLabel: "New Trip",
      action: "create",
      before: null,
      after: tripSnapshot(stored),
      changes: null,
      metadata: { ownerParticipantId: ps[0].id },
    });
  });

  it("the non-admin creator can read the trip back as Owner and sees it in listTrips", async () => {
    const trip = await createTrip(testDb(), act("outsider"), { name: "Mine" });
    const got = await getTrip(testDb(), auth("outsider"), trip.id);
    expect(got.role).toBe("Owner");
    expect(got.participants.map((p) => [p.userId, p.role])).toEqual([[IDS.outsider, "Owner"]]);
    expect((await listTrips(testDb(), auth("outsider"))).map((t) => [t.id, t.role])).toContainEqual([trip.id, "Owner"]);
    // Other users are still non-members.
    await expectServiceError(getTrip(testDb(), auth("editor"), trip.id), "not_found");
  });

  it("admin creators also get an Owner row", async () => {
    const trip = await createTrip(testDb(), act("admin"), { name: "Admin Trip" });
    const ps = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(ps.map((p) => [p.userId, p.role])).toEqual([[IDS.admin, "Owner"]]);
  });

  it("global viewer is forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createTrip(testDb(), act("viewer"), { name: "Nope" }), "forbidden", "Forbidden: Viewers cannot create trips");
    expect(await dbState()).toEqual(before);
  });

  it("is atomic: when the Owner row cannot be inserted, no trip row is left behind", async () => {
    const before = await dbState();
    // participants.name is NOT NULL; a user with a null name makes the second batch statement fail.
    const broken = { ...act("editor"), name: null as unknown as string };
    const err = await createTrip(testDb(), broken, { name: "Half" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("global viewer is forbidden and no event is recorded", async () => {
    await expectServiceError(createTrip(testDb(), act("viewer"), { name: "Nope" }), "forbidden");
    expect(await auditRows()).toEqual([]);
  });
});

describe("updateTrip", () => {
  it("Editor and Owner can patch; returned row is stored", async () => {
    const t = await updateTrip(testDb(), act("editor"), IDS.trip, { name: "Renamed", description: null });
    expect(t).toMatchObject({ id: IDS.trip, name: "Renamed", description: null, destination: "Testville" });
    const [stored] = await testDb().select().from(trips).where(eq(trips.id, IDS.trip));
    expect(stored).toEqual(t);
    expect((await updateTrip(testDb(), act("owner"), IDS.trip, { destination: "Elsewhere" })).destination).toBe("Elsewhere");

    // One trip.update per write, with before/after snapshots and only the changed columns in changes.
    const events = await auditRows();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ...actorColumns("editor"),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      entityLabel: "Renamed",
      action: "update",
      before: tripSnapshot(w.trip),
      after: tripSnapshot(t),
      changes: {
        name: { from: "Parity Trip", to: "Renamed" },
        description: { from: "Fake trip for parity tests", to: null },
      },
      metadata: null,
    });
    expect(events[1]).toMatchObject({
      ...actorColumns("owner"),
      entityId: IDS.trip,
      action: "update",
      changes: { destination: { from: "Testville", to: "Elsewhere" } },
    });
  });

  it("no-op patch (same values) writes nothing: no event, updatedAt untouched, stored row returned", async () => {
    const before = await dbState();
    const t = await updateTrip(testDb(), act("editor"), IDS.trip, {
      name: w.trip.name,
      destination: w.trip.destination,
      description: w.trip.description,
    });
    expect(t).toEqual(w.trip);
    expect(t.updatedAt).toBe(w.trip.updatedAt);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("empty patch writes nothing and returns the stored row", async () => {
    const before = await dbState();
    const t = await updateTrip(testDb(), act("owner"), IDS.trip, {});
    expect(t).toEqual(w.trip);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("a patch that only re-sends some fields records only the fields that changed", async () => {
    await updateTrip(testDb(), act("owner"), IDS.trip, { name: w.trip.name, endDate: "2090-03-09" });
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0].changes).toEqual({ endDate: { from: "2090-03-08", to: "2090-03-09" } });
  });

  it("forbidden and not_found record no event", async () => {
    await expectServiceError(updateTrip(testDb(), act("viewer"), IDS.trip, { name: "X" }), "forbidden");
    await expectServiceError(updateTrip(testDb(), act("outsider"), IDS.trip, { name: "X" }), "not_found");
    await expectServiceError(updateTrip(testDb(), act("admin"), IDS.missing, { name: "X" }), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("Viewer is forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), act("viewer"), IDS.trip, { name: "X" }), "forbidden", "Forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("non-member is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), act("outsider"), IDS.trip, { name: "X" }), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("admin on a missing trip is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateTrip(testDb(), act("admin"), IDS.missing, { name: "X" }), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });
});

describe("deleteTrip", () => {
  it("Editor and Viewer are forbidden (Owner required) and nothing is deleted", async () => {
    const before = await dbState();
    await expectServiceError(deleteTrip(testDb(), act("editor"), IDS.trip), "forbidden", "Forbidden: only trip Owners can delete trips");
    await expectServiceError(deleteTrip(testDb(), act("viewer"), IDS.trip), "forbidden", "Forbidden: only trip Owners can delete trips");
    expect(await dbState()).toEqual(before);
  });

  it("non-member is not_found and nothing is deleted", async () => {
    const before = await dbState();
    await expectServiceError(deleteTrip(testDb(), act("outsider"), IDS.trip), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("Owner deletes the trip and its participants cascade", async () => {
    await deleteTrip(testDb(), act("owner"), IDS.trip);
    expect(await testDb().select().from(trips).where(eq(trips.id, IDS.trip))).toEqual([]);
    expect(await testDb().select().from(participants).where(eq(participants.tripId, IDS.trip))).toEqual([]);
    // other trip untouched
    expect(await testDb().select().from(trips).where(eq(trips.id, IDS.otherTrip))).toHaveLength(1);

    // One trip.delete with the full before snapshot; cascaded participants get no events.
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...actorColumns("owner"),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      entityLabel: "Parity Trip",
      action: "delete",
      before: tripSnapshot(w.trip),
      after: null,
      changes: null,
      metadata: { itineraries: 0, expenses: 0, participants: 4, documents: 0, invites: 0 },
    });
  });

  it("delete metadata counts every child table, and children get no events of their own", async () => {
    const ts = new Date().toISOString();
    await seedItinerary(IDS.trip);
    await seedItinerary(IDS.trip);
    await seedItinerary(IDS.trip);
    await seedExpense(IDS.trip, { payerId: IDS.editorP });
    await seedExpense(IDS.trip);
    await testDb().insert(documents).values({
      id: crypto.randomUUID(),
      tripId: IDS.trip,
      reservationId: null,
      fileUrl: "https://files.example.test/fake.pdf",
      documentType: "Other",
      name: "Fake Doc",
      createdAt: ts,
      updatedAt: ts,
    });
    await testDb().insert(invites).values({
      id: crypto.randomUUID(),
      tripId: IDS.trip,
      email: "invitee@example.test",
      name: "Invitee",
      role: "Viewer",
      token: "fake-invite-token-for-tests",
      status: "pending",
      participantId: null,
      invitedBy: IDS.owner,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: ts,
    });
    // Children on the other trip must not be counted.
    await seedItinerary(IDS.otherTrip);
    await seedExpense(IDS.otherTrip);

    await deleteTrip(testDb(), act("admin"), IDS.trip);
    expect(await testDb().select().from(documents).where(eq(documents.tripId, IDS.trip))).toEqual([]);
    expect(await testDb().select().from(invites).where(eq(invites.tripId, IDS.trip))).toEqual([]);

    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...actorColumns("admin"),
      entityType: "trip",
      entityId: IDS.trip,
      action: "delete",
      metadata: { itineraries: 3, expenses: 2, participants: 4, documents: 1, invites: 1 },
    });
  });

  it("forbidden and not_found record no event", async () => {
    await expectServiceError(deleteTrip(testDb(), act("editor"), IDS.trip), "forbidden");
    await expectServiceError(deleteTrip(testDb(), act("outsider"), IDS.trip), "not_found");
    await expectServiceError(deleteTrip(testDb(), act("admin"), IDS.missing), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("admin on a missing trip is not_found", async () => {
    await expectServiceError(deleteTrip(testDb(), act("admin"), IDS.missing), "not_found", "Trip not found");
  });
});

describe("audit snapshot shape and actor copy (gap audit, AUDIT_TDD 6.4 / PRD 6.2)", () => {
  const TRIP_KEYS = [...SNAPSHOT_COLUMNS.trip].sort();
  const keysOf = (snap: unknown) => Object.keys(snap as object).sort();

  it("create, update and delete snapshots carry exactly the allow-listed trip columns, never createdAt or updatedAt", async () => {
    const created = await createTrip(testDb(), act("owner"), { name: "Shape", description: "d" });
    await updateTrip(testDb(), act("owner"), created.id, { description: "e" });
    await deleteTrip(testDb(), act("owner"), created.id);

    const events = await auditRows();
    expect(events.map((e) => e.action)).toEqual(["create", "update", "delete"]);
    const [c, u, d] = events;
    expect(c.before).toBeNull();
    expect(keysOf(c.after)).toEqual(TRIP_KEYS);
    expect(keysOf(u.before)).toEqual(TRIP_KEYS);
    expect(keysOf(u.after)).toEqual(TRIP_KEYS);
    expect(keysOf(d.before)).toEqual(TRIP_KEYS);
    expect(d.after).toBeNull();
    for (const snap of [c.after, u.before, u.after, d.before]) {
      expect(snap).not.toHaveProperty("createdAt");
      expect(snap).not.toHaveProperty("updatedAt");
    }
    // Every trip event is trip-scoped.
    expect(events.every((e) => e.tripId === created.id)).toBe(true);
  });

  it("channel, clientId and requestId are copied from the Actor, not defaulted (service token caller)", async () => {
    const actor = toActor(w.users.owner, { channel: "service_token", clientId: "svc-fake-cn", requestId: "ray-svc" });
    await updateTrip(testDb(), actor, IDS.trip, { name: "Via service token" });
    const [e] = await auditRows();
    expect(e).toMatchObject({
      actorUserId: IDS.owner,
      actorName: "Owner User",
      actorEmail: "owner@example.test",
      actorRole: "editor",
      channel: "service_token",
      clientId: "svc-fake-cn",
      requestId: "ray-svc",
    });
  });
});

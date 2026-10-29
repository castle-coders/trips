// services/invites.ts: listInvites, createInvite, deleteInvite, acceptInvite.
// Called directly (no requireTripEditor middleware in front), plus a REST block that pins the
// status codes the thinned route and the auth accept handler return. Spec: specs/AUDIT_TDD.md
// 7.1, 7.2 (invites rows), 12. The invite token must never appear in any audit JSON column.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as DbActor } from "../src/db";
import { invites, participants, users } from "../src/db/schema";
import { SNAPSHOT_COLUMNS } from "../src/services/audit";
import { acceptInvite, createInvite, deleteInvite, listInvites, type Invite } from "../src/services/invites";
import {
  IDS,
  addUserEmail,
  asUser,
  dbState,
  expectServiceError,
  read,
  seedRoleWorld,
  seedUser,
  testDb,
  toAuth,
  type Actor as Role,
  type RoleWorld,
} from "./helpers";
import { auditRows, toActor, type AuditRow } from "./helpers/audit";

let w: RoleWorld;
const actor = (a: Role): DbActor => toActor(w.users[a]);

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

/** Insert a pending invite row directly. The token is an obviously fake, greppable string. */
async function seedInvite(input: Partial<typeof invites.$inferInsert> = {}): Promise<Invite> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    tripId: IDS.trip,
    participantId: null,
    email: null,
    name: "Invited Person",
    role: "Viewer",
    token: `fake-invite-token-${crypto.randomUUID()}`,
    status: "pending",
    invitedBy: IDS.owner,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now.toISOString(),
    ...input,
  };
  await testDb().insert(invites).values(row);
  const [stored] = await testDb().select().from(invites).where(eq(invites.id, row.id));
  return stored;
}

const storedInvite = async (id: string) => (await testDb().select().from(invites).where(eq(invites.id, id)))[0];
const storedUser = async (id: string) => (await testDb().select().from(users).where(eq(users.id, id)))[0];
const tripParticipants = () => testDb().select().from(participants).where(eq(participants.tripId, IDS.trip));

/** Every JSON column of every event, serialized, so a secret can be searched for as a substring. */
function allJson(rows: AuditRow[]): string {
  return rows.map((r) => JSON.stringify([r.before, r.after, r.changes, r.metadata, r.entityLabel])).join("\n");
}

function expectNoToken(rows: AuditRow[], ...tokens: string[]) {
  const json = allJson(rows);
  for (const t of tokens) expect(json, `token ${t} leaked into an audit column`).not.toContain(t);
  for (const r of rows) {
    for (const snap of [r.before, r.after]) {
      if (snap) expect(Object.keys(snap)).not.toContain("token");
    }
  }
}

beforeEach(async () => {
  w = await seedRoleWorld();
});

describe("listInvites", () => {
  it("Owner, Editor and admin get the full rows; Viewer and non-member are forbidden", async () => {
    const a = await seedInvite({ name: "A" });
    const b = await seedInvite({ name: "B" });
    await seedInvite({ tripId: IDS.otherTrip, invitedBy: IDS.outsider, name: "Elsewhere" });
    const expected = byId([a, b]);
    for (const r of ["owner", "editor", "admin"] as const) {
      expect(byId(await listInvites(testDb(), toAuth(w.users[r]), IDS.trip)), r).toEqual(expected);
    }
    await expectServiceError(listInvites(testDb(), toAuth(w.users.viewer), IDS.trip), "forbidden", "Forbidden");
    await expectServiceError(listInvites(testDb(), toAuth(w.users.outsider), IDS.trip), "forbidden", "Forbidden");
    expect(await listInvites(testDb(), toAuth(w.users.admin), IDS.missing)).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});

describe("role matrix for create/delete", () => {
  it("Editor and Viewer are forbidden, non-member is not_found, nothing is written", async () => {
    const inv = await seedInvite();
    const before = { ...(await dbState()), invites: await testDb().select().from(invites) };
    for (const a of ["editor", "viewer"] as const) {
      await expectServiceError(createInvite(testDb(), actor(a), IDS.trip, { name: "X" }), "forbidden", "Forbidden");
      await expectServiceError(deleteInvite(testDb(), actor(a), IDS.trip, inv.id), "forbidden", "Forbidden");
    }
    await expectServiceError(createInvite(testDb(), actor("outsider"), IDS.trip, { name: "X" }), "not_found", "Trip not found");
    await expectServiceError(deleteInvite(testDb(), actor("outsider"), IDS.trip, inv.id), "not_found", "Trip not found");
    expect({ ...(await dbState()), invites: await testDb().select().from(invites) }).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("Owner and admin may create and delete", async () => {
    for (const a of ["owner", "admin"] as const) {
      const created = await createInvite(testDb(), actor(a), IDS.trip, { name: `By ${a}` });
      expect(created.invitedBy).toBe(w.users[a].id);
      await deleteInvite(testDb(), actor(a), IDS.trip, created.id);
      expect(await storedInvite(created.id)).toBeUndefined();
    }
    expect((await auditRows()).map((e) => e.action)).toEqual(["create", "delete", "create", "delete"]);
  });

  it("admin on a missing trip: create is Trip not found, delete is Invite not found", async () => {
    await expectServiceError(createInvite(testDb(), actor("admin"), IDS.missing, { name: "X" }), "not_found", "Trip not found");
    await expectServiceError(deleteInvite(testDb(), actor("admin"), IDS.missing, IDS.missing), "not_found", "Invite not found");
    expect(await auditRows()).toEqual([]);
  });

  it("an invite on another trip is Invite not found (scoped by tripId)", async () => {
    const other = await seedInvite({ tripId: IDS.otherTrip, invitedBy: IDS.outsider });
    await expectServiceError(deleteInvite(testDb(), actor("owner"), IDS.trip, other.id), "not_found", "Invite not found");
    expect(await storedInvite(other.id)).toBeDefined();
    expect(await auditRows()).toEqual([]);
  });
});

describe("createInvite", () => {
  it("inserts a pending Viewer invite with a 7-day expiry and records one invite.create without the token", async () => {
    const t0 = Date.now();
    const row = await createInvite(testDb(), actor("owner"), IDS.trip, { name: "New Invitee", participantId: IDS.guestP });
    expect(row).toMatchObject({
      tripId: IDS.trip,
      participantId: IDS.guestP,
      email: null,
      name: "New Invitee",
      role: "Viewer",
      status: "pending",
      invitedBy: IDS.owner,
    });
    expect(row.token).toMatch(/^[0-9a-f-]{36}$/);
    const ttl = new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime();
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(t0);
    expect(await storedInvite(row.id)).toEqual(row);

    const events = await auditRows();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      action: "create",
      entityType: "invite",
      entityId: row.id,
      tripId: IDS.trip,
      entityLabel: "New Invitee",
      actorUserId: IDS.owner,
      actorName: "Owner User",
      actorEmail: "owner@example.test",
      actorRole: "editor",
      channel: "web",
      clientId: null,
      requestId: "ray-test",
      before: null,
      changes: null,
      metadata: null,
    });
    expect(e.after).toEqual({
      id: row.id,
      tripId: IDS.trip,
      participantId: IDS.guestP,
      name: "New Invitee",
      role: "Viewer",
      status: "pending",
      invitedBy: IDS.owner,
      expiresAt: row.expiresAt,
    });
    expect(Object.keys(e.after!).sort()).toEqual([...SNAPSHOT_COLUMNS.invite].sort());
    expectNoToken(events, row.token);
  });

  it("empty name is stored as null and labelled Invite", async () => {
    const row = await createInvite(testDb(), actor("owner"), IDS.trip, { name: "" });
    expect(row.name).toBeNull();
    expect(row.participantId).toBeNull();
    const [e] = await auditRows();
    expect(e.entityLabel).toBe("Invite");
    expect(e.after).toMatchObject({ name: null });
  });
});

describe("invite snapshot shape (gap audit, AUDIT_TDD 6.4)", () => {
  it("create and delete snapshots carry exactly the allow-listed invite columns: no token, no createdAt, no email", async () => {
    const row = await createInvite(testDb(), actor("owner"), IDS.trip, { name: "Shape" });
    await deleteInvite(testDb(), actor("owner"), IDS.trip, row.id);
    const events = await auditRows();
    expect(events.map((e) => e.action)).toEqual(["create", "delete"]);
    const keys = [...SNAPSHOT_COLUMNS.invite].sort();
    expect(Object.keys(events[0].after!).sort()).toEqual(keys);
    expect(events[0].before).toBeNull();
    expect(Object.keys(events[1].before!).sort()).toEqual(keys);
    expect(events[1].after).toBeNull();
    for (const snap of [events[0].after, events[1].before]) {
      expect(snap).not.toHaveProperty("token");
      expect(snap).not.toHaveProperty("createdAt");
    }
    expectNoToken(events, row.token);
  });

  it("channel, clientId and requestId are copied from the Actor (service token caller)", async () => {
    const svc = toActor(w.users.owner, { channel: "service_token", clientId: "svc-fake-cn", requestId: "ray-svc" });
    await createInvite(testDb(), svc, IDS.trip, { name: "Svc" });
    const [e] = await auditRows();
    expect(e).toMatchObject({ actorUserId: IDS.owner, actorName: "Owner User", channel: "service_token", clientId: "svc-fake-cn", requestId: "ray-svc" });
  });
});

describe("deleteInvite", () => {
  it("removes the row and records one invite.delete with the allow-listed before snapshot, no token", async () => {
    const inv = await seedInvite({ name: "Going Away" });
    await deleteInvite(testDb(), actor("admin"), IDS.trip, inv.id);
    expect(await storedInvite(inv.id)).toBeUndefined();

    const events = await auditRows();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      action: "delete",
      entityType: "invite",
      entityId: inv.id,
      tripId: IDS.trip,
      entityLabel: "Going Away",
      actorUserId: IDS.admin,
      after: null,
      changes: null,
      metadata: null,
    });
    expect(e.before).toEqual({
      id: inv.id,
      tripId: IDS.trip,
      participantId: null,
      name: "Going Away",
      role: "Viewer",
      status: "pending",
      invitedBy: IDS.owner,
      expiresAt: inv.expiresAt,
    });
    expectNoToken(events, inv.token);
  });
});

describe("acceptInvite", () => {
  const newcomer = () => seedUser("newcomer@example.test", "viewer", { name: "Newcomer" });

  it("new participant, invite name matches the user: exactly participant.create + invite.accept", async () => {
    const u = await newcomer();
    const inv = await seedInvite({ name: "Newcomer", role: "Editor" });
    const before = await tripParticipants();

    const result = await acceptInvite(testDb(), toActor(u), inv);
    expect(result.alreadyParticipant).toBe(false);
    expect(result.resolvedName).toBe("Newcomer");
    expect(result.participant).toMatchObject({
      tripId: IDS.trip,
      userId: u.id,
      email: u.email,
      name: "Newcomer",
      role: "Editor",
      traveling: false,
    });

    const after = await tripParticipants();
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((p) => p.id === result.participant.id)).toEqual(result.participant);
    expect((await storedInvite(inv.id)).status).toBe("accepted");
    expect((await storedUser(u.id)).name).toBe("Newcomer");

    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ["participant", "create"],
      ["invite", "accept"],
    ]);
    const [pc, ia] = events;
    expect(pc).toMatchObject({
      entityId: result.participant.id,
      tripId: IDS.trip,
      entityLabel: "Newcomer",
      actorUserId: u.id,
      actorEmail: u.email,
      channel: "web",
      before: null,
      changes: null,
      after: { id: result.participant.id, tripId: IDS.trip, userId: u.id, email: u.email, name: "Newcomer", role: "Editor", traveling: false },
    });
    expect(ia).toMatchObject({
      entityId: inv.id,
      tripId: IDS.trip,
      entityLabel: "Newcomer",
      actorUserId: u.id,
      channel: "web",
      metadata: { participantId: result.participant.id, alreadyParticipant: false },
      changes: { status: { from: "pending", to: "accepted" } },
    });
    expect(ia.before).toMatchObject({ id: inv.id, status: "pending", role: "Editor" });
    expect(ia.after).toMatchObject({ id: inv.id, status: "accepted", role: "Editor" });
    expect(Object.keys(ia.before!).sort()).toEqual([...SNAPSHOT_COLUMNS.invite].sort());
    expect(Object.keys(ia.after!).sort()).toEqual([...SNAPSHOT_COLUMNS.invite].sort());
    expectNoToken(events, inv.token);
  });

  it("invite name differs from the user name: user.update is added, user snapshots carry no passwordHash", async () => {
    const u = await newcomer();
    await testDb().update(users).set({ passwordHash: "fake-hash-never-logged" }).where(eq(users.id, u.id));
    const inv = await seedInvite({ name: "Preferred Name" });

    const result = await acceptInvite(testDb(), toActor(u), inv);
    expect(result.resolvedName).toBe("Preferred Name");
    expect(result.participant.name).toBe("Preferred Name");
    const stored = await storedUser(u.id);
    expect(stored.name).toBe("Preferred Name");
    expect(stored.updatedAt > u.updatedAt).toBe(true);

    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ["user", "update"],
      ["participant", "create"],
      ["invite", "accept"],
    ]);
    const [uu] = events;
    expect(uu).toMatchObject({
      entityId: u.id,
      tripId: null,
      entityLabel: u.email,
      actorUserId: u.id,
      before: { id: u.id, email: u.email, name: "Newcomer", role: "viewer" },
      after: { id: u.id, email: u.email, name: "Preferred Name", role: "viewer" },
      changes: { name: { from: "Newcomer", to: "Preferred Name" } },
    });
    expect(allJson(events)).not.toContain("fake-hash-never-logged");
    expect(allJson(events)).not.toContain("passwordHash");
    expectNoToken(events, inv.token);
  });

  it("invite without a name keeps the user name and records no user.update", async () => {
    const u = await newcomer();
    const inv = await seedInvite({ name: null });
    const result = await acceptInvite(testDb(), toActor(u), inv);
    expect(result.resolvedName).toBe("Newcomer");
    expect((await auditRows()).map((e) => [e.entityType, e.action])).toEqual([
      ["participant", "create"],
      ["invite", "accept"],
    ]);
    const [, ia] = await auditRows();
    expect(ia.entityLabel).toBe("Invite");
  });

  it("already a participant by user id: only invite.accept, alreadyParticipant true, no insert", async () => {
    const inv = await seedInvite({ name: "Viewer User" });
    const before = await tripParticipants();

    const result = await acceptInvite(testDb(), actor("viewer"), inv);
    expect(result.alreadyParticipant).toBe(true);
    expect(result.participant.id).toBe(IDS.viewerP);
    expect(await tripParticipants()).toEqual(before);
    expect((await storedInvite(inv.id)).status).toBe("accepted");

    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([["invite", "accept"]]);
    expect(events[0].metadata).toEqual({ participantId: IDS.viewerP, alreadyParticipant: true });
    expectNoToken(events, inv.token);
  });

  it("already a participant through a linked email: only invite.accept, participantId is the matching row", async () => {
    const u = await newcomer();
    await addUserEmail(u.id, "guest-alias@example.test");
    await testDb().update(participants).set({ email: "guest-alias@example.test" }).where(eq(participants.id, IDS.guestP));
    const inv = await seedInvite({ name: "Newcomer" });

    const result = await acceptInvite(testDb(), toActor(u), inv);
    expect(result).toMatchObject({ alreadyParticipant: true, participant: { id: IDS.guestP } });
    expect((await tripParticipants()).find((p) => p.userId === u.id)).toBeUndefined();
    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([["invite", "accept"]]);
    expect(events[0].metadata).toEqual({ participantId: IDS.guestP, alreadyParticipant: true });
  });

  it("already a participant and the invite renames the user: user.update + invite.accept", async () => {
    const inv = await seedInvite({ name: "Renamed Viewer" });
    await acceptInvite(testDb(), actor("viewer"), inv);
    expect((await storedUser(IDS.viewer)).name).toBe("Renamed Viewer");
    expect((await auditRows()).map((e) => [e.entityType, e.action])).toEqual([
      ["user", "update"],
      ["invite", "accept"],
    ]);
  });

  it("a non-pending invite is not_found and writes nothing", async () => {
    const u = await newcomer();
    const inv = await seedInvite({ status: "accepted" });
    const before = await tripParticipants();
    await expectServiceError(acceptInvite(testDb(), toActor(u), inv), "not_found", "Invite not found");
    expect(await tripParticipants()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("the actor on every event is the accepting user, including channel and requestId", async () => {
    const u = await newcomer();
    const inv = await seedInvite({ name: "Other Name" });
    await acceptInvite(testDb(), toActor(u, { channel: "web", requestId: "ray-accept" }), inv);
    for (const e of await auditRows()) {
      expect(e).toMatchObject({ actorUserId: u.id, actorName: u.name, actorEmail: u.email, actorRole: "viewer", channel: "web", clientId: null, requestId: "ray-accept" });
    }
  });
});

describe("REST status codes through the thinned routes", () => {
  const base = `/api/trips/${IDS.trip}/invites`;

  it("GET: Owner, Editor, admin 200; Viewer and non-member 403 Forbidden", async () => {
    const inv = await seedInvite();
    for (const a of ["owner", "editor", "admin"] as const) {
      const r = await read(await w.as[a].get(base));
      expect(r.status, a).toBe(200);
      expect(r.body.map((i: { id: string }) => i.id)).toEqual([inv.id]);
    }
    for (const a of ["viewer", "outsider"] as const) {
      expect(await read(await w.as[a].get(base)), a).toEqual({ status: 403, body: { error: "Forbidden" } });
    }
    expect(await auditRows()).toEqual([]);
  });

  it("POST/DELETE: Editor, Viewer, non-member 403 Forbidden; Owner and admin succeed with one event each", async () => {
    const inv = await seedInvite();
    for (const a of ["editor", "viewer", "outsider"] as const) {
      expect(await read(await w.as[a].post(base, { name: "X" })), `${a} POST`).toEqual({ status: 403, body: { error: "Forbidden" } });
      expect(await read(await w.as[a].delete(`${base}/${inv.id}`)), `${a} DELETE`).toEqual({ status: 403, body: { error: "Forbidden" } });
    }
    expect(await auditRows()).toEqual([]);

    const created = await read(await w.as.owner.post(base, { name: "Via REST" }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ tripId: IDS.trip, name: "Via REST", role: "Viewer", status: "pending", invitedBy: IDS.owner });
    expect(typeof created.body.token).toBe("string");
    expect((await w.as.admin.delete(`${base}/${created.body.id}`)).status).toBe(204);

    const events = await auditRows();
    expect(events.map((e) => [e.action, e.actorUserId, e.channel])).toEqual([
      ["create", IDS.owner, "dev"],
      ["delete", IDS.admin, "dev"],
    ]);
    expectNoToken(events, created.body.token);
  });

  it("404s: POST on a missing trip (admin) is Trip not found; DELETE of a missing or other-trip invite is Invite not found", async () => {
    const other = await seedInvite({ tripId: IDS.otherTrip, invitedBy: IDS.outsider });
    expect(await read(await w.as.admin.post(`/api/trips/${IDS.missing}/invites`, { name: "X" }))).toEqual({ status: 404, body: { error: "Trip not found" } });
    expect(await read(await w.as.owner.delete(`${base}/${IDS.missing}`))).toEqual({ status: 404, body: { error: "Invite not found" } });
    expect(await read(await w.as.owner.delete(`${base}/${other.id}`))).toEqual({ status: 404, body: { error: "Invite not found" } });
    expect(await auditRows()).toEqual([]);
  });
});

describe("POST /auth/invite/:token/accept through the auth route", () => {
  it("existing user, new participant: 200 with the resolved name, participant.create + invite.accept", async () => {
    const u = await seedUser("joiner@example.test", "viewer", { name: "joiner" });
    const inv = await seedInvite({ name: "Joiner Proper" });
    const r = await read(await asUser(u.email).post(`/api/auth/invite/${inv.token}/accept`, undefined, { headers: { "cf-ray": "ray-rest-accept" } }));
    expect(r).toEqual({ status: 200, body: { user: { id: u.id, email: u.email, name: "Joiner Proper", role: "viewer" } } });

    const p = (await tripParticipants()).find((x) => x.userId === u.id);
    expect(p).toMatchObject({ name: "Joiner Proper", role: "Viewer" });
    expect((await storedInvite(inv.id)).status).toBe("accepted");

    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action, e.actorUserId, e.channel, e.requestId])).toEqual([
      // The test request authenticates through the DEV_MODE header, so the session channel is "dev".
      ["user", "update", u.id, "dev", "ray-rest-accept"],
      ["participant", "create", u.id, "dev", "ray-rest-accept"],
      ["invite", "accept", u.id, "dev", "ray-rest-accept"],
    ]);
    expect(events[2].metadata).toEqual({ participantId: p!.id, alreadyParticipant: false });
    expectNoToken(events, inv.token);
  });

  it("brand-new user: the user is created, then participant.create + invite.accept are recorded with that user as actor", async () => {
    const inv = await seedInvite({ name: "fresh" });
    const r = await read(await asUser("fresh@example.test").post(`/api/auth/invite/${inv.token}/accept`));
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: "fresh@example.test", name: "fresh" });
    const newUserId = r.body.user.id;
    expect(await storedUser(newUserId)).toBeDefined();

    const events = (await auditRows()).filter((e) => e.entityType !== "user");
    expect(events.map((e) => [e.entityType, e.action, e.actorUserId])).toEqual([
      ["participant", "create", newUserId],
      ["invite", "accept", newUserId],
    ]);
    expectNoToken(await auditRows(), inv.token);
  });

  it("brand-new user: user.create is recorded first, with the new user as actor on all three events and no token or hash anywhere", async () => {
    // The dev bypass names the new user after its email local part, so an invite named the same way adds no user.update.
    const inv = await seedInvite({ name: "minted" });
    const r = await read(await asUser("minted@example.test").post(`/api/auth/invite/${inv.token}/accept`, undefined, { headers: { "cf-ray": "ray-minted" } }));
    expect(r.status).toBe(200);
    const newUserId: string = r.body.user.id;

    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action, e.tripId])).toEqual([
      ["user", "create", null],
      ["participant", "create", IDS.trip],
      ["invite", "accept", IDS.trip],
    ]);
    for (const e of events) {
      // No session existed before the user was created, so every event carries the web channel.
      expect(e).toMatchObject({ actorUserId: newUserId, actorEmail: "minted@example.test", actorRole: "viewer", channel: "web", clientId: null });
    }
    const [uc, pc, ia] = events;
    expect(uc).toMatchObject({ entityId: newUserId, entityLabel: "minted@example.test", before: null, changes: null });
    expect(Object.keys(uc.after!).sort()).toEqual([...SNAPSHOT_COLUMNS.user].sort());
    expect(uc.after).not.toHaveProperty("passwordHash");
    expect(pc.after).toMatchObject({ userId: newUserId, email: "minted@example.test", name: "minted", role: "Viewer" });
    expect(ia.metadata).toEqual({ participantId: (pc.after as { id: string }).id, alreadyParticipant: false });
    expect([pc.requestId, ia.requestId]).toEqual(["ray-minted", "ray-minted"]);
    expectNoToken(events, inv.token);
    expect(allJson(events)).not.toContain("passwordHash");
  });

  it("already a participant: 200, only invite.accept with alreadyParticipant true", async () => {
    const inv = await seedInvite({ name: "Editor User" });
    const r = await read(await w.as.editor.post(`/api/auth/invite/${inv.token}/accept`));
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe("Editor User");
    const events = await auditRows();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([["invite", "accept"]]);
    expect(events[0].metadata).toEqual({ participantId: IDS.editorP, alreadyParticipant: true });
  });

  it("HTML form submission gets the welcome page and the same events", async () => {
    const inv = await seedInvite({ name: "Viewer User" });
    const res = await w.as.viewer.post(`/api/auth/invite/${inv.token}/accept`, "", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Welcome to Parity Trip!");
    expect((await auditRows()).map((e) => [e.entityType, e.action])).toEqual([["invite", "accept"]]);
  });

  it("unknown, accepted or expired tokens are 404 and write nothing", async () => {
    const accepted = await seedInvite({ status: "accepted" });
    const expired = await seedInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const before = await tripParticipants();
    expect(await read(await w.as.viewer.post(`/api/auth/invite/no-such-token/accept`))).toEqual({ status: 404, body: { error: "Invite not found" } });
    expect(await read(await w.as.viewer.post(`/api/auth/invite/${accepted.token}/accept`))).toEqual({ status: 404, body: { error: "Invite not found" } });
    expect(await read(await w.as.viewer.post(`/api/auth/invite/${expired.token}/accept`))).toEqual({ status: 404, body: { error: "Invite has expired" } });
    expect(await tripParticipants()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });
});

// services/users.ts and lib/merge.ts: every write records exactly one audit event in the same
// batch as the data statement (AUDIT_TDD 7.3), always with tripId null. passwordHash never
// reaches a snapshot. The merge is read-then-batch and its end state is the one the former
// sequential code produced.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/db";
import { expenses, invites, participants, serviceIdentities, userEmails, users } from "../src/db/schema";
import { mergeAccountsD1 } from "../src/lib/merge";
import { createUserWithEmail } from "../src/middleware/auth";
import {
  createServiceIdentity,
  createUser,
  deleteServiceIdentity,
  deleteUser,
  getUser,
  linkEmail,
  setPrimaryEmail,
  unlinkEmail,
  updateProfile,
  updateUser,
} from "../src/services/users";
import { addParticipant, addUserEmail, expectServiceError, seedExpense, seedTrip, seedUser, testDb } from "./helpers";
import { auditRows, toActor, type AuditRow } from "./helpers/audit";

const FAKE_HASH = "fake-password-hash-never-logged";

let admin: Awaited<ReturnType<typeof seedUser>>;
let adminActor: Actor;

beforeEach(async () => {
  admin = await seedUser("admin@example.test", "admin");
  adminActor = toActor(admin);
});

/** User snapshot as the allow-list stores it. */
const userSnapshot = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  avatarUrl: u.avatarUrl,
  googleId: u.googleId,
});

const emailSnapshot = (e: typeof userEmails.$inferSelect) => ({
  id: e.id,
  userId: e.userId,
  email: e.email,
  isPrimary: e.isPrimary,
});

const actorColumns = (a: Actor) => ({
  actorUserId: a.id,
  actorName: a.name,
  actorEmail: a.email,
  actorRole: a.role,
  channel: a.channel,
  clientId: a.clientId,
  requestId: a.requestId,
});

/** The single event recorded so far. */
async function onlyEvent(): Promise<AuditRow> {
  const rows = await auditRows();
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function userById(id: string) {
  const rows = await testDb().select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

async function emailsOf(userId: string) {
  return testDb().select().from(userEmails).where(eq(userEmails.userId, userId));
}

/** Seed a user whose row carries a password hash (the column exists; the app never sets it). */
async function seedUserWithHash(email: string, role: "admin" | "editor" | "viewer" = "viewer") {
  const u = await seedUser(email, role);
  await testDb().update(users).set({ passwordHash: FAKE_HASH }).where(eq(users.id, u.id));
  return (await userById(u.id))!;
}

/** Every JSON column of every event, serialized, for "secret never stored" checks. */
async function allJsonText(): Promise<string> {
  const rows = await auditRows();
  return rows.map((r) => JSON.stringify([r.before, r.after, r.changes, r.metadata])).join("\n");
}

describe("createUser (POST /admin/users)", () => {
  it("inserts the user and primary email and records user.create with tripId null", async () => {
    const created = await createUser(testDb(), adminActor, { email: "new@example.test", name: "New", role: "editor" });

    const stored = await userById(created.id);
    expect(stored).toMatchObject({ email: "new@example.test", name: "New", role: "editor", passwordHash: null });
    const emails = await emailsOf(created.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ email: "new@example.test", isPrimary: true });

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      ...actorColumns(adminActor),
      tripId: null,
      entityType: "user",
      entityId: created.id,
      entityLabel: "new@example.test",
      action: "create",
      before: null,
      changes: null,
      metadata: null,
    });
    expect(ev.after).toEqual(userSnapshot(stored!));
    expect(ev.after).not.toHaveProperty("passwordHash");
  });

  it("conflict on an email that is already linked, writing nothing", async () => {
    const other = await seedUser("other@example.test");
    await addUserEmail(other.id, "linked@example.test");
    await expectServiceError(
      createUser(testDb(), adminActor, { email: "linked@example.test", name: "X", role: "viewer" }),
      "conflict",
      "Email already exists"
    );
    expect(await auditRows()).toEqual([]);
    expect(await testDb().select().from(users)).toHaveLength(2);
  });
});

describe("updateUser (PUT /admin/users/:id)", () => {
  it("records user.update with before/after/changes", async () => {
    const target = await seedUser("target@example.test", "viewer", { name: "Target" });
    const updated = await updateUser(testDb(), adminActor, target.id, { role: "editor" });

    expect(updated.role).toBe("editor");
    expect(updated.name).toBe("Target");
    expect((await userById(target.id))!.role).toBe("editor");

    const ev = await onlyEvent();
    expect(ev).toMatchObject({ ...actorColumns(adminActor), tripId: null, entityType: "user", entityId: target.id, action: "update" });
    expect(ev.before).toEqual(userSnapshot(target));
    expect(ev.after).toEqual({ ...userSnapshot(target), role: "editor" });
    expect(ev.changes).toEqual({ role: { from: "viewer", to: "editor" } });
  });

  it("no-op update writes nothing, records nothing and returns the stored row", async () => {
    const target = await seedUser("target@example.test", "viewer", { name: "Target" });
    const result = await updateUser(testDb(), adminActor, target.id, { name: "Target", role: "viewer" });
    expect(result).toEqual(target);
    expect((await userById(target.id))!.updatedAt).toBe(target.updatedAt);
    expect(await auditRows()).toEqual([]);
  });

  it("empty patch is a no-op too", async () => {
    const target = await seedUser("target@example.test");
    expect(await updateUser(testDb(), adminActor, target.id, {})).toEqual(target);
    expect(await auditRows()).toEqual([]);
  });

  it("a partial patch that re-sends the same name with a role change records only the role", async () => {
    const target = await seedUser("target@example.test", "viewer", { name: "Target" });
    await updateUser(testDb(), adminActor, target.id, { name: "Target", role: "editor" });
    const ev = await onlyEvent();
    expect(ev.changes).toEqual({ role: { from: "viewer", to: "editor" } });
    expect(ev.entityLabel).toBe("target@example.test");
    for (const snap of [ev.before, ev.after]) {
      expect(Object.keys(snap as object).sort()).toEqual(["avatarUrl", "email", "googleId", "id", "name", "role"]);
    }
  });

  it("channel, clientId and requestId are copied from the Actor (service token admin)", async () => {
    const target = await seedUser("target@example.test");
    const svc = toActor(admin, { channel: "service_token", clientId: "svc-fake-cn", requestId: "ray-svc" });
    await updateUser(testDb(), svc, target.id, { name: "Renamed" });
    const ev = await onlyEvent();
    expect(ev).toMatchObject({ ...actorColumns(svc), tripId: null, entityType: "user", action: "update" });
  });

  it("not_found for an unknown user", async () => {
    await expectServiceError(updateUser(testDb(), adminActor, crypto.randomUUID(), { name: "X" }), "not_found", "User not found");
    expect(await auditRows()).toEqual([]);
  });
});

describe("deleteUser (DELETE /admin/users/:id)", () => {
  it("records user.delete with before and revokedGrants; cascaded children get no events", async () => {
    const target = await seedUserWithHash("target@example.test", "editor");
    await addUserEmail(target.id, "second@example.test");
    const { trip } = await seedTrip(target.id);
    await testDb().insert(serviceIdentities).values({
      id: crypto.randomUUID(),
      cfAccessSubject: "subject-fake",
      commonName: "svc-fake",
      userId: target.id,
      createdAt: new Date().toISOString(),
    });

    await deleteUser(testDb(), adminActor, target.id, { revokedGrants: 2 });

    expect(await userById(target.id)).toBeNull();
    expect(await emailsOf(target.id)).toEqual([]);
    expect(await testDb().select().from(serviceIdentities)).toEqual([]);
    // participants.userId has no FK to users: the row survives, as it always has.
    const leftover = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(leftover.map((p) => p.userId)).toEqual([target.id]);

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      ...actorColumns(adminActor),
      tripId: null,
      entityType: "user",
      entityId: target.id,
      entityLabel: "target@example.test",
      action: "delete",
      after: null,
      changes: null,
      metadata: { revokedGrants: 2 },
    });
    expect(ev.before).toEqual(userSnapshot(target));
    expect(ev.before).not.toHaveProperty("passwordHash");
  });

  it("not_found for an unknown user (getUser is the route's pre-revocation check)", async () => {
    await expectServiceError(getUser(testDb(), crypto.randomUUID()), "not_found", "User not found");
    await expectServiceError(deleteUser(testDb(), adminActor, crypto.randomUUID(), { revokedGrants: 0 }), "not_found", "User not found");
    expect(await auditRows()).toEqual([]);
  });
});

describe("updateProfile (PUT /me)", () => {
  it("records user.update on the actor's own row", async () => {
    const me = await seedUser("me@example.test", "viewer", { name: "Old" });
    const actor = toActor(me, { channel: "dev" });
    const updated = await updateProfile(testDb(), actor, { name: "New Name" });
    expect(updated.name).toBe("New Name");
    expect((await userById(me.id))!.name).toBe("New Name");

    const ev = await onlyEvent();
    expect(ev).toMatchObject({ ...actorColumns(actor), tripId: null, entityType: "user", entityId: me.id, action: "update" });
    expect(ev.changes).toEqual({ name: { from: "Old", to: "New Name" } });
  });

  it("same name: nothing written, nothing recorded", async () => {
    const me = await seedUser("me@example.test", "viewer", { name: "Same" });
    expect(await updateProfile(testDb(), toActor(me), { name: "Same" })).toEqual(me);
    expect(await auditRows()).toEqual([]);
  });
});

describe("linkEmail", () => {
  it("inserts a non-primary email and records user_email.link", async () => {
    const me = await seedUser("me@example.test");
    const row = await linkEmail(testDb(), toActor(me), me.id, "alt@example.test");
    expect(row.isPrimary).toBe(false);
    expect((await emailsOf(me.id)).map((e) => e.email).sort()).toEqual(["alt@example.test", "me@example.test"]);

    const ev = await onlyEvent();
    expect(ev).toMatchObject({ tripId: null, entityType: "user_email", entityId: row.id, entityLabel: "alt@example.test", action: "link", before: null });
    expect(ev.after).toEqual(emailSnapshot(row));
  });

  it("conflict when the address is already linked", async () => {
    const me = await seedUser("me@example.test");
    const other = await seedUser("other@example.test");
    await expectServiceError(linkEmail(testDb(), toActor(me), me.id, other.email), "conflict", "Email already exists");
    expect(await auditRows()).toEqual([]);
  });
});

describe("unlinkEmail (DELETE /me/emails/:id)", () => {
  it("deletes a secondary email and records user_email.unlink", async () => {
    const me = await seedUser("me@example.test");
    await addUserEmail(me.id, "alt@example.test");
    const alt = (await emailsOf(me.id)).find((e) => e.email === "alt@example.test")!;

    await unlinkEmail(testDb(), toActor(me), alt.id);
    expect((await emailsOf(me.id)).map((e) => e.email)).toEqual(["me@example.test"]);

    const ev = await onlyEvent();
    expect(ev).toMatchObject({ tripId: null, entityType: "user_email", entityId: alt.id, action: "unlink", after: null });
    expect(ev.before).toEqual(emailSnapshot(alt));
  });

  it("refuses the primary, the only email, and someone else's email, recording nothing", async () => {
    const me = await seedUser("me@example.test");
    const other = await seedUser("other@example.test");
    const [mine] = await emailsOf(me.id);
    const [theirs] = await emailsOf(other.id);

    await expectServiceError(unlinkEmail(testDb(), toActor(me), mine.id), "validation", "Cannot remove primary email");
    await expectServiceError(unlinkEmail(testDb(), toActor(me), theirs.id), "not_found", "Email not found");

    // Make a non-primary the only email to hit the "only email" guard.
    await testDb().update(userEmails).set({ isPrimary: false }).where(eq(userEmails.id, mine.id));
    await expectServiceError(unlinkEmail(testDb(), toActor(me), mine.id), "validation", "Cannot remove only email");

    expect(await auditRows()).toEqual([]);
  });
});

describe("setPrimaryEmail (PUT /me/emails/:id/primary)", () => {
  it("swaps primaries, updates users.email and records user_email.set_primary with previousPrimaryEmailId", async () => {
    const me = await seedUser("me@example.test");
    await addUserEmail(me.id, "alt@example.test");
    const before = await emailsOf(me.id);
    const prev = before.find((e) => e.isPrimary)!;
    const alt = before.find((e) => e.email === "alt@example.test")!;

    const after = await setPrimaryEmail(testDb(), toActor(me), alt.id);
    expect(after).toEqual({ ...alt, isPrimary: true });

    const now = await emailsOf(me.id);
    expect(now.find((e) => e.id === alt.id)!.isPrimary).toBe(true);
    expect(now.find((e) => e.id === prev.id)!.isPrimary).toBe(false);
    expect((await userById(me.id))!.email).toBe("alt@example.test");

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      tripId: null,
      entityType: "user_email",
      entityId: alt.id,
      entityLabel: "alt@example.test",
      action: "set_primary",
      metadata: { previousPrimaryEmailId: prev.id },
    });
    expect(ev.before).toEqual(emailSnapshot(alt));
    expect(ev.after).toEqual({ ...emailSnapshot(alt), isPrimary: true });
    expect(ev.changes).toEqual({ isPrimary: { from: false, to: true } });
  });

  it("already primary: no-op, nothing written, no event", async () => {
    const me = await seedUser("me@example.test");
    const [mine] = await emailsOf(me.id);
    const result = await setPrimaryEmail(testDb(), toActor(me), mine.id);
    expect(result).toEqual(mine);
    expect(await emailsOf(me.id)).toEqual([mine]);
    expect(await auditRows()).toEqual([]);
  });

  it("not_found for another user's email", async () => {
    const me = await seedUser("me@example.test");
    const other = await seedUser("other@example.test");
    const [theirs] = await emailsOf(other.id);
    await expectServiceError(setPrimaryEmail(testDb(), toActor(me), theirs.id), "not_found", "Email not found");
    expect(await auditRows()).toEqual([]);
  });
});

describe("service identities", () => {
  it("create records service_identity.create and returns the owner's display fields", async () => {
    const owner = await seedUser("owner@example.test", "editor", { name: "Owner" });
    const created = await createServiceIdentity(testDb(), adminActor, {
      cfAccessSubject: "subject-fake",
      commonName: "svc-fake",
      userId: owner.id,
    });
    expect(created).toMatchObject({ cfAccessSubject: "subject-fake", commonName: "svc-fake", userId: owner.id, userName: "Owner", userEmail: owner.email });

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      ...actorColumns(adminActor),
      tripId: null,
      entityType: "service_identity",
      entityId: created.id,
      entityLabel: "svc-fake",
      action: "create",
      before: null,
    });
    expect(ev.after).toEqual({ id: created.id, cfAccessSubject: "subject-fake", commonName: "svc-fake", userId: owner.id });
  });

  it("create: not_found for a missing user, conflict for a mapped subject", async () => {
    const owner = await seedUser("owner@example.test");
    await expectServiceError(
      createServiceIdentity(testDb(), adminActor, { cfAccessSubject: "s", commonName: "c", userId: crypto.randomUUID() }),
      "not_found",
      "User not found"
    );
    await createServiceIdentity(testDb(), adminActor, { cfAccessSubject: "s", commonName: "c", userId: owner.id });
    await expectServiceError(
      createServiceIdentity(testDb(), adminActor, { cfAccessSubject: "s", commonName: "c2", userId: owner.id }),
      "conflict",
      "Subject already mapped"
    );
    expect(await auditRows()).toHaveLength(1);
  });

  it("delete records service_identity.delete; not_found otherwise", async () => {
    const owner = await seedUser("owner@example.test");
    const created = await createServiceIdentity(testDb(), adminActor, { cfAccessSubject: "s", commonName: "c", userId: owner.id });
    await deleteServiceIdentity(testDb(), adminActor, created.id);
    expect(await testDb().select().from(serviceIdentities)).toEqual([]);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ entityType: "service_identity", entityId: created.id, action: "delete", after: null });
    expect(rows[1].before).toEqual({ id: created.id, cfAccessSubject: "s", commonName: "c", userId: owner.id });

    await expectServiceError(deleteServiceIdentity(testDb(), adminActor, created.id), "not_found", "Not found");
  });
});

describe("mergeAccountsD1", () => {
  it("shared trip with differing roles: keep row promoted, duplicate removed, expenses re-pointed; one user.merge event", async () => {
    const keep = await seedUser("keep@example.test", "viewer");
    const gone = await seedUser("gone@example.test", "viewer");
    const { trip } = await seedTrip(null);
    const kp = await addParticipant(trip.id, keep.id, "Viewer");
    const mp = await addParticipant(trip.id, gone.id, "Owner");
    const paidByGone = await seedExpense(trip.id, { payerId: mp.id, description: "Gone paid" });
    const paidByKeep = await seedExpense(trip.id, { payerId: kp.id, description: "Keep paid" });

    const result = await mergeAccountsD1(testDb(), adminActor, keep.id, gone.id);
    expect(result).toEqual({
      mergedUserId: gone.id,
      mergedEmail: "gone@example.test",
      movedEmails: 1,
      movedParticipants: 0,
      dedupedTrips: 1,
      promotedRole: null,
    });

    const parts = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: kp.id, userId: keep.id, role: "Owner" });
    const exp = await testDb().select().from(expenses).where(eq(expenses.tripId, trip.id));
    expect(exp.find((e) => e.id === paidByGone.id)!.payerId).toBe(kp.id);
    expect(exp.find((e) => e.id === paidByKeep.id)!.payerId).toBe(kp.id);
    expect(await userById(gone.id)).toBeNull();
    const emails = await emailsOf(keep.id);
    expect(emails.map((e) => [e.email, e.isPrimary]).sort()).toEqual([
      ["gone@example.test", false],
      ["keep@example.test", true],
    ]);

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      ...actorColumns(adminActor),
      tripId: null,
      entityType: "user",
      entityId: keep.id,
      entityLabel: "keep@example.test",
      action: "merge",
      changes: null,
      metadata: result,
    });
    expect(ev.before).toEqual(userSnapshot(keep));
    expect(ev.after).toEqual(userSnapshot(keep));
  });

  it("shared trip where the keep role is already higher: no role change", async () => {
    const keep = await seedUser("keep@example.test");
    const gone = await seedUser("gone@example.test");
    const { trip } = await seedTrip(null);
    const kp = await addParticipant(trip.id, keep.id, "Editor");
    await addParticipant(trip.id, gone.id, "Viewer");

    await mergeAccountsD1(testDb(), adminActor, keep.id, gone.id);
    const parts = await testDb().select().from(participants).where(eq(participants.tripId, trip.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: kp.id, role: "Editor" });
    expect(await auditRows()).toHaveLength(1);
  });

  it("unshared trips are transferred with the keep user's id and email; invites and service identities move", async () => {
    const keep = await seedUser("keep@example.test");
    const gone = await seedUser("gone@example.test");
    await addUserEmail(gone.id, "gone-alt@example.test");
    const { trip: t1 } = await seedTrip(null);
    const { trip: t2 } = await seedTrip(null);
    const p1 = await addParticipant(t1.id, gone.id, "Owner");
    const p2 = await addParticipant(t2.id, gone.id, "Editor");
    const now = new Date().toISOString();
    const inviteId = crypto.randomUUID();
    await testDb().insert(invites).values({
      id: inviteId,
      tripId: t1.id,
      name: "Guest",
      role: "Viewer",
      token: crypto.randomUUID(),
      status: "pending",
      invitedBy: gone.id,
      expiresAt: now,
      createdAt: now,
    });
    const identityId = crypto.randomUUID();
    await testDb().insert(serviceIdentities).values({
      id: identityId,
      cfAccessSubject: "subject-fake",
      commonName: "svc-fake",
      userId: gone.id,
      createdAt: now,
    });

    const result = await mergeAccountsD1(testDb(), adminActor, keep.id, gone.id);
    expect(result).toMatchObject({ movedEmails: 2, movedParticipants: 2, dedupedTrips: 0, promotedRole: null });

    const [r1] = await testDb().select().from(participants).where(eq(participants.id, p1.id));
    const [r2] = await testDb().select().from(participants).where(eq(participants.id, p2.id));
    expect(r1).toMatchObject({ userId: keep.id, email: keep.email, role: "Owner" });
    expect(r2).toMatchObject({ userId: keep.id, email: keep.email, role: "Editor" });
    const [inv] = await testDb().select().from(invites).where(eq(invites.id, inviteId));
    expect(inv.invitedBy).toBe(keep.id);
    const [ident] = await testDb().select().from(serviceIdentities).where(eq(serviceIdentities.id, identityId));
    expect(ident.userId).toBe(keep.id);
    expect((await emailsOf(keep.id)).map((e) => [e.email, e.isPrimary]).sort()).toEqual([
      ["gone-alt@example.test", false],
      ["gone@example.test", false],
      ["keep@example.test", true],
    ]);
    expect(await userById(gone.id)).toBeNull();
    expect(await auditRows()).toHaveLength(1);
  });

  it("role promotion on (default): keep user takes the higher global role; after reflects it", async () => {
    const keep = await seedUser("keep@example.test", "viewer");
    const gone = await seedUser("gone@example.test", "editor");

    const result = await mergeAccountsD1(testDb(), adminActor, keep.id, gone.id);
    expect(result!.promotedRole).toBe("editor");
    const stored = (await userById(keep.id))!;
    expect(stored.role).toBe("editor");
    expect(stored.updatedAt).not.toBe(keep.updatedAt);

    const ev = await onlyEvent();
    expect(ev.before).toEqual(userSnapshot(keep));
    expect(ev.after).toEqual({ ...userSnapshot(keep), role: "editor" });
    expect(ev.changes).toEqual({ role: { from: "viewer", to: "editor" } });
    expect(ev.metadata).toMatchObject({ promotedRole: "editor" });
  });

  it("role promotion off (self-service link): role untouched", async () => {
    const keep = await seedUser("keep@example.test", "viewer");
    const gone = await seedUser("gone@example.test", "admin");
    const goneActor = toActor(gone);

    const result = await mergeAccountsD1(testDb(), goneActor, keep.id, gone.id, { promoteRole: false });
    expect(result!.promotedRole).toBeNull();
    const stored = (await userById(keep.id))!;
    expect(stored.role).toBe("viewer");
    expect(stored.updatedAt).toBe(keep.updatedAt);

    const ev = await onlyEvent();
    // The merged-away user is the actor; its columns are denormalized so the row survives the delete.
    expect(ev).toMatchObject({ ...actorColumns(goneActor), entityId: keep.id, action: "merge", changes: null });
  });

  it("promotion is never a demotion", async () => {
    const keep = await seedUser("keep@example.test", "admin");
    const gone = await seedUser("gone@example.test", "viewer");
    const result = await mergeAccountsD1(testDb(), adminActor, keep.id, gone.id);
    expect(result!.promotedRole).toBeNull();
    expect((await userById(keep.id))!.role).toBe("admin");
  });

  it("self-merge is a no-op that records nothing", async () => {
    const keep = await seedUser("keep@example.test");
    expect(await mergeAccountsD1(testDb(), adminActor, keep.id, keep.id)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it("not_found for a missing keep or merge user, writing nothing", async () => {
    const keep = await seedUser("keep@example.test");
    const gone = await seedUser("gone@example.test");
    await expectServiceError(mergeAccountsD1(testDb(), adminActor, crypto.randomUUID(), gone.id), "not_found", "Keep user not found");
    await expectServiceError(mergeAccountsD1(testDb(), adminActor, keep.id, crypto.randomUUID()), "not_found", "Merge user not found");
    expect(await userById(gone.id)).not.toBeNull();
    expect(await auditRows()).toEqual([]);
  });
});

describe("passwordHash never reaches an audit row", () => {
  it("update, delete and merge on hashed users store no hash in any JSON column", async () => {
    const a = await seedUserWithHash("a@example.test", "viewer");
    const b = await seedUserWithHash("b@example.test", "editor");
    const c = await seedUserWithHash("c@example.test", "viewer");

    await updateUser(testDb(), adminActor, a.id, { name: "A2" });
    await updateProfile(testDb(), toActor(a), { name: "A3" });
    await mergeAccountsD1(testDb(), adminActor, a.id, b.id);
    await deleteUser(testDb(), adminActor, c.id, { revokedGrants: 0 });

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["update", "update", "merge", "delete"]);
    const text = await allJsonText();
    expect(text).not.toContain(FAKE_HASH);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("password_hash");
  });
});

describe("createUserWithEmail (middleware/auth.ts)", () => {
  it("records user.create with the new user as actor on the given channel", async () => {
    const created = await createUserWithEmail(testDb(), "first@example.test", "First", undefined, { channel: "dev", requestId: "ray-x" });
    // admin seeded in beforeEach, so this is not the bootstrap user
    expect(created.role).toBe("viewer");
    expect(await emailsOf(created.id)).toHaveLength(1);

    const ev = await onlyEvent();
    expect(ev).toMatchObject({
      actorUserId: created.id,
      actorName: "First",
      actorEmail: "first@example.test",
      actorRole: "viewer",
      channel: "dev",
      clientId: null,
      requestId: "ray-x",
      tripId: null,
      entityType: "user",
      entityId: created.id,
      action: "create",
      before: null,
    });
    expect(ev.after).toEqual({ id: created.id, email: "first@example.test", name: "First", role: "viewer", avatarUrl: null, googleId: null });
  });

  it("defaults to the web channel; bootstrap admin email becomes admin", async () => {
    const created = await createUserWithEmail(testDb(), "boot@example.test", "Boot", "boot@example.test");
    expect(created.role).toBe("admin");
    const ev = await onlyEvent();
    expect(ev).toMatchObject({ channel: "web", requestId: null, actorRole: "admin" });
  });
});

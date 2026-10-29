// services/participants.ts: listParticipants, createParticipant, updateParticipant, deleteParticipant.
// Called directly (no requireTripEditor middleware in front), plus a REST block that pins the
// status codes the thinned route returns through onError. Spec: specs/AUDIT_TDD.md 7.1, 7.2, 12.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as DbActor } from "../src/db";
import { participants } from "../src/db/schema";
import { SNAPSHOT_COLUMNS } from "../src/services/audit";
import {
  createParticipant,
  deleteParticipant,
  listParticipants,
  updateParticipant,
  type CreateParticipant,
} from "../src/services/participants";
import {
  IDS,
  addParticipant,
  dbState,
  expectServiceError,
  read,
  seedRoleWorld,
  testDb,
  toAuth,
  type Actor as Role,
  type RoleWorld,
} from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

let w: RoleWorld;
const actor = (a: Role): DbActor => toActor(w.users[a]);

const input: CreateParticipant = { name: "New Traveler", email: "new@example.test", role: "Editor", traveling: true };

const participantEvents = async () => (await auditRows()).filter((r) => r.entityType === "participant");

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

beforeEach(async () => {
  w = await seedRoleWorld();
});

describe("listParticipants", () => {
  it("every member role and admin get the same full rows", async () => {
    const expected = byId(await testDb().select().from(participants).where(eq(participants.tripId, IDS.trip)));
    expect(expected).toHaveLength(4);
    for (const a of ["owner", "editor", "viewer", "admin"] as const) {
      expect(byId(await listParticipants(testDb(), toAuth(w.users[a]), IDS.trip)), a).toEqual(expected);
    }
  });

  it("non-member is not_found; admin on a missing trip gets []", async () => {
    await expectServiceError(listParticipants(testDb(), toAuth(w.users.outsider), IDS.trip), "not_found", "Trip not found");
    expect(await listParticipants(testDb(), toAuth(w.users.admin), IDS.missing)).toEqual([]);
  });

  it("reads record no events", async () => {
    await listParticipants(testDb(), toAuth(w.users.owner), IDS.trip);
    expect(await auditRows()).toEqual([]);
  });
});

describe("role matrix", () => {
  it("Owner and admin may write; Editor and Viewer are forbidden; non-member is not_found; nothing is written", async () => {
    const before = await dbState();
    for (const a of ["editor", "viewer"] as const) {
      await expectServiceError(createParticipant(testDb(), actor(a), IDS.trip, input), "forbidden", "Forbidden");
      await expectServiceError(updateParticipant(testDb(), actor(a), IDS.trip, IDS.guestP, { role: "Editor" }), "forbidden", "Forbidden");
      await expectServiceError(deleteParticipant(testDb(), actor(a), IDS.trip, IDS.guestP), "forbidden", "Forbidden");
    }
    await expectServiceError(createParticipant(testDb(), actor("outsider"), IDS.trip, input), "not_found", "Trip not found");
    await expectServiceError(updateParticipant(testDb(), actor("outsider"), IDS.trip, IDS.guestP, { role: "Editor" }), "not_found", "Trip not found");
    await expectServiceError(deleteParticipant(testDb(), actor("outsider"), IDS.trip, IDS.guestP), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);

    for (const a of ["owner", "admin"] as const) {
      const created = await createParticipant(testDb(), actor(a), IDS.trip, { ...input, name: `By ${a}` });
      expect(created.name).toBe(`By ${a}`);
      expect((await updateParticipant(testDb(), actor(a), IDS.trip, created.id, { role: "Viewer" })).role).toBe("Viewer");
      await deleteParticipant(testDb(), actor(a), IDS.trip, created.id);
    }
    expect(await dbState()).toEqual(before);
  });

  it("admin on a missing trip: create is Trip not found, update/delete are Participant not found", async () => {
    await expectServiceError(createParticipant(testDb(), actor("admin"), IDS.missing, input), "not_found", "Trip not found");
    await expectServiceError(updateParticipant(testDb(), actor("admin"), IDS.missing, IDS.guestP, { name: "X" }), "not_found", "Participant not found");
    await expectServiceError(deleteParticipant(testDb(), actor("admin"), IDS.missing, IDS.guestP), "not_found", "Participant not found");
    expect(await auditRows()).toEqual([]);
  });

  it("a participant on another trip is Participant not found (scoped by tripId)", async () => {
    await expectServiceError(updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.outsiderP, { name: "X" }), "not_found", "Participant not found");
    await expectServiceError(deleteParticipant(testDb(), actor("owner"), IDS.trip, IDS.outsiderP), "not_found", "Participant not found");
    expect(await testDb().select().from(participants).where(eq(participants.id, IDS.outsiderP))).toHaveLength(1);
  });
});

describe("createParticipant", () => {
  it("inserts the row and records one participant.create with the allow-listed after snapshot", async () => {
    const row = await createParticipant(testDb(), actor("owner"), IDS.trip, input);
    expect(row).toMatchObject({ tripId: IDS.trip, userId: null, email: "new@example.test", name: "New Traveler", role: "Editor", traveling: true });
    expect(row.createdAt).toBe(row.updatedAt);
    const [stored] = await testDb().select().from(participants).where(eq(participants.id, row.id));
    expect(stored).toEqual(row);

    const events = await participantEvents();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      action: "create",
      entityType: "participant",
      entityId: row.id,
      tripId: IDS.trip,
      entityLabel: "New Traveler",
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
      userId: null,
      email: "new@example.test",
      name: "New Traveler",
      role: "Editor",
      traveling: true,
    });
    expect(Object.keys(e.after as object).sort()).toEqual([...SNAPSHOT_COLUMNS.participant].sort());
  });

  it("defaults: userId/email null, traveling false", async () => {
    const row = await createParticipant(testDb(), actor("admin"), IDS.trip, { name: "Minimal", role: "Viewer" });
    expect(row).toMatchObject({ userId: null, email: null, traveling: false, role: "Viewer" });
    const [e] = await participantEvents();
    expect(e.after).toMatchObject({ userId: null, email: null, traveling: false });
    expect(e.actorUserId).toBe(IDS.admin);
  });

  it("is atomic: a failing insert leaves no event behind", async () => {
    const before = await dbState();
    // participants.name is NOT NULL; the data statement fails and the batch rolls back the event.
    const err = await createParticipant(testDb(), actor("owner"), IDS.trip, { ...input, name: null as unknown as string }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });
});

describe("updateParticipant", () => {
  it("role change records one participant.update with before/after and changes", async () => {
    const [before] = await testDb().select().from(participants).where(eq(participants.id, IDS.editorP));
    const updated = await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.editorP, { role: "Owner" });
    expect(updated).toMatchObject({ id: IDS.editorP, role: "Owner", name: "Editor User" });
    expect(updated.updatedAt >= before.updatedAt).toBe(true);
    const [stored] = await testDb().select().from(participants).where(eq(participants.id, IDS.editorP));
    expect(stored).toEqual(updated);

    const events = await participantEvents();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ action: "update", entityId: IDS.editorP, tripId: IDS.trip, entityLabel: "Editor User", actorUserId: IDS.owner });
    expect(e.before).toEqual({ id: IDS.editorP, tripId: IDS.trip, userId: IDS.editor, email: "editor@example.test", name: "Editor User", role: "Editor", traveling: true });
    expect(e.after).toEqual({ ...(e.before as object), role: "Owner" });
    expect(e.changes).toEqual({ role: { from: "Editor", to: "Owner" } });
  });

  it("multi-field patch lists every changed path and nothing else", async () => {
    await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.guestP, { name: "Renamed Guest", traveling: false, email: "guest@example.test" });
    const [e] = await participantEvents();
    expect(e.changes).toEqual({
      name: { from: "Guest Traveler", to: "Renamed Guest" },
      traveling: { from: true, to: false },
      email: { from: null, to: "guest@example.test" },
    });
  });

  it("no-op patch (same values) writes nothing: no event, updatedAt untouched, stored row returned", async () => {
    const before = await dbState();
    const [stored] = await testDb().select().from(participants).where(eq(participants.id, IDS.viewerP));
    const res = await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.viewerP, { role: "Viewer", name: "Viewer User", traveling: false });
    expect(res).toEqual(stored);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("empty patch writes nothing", async () => {
    const before = await dbState();
    const [stored] = await testDb().select().from(participants).where(eq(participants.id, IDS.viewerP));
    expect(await updateParticipant(testDb(), actor("admin"), IDS.trip, IDS.viewerP, {})).toEqual(stored);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("each real update is exactly one event", async () => {
    await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.guestP, { role: "Editor" });
    await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.guestP, { role: "Editor" }); // no-op
    await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.guestP, { role: "Viewer" });
    const events = await participantEvents();
    expect(events.map((e) => e.changes)).toEqual([
      { role: { from: "Viewer", to: "Editor" } },
      { role: { from: "Editor", to: "Viewer" } },
    ]);
  });
});

describe("deleteParticipant", () => {
  it("deletes the row and records one participant.delete with the row as before", async () => {
    await deleteParticipant(testDb(), actor("owner"), IDS.trip, IDS.viewerP);
    expect(await testDb().select().from(participants).where(eq(participants.id, IDS.viewerP))).toEqual([]);

    const events = await participantEvents();
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ action: "delete", entityId: IDS.viewerP, tripId: IDS.trip, entityLabel: "Viewer User", actorUserId: IDS.owner, after: null, changes: null });
    expect(e.before).toEqual({ id: IDS.viewerP, tripId: IDS.trip, userId: IDS.viewer, email: "viewer@example.test", name: "Viewer User", role: "Viewer", traveling: false });
    expect(Object.keys(e.before as object)).not.toContain("createdAt");
  });

  it("an Owner may remove themselves; the event still carries them as actor", async () => {
    await deleteParticipant(testDb(), actor("owner"), IDS.trip, IDS.ownerP);
    const [e] = await participantEvents();
    expect(e).toMatchObject({ action: "delete", entityId: IDS.ownerP, actorUserId: IDS.owner });
    // Now a non-member.
    await expectServiceError(deleteParticipant(testDb(), actor("owner"), IDS.trip, IDS.guestP), "not_found", "Trip not found");
  });
});

describe("actor copy (gap audit, PRD 6.2)", () => {
  it("channel, clientId and requestId are copied from the Actor, not defaulted (MCP OAuth caller)", async () => {
    const mcp = toActor(w.users.owner, { channel: "mcp_oauth", clientId: "client-fake", requestId: "ray-mcp" });
    await updateParticipant(testDb(), mcp, IDS.trip, IDS.guestP, { role: "Editor" });
    const [e] = await participantEvents();
    expect(e).toMatchObject({
      actorUserId: IDS.owner,
      actorName: "Owner User",
      actorEmail: "owner@example.test",
      actorRole: "editor",
      channel: "mcp_oauth",
      clientId: "client-fake",
      requestId: "ray-mcp",
      tripId: IDS.trip,
    });
  });

  it("a partial patch that re-sends identical values alongside one change records only that change", async () => {
    await updateParticipant(testDb(), actor("owner"), IDS.trip, IDS.editorP, { name: "Editor User", traveling: true, role: "Viewer" });
    const events = await participantEvents();
    expect(events).toHaveLength(1);
    expect(events[0].changes).toEqual({ role: { from: "Editor", to: "Viewer" } });
  });
});

describe("REST status codes through the thinned route", () => {
  const base = `/api/trips/${IDS.trip}/participants`;

  it("GET: members and admin 200 with every row; non-member 404 Trip not found", async () => {
    for (const a of ["owner", "editor", "viewer", "admin"] as const) {
      const r = await read(await w.as[a].get(base));
      expect(r.status, a).toBe(200);
      expect(r.body.map((p: { id: string }) => p.id).sort()).toEqual([IDS.ownerP, IDS.editorP, IDS.viewerP, IDS.guestP].sort());
    }
    expect(await read(await w.as.outsider.get(base))).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("writes: Editor/Viewer/non-member 403 Forbidden (non-member from requireTripEditor), Owner/admin succeed", async () => {
    for (const a of ["editor", "viewer", "outsider"] as const) {
      expect(await read(await w.as[a].post(base, input)), `${a} POST`).toEqual({ status: 403, body: { error: "Forbidden" } });
      expect(await read(await w.as[a].put(`${base}/${IDS.guestP}`, { role: "Editor" })), `${a} PUT`).toEqual({ status: 403, body: { error: "Forbidden" } });
      expect(await read(await w.as[a].delete(`${base}/${IDS.guestP}`)), `${a} DELETE`).toEqual({ status: 403, body: { error: "Forbidden" } });
    }
    expect(await auditRows()).toEqual([]);

    const created = await read(await w.as.owner.post(base, input));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ tripId: IDS.trip, name: "New Traveler", role: "Editor" });
    const put = await read(await w.as.admin.put(`${base}/${created.body.id}`, { role: "Viewer" }));
    expect(put.status).toBe(200);
    expect(put.body.role).toBe("Viewer");
    expect((await w.as.owner.delete(`${base}/${created.body.id}`)).status).toBe(204);

    const events = await participantEvents();
    expect(events.map((e) => [e.action, e.actorUserId, e.channel])).toEqual([
      ["create", IDS.owner, "dev"],
      ["update", IDS.admin, "dev"],
      ["delete", IDS.owner, "dev"],
    ]);
  });

  it("404s: POST on a missing trip (admin) is Trip not found; PUT/DELETE on a missing participant is Participant not found", async () => {
    expect(await read(await w.as.admin.post(`/api/trips/${IDS.missing}/participants`, input))).toEqual({ status: 404, body: { error: "Trip not found" } });
    expect(await read(await w.as.owner.put(`${base}/${IDS.missing}`, { role: "Editor" }))).toEqual({ status: 404, body: { error: "Participant not found" } });
    expect(await read(await w.as.owner.delete(`${base}/${IDS.missing}`))).toEqual({ status: 404, body: { error: "Participant not found" } });
    expect(await read(await w.as.owner.delete(`${base}/${IDS.outsiderP}`))).toEqual({ status: 404, body: { error: "Participant not found" } });
  });

  it("no-op PUT returns 200 with the stored row and does not bump updatedAt", async () => {
    const [stored] = await testDb().select().from(participants).where(eq(participants.id, IDS.viewerP));
    const r = await read(await w.as.owner.put(`${base}/${IDS.viewerP}`, { role: "Viewer" }));
    expect(r).toEqual({ status: 200, body: stored });
    expect(await auditRows()).toEqual([]);
  });

  it("extra guest rows seeded later are listed too", async () => {
    const extra = await addParticipant(IDS.trip, null, "Viewer", { name: "Late Guest" });
    const r = await read(await w.as.viewer.get(base));
    expect(r.body.map((p: { id: string }) => p.id)).toContain(extra.id);
  });
});

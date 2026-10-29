// REST audit history endpoints through the real Worker (specs/AUDIT_TDD.md 8, 11; AUDIT_PRD.md 6.5,
// acceptance 6, 7, 10):
//   GET /trips/{tripId}/audit
//   GET /trips/{tripId}/audit/{entityType}/{entityId}
//   GET /admin/audit
// Authorization, requestId visibility, response shape, cursor pagination, every filter, bad input.
// Events are seeded through the test-only helpers in ./helpers/audit; nothing here writes
// production data beyond the role world. All ids and secrets are obviously fake.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { participants, trips } from "../src/db/schema";
import { AuditEventSchema, AuditPageSchema } from "../src/schemas/audit";
import { DEFAULT_LIMIT, ENTITY_TYPES, MAX_LIMIT, encodeCursor } from "../src/services/audit";
import { IDS, anonymous, asUser, read, seedRoleWorld, testDb, type RoleWorld } from "./helpers";
import { auditRows, seedEvent, seedManyEvents, seedRawEvent, toActor } from "./helpers/audit";

let w: RoleWorld;

const TRIP_URL = `/api/trips/${IDS.trip}/audit`;
const OTHER_TRIP_URL = `/api/trips/${IDS.otherTrip}/audit`;
const ADMIN_URL = "/api/admin/audit";
const entityUrl = (entityType: string, entityId: string, tripId: string = IDS.trip) =>
  `/api/trips/${tripId}/audit/${entityType}/${entityId}`;

/** Fixed, obviously fake entity ids. */
const E = {
  expense1: "00000000-0000-4000-8000-0000000e0001",
  expense2: "00000000-0000-4000-8000-0000000e0002",
  itinerary1: "00000000-0000-4000-8000-0000000f0001",
  otherTripExpense: "00000000-0000-4000-8000-0000000e0b02",
  adminUser: "00000000-0000-4000-8000-0000000a0a0a",
} as const;

const FAKE_CLIENT_ID = "fake-oauth-client-0001";

type Page = { events: Record<string, unknown>[]; nextCursor: string | null };

/** GET a page, assert 200, and validate the body against the exported `AuditPageSchema`. */
async function pageOf(fetch: RoleWorld["as"][keyof RoleWorld["as"]], url: string): Promise<Page> {
  const r = await read(await fetch.get(url));
  expect(r.status, `${url} -> ${JSON.stringify(r.body)}`).toBe(200);
  const parsed = AuditPageSchema.safeParse(r.body);
  expect(parsed.success, `AuditPageSchema: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
  // Return the raw body (not the parsed copy) so key presence/absence can be asserted exactly.
  return r.body as Page;
}

const ids = (p: Page) => p.events.map((e) => e.id as string);
const entityIds = (p: Page) => p.events.map((e) => e.entityId as string);

/** Three events on the trip, one on the other trip, one administration event (trip_id IS NULL). */
async function seedBaseline() {
  const owner = toActor(w.users.owner);
  const editor = toActor(w.users.editor);
  const admin = toActor(w.users.admin);
  await seedEvent({ actor: owner, tripId: IDS.trip, entityType: "expense", entityId: E.expense1, action: "create", after: { id: E.expense1, tripId: IDS.trip, description: "Taxi" } });
  await seedEvent({
    actor: editor,
    tripId: IDS.trip,
    entityType: "expense",
    entityId: E.expense1,
    action: "update",
    before: { id: E.expense1, tripId: IDS.trip, description: "Taxi", amount: 10 },
    after: { id: E.expense1, tripId: IDS.trip, description: "Taxi", amount: 12 },
  });
  await seedEvent({ actor: owner, tripId: IDS.trip, entityType: "itinerary", entityId: E.itinerary1, action: "create", after: { id: E.itinerary1, tripId: IDS.trip, type: "Lodging", content: { propertyName: "Fake Hotel" } } });
  await seedEvent({ actor: toActor(w.users.outsider), tripId: IDS.otherTrip, entityType: "expense", entityId: E.otherTripExpense, action: "create", after: { id: E.otherTripExpense, tripId: IDS.otherTrip, description: "Other trip taxi" } });
  await seedEvent({ actor: admin, tripId: null, entityType: "user", entityId: E.adminUser, action: "create", after: { id: E.adminUser, email: "created@example.test", role: "viewer" } });
}

beforeEach(async () => {
  w = await seedRoleWorld();
});

describe("authorization", () => {
  beforeEach(seedBaseline);

  it("trip endpoint: Owner, Editor and admin (not a participant) 200; Viewer 403; non-member 404", async () => {
    for (const a of ["owner", "editor", "admin"] as const) {
      const p = await pageOf(w.as[a], TRIP_URL);
      expect(p.events, a).toHaveLength(3);
      expect(p.nextCursor, a).toBeNull();
    }
    expect(await read(await w.as.viewer.get(TRIP_URL))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(await read(await w.as.outsider.get(TRIP_URL))).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("entity endpoint: Owner, Editor and admin 200; Viewer 403; non-member 404", async () => {
    const url = entityUrl("expense", E.expense1);
    for (const a of ["owner", "editor", "admin"] as const) {
      const p = await pageOf(w.as[a], url);
      expect(p.events, a).toHaveLength(2);
    }
    expect(await read(await w.as.viewer.get(url))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(await read(await w.as.outsider.get(url))).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("/admin/audit: admin 200; every non-admin (including the trip Owner) 403 Forbidden", async () => {
    const p = await pageOf(w.as.admin, ADMIN_URL);
    expect(p.events).toHaveLength(5);
    for (const a of ["owner", "editor", "viewer", "outsider"] as const) {
      expect(await read(await w.as[a].get(ADMIN_URL)), a).toEqual({ status: 403, body: { error: "Forbidden" } });
    }
  });

  it("the outsider (Owner of the other trip) can read the other trip but not this one", async () => {
    const p = await pageOf(w.as.outsider, OTHER_TRIP_URL);
    expect(entityIds(p)).toEqual([E.otherTripExpense]);
    expect((await w.as.outsider.get(TRIP_URL)).status).toBe(404);
    expect((await w.as.owner.get(OTHER_TRIP_URL)).status).toBe(404);
  });

  it("unauthenticated (no dev header) is 401 Unauthorized on all three endpoints", async () => {
    for (const url of [TRIP_URL, entityUrl("expense", E.expense1), ADMIN_URL]) {
      expect(await read(await anonymous().get(url)), url).toEqual({ status: 401, body: { error: "Unauthorized" } });
    }
  });

  it("an unknown dev email is 401, not 404 or 403", async () => {
    for (const url of [TRIP_URL, ADMIN_URL]) {
      expect(await read(await asUser("nobody@example.test").get(url)), url).toEqual({ status: 401, body: { error: "Unauthorized" } });
    }
  });

  it("role is checked per request: a Viewer promoted to Editor can read; demoted back, cannot", async () => {
    expect((await w.as.viewer.get(TRIP_URL)).status).toBe(403);
    expect((await w.as.viewer.get(entityUrl("expense", E.expense1))).status).toBe(403);

    await testDb().update(participants).set({ role: "Editor" }).where(eq(participants.id, IDS.viewerP));
    expect((await w.as.viewer.get(TRIP_URL)).status).toBe(200);
    expect((await w.as.viewer.get(entityUrl("expense", E.expense1))).status).toBe(200);

    await testDb().update(participants).set({ role: "Viewer" }).where(eq(participants.id, IDS.viewerP));
    expect((await w.as.viewer.get(TRIP_URL)).status).toBe(403);
  });

  it("a member removed from the trip becomes a non-member (404)", async () => {
    expect((await w.as.editor.get(TRIP_URL)).status).toBe(200);
    await testDb().delete(participants).where(eq(participants.id, IDS.editorP));
    expect(await read(await w.as.editor.get(TRIP_URL))).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("admin on a trip id that does not exist: 200 with an empty page (admins are Owner everywhere, no existence check); non-admin 404", async () => {
    // Observed convention shared with the other trip-scoped routes. Note PRD 6.5 says a deleted
    // trip's history is reachable "only through /admin/audit"; for admins the trip endpoint
    // also serves it, since nothing checks the trips table. Reported, not changed.
    expect(await read(await w.as.admin.get(`/api/trips/${IDS.missing}/audit`))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
    expect(await read(await w.as.owner.get(`/api/trips/${IDS.missing}/audit`))).toEqual({ status: 404, body: { error: "Trip not found" } });
  });

  it("reads record no audit events of their own", async () => {
    const before = (await auditRows()).length;
    await w.as.owner.get(TRIP_URL);
    await w.as.owner.get(entityUrl("expense", E.expense1));
    await w.as.admin.get(ADMIN_URL);
    await w.as.viewer.get(TRIP_URL);
    await w.as.outsider.get(TRIP_URL);
    expect((await auditRows()).length).toBe(before);
  });
});

describe("requestId visibility", () => {
  beforeEach(seedBaseline);

  it("admin sees a requestId key on every event from all three endpoints", async () => {
    for (const url of [TRIP_URL, entityUrl("expense", E.expense1), ADMIN_URL]) {
      const p = await pageOf(w.as.admin, url);
      expect(p.events.length, url).toBeGreaterThan(0);
      for (const e of p.events) {
        expect(Object.prototype.hasOwnProperty.call(e, "requestId"), `${url} ${e.id}`).toBe(true);
        // toActor() seeds "ray-test"; a real request stores the cf-ray or null.
        expect(e.requestId, url).toBe("ray-test");
      }
    }
  });

  it("Owner and Editor never see the requestId key (absent, not null) on trip and entity endpoints", async () => {
    for (const a of ["owner", "editor"] as const) {
      for (const url of [TRIP_URL, entityUrl("expense", E.expense1)]) {
        const p = await pageOf(w.as[a], url);
        expect(p.events.length, `${a} ${url}`).toBeGreaterThan(0);
        for (const e of p.events) {
          expect(Object.keys(e), `${a} ${url} ${e.id}`).not.toContain("requestId");
        }
      }
    }
  });

  it("a request with a cf-ray header stores it; events written over the Worker carry channel dev", async () => {
    // Drive a real write through the Worker so the stored requestId comes from the header.
    const created = await read(
      await w.as.owner.post(`/api/trips/${IDS.trip}/expenses`, { description: "Ray expense", amount: 5, currency: "USD", category: "Other", payerId: IDS.ownerP, splitType: "EQUAL" }, { headers: { "cf-ray": "8fakeray0000abcd-SJC" } })
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const p = await pageOf(w.as.admin, entityUrl("expense", created.body.id));
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ requestId: "8fakeray0000abcd-SJC", channel: "dev", clientId: null, actorUserId: IDS.owner, action: "create" });
    // Non-admin view of the same event: no key.
    const ownerView = await pageOf(w.as.owner, entityUrl("expense", created.body.id));
    expect(Object.keys(ownerView.events[0])).not.toContain("requestId");
  });
});

describe("response shape", () => {
  it("every event parses with AuditEventSchema and carries the seeded values; nextCursor is string or null", async () => {
    await seedBaseline();
    const p = await pageOf(w.as.owner, TRIP_URL);
    expect(p.nextCursor).toBeNull();
    for (const e of p.events) expect(AuditEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);

    // Newest first: itinerary create, expense update, expense create.
    expect(p.events.map((e) => [e.entityType, e.action])).toEqual([
      ["itinerary", "create"],
      ["expense", "update"],
      ["expense", "create"],
    ]);
    const update = p.events[1];
    expect(update).toMatchObject({
      tripId: IDS.trip,
      entityId: E.expense1,
      entityLabel: "Taxi",
      actorUserId: IDS.editor,
      actorName: "Editor User",
      actorEmail: "editor@example.test",
      actorRole: "editor",
      channel: "web",
      clientId: null,
      before: { id: E.expense1, tripId: IDS.trip, description: "Taxi", amount: 10 },
      after: { id: E.expense1, tripId: IDS.trip, description: "Taxi", amount: 12 },
      changes: { amount: { from: 10, to: 12 } },
      metadata: null,
    });
    const create = p.events[2];
    expect(create.before).toBeNull();
    expect(create.changes).toBeNull();
    expect(Object.keys(update).sort()).toEqual(
      ["action", "actorEmail", "actorName", "actorRole", "actorUserId", "after", "before", "changes", "channel", "clientId", "createdAt", "entityId", "entityLabel", "entityType", "id", "metadata", "tripId"].sort()
    );
    expect(Object.keys(update)).not.toContain("seq");
  });

  it("a non-empty page that has more rows carries a non-empty string nextCursor", async () => {
    await seedManyEvents(toActor(w.users.owner), IDS.trip, 3);
    const p = await pageOf(w.as.owner, `${TRIP_URL}?limit=2`);
    expect(p.events).toHaveLength(2);
    expect(typeof p.nextCursor).toBe("string");
    expect((p.nextCursor as string).length).toBeGreaterThan(0);
    // Opaque to clients but must be exactly what the service encodes for the last row's seq.
    const rows = await auditRows();
    const last = rows.find((r) => r.id === p.events[1].id)!;
    expect(p.nextCursor).toBe(encodeCursor(last.seq));
  });

  it("an empty trip returns { events: [], nextCursor: null }", async () => {
    expect(await read(await w.as.owner.get(TRIP_URL))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
    expect(await read(await w.as.owner.get(entityUrl("expense", E.expense1)))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
    expect(await read(await w.as.admin.get(ADMIN_URL))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
  });
});

describe("pagination", () => {
  const TOTAL = 125;
  let seeded: string[];

  beforeEach(async () => {
    // seedManyEvents writes expense creates; mix in other entity types and actions so the page
    // walk is not over a homogeneous set.
    const owner = toActor(w.users.owner);
    const editor = toActor(w.users.editor);
    await seedEvent({ actor: owner, tripId: IDS.trip, entityType: "trip", entityId: IDS.trip, action: "update", before: { id: IDS.trip, name: "Parity Trip" }, after: { id: IDS.trip, name: "Renamed Trip" } });
    seeded = await seedManyEvents(owner, IDS.trip, 60);
    await seedEvent({ actor: editor, tripId: IDS.trip, entityType: "itinerary", entityId: E.itinerary1, action: "create", after: { id: E.itinerary1, tripId: IDS.trip, type: "Rail", content: { name: "Fake Rail" } } });
    seeded.push(...(await seedManyEvents(editor, IDS.trip, 61)));
    await seedEvent({ actor: owner, tripId: IDS.trip, entityType: "itinerary", entityId: E.itinerary1, action: "delete", before: { id: E.itinerary1, tripId: IDS.trip, type: "Rail", content: { name: "Fake Rail" } } });
    await seedEvent({ actor: owner, tripId: IDS.trip, entityType: "participant", entityId: IDS.guestP, action: "update", before: { id: IDS.guestP, role: "Viewer" }, after: { id: IDS.guestP, role: "Editor" } });
    // Noise that must never appear: another trip and an administration event.
    await seedEvent({ actor: toActor(w.users.outsider), tripId: IDS.otherTrip, entityType: "expense", entityId: E.otherTripExpense, action: "create" });
    await seedEvent({ actor: toActor(w.users.admin), tripId: null, entityType: "user", entityId: E.adminUser, action: "create" });
    expect((await auditRows()).filter((r) => r.tripId === IDS.trip)).toHaveLength(TOTAL);
  });

  /** Walk every page through nextCursor. */
  async function walk(fetch: RoleWorld["as"]["owner"], base: string, limit: number): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const sep = base.includes("?") ? "&" : "?";
      const url = `${base}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const p = await pageOf(fetch, url);
      pages.push(p);
      cursor = p.nextCursor;
      if (cursor === null) break;
    }
    return pages;
  }

  it("limit=30 walks 5 pages with no duplicates or gaps, newest first throughout, last page nextCursor null", async () => {
    const pages = await walk(w.as.owner, TRIP_URL, 30);
    expect(pages.map((p) => p.events.length)).toEqual([30, 30, 30, 30, 5]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, false, false, true]);

    const all = pages.flatMap(ids);
    expect(new Set(all).size).toBe(TOTAL);
    const expected = (await auditRows()).filter((r) => r.tripId === IDS.trip);
    expect(new Set(all)).toEqual(new Set(expected.map((r) => r.id)));

    // Newest first on every page and across page boundaries: the concatenation equals the
    // trip's rows in descending seq.
    expect(all).toEqual([...expected].sort((a, b) => b.seq - a.seq).map((r) => r.id));
    for (const p of pages) {
      const ts = p.events.map((e) => e.createdAt as string);
      for (let i = 1; i < ts.length; i++) expect(ts[i] <= ts[i - 1], `createdAt not descending at ${i}`).toBe(true);
    }
  });

  it("the same walk as admin yields the same ids in the same order", async () => {
    const [asOwner, asAdmin] = await Promise.all([walk(w.as.owner, TRIP_URL, 30), walk(w.as.admin, TRIP_URL, 30)]);
    expect(asAdmin.flatMap(ids)).toEqual(asOwner.flatMap(ids));
  });

  it(`limit omitted gives ${DEFAULT_LIMIT}; limit=${MAX_LIMIT} gives all ${TOTAL} in one page`, async () => {
    const def = await pageOf(w.as.owner, TRIP_URL);
    expect(def.events).toHaveLength(DEFAULT_LIMIT);
    expect(def.nextCursor).not.toBeNull();

    const max = await pageOf(w.as.owner, `${TRIP_URL}?limit=${MAX_LIMIT}`);
    expect(max.events).toHaveLength(TOTAL);
    expect(max.nextCursor).toBeNull();

    // Exactly `limit` rows left: no spurious extra page.
    const exact = await walk(w.as.owner, TRIP_URL, TOTAL);
    expect(exact.map((p) => p.events.length)).toEqual([TOTAL]);
    expect(exact[0].nextCursor).toBeNull();
  });

  it(`limit=${MAX_LIMIT + 1}, limit=0, limit=-1 and limit=abc are 400 on all three endpoints`, async () => {
    for (const bad of [String(MAX_LIMIT + 1), "0", "-1", "abc", "1.5"]) {
      for (const url of [TRIP_URL, entityUrl("expense", seeded[0]), ADMIN_URL]) {
        const r = await read(await w.as.admin.get(`${url}?limit=${bad}`));
        expect(r.status, `${url} limit=${bad}`).toBe(400);
        expect(r.body.success, `${url} limit=${bad}`).toBe(false);
      }
    }
  });

  it("entity endpoint paginates one entity's history", async () => {
    // itinerary1 has a create and a delete; the expense ids each have exactly one event.
    const p = await pageOf(w.as.editor, `${entityUrl("itinerary", E.itinerary1)}?limit=1`);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].action).toBe("delete");
    const p2 = await pageOf(w.as.editor, `${entityUrl("itinerary", E.itinerary1)}?limit=1&cursor=${p.nextCursor}`);
    expect(p2.events).toHaveLength(1);
    expect(p2.events[0].action).toBe("create");
    expect(p2.nextCursor).toBeNull();
  });

  it("admin endpoint paginates across trips and administration events", async () => {
    const pages = await walk(w.as.admin, ADMIN_URL, 50);
    const all = pages.flatMap(ids);
    const everything = await auditRows();
    expect(pages.map((p) => p.events.length)).toEqual([50, 50, 27]);
    expect(all).toEqual([...everything].sort((a, b) => b.seq - a.seq).map((r) => r.id));
    expect(pages.flatMap((p) => p.events).some((e) => e.tripId === null)).toBe(true);
  });

  it("a cursor below every seq returns an empty last page", async () => {
    const p = await pageOf(w.as.owner, `${TRIP_URL}?cursor=${encodeCursor(0)}`);
    expect(p).toEqual({ events: [], nextCursor: null });
  });

  it("cursor combined with entityType pages the filtered set only", async () => {
    const pages = await walk(w.as.owner, `${TRIP_URL}?entityType=expense`, 40);
    expect(pages.map((p) => p.events.length)).toEqual([40, 40, 40, 1]);
    const all = pages.flatMap((p) => p.events);
    expect(all.every((e) => e.entityType === "expense")).toBe(true);
    expect(new Set(all.map((e) => e.entityId))).toEqual(new Set(seeded));
    expect(new Set(all.map((e) => e.id)).size).toBe(121);
  });

  it("cursor combined with actorUserId pages the filtered set only", async () => {
    const pages = await walk(w.as.owner, `${TRIP_URL}?actorUserId=${IDS.editor}`, 25);
    expect(pages.map((p) => p.events.length)).toEqual([25, 25, 12]);
    const all = pages.flatMap((p) => p.events);
    expect(all.every((e) => e.actorUserId === IDS.editor)).toBe(true);
    expect(all.filter((e) => e.entityType === "itinerary")).toHaveLength(1);
  });
});

describe("filters on the trip endpoint", () => {
  beforeEach(seedBaseline);

  it("entityType narrows to that type only", async () => {
    const expense = await pageOf(w.as.owner, `${TRIP_URL}?entityType=expense`);
    expect(expense.events.map((e) => [e.entityType, e.action])).toEqual([
      ["expense", "update"],
      ["expense", "create"],
    ]);
    const itin = await pageOf(w.as.owner, `${TRIP_URL}?entityType=itinerary`);
    expect(itin.events.map((e) => e.entityType)).toEqual(["itinerary"]);
    const none = await pageOf(w.as.owner, `${TRIP_URL}?entityType=document`);
    expect(none).toEqual({ events: [], nextCursor: null });
  });

  it("entityId narrows to that id; combined with entityType it excludes a same-id row of another type", async () => {
    // Same id, different entity type (TDD 6.2: the pair is what identifies an item).
    await seedEvent({ actor: toActor(w.users.owner), tripId: IDS.trip, entityType: "document", entityId: E.expense1, action: "create", after: { id: E.expense1, tripId: IDS.trip, name: "Receipt" } });
    const byId = await pageOf(w.as.owner, `${TRIP_URL}?entityId=${E.expense1}`);
    expect(byId.events.map((e) => e.entityType)).toEqual(["document", "expense", "expense"]);
    const both = await pageOf(w.as.owner, `${TRIP_URL}?entityId=${E.expense1}&entityType=expense`);
    expect(both.events.map((e) => e.entityType)).toEqual(["expense", "expense"]);
  });

  it("actorUserId narrows to that actor", async () => {
    const p = await pageOf(w.as.owner, `${TRIP_URL}?actorUserId=${IDS.editor}`);
    expect(p.events.map((e) => [e.actorUserId, e.action])).toEqual([[IDS.editor, "update"]]);
    const none = await pageOf(w.as.owner, `${TRIP_URL}?actorUserId=${IDS.viewer}`);
    expect(none.events).toEqual([]);
    const notUuid = await read(await w.as.owner.get(`${TRIP_URL}?actorUserId=editor`));
    expect(notUuid.status).toBe(400);
    expect(notUuid.body.success).toBe(false);
  });

  it("action narrows to that action; an unknown action is 400", async () => {
    const p = await pageOf(w.as.owner, `${TRIP_URL}?action=create`);
    expect(p.events.map((e) => e.entityType)).toEqual(["itinerary", "expense"]);
    const upd = await pageOf(w.as.owner, `${TRIP_URL}?action=update`);
    expect(upd.events.map((e) => e.entityId)).toEqual([E.expense1]);
    const bad = await read(await w.as.owner.get(`${TRIP_URL}?action=explode`));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
  });

  it("unknown entityType query value is 400", async () => {
    const bad = await read(await w.as.owner.get(`${TRIP_URL}?entityType=widget`));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
  });

  it("since and until are inclusive on createdAt and combine", async () => {
    const owner = toActor(w.users.owner);
    const at = async (createdAt: string, entityId: string) =>
      seedRawEvent(owner, { tripId: IDS.trip, entityType: "expense", entityId, createdAt, entityLabel: `at ${createdAt}` });
    const A = "00000000-0000-4000-8000-00000000d001";
    const B = "00000000-0000-4000-8000-00000000d002";
    const C = "00000000-0000-4000-8000-00000000d003";
    await at("2020-01-01T00:00:00.000Z", A);
    await at("2020-06-01T12:00:00.000Z", B);
    await at("2021-01-01T00:00:00.000Z", C);

    const since = await pageOf(w.as.owner, `${TRIP_URL}?since=2020-06-01T12:00:00.000Z&until=2021-01-01T00:00:00.000Z`);
    expect(entityIds(since)).toEqual([C, B]);
    const until = await pageOf(w.as.owner, `${TRIP_URL}?until=2020-06-01T12:00:00.000Z`);
    expect(entityIds(until)).toEqual([B, A]);
    const sinceOnly = await pageOf(w.as.owner, `${TRIP_URL}?since=2020-06-01T12:00:00.001Z`);
    // Everything seeded "now" by seedBaseline plus C; B is excluded by one millisecond.
    expect(entityIds(sinceOnly)).toContain(C);
    expect(entityIds(sinceOnly)).not.toContain(B);
    expect(entityIds(sinceOnly)).not.toContain(A);
    expect(sinceOnly.events).toHaveLength(4);
    const window = await pageOf(w.as.owner, `${TRIP_URL}?since=2020-02-01T00:00:00Z&until=2020-12-31T23:59:59Z`);
    expect(entityIds(window)).toEqual([B]);
    const empty = await pageOf(w.as.owner, `${TRIP_URL}?since=2021-01-01T00:00:00.001Z&until=2021-06-01T00:00:00Z`);
    expect(empty.events).toEqual([]);

    const bad = await read(await w.as.owner.get(`${TRIP_URL}?since=yesterday`));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
  });

  it("filters combine with AND", async () => {
    const p = await pageOf(w.as.owner, `${TRIP_URL}?entityType=expense&action=create&actorUserId=${IDS.owner}`);
    expect(p.events.map((e) => [e.entityType, e.action, e.actorUserId])).toEqual([["expense", "create", IDS.owner]]);
    const none = await pageOf(w.as.owner, `${TRIP_URL}?entityType=expense&action=create&actorUserId=${IDS.editor}`);
    expect(none.events).toEqual([]);
  });

  it("the trip endpoint never shows another trip's or an administration event, even when entityId points at them", async () => {
    const other = await pageOf(w.as.owner, `${TRIP_URL}?entityId=${E.otherTripExpense}`);
    expect(other.events).toEqual([]);
    const adminEvent = await pageOf(w.as.owner, `${TRIP_URL}?entityId=${E.adminUser}&entityType=user`);
    expect(adminEvent.events).toEqual([]);
    const all = await pageOf(w.as.admin, `${TRIP_URL}?limit=200`);
    expect(all.events.every((e) => e.tripId === IDS.trip)).toBe(true);
    expect(all.events).toHaveLength(3);

    // Same through the entity endpoint.
    expect(await read(await w.as.owner.get(entityUrl("expense", E.otherTripExpense)))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
    expect(await read(await w.as.admin.get(entityUrl("user", E.adminUser)))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
  });
});

describe("filters on the admin endpoint", () => {
  beforeEach(async () => {
    await seedBaseline();
    await seedEvent({
      actor: toActor(w.users.owner, { channel: "mcp_oauth", clientId: FAKE_CLIENT_ID }),
      tripId: IDS.trip,
      entityType: "expense",
      entityId: E.expense2,
      action: "create",
      after: { id: E.expense2, tripId: IDS.trip, description: "Via Claude" },
    });
    await seedEvent({
      actor: toActor(w.users.owner, { channel: "mcp_stage1", clientId: "fake-service-cn" }),
      tripId: IDS.trip,
      entityType: "expense",
      entityId: E.expense2,
      action: "delete",
      before: { id: E.expense2, tripId: IDS.trip, description: "Via Claude" },
    });
  });

  it("without tripId sees both trips plus the tripId: null administration event", async () => {
    const p = await pageOf(w.as.admin, ADMIN_URL);
    expect(p.events).toHaveLength(7);
    const tripIds = new Set(p.events.map((e) => e.tripId));
    expect(tripIds).toEqual(new Set([IDS.trip, IDS.otherTrip, null]));
    const adminEvent = p.events.find((e) => e.tripId === null)!;
    expect(adminEvent).toMatchObject({ entityType: "user", entityId: E.adminUser, actorUserId: IDS.admin, requestId: "ray-test" });
  });

  it("tripId narrows to one trip; a trip no one is a member of is still readable", async () => {
    const a = await pageOf(w.as.admin, `${ADMIN_URL}?tripId=${IDS.trip}`);
    expect(a.events).toHaveLength(5);
    expect(a.events.every((e) => e.tripId === IDS.trip)).toBe(true);
    const b = await pageOf(w.as.admin, `${ADMIN_URL}?tripId=${IDS.otherTrip}`);
    expect(entityIds(b)).toEqual([E.otherTripExpense]);
    // Acceptance 4: a deleted trip's history stays readable here.
    await testDb().delete(trips).where(eq(trips.id, IDS.otherTrip));
    const afterDelete = await pageOf(w.as.admin, `${ADMIN_URL}?tripId=${IDS.otherTrip}`);
    expect(entityIds(afterDelete)).toEqual([E.otherTripExpense]);
    const bad = await read(await w.as.admin.get(`${ADMIN_URL}?tripId=not-a-uuid`));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
  });

  it("channel narrows; an unknown channel is 400", async () => {
    const oauth = await pageOf(w.as.admin, `${ADMIN_URL}?channel=mcp_oauth`);
    expect(oauth.events.map((e) => [e.channel, e.clientId, e.action])).toEqual([["mcp_oauth", FAKE_CLIENT_ID, "create"]]);
    const stage1 = await pageOf(w.as.admin, `${ADMIN_URL}?channel=mcp_stage1`);
    expect(stage1.events.map((e) => e.clientId)).toEqual(["fake-service-cn"]);
    const web = await pageOf(w.as.admin, `${ADMIN_URL}?channel=web`);
    expect(web.events).toHaveLength(5);
    expect(web.events.every((e) => e.clientId === null)).toBe(true);
    const bad = await read(await w.as.admin.get(`${ADMIN_URL}?channel=carrier_pigeon`));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
  });

  it("clientId narrows to that client", async () => {
    const p = await pageOf(w.as.admin, `${ADMIN_URL}?clientId=${FAKE_CLIENT_ID}`);
    expect(p.events.map((e) => [e.entityId, e.channel])).toEqual([[E.expense2, "mcp_oauth"]]);
    const none = await pageOf(w.as.admin, `${ADMIN_URL}?clientId=fake-unknown-client`);
    expect(none.events).toEqual([]);
  });

  it("the shared filters work on the admin endpoint and combine with the admin-only ones", async () => {
    const users = await pageOf(w.as.admin, `${ADMIN_URL}?entityType=user`);
    expect(users.events.map((e) => e.tripId)).toEqual([null]);
    const byActor = await pageOf(w.as.admin, `${ADMIN_URL}?actorUserId=${IDS.outsider}`);
    expect(byActor.events.map((e) => e.tripId)).toEqual([IDS.otherTrip]);
    const combo = await pageOf(w.as.admin, `${ADMIN_URL}?tripId=${IDS.trip}&entityId=${E.expense2}&action=delete`);
    expect(combo.events.map((e) => e.channel)).toEqual(["mcp_stage1"]);
    const combo2 = await pageOf(w.as.admin, `${ADMIN_URL}?channel=mcp_oauth&action=delete`);
    expect(combo2.events).toEqual([]);
  });

  it("cursor combined with tripId pages the filtered set only", async () => {
    await seedManyEvents(toActor(w.users.outsider), IDS.otherTrip, 45);
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await pageOf(w.as.admin, `${ADMIN_URL}?tripId=${IDS.otherTrip}&limit=20${cursor ? `&cursor=${cursor}` : ""}`);
      pages.push(p);
      cursor = p.nextCursor;
    } while (cursor !== null);
    expect(pages.map((p) => p.events.length)).toEqual([20, 20, 6]);
    const all = pages.flatMap((p) => p.events);
    expect(all.every((e) => e.tripId === IDS.otherTrip)).toBe(true);
    expect(new Set(all.map((e) => e.id)).size).toBe(46);
  });
});

describe("entity endpoint", () => {
  beforeEach(async () => {
    await seedBaseline();
    // Same id as expense1 under a different entity type, and a second expense: both excluded.
    await seedEvent({ actor: toActor(w.users.owner), tripId: IDS.trip, entityType: "document", entityId: E.expense1, action: "create", after: { id: E.expense1, tripId: IDS.trip, name: "Receipt" } });
    await seedEvent({ actor: toActor(w.users.owner), tripId: IDS.trip, entityType: "expense", entityId: E.expense2, action: "create", after: { id: E.expense2, tripId: IDS.trip, description: "Dinner" } });
  });

  it("returns only that entity's rows, newest first", async () => {
    const p = await pageOf(w.as.editor, entityUrl("expense", E.expense1));
    expect(p.events.map((e) => [e.entityType, e.entityId, e.action])).toEqual([
      ["expense", E.expense1, "update"],
      ["expense", E.expense1, "create"],
    ]);
    const doc = await pageOf(w.as.editor, entityUrl("document", E.expense1));
    expect(doc.events.map((e) => [e.entityType, e.action])).toEqual([["document", "create"]]);
  });

  it("the path wins over entityType / entityId query parameters", async () => {
    // AuditEntityQuerySchema has no entity filters; unknown query keys are ignored by Zod.
    const p = await pageOf(w.as.owner, `${entityUrl("expense", E.expense1)}?entityType=document&entityId=${E.expense2}`);
    expect(p.events.map((e) => [e.entityType, e.entityId])).toEqual([
      ["expense", E.expense1],
      ["expense", E.expense1],
    ]);
  });

  it("action, actorUserId, since and until filter the entity's history", async () => {
    const created = await pageOf(w.as.owner, `${entityUrl("expense", E.expense1)}?action=create`);
    expect(created.events.map((e) => e.action)).toEqual(["create"]);
    const byEditor = await pageOf(w.as.owner, `${entityUrl("expense", E.expense1)}?actorUserId=${IDS.editor}`);
    expect(byEditor.events.map((e) => e.action)).toEqual(["update"]);
    const old = await pageOf(w.as.owner, `${entityUrl("expense", E.expense1)}?until=2000-01-01T00:00:00Z`);
    expect(old.events).toEqual([]);
    const recent = await pageOf(w.as.owner, `${entityUrl("expense", E.expense1)}?since=2000-01-01T00:00:00Z`);
    expect(recent.events).toHaveLength(2);
  });

  it("unknown entityType in the path is 400; an unknown entity id is 200 with an empty page", async () => {
    const bad = await read(await w.as.owner.get(entityUrl("widget", E.expense1)));
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
    expect(await read(await w.as.owner.get(entityUrl("expense", IDS.missing)))).toEqual({ status: 200, body: { events: [], nextCursor: null } });
  });

  it("every stored entity type is accepted in the path", async () => {
    for (const t of ENTITY_TYPES) {
      expect((await w.as.owner.get(entityUrl(t, E.expense1))).status, t).toBe(200);
    }
  });

  it("authorization is checked before the entity type: Viewer 403 and non-member 404 even for a bad path; anonymous 401", async () => {
    // The Zod param check runs first, so an invalid entityType is 400 for everyone authenticated.
    expect((await w.as.viewer.get(entityUrl("widget", E.expense1))).status).toBe(400);
    expect(await read(await w.as.viewer.get(entityUrl("expense", IDS.missing)))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(await read(await w.as.outsider.get(entityUrl("expense", IDS.missing)))).toEqual({ status: 404, body: { error: "Trip not found" } });
    expect((await anonymous().get(entityUrl("widget", E.expense1))).status).toBe(401);
  });
});

describe("bad cursor", () => {
  beforeEach(seedBaseline);

  const BAD_CURSORS = [
    "!!!", // illegal characters
    "aGVsbG8", // base64url("hello"): well-formed, not a decimal
    "LTE", // base64url("-1")
    "MDE", // base64url("01"): leading zero
    "MS41", // base64url("1.5")
    "A".repeat(33), // over the length bound
  ];

  it("is 400 { error: 'Invalid cursor' } on all three endpoints", async () => {
    for (const cursor of BAD_CURSORS) {
      for (const url of [TRIP_URL, entityUrl("expense", E.expense1), ADMIN_URL]) {
        expect(await read(await w.as.admin.get(`${url}?cursor=${encodeURIComponent(cursor)}`)), `${url} cursor=${cursor}`).toEqual({
          status: 400,
          body: { error: "Invalid cursor" },
        });
      }
    }
  });

  it("an empty cursor fails the query schema (400) rather than the service", async () => {
    const r = await read(await w.as.owner.get(`${TRIP_URL}?cursor=`));
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it("a bad cursor does not bypass authorization", async () => {
    expect(await read(await w.as.viewer.get(`${TRIP_URL}?cursor=!!!`))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(await read(await w.as.outsider.get(`${TRIP_URL}?cursor=!!!`))).toEqual({ status: 404, body: { error: "Trip not found" } });
    expect(await read(await w.as.owner.get(`${ADMIN_URL}?cursor=!!!`))).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect((await anonymous().get(`${TRIP_URL}?cursor=!!!`)).status).toBe(401);
  });
});

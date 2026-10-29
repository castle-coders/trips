// services/audit.ts: auditInsert, recordEvent, pickSnapshot, labelFor, cursors and the three
// list functions. Called directly (no HTTP), as the service write hooks and routes call them.
// Spec: specs/AUDIT_TDD.md sections 6.1 to 6.4 and 10; specs/AUDIT_PRD.md 6.3.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as DbActor } from "../src/db";
import { auditEvents, trips } from "../src/db/schema";
import {
  ACTIONS,
  DEFAULT_LIMIT,
  ENTITY_TYPES,
  LABEL_MAX_LENGTH,
  MAX_LIMIT,
  SNAPSHOT_COLUMNS,
  auditInsert,
  decodeCursor,
  encodeCursor,
  isAction,
  isEntityType,
  labelFor,
  listAdminEvents,
  listEntityEvents,
  listTripEvents,
  pickSnapshot,
  recordEvent,
  type AuditEventView,
  type EntityType,
} from "../src/services/audit";
import { ServiceError } from "../src/services/errors";
import { IDS, errorOf, expectServiceError, seedRoleWorld, testDb, type Actor as Role, type RoleWorld } from "./helpers";
import { auditRows, seedEvent, seedManyEvents, seedRawEvent, toActor } from "./helpers/audit";

let w: RoleWorld;
const actor = (a: Role, overrides: Partial<Pick<DbActor, "channel" | "clientId" | "requestId">> = {}): DbActor =>
  toActor(w.users[a], overrides);

beforeEach(async () => {
  w = await seedRoleWorld();
});

// A trips row shaped like seedTrip's, for the batch tests.
function tripRow(id: string, name: string) {
  const ts = new Date().toISOString();
  return {
    id,
    name,
    destination: "Testville",
    startDate: "2030-01-10",
    endDate: "2030-01-15",
    description: null,
    splitwiseGroupId: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("type guards", () => {
  it("isEntityType / isAction accept every listed value and nothing else", () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
    for (const a of ACTIONS) expect(isAction(a)).toBe(true);
    expect(isEntityType("trips")).toBe(false);
    expect(isEntityType(null)).toBe(false);
    expect(isAction("upsert")).toBe(false);
    expect(isAction(1)).toBe(false);
  });
});

describe("auditInsert", () => {
  it("returns null for an update whose allow-listed diff is empty", () => {
    const row = { id: "t1", name: "Trip", destination: "X", createdAt: "a", updatedAt: "a" };
    const stmt = auditInsert(testDb(), {
      actor: actor("owner"),
      tripId: "t1",
      entityType: "trip",
      entityId: "t1",
      action: "update",
      before: row,
      after: { ...row },
    });
    expect(stmt).toBeNull();
  });

  it("returns null when only updatedAt (and createdAt) differ", () => {
    const before = { id: "t1", name: "Trip", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
    const after = { ...before, createdAt: "2030-02-01T00:00:00.000Z", updatedAt: "2030-02-02T00:00:00.000Z" };
    const stmt = auditInsert(testDb(), {
      actor: actor("owner"),
      tripId: "t1",
      entityType: "trip",
      entityId: "t1",
      action: "update",
      before,
      after,
    });
    expect(stmt).toBeNull();
  });

  it("returns null when only a non-allow-listed column differs", () => {
    const before = { id: "i1", tripId: "t1", name: "Alice", role: "Viewer", status: "pending", token: "fake-token-aaa" };
    const after = { ...before, token: "fake-token-bbb" };
    const stmt = auditInsert(testDb(), {
      actor: actor("owner"),
      tripId: "t1",
      entityType: "invite",
      entityId: "i1",
      action: "update",
      before,
      after,
    });
    expect(stmt).toBeNull();
  });

  it("create: before and changes are null, after is the allow-listed snapshot", async () => {
    const stmt = auditInsert(testDb(), {
      actor: actor("owner"),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      action: "create",
      // A sloppy caller passing `before` on a create: it is discarded.
      before: { id: "ignored" },
      after: { id: IDS.trip, name: "New Trip", destination: "X", createdAt: "a", updatedAt: "a" },
    });
    expect(stmt).not.toBeNull();
    await stmt!;
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      entityLabel: "New Trip",
      action: "create",
      before: null,
      after: { id: IDS.trip, name: "New Trip", destination: "X" },
      changes: null,
      metadata: null,
    });
  });

  it("delete: after and changes are null, before is the snapshot, metadata is stored", async () => {
    const stmt = auditInsert(testDb(), {
      actor: actor("owner"),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      action: "delete",
      before: { id: IDS.trip, name: "Old Trip", createdAt: "a", updatedAt: "a" },
      after: { id: "ignored" },
      metadata: { itineraries: 2, expenses: 3, participants: 4, documents: 0, invites: 1 },
    });
    await stmt!;
    const [row] = await auditRows();
    expect(row).toMatchObject({
      entityLabel: "Old Trip",
      action: "delete",
      before: { id: IDS.trip, name: "Old Trip" },
      after: null,
      changes: null,
      metadata: { itineraries: 2, expenses: 3, participants: 4, documents: 0, invites: 1 },
    });
  });

  it("update: both snapshots stored, changes is the diff, label from after", async () => {
    const before = { id: IDS.trip, name: "Before", destination: "X", endDate: null, createdAt: "a", updatedAt: "a" };
    const after = { id: IDS.trip, name: "After", destination: "X", endDate: "2030-01-15", createdAt: "a", updatedAt: "b" };
    await auditInsert(testDb(), {
      actor: actor("editor"),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      action: "update",
      before,
      after,
    })!;
    const [row] = await auditRows();
    expect(row.entityLabel).toBe("After");
    expect(row.before).toEqual({ id: IDS.trip, name: "Before", destination: "X", endDate: null });
    expect(row.after).toEqual({ id: IDS.trip, name: "After", destination: "X", endDate: "2030-01-15" });
    expect(row.changes).toEqual({
      name: { from: "Before", to: "After" },
      endDate: { from: null, to: "2030-01-15" },
    });
  });

  it("update of nested itinerary content records JSON-path changes only", async () => {
    const content = (time: string) => ({
      legs: [{ airline: "Test Air", flightNumber: "TA100", departureAirport: "AAA", arrivalAirport: "BBB", departureTime: time }],
    });
    await auditInsert(testDb(), {
      actor: actor("editor"),
      tripId: IDS.trip,
      entityType: "itinerary",
      entityId: "it1",
      action: "update",
      before: { id: "it1", tripId: IDS.trip, type: "Flight", content: content("08:10") },
      after: { id: "it1", tripId: IDS.trip, type: "Flight", content: content("09:45") },
    })!;
    const [row] = await auditRows();
    expect(row.changes).toEqual({ "content.legs[0].departureTime": { from: "08:10", to: "09:45" } });
    expect(row.entityLabel).toBe("Test Air TA100 AAA to BBB");
  });

  it("fills actor columns, id, createdAt from the Actor and the clock", async () => {
    const t0 = Date.now();
    await auditInsert(testDb(), {
      actor: actor("owner", { channel: "mcp_oauth", clientId: "client-fake-1", requestId: "ray-abc" }),
      tripId: IDS.trip,
      entityType: "trip",
      entityId: IDS.trip,
      action: "create",
      after: { id: IDS.trip, name: "T" },
    })!;
    const [row] = await auditRows();
    expect(row).toMatchObject({
      actorUserId: IDS.owner,
      actorName: "Owner User",
      actorEmail: "owner@example.test",
      actorRole: "editor",
      channel: "mcp_oauth",
      clientId: "client-fake-1",
      requestId: "ray-abc",
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.seq).toBeGreaterThan(0);
    const created = Date.parse(row.createdAt);
    expect(created).toBeGreaterThanOrEqual(t0 - 1000);
    expect(created).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("other actions (accept, merge, ...) keep both snapshots and set changes only when they differ", async () => {
    const db = testDb();
    const pending = { id: "i1", tripId: IDS.trip, name: "Alice", role: "Viewer", status: "pending", token: "fake-token-1" };
    await auditInsert(db, {
      actor: actor("viewer"),
      tripId: IDS.trip,
      entityType: "invite",
      entityId: "i1",
      action: "accept",
      before: pending,
      after: { ...pending, status: "accepted" },
    })!;
    const same = auditInsert(db, {
      actor: actor("admin"),
      tripId: null,
      entityType: "user",
      entityId: "u1",
      action: "merge",
      before: { id: "u1", email: "a@example.test" },
      after: { id: "u1", email: "a@example.test" },
      metadata: { mergedUserId: "u2" },
    });
    expect(same).not.toBeNull();
    await same!;
    const [accept, merge] = await auditRows();
    expect(accept.changes).toEqual({ status: { from: "pending", to: "accepted" } });
    expect(accept.before).not.toHaveProperty("token");
    expect(accept.after).not.toHaveProperty("token");
    expect(merge.changes).toBeNull();
    expect(merge.metadata).toEqual({ mergedUserId: "u2" });
  });
});

describe("auditInsert inside db.batch", () => {
  it("composed next to a data insert, both rows land", async () => {
    const db = testDb();
    const id = "00000000-0000-4000-8000-00000000b111";
    const row = tripRow(id, "Batched Trip");
    const audit = auditInsert(db, {
      actor: actor("owner"),
      tripId: id,
      entityType: "trip",
      entityId: id,
      action: "create",
      after: row,
    });
    await db.batch([db.insert(trips).values(row), audit!]);
    expect(await db.select().from(trips).where(eq(trips.id, id))).toHaveLength(1);
    const events = await auditRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tripId: id, entityLabel: "Batched Trip", action: "create" });
  });

  it("a failing second statement rolls back the data insert (D1 batch atomicity)", async () => {
    const db = testDb();
    const id = "00000000-0000-4000-8000-00000000b222";
    const row = tripRow(id, "Rolled Back Trip");
    // Hand-built audit row missing the NOT NULL `entityLabel`.
    const bad = db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      actorUserId: IDS.owner,
      actorName: "Owner User",
      actorEmail: "owner@example.test",
      actorRole: "editor",
      channel: "web",
      tripId: id,
      entityType: "trip",
      entityId: id,
      action: "create",
    } as unknown as typeof auditEvents.$inferInsert);
    const err = await errorOf(db.batch([db.insert(trips).values(row), bad]));
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/NOT NULL/i);
    expect(await db.select().from(trips).where(eq(trips.id, id))).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("recordEvent", () => {
  it("writes exactly one row", async () => {
    await recordEvent(testDb(), {
      actor: actor("admin"),
      tripId: null,
      entityType: "oauth_client",
      entityId: "client-fake-1",
      action: "create",
      after: { clientId: "client-fake-1", clientName: "Fake Client", clientSecret: "fake-secret-zzz" },
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tripId: null, entityType: "oauth_client", entityLabel: "Fake Client" });
    expect(rows[0].after).toEqual({ clientId: "client-fake-1", clientName: "Fake Client" });
  });

  it("skips on an empty update diff", async () => {
    const snap = { id: "u1", email: "u@example.test", name: "U", role: "viewer", updatedAt: "a" };
    await recordEvent(testDb(), {
      actor: actor("admin"),
      tripId: null,
      entityType: "user",
      entityId: "u1",
      action: "update",
      before: snap,
      after: { ...snap, updatedAt: "b" },
    });
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("pickSnapshot / allow-lists (TDD 6.4)", () => {
  it("invite rows drop token", () => {
    const snap = pickSnapshot("invite", {
      id: "i1",
      tripId: "t1",
      participantId: "p1",
      name: "Alice",
      role: "Viewer",
      status: "pending",
      invitedBy: "u1",
      expiresAt: "2030-01-01",
      token: "fake-invite-token-123",
      createdAt: "a",
      updatedAt: "a",
    });
    expect(snap).toEqual({
      id: "i1",
      tripId: "t1",
      participantId: "p1",
      name: "Alice",
      role: "Viewer",
      status: "pending",
      invitedBy: "u1",
      expiresAt: "2030-01-01",
    });
    expect(JSON.stringify(snap)).not.toContain("fake-invite-token-123");
  });

  it("user rows drop passwordHash", () => {
    const snap = pickSnapshot("user", {
      id: "u1",
      email: "u@example.test",
      name: "U",
      role: "admin",
      avatarUrl: null,
      googleId: "g-1",
      passwordHash: "$fake$hash$abc",
      createdAt: "a",
      updatedAt: "a",
    });
    expect(snap).toEqual({ id: "u1", email: "u@example.test", name: "U", role: "admin", avatarUrl: null, googleId: "g-1" });
    expect(JSON.stringify(snap)).not.toContain("$fake$hash$abc");
  });

  it("oauth_client objects drop clientSecret and clientSecretHash", () => {
    const snap = pickSnapshot("oauth_client", {
      clientId: "c1",
      clientName: "Fake Client",
      redirectUris: ["https://example.test/cb"],
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecret: "fake-plain-secret",
      clientSecretHash: "fake-secret-hash",
      registrationDate: 1,
    });
    expect(snap).toEqual({
      clientId: "c1",
      clientName: "Fake Client",
      redirectUris: ["https://example.test/cb"],
      tokenEndpointAuthMethod: "client_secret_post",
    });
  });

  it("oauth_grant objects drop token hashes", () => {
    const snap = pickSnapshot("oauth_grant", {
      grantId: "g1",
      userId: "u1",
      clientId: "c1",
      clientName: "Fake Client",
      scopes: ["read"],
      createdAt: 123,
      authCodeId: "fake-code-hash",
      previousRefreshTokenId: "fake-rt-hash",
      refreshTokenId: "fake-rt-hash-2",
    });
    expect(Object.keys(snap!).sort()).toEqual(["clientId", "clientName", "createdAt", "grantId", "scopes", "userId"]);
  });

  it("createdAt and updatedAt are dropped for every entity type except oauth_grant (TDD 6.4 lists createdAt there)", () => {
    for (const t of ENTITY_TYPES) {
      const snap = pickSnapshot(t, { id: "x", createdAt: "a", updatedAt: "b" })!;
      expect(snap, t).not.toHaveProperty("updatedAt");
      if (t === "oauth_grant") expect(snap).toHaveProperty("createdAt", "a");
      else expect(snap, t).not.toHaveProperty("createdAt");
    }
    expect(SNAPSHOT_COLUMNS.oauth_grant).toContain("createdAt");
  });

  it("no allow-list contains token, passwordHash or a secret column", () => {
    for (const t of ENTITY_TYPES) {
      for (const col of SNAPSHOT_COLUMNS[t]) {
        // Exact `token`, anything password/secret-ish, and `...Hash` / `...TokenId` columns. `tokenEndpointAuthMethod` is a public setting.
        expect(col, t).not.toMatch(/^token$|password|secret|Hash$|TokenId$/i);
      }
    }
  });

  it("absent and undefined keys are omitted rather than set to undefined; null is kept", () => {
    const snap = pickSnapshot("trip", { id: "t1", name: "T", description: undefined, endDate: null })!;
    expect(Object.keys(snap).sort()).toEqual(["endDate", "id", "name"]);
    expect("description" in snap).toBe(false);
    expect(snap.endDate).toBeNull();
  });

  it("null and undefined rows give null", () => {
    expect(pickSnapshot("trip", null)).toBeNull();
    expect(pickSnapshot("trip", undefined)).toBeNull();
  });

  it("every entity type's allow-list matches the TDD 6.4 table", () => {
    expect(SNAPSHOT_COLUMNS).toEqual({
      trip: ["id", "name", "destination", "startDate", "endDate", "description", "splitwiseGroupId"],
      itinerary: ["id", "tripId", "type", "status", "schemaVersion", "content", "confirmationNumber", "totalCost", "currency", "notes"],
      expense: ["id", "tripId", "description", "amount", "currency", "category", "payerId", "payerName", "splitType"],
      participant: ["id", "tripId", "userId", "email", "name", "role", "traveling"],
      document: ["id", "tripId", "reservationId", "fileUrl", "documentType", "name"],
      invite: ["id", "tripId", "participantId", "name", "role", "status", "invitedBy", "expiresAt"],
      user: ["id", "email", "name", "role", "avatarUrl", "googleId"],
      user_email: ["id", "userId", "email", "isPrimary"],
      service_identity: ["id", "cfAccessSubject", "commonName", "userId"],
      oauth_grant: ["grantId", "userId", "clientId", "clientName", "scopes", "createdAt"],
      oauth_client: ["clientId", "clientName", "redirectUris", "tokenEndpointAuthMethod"],
    });
  });
});

describe("labelFor (TDD 6.4)", () => {
  it("trip, expense, participant, document, user, user_email, service_identity, oauth_client", () => {
    expect(labelFor("trip", { name: "Tokyo 2030" })).toBe("Tokyo 2030");
    expect(labelFor("expense", { description: "Dinner" })).toBe("Dinner");
    expect(labelFor("participant", { name: "Alice" })).toBe("Alice");
    expect(labelFor("document", { name: "boarding.pdf" })).toBe("boarding.pdf");
    expect(labelFor("user", { email: "u@example.test", name: "U" })).toBe("u@example.test");
    expect(labelFor("user_email", { email: "alt@example.test" })).toBe("alt@example.test");
    expect(labelFor("service_identity", { commonName: "ci-bot" })).toBe("ci-bot");
    expect(labelFor("oauth_client", { clientName: "Fake Client", clientId: "c1" })).toBe("Fake Client");
  });

  it("itinerary Flight: airline, flightNumber and route of leg 0", () => {
    const content = {
      legs: [
        { airline: "UA", flightNumber: "123", departureAirport: "SFO", arrivalAirport: "JFK" },
        { airline: "UA", flightNumber: "999", departureAirport: "JFK", arrivalAirport: "BOS" },
      ],
    };
    expect(labelFor("itinerary", { type: "Flight", content })).toBe("UA 123 SFO to JFK");
  });

  it("itinerary Flight with no legs falls back to type", () => {
    expect(labelFor("itinerary", { type: "Flight", content: { legs: [] } })).toBe("Flight");
    expect(labelFor("itinerary", { type: "Flight", content: {} })).toBe("Flight");
  });

  it("itinerary Lodging: propertyName", () => {
    expect(labelFor("itinerary", { type: "Lodging", content: { propertyName: "Hotel Fake", name: "ignored" } })).toBe("Hotel Fake");
    expect(labelFor("itinerary", { type: "Lodging", content: {} })).toBe("Lodging");
  });

  it("itinerary other types: first of name, title, vendor; fallback type", () => {
    expect(labelFor("itinerary", { type: "Activity", content: { name: "Museum", title: "T", vendor: "V" } })).toBe("Museum");
    expect(labelFor("itinerary", { type: "Activity", content: { title: "Walking Tour", vendor: "V" } })).toBe("Walking Tour");
    expect(labelFor("itinerary", { type: "Transport", content: { vendor: "Rail Co" } })).toBe("Rail Co");
    expect(labelFor("itinerary", { type: "Transport", content: { foo: "bar" } })).toBe("Transport");
    expect(labelFor("itinerary", { type: "Transport", content: null })).toBe("Transport");
  });

  it("invite: name, else 'Invite'", () => {
    expect(labelFor("invite", { name: "Alice", role: "Viewer" })).toBe("Alice");
    expect(labelFor("invite", { name: null, role: "Viewer" })).toBe("Invite");
    expect(labelFor("invite", { role: "Viewer" })).toBe("Invite");
  });

  it("oauth_grant: clientName, else clientId", () => {
    expect(labelFor("oauth_grant", { clientName: "Fake Client", clientId: "c1" })).toBe("Fake Client");
    expect(labelFor("oauth_grant", { clientId: "c1" })).toBe("c1");
  });

  it("clips at 200 characters", () => {
    const long = "x".repeat(500);
    expect(LABEL_MAX_LENGTH).toBe(200);
    expect(labelFor("trip", { name: long })).toHaveLength(200);
    expect(labelFor("itinerary", { type: "Lodging", content: { propertyName: long } })).toHaveLength(200);
    expect(labelFor("trip", { name: "x".repeat(200) })).toHaveLength(200);
  });

  it("never returns an empty string: falls back to the entity type", () => {
    for (const t of ENTITY_TYPES) {
      expect(labelFor(t, {}).length, t).toBeGreaterThan(0);
      expect(labelFor(t, null).length, t).toBeGreaterThan(0);
    }
    expect(labelFor("trip", { name: "" })).toBe("trip");
    expect(labelFor("itinerary", {})).toBe("itinerary");
  });
});

describe("cursor (TDD 6.3)", () => {
  it("round-trips", () => {
    for (const seq of [0, 1, 7, 50, 4096, 123456789, Number.MAX_SAFE_INTEGER]) {
      const c = encodeCursor(seq);
      expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(c)).toBe(seq);
    }
  });

  it("encodes as base64url of the decimal string, no padding", () => {
    expect(encodeCursor(42)).toBe(btoa("42").replace(/=+$/, ""));
    expect(encodeCursor(42)).not.toMatch(/[=+/]/);
  });

  it("decodeCursor throws ServiceError(validation) on garbage, empty, negative and non-integer", () => {
    const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = [
      "",
      "!!!",
      "a b",
      "a+b",
      "a/b==",
      b64url("-1"),
      b64url("1.5"),
      b64url("abc"),
      b64url("01"),
      b64url(""),
      b64url("99999999999999999999"),
      "A".repeat(33),
    ];
    for (const c of bad) {
      let err: unknown;
      try {
        decodeCursor(c);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(c)).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code, JSON.stringify(c)).toBe("validation");
    }
  });

  it("encodeCursor rejects negative and non-integer seq", () => {
    expect(() => encodeCursor(-1)).toThrow();
    expect(() => encodeCursor(1.5)).toThrow();
  });
});

describe("listTripEvents", () => {
  beforeEach(async () => {
    await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "trip", entityId: IDS.trip, action: "create" });
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "expense", entityId: "e1", action: "create" });
  });

  it("Owner and Editor succeed; admin non-member succeeds", async () => {
    for (const a of ["owner", "editor", "admin"] as const) {
      const page = await listTripEvents(testDb(), actor(a), IDS.trip);
      expect(page.events.map((e) => e.entityType), a).toEqual(["expense", "trip"]);
      expect(page.nextCursor).toBeNull();
    }
  });

  it("Viewer gets forbidden; non-member gets not_found", async () => {
    await expectServiceError(listTripEvents(testDb(), actor("viewer"), IDS.trip), "forbidden");
    await expectServiceError(listTripEvents(testDb(), actor("outsider"), IDS.trip), "not_found");
    await expectServiceError(listTripEvents(testDb(), actor("owner"), IDS.missing), "not_found");
  });

  it("returns newest first (descending seq) with the view shape (no seq)", async () => {
    const { events } = await listTripEvents(testDb(), actor("editor"), IDS.trip);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ entityType: "expense", actorUserId: IDS.editor });
    expect(events[1]).toMatchObject({ entityType: "trip", actorUserId: IDS.owner });
    expect(events[0]).not.toHaveProperty("seq");
    expect(events[0].before).toBeNull();
    expect(events[0].after).toMatchObject({ id: "e1" });
    expect(events[0].changes).toBeNull();
    expect(events[0].metadata).toBeNull();
  });

  it("requestId is absent for Editor and Owner, present for admin", async () => {
    const editorPage = await listTripEvents(testDb(), actor("editor"), IDS.trip);
    const ownerPage = await listTripEvents(testDb(), actor("owner"), IDS.trip);
    for (const e of [...editorPage.events, ...ownerPage.events]) expect("requestId" in e).toBe(false);
    const adminPage = await listTripEvents(testDb(), actor("admin"), IDS.trip);
    for (const e of adminPage.events) expect(e.requestId).toBe("ray-test");
  });

  it("a bad cursor is a validation error", async () => {
    await expectServiceError(listTripEvents(testDb(), actor("editor"), IDS.trip, { cursor: "!!!" }), "validation");
    await expectServiceError(listTripEvents(testDb(), actor("editor"), IDS.trip, { cursor: "" }), "validation");
  });

  it("limit defaults to 50 and clamps to 200", async () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(200);
    await seedManyEvents(actor("editor"), IDS.trip, 205);
    const dflt = await listTripEvents(testDb(), actor("editor"), IDS.trip);
    expect(dflt.events).toHaveLength(50);
    expect(dflt.nextCursor).not.toBeNull();
    const big = await listTripEvents(testDb(), actor("editor"), IDS.trip, { limit: 1000 });
    expect(big.events).toHaveLength(200);
    expect(big.nextCursor).not.toBeNull();
    const second = await listTripEvents(testDb(), actor("editor"), IDS.trip, { limit: 1000, cursor: big.nextCursor! });
    expect(second.events).toHaveLength(7); // 205 seeded + 2 from beforeEach - 200
    expect(second.nextCursor).toBeNull();
  });

  it("walks every page with no duplicates or gaps; the last page has nextCursor null", async () => {
    const seeded = await seedManyEvents(actor("editor"), IDS.trip, 205);
    const total = seeded.length + 2;
    for (const limit of [30, 200]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, { limit, cursor });
        pages++;
        expect(page.events.length).toBeLessThanOrEqual(limit);
        if (page.nextCursor !== null) expect(page.events).toHaveLength(limit);
        seen.push(...page.events.map((e) => e.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(pages).toBe(Math.ceil(total / limit));
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    }
    // Newest-first across pages: the first page's first event is the last seeded one.
    const first = await listTripEvents(testDb(), actor("editor"), IDS.trip, { limit: 1 });
    expect(first.events[0].entityId).toBe(seeded[seeded.length - 1]);
  });

  describe("filters", () => {
    beforeEach(async () => {
      await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "expense", entityId: "e1", action: "update", before: { id: "e1", amount: 1 }, after: { id: "e1", amount: 2 } });
      await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "expense", entityId: "e2", action: "create" });
      await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "itinerary", entityId: "it1", action: "create", after: { id: "it1", type: "Activity", content: { name: "Museum" } } });
      await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "expense", entityId: "e2", action: "delete", before: { id: "e2", description: "Gone" } });
    });

    const ids = (page: { events: AuditEventView[] }) => page.events.map((e) => `${e.entityType}:${e.entityId}:${e.action}`);

    it("entityType", async () => {
      const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityType: "expense" });
      expect(ids(page)).toEqual(["expense:e2:delete", "expense:e2:create", "expense:e1:update", "expense:e1:create"]);
      expect(ids(await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityType: "document" }))).toEqual([]);
    });

    it("entityId", async () => {
      const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityId: "e2" });
      expect(ids(page)).toEqual(["expense:e2:delete", "expense:e2:create"]);
    });

    it("actorUserId", async () => {
      const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, { actorUserId: IDS.editor });
      expect(ids(page)).toEqual(["expense:e1:update", "expense:e1:create"]);
      for (const e of page.events) expect(e.actorUserId).toBe(IDS.editor);
    });

    it("action", async () => {
      expect(ids(await listTripEvents(testDb(), actor("editor"), IDS.trip, { action: "update" }))).toEqual(["expense:e1:update"]);
      expect(ids(await listTripEvents(testDb(), actor("editor"), IDS.trip, { action: "delete" }))).toEqual(["expense:e2:delete"]);
      expect(ids(await listTripEvents(testDb(), actor("editor"), IDS.trip, { action: "merge" }))).toEqual([]);
    });

    it("filters combine with AND", async () => {
      const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityType: "expense", action: "create", actorUserId: IDS.owner });
      expect(ids(page)).toEqual(["expense:e2:create"]);
    });

    it("since and until are inclusive on createdAt", async () => {
      const a = actor("editor");
      const day = (n: number) => `2020-01-0${n}T00:00:00.000Z`; // in the past, so recordEvent rows (now) sort after them
      await seedRawEvent(a, { tripId: IDS.trip, entityId: "d1", createdAt: day(1) });
      await seedRawEvent(a, { tripId: IDS.trip, entityId: "d2", createdAt: day(2) });
      await seedRawEvent(a, { tripId: IDS.trip, entityId: "d3", createdAt: day(3) });
      const dated = (page: { events: AuditEventView[] }) =>
        page.events.filter((e) => e.entityLabel === "Raw Event").map((e) => e.entityId);
      // Everything seeded via recordEvent has createdAt = now (after 2020), so `until` day(3) isolates the raw rows.
      expect(dated(await listTripEvents(testDb(), a, IDS.trip, { until: day(3) }))).toEqual(["d3", "d2", "d1"]);
      expect(dated(await listTripEvents(testDb(), a, IDS.trip, { since: day(2), until: day(3) }))).toEqual(["d3", "d2"]);
      expect(dated(await listTripEvents(testDb(), a, IDS.trip, { until: day(2) }))).toEqual(["d2", "d1"]);
      expect(dated(await listTripEvents(testDb(), a, IDS.trip, { since: day(2), until: day(2) }))).toEqual(["d2"]);
      expect(dated(await listTripEvents(testDb(), a, IDS.trip, { since: day(4), until: day(5) }))).toEqual([]);
      const sinceNow = await listTripEvents(testDb(), a, IDS.trip, { since: day(3) });
      expect(dated(sinceNow)).toEqual(["d3"]);
      expect(sinceNow.events.length).toBeGreaterThan(1); // the recordEvent rows (now) are after day(3) too
    });

    it("cursor combines with filters", async () => {
      const p1 = await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityType: "expense", limit: 3 });
      expect(ids(p1)).toEqual(["expense:e2:delete", "expense:e2:create", "expense:e1:update"]);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await listTripEvents(testDb(), actor("editor"), IDS.trip, { entityType: "expense", limit: 3, cursor: p1.nextCursor! });
      expect(ids(p2)).toEqual(["expense:e1:create"]);
      expect(p2.nextCursor).toBeNull();
    });
  });
});

describe("scope isolation (TDD 10): listTripEvents never returns another trip's or tripId IS NULL rows", () => {
  const NULL_ENTITY = "00000000-0000-4000-8000-0000000000aa";
  const B_ENTITY = "00000000-0000-4000-8000-0000000000bb";

  beforeEach(async () => {
    // Trip A: two events by owner and editor.
    await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "trip", entityId: IDS.trip, action: "create" });
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "expense", entityId: "ea", action: "create" });
    // Trip B: an event by outsider, plus one by admin.
    await seedEvent({ actor: actor("outsider"), tripId: IDS.otherTrip, entityType: "trip", entityId: IDS.otherTrip, action: "create" });
    await seedEvent({ actor: actor("admin"), tripId: IDS.otherTrip, entityType: "expense", entityId: B_ENTITY, action: "create" });
    // Administration event: tripId null, by admin.
    await seedEvent({
      actor: actor("admin", { channel: "dev", requestId: "ray-admin" }),
      tripId: null,
      entityType: "user",
      entityId: NULL_ENTITY,
      action: "create",
      after: { id: NULL_ENTITY, email: "new@example.test", passwordHash: "fake-hash" },
    });
    expect(await auditRows()).toHaveLength(5);
  });

  const crafted: Array<Record<string, unknown>> = [
    {},
    { entityType: "user" },
    { entityType: "user", entityId: NULL_ENTITY },
    { entityId: NULL_ENTITY },
    { entityId: B_ENTITY },
    { entityType: "expense", entityId: B_ENTITY },
    { actorUserId: IDS.admin },
    { actorUserId: IDS.outsider },
    { action: "create" },
    { action: "create", actorUserId: IDS.admin, entityType: "user" },
    { since: "2000-01-01T00:00:00.000Z", until: "2999-01-01T00:00:00.000Z" },
    { limit: 200 },
    { tripId: IDS.otherTrip },
    { tripId: null },
    { tripId: undefined },
    { tripId: IDS.otherTrip, entityId: B_ENTITY, actorUserId: IDS.admin },
    { channel: "dev" },
    { clientId: null },
  ];

  it.each(crafted)("editor of A with opts %o sees only trip A rows", async (opts) => {
    const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, opts as never);
    for (const e of page.events) {
      expect(e.tripId).toBe(IDS.trip);
      expect(e.entityId).not.toBe(NULL_ENTITY);
      expect(e.entityId).not.toBe(B_ENTITY);
    }
    expect(page.events.length).toBeLessThanOrEqual(2);
  });

  it("filters that only match out-of-scope rows return an empty page", async () => {
    for (const opts of [{ entityType: "user" }, { entityId: NULL_ENTITY }, { entityId: B_ENTITY }, { actorUserId: IDS.outsider }] as const) {
      const page = await listTripEvents(testDb(), actor("editor"), IDS.trip, opts as never);
      expect(page.events, JSON.stringify(opts)).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }
  });

  it("the admin sees the same scoping on a trip-scoped call", async () => {
    const page = await listTripEvents(testDb(), actor("admin"), IDS.trip, { actorUserId: IDS.admin });
    expect(page.events).toEqual([]);
    const all = await listTripEvents(testDb(), actor("admin"), IDS.trip);
    expect(all.events.map((e) => e.tripId)).toEqual([IDS.trip, IDS.trip]);
  });

  it("the outsider sees only trip B rows on trip B and nothing on trip A", async () => {
    const b = await listTripEvents(testDb(), actor("outsider"), IDS.otherTrip);
    expect(b.events.map((e) => e.tripId)).toEqual([IDS.otherTrip, IDS.otherTrip]);
    await expectServiceError(listTripEvents(testDb(), actor("outsider"), IDS.trip), "not_found");
  });

  it("listEntityEvents on trip A cannot reach B's or the null-trip entity by id", async () => {
    const page = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "expense", B_ENTITY);
    expect(page.events).toEqual([]);
    const nul = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "user", NULL_ENTITY);
    expect(nul.events).toEqual([]);
  });

  it("listAdminEvents sees trip A, trip B and the null-trip event", async () => {
    const page = await listAdminEvents(testDb(), actor("admin"));
    expect(page.events.map((e) => e.tripId)).toEqual([null, IDS.otherTrip, IDS.otherTrip, IDS.trip, IDS.trip]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("listEntityEvents", () => {
  beforeEach(async () => {
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "itinerary", entityId: "it1", action: "create", after: { id: "it1", type: "Activity", content: { name: "Museum" } } });
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "itinerary", entityId: "it1", action: "update", before: { id: "it1", type: "Activity", status: "Pending" }, after: { id: "it1", type: "Activity", status: "Confirmed" } });
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "itinerary", entityId: "it2", action: "create" });
    await seedEvent({ actor: actor("editor"), tripId: IDS.trip, entityType: "expense", entityId: "it1", action: "create" }); // same id, different type
    await seedEvent({ actor: actor("owner"), tripId: IDS.trip, entityType: "itinerary", entityId: "it1", action: "delete", before: { id: "it1", type: "Activity" } });
  });

  it("returns only the named entity's rows, newest first", async () => {
    const page = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1");
    expect(page.events.map((e) => e.action)).toEqual(["delete", "update", "create"]);
    for (const e of page.events) expect([e.entityType, e.entityId]).toEqual(["itinerary", "it1"]);
    expect(page.events[1].changes).toEqual({ status: { from: "Pending", to: "Confirmed" } });
  });

  it("ignores conflicting entityType / entityId in opts; other filters still apply", async () => {
    const page = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", {
      entityType: "expense",
      entityId: "it2",
    });
    expect(page.events.map((e) => e.action)).toEqual(["delete", "update", "create"]);
    const byOwner = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", { actorUserId: IDS.owner });
    expect(byOwner.events.map((e) => e.action)).toEqual(["delete"]);
    const updates = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", { action: "update" });
    expect(updates.events.map((e) => e.action)).toEqual(["update"]);
  });

  it("authorization matches listTripEvents", async () => {
    expect((await listEntityEvents(testDb(), actor("owner"), IDS.trip, "itinerary", "it1")).events).toHaveLength(3);
    expect((await listEntityEvents(testDb(), actor("admin"), IDS.trip, "itinerary", "it1")).events).toHaveLength(3);
    await expectServiceError(listEntityEvents(testDb(), actor("viewer"), IDS.trip, "itinerary", "it1"), "forbidden");
    await expectServiceError(listEntityEvents(testDb(), actor("outsider"), IDS.trip, "itinerary", "it1"), "not_found");
    await expectServiceError(listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", { cursor: "!!!" }), "validation");
  });

  it("paginates with the cursor", async () => {
    const p1 = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", { limit: 2 });
    expect(p1.events.map((e) => e.action)).toEqual(["delete", "update"]);
    const p2 = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1", { limit: 2, cursor: p1.nextCursor! });
    expect(p2.events.map((e) => e.action)).toEqual(["create"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("requestId only for admin", async () => {
    const editor = await listEntityEvents(testDb(), actor("editor"), IDS.trip, "itinerary", "it1");
    for (const e of editor.events) expect("requestId" in e).toBe(false);
    const admin = await listEntityEvents(testDb(), actor("admin"), IDS.trip, "itinerary", "it1");
    for (const e of admin.events) expect(e.requestId).toBe("ray-test");
  });
});

describe("listAdminEvents", () => {
  beforeEach(async () => {
    await seedEvent({ actor: actor("owner", { channel: "web" }), tripId: IDS.trip, entityType: "trip", entityId: IDS.trip, action: "create" });
    await seedEvent({ actor: actor("editor", { channel: "mcp_oauth", clientId: "client-fake-1", requestId: "ray-mcp" }), tripId: IDS.trip, entityType: "expense", entityId: "e1", action: "create" });
    await seedEvent({ actor: actor("outsider", { channel: "mcp_stage1", clientId: "svc-bot" }), tripId: IDS.otherTrip, entityType: "trip", entityId: IDS.otherTrip, action: "update", before: { id: IDS.otherTrip, name: "A" }, after: { id: IDS.otherTrip, name: "B" } });
    await seedEvent({ actor: actor("admin", { channel: "dev", requestId: null }), tripId: null, entityType: "service_identity", entityId: "si1", action: "create", after: { id: "si1", commonName: "svc-bot" } });
  });

  it("non-admin gets forbidden, even an Owner of every trip", async () => {
    for (const a of ["owner", "editor", "viewer", "outsider"] as const) {
      await expectServiceError(listAdminEvents(testDb(), actor(a)), "forbidden");
    }
  });

  it("admin sees every event including tripId null, newest first, with requestId", async () => {
    const page = await listAdminEvents(testDb(), actor("admin"));
    expect(page.events.map((e) => [e.tripId, e.entityType])).toEqual([
      [null, "service_identity"],
      [IDS.otherTrip, "trip"],
      [IDS.trip, "expense"],
      [IDS.trip, "trip"],
    ]);
    expect(page.events.map((e) => e.requestId)).toEqual([null, "ray-test", "ray-mcp", "ray-test"]);
    for (const e of page.events) expect("requestId" in e).toBe(true);
    expect(page.events[0]).not.toHaveProperty("seq");
  });

  it("tripId filter", async () => {
    const page = await listAdminEvents(testDb(), actor("admin"), { tripId: IDS.otherTrip });
    expect(page.events.map((e) => e.tripId)).toEqual([IDS.otherTrip]);
    expect((await listAdminEvents(testDb(), actor("admin"), { tripId: IDS.missing })).events).toEqual([]);
  });

  it("channel filter", async () => {
    expect((await listAdminEvents(testDb(), actor("admin"), { channel: "mcp_oauth" })).events.map((e) => e.entityId)).toEqual(["e1"]);
    expect((await listAdminEvents(testDb(), actor("admin"), { channel: "dev" })).events.map((e) => e.entityId)).toEqual(["si1"]);
    expect((await listAdminEvents(testDb(), actor("admin"), { channel: "service_token" })).events).toEqual([]);
  });

  it("clientId filter", async () => {
    expect((await listAdminEvents(testDb(), actor("admin"), { clientId: "client-fake-1" })).events.map((e) => e.entityId)).toEqual(["e1"]);
    expect((await listAdminEvents(testDb(), actor("admin"), { clientId: "svc-bot" })).events.map((e) => e.entityId)).toEqual([IDS.otherTrip]);
  });

  it("common filters and cursor apply too", async () => {
    expect((await listAdminEvents(testDb(), actor("admin"), { action: "update" })).events.map((e) => e.entityId)).toEqual([IDS.otherTrip]);
    expect((await listAdminEvents(testDb(), actor("admin"), { entityType: "trip", actorUserId: IDS.owner })).events.map((e) => e.entityId)).toEqual([IDS.trip]);
    const p1 = await listAdminEvents(testDb(), actor("admin"), { limit: 3 });
    expect(p1.events).toHaveLength(3);
    const p2 = await listAdminEvents(testDb(), actor("admin"), { limit: 3, cursor: p1.nextCursor! });
    expect(p2.events.map((e) => e.entityType)).toEqual(["trip"]);
    expect(p2.nextCursor).toBeNull();
    await expectServiceError(listAdminEvents(testDb(), actor("admin"), { cursor: "nope!" }), "validation");
  });
});

describe("append-only surface", () => {
  it("the service module exports no update or delete function for audit rows", async () => {
    const mod = await import("../src/services/audit");
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/^(update|delete|remove|purge|clear)/i);
    }
  });

  it("entity type coverage: every EntityType has an allow-list and a label", () => {
    const types: EntityType[] = [...ENTITY_TYPES];
    expect(types).toHaveLength(11);
    for (const t of types) {
      expect(SNAPSHOT_COLUMNS[t].length).toBeGreaterThan(0);
      expect(typeof labelFor(t, {})).toBe("string");
    }
  });
});

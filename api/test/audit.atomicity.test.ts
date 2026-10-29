// Atomicity of every audited write (specs/AUDIT_TDD.md 7.1, 11 "audit.atomicity.test.ts").
//
// Each service composes its data statement(s) and the audit event in one `db.batch([...])`.
// If the batch fails, neither the data row nor the event may land. This file proves that in
// three independent ways:
//
// 1. A failing `db` built with `Object.create(db, { batch: { value: () => reject("boom") } })`.
//    Drizzle's D1 client exposes `batch` as a prototype method and every service calls
//    `db.batch(...)` on the object it receives, so the own property shadows it while
//    `select` / `insert` / `update` / `delete` keep working through the prototype chain
//    (reads still hit the real D1; statement builders are inert until batched). For every
//    write function: seed with the real db, call with the failing db, assert "boom", then
//    assert every application table (and audit_events) is byte-identical to before.
// 2. A positive control: the same calls against the real db succeed and record exactly the
//    documented events, so section 1 is not passing vacuously.
// 3. A D1-level proof that does not use the override: a batch whose second statement violates
//    a NOT NULL constraint leaves the first statement's effect unapplied. The insert case
//    already lives in services.audit.test.ts ("a failing second statement rolls back the data
//    insert"); here the update and delete cases are added so all three verbs are covered.
import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/db";
import {
  auditEvents,
  documents,
  expenses,
  invites,
  itineraries,
  participants,
  serviceIdentities,
  trips,
  userEmails,
  users,
} from "../src/db/schema";
import { mergeAccountsD1 } from "../src/lib/merge";
import type { Db } from "../src/services/access";
import { createDocument, deleteDocument, updateDocument } from "../src/services/documents";
import { createExpense, deleteExpense, updateExpense } from "../src/services/expenses";
import { acceptInvite, createInvite, deleteInvite, type Invite } from "../src/services/invites";
import { createItinerary, deleteItinerary, updateItinerary } from "../src/services/itineraries";
import { createParticipant, deleteParticipant, updateParticipant } from "../src/services/participants";
import { createTrip, deleteTrip, updateTrip } from "../src/services/trips";
import {
  createServiceIdentity,
  createUser,
  deleteServiceIdentity,
  deleteUser,
  linkEmail,
  setPrimaryEmail,
  unlinkEmail,
  updateProfile,
  updateUser,
} from "../src/services/users";
import {
  addParticipant,
  addUserEmail,
  errorOf,
  seedExpense,
  seedItinerary,
  seedTrip,
  seedUser,
  testDb,
  type SeededTrip,
  type SeededUser,
} from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

// --- The seam ---

/**
 * A db whose `batch` always rejects with "boom" while everything else is the real client.
 * This is the exact construction the TDD prescribes; see the file header for why it intercepts.
 */
function failingDb(db: Db): Db {
  return Object.create(db, { batch: { value: () => Promise.reject(new Error("boom")) } }) as Db;
}

// --- Full-storage snapshot ---

type Row = { id: string };
const byId = <T extends Row>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Every application table, rows sorted by id, plus audit_events in seq order. Serialised to a
 * string so the "unchanged" assertion is byte-for-byte (including `updatedAt`), not merely
 * structurally equal.
 */
async function snapshotAll(): Promise<string> {
  const db = testDb();
  const state = {
    users: byId(await db.select().from(users)),
    userEmails: byId(await db.select().from(userEmails)),
    serviceIdentities: byId(await db.select().from(serviceIdentities)),
    trips: byId(await db.select().from(trips)),
    participants: byId(await db.select().from(participants)),
    itineraries: byId(await db.select().from(itineraries)),
    expenses: byId(await db.select().from(expenses)),
    documents: byId(await db.select().from(documents)),
    invites: byId(await db.select().from(invites)),
    auditEvents: await db.select().from(auditEvents).orderBy(asc(auditEvents.seq)),
  };
  return JSON.stringify(state);
}

// --- Fixtures ---

let admin: SeededUser;
let owner: SeededUser;
let adminActor: Actor;
let ownerActor: Actor;
let trip: SeededTrip;

beforeEach(async () => {
  admin = await seedUser("admin@example.test", "admin");
  owner = await seedUser("owner@example.test", "editor");
  adminActor = toActor(admin);
  ownerActor = toActor(owner);
  trip = (await seedTrip(owner.id, { name: "Atomic Trip" })).trip;
});

const seedDocument = async (tripId: string) => {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    tripId,
    reservationId: null,
    fileUrl: "https://example.test/fake-receipt.pdf",
    documentType: "OTHER",
    name: "Fake Receipt",
    createdAt: now,
    updatedAt: now,
  };
  await testDb().insert(documents).values(row);
  return row;
};

const seedInvite = async (tripId: string, invitedBy: string, name: string | null = "Invited Person"): Promise<Invite> => {
  const now = new Date();
  const row: Invite = {
    id: crypto.randomUUID(),
    tripId,
    participantId: null,
    email: null,
    name,
    role: "Viewer",
    token: `fake-invite-token-${crypto.randomUUID()}`,
    status: "pending",
    invitedBy,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now.toISOString(),
  };
  await testDb().insert(invites).values(row);
  return row;
};

const activityContent = { name: "Fake Museum", startTime: "2030-01-11T10:00" };

/**
 * One audited write. `seed` runs against the real db and returns the call to make; `events`
 * is the exact ordered list of `entityType.action` the real-db run must record.
 */
interface WriteCase {
  name: string;
  seed: () => Promise<(db: Db) => Promise<unknown>>;
  events: string[];
}

const CASES: WriteCase[] = [
  // trips
  {
    name: "createTrip",
    seed: async () => (db) => createTrip(db, ownerActor, { name: "Another Trip" }),
    events: ["trip.create"],
  },
  {
    name: "updateTrip",
    seed: async () => (db) => updateTrip(db, ownerActor, trip.id, { name: "Renamed Trip" }),
    events: ["trip.update"],
  },
  {
    name: "deleteTrip",
    seed: async () => {
      // Children so the delete has something to cascade and count.
      await seedItinerary(trip.id);
      await seedExpense(trip.id);
      return (db) => deleteTrip(db, ownerActor, trip.id);
    },
    events: ["trip.delete"],
  },
  // itineraries
  {
    name: "createItinerary",
    seed: async () => (db) =>
      createItinerary(db, ownerActor, trip.id, { type: "Activity", status: "Pending", content: activityContent }),
    events: ["itinerary.create"],
  },
  {
    name: "updateItinerary",
    seed: async () => {
      const it = await seedItinerary(trip.id);
      return (db) => updateItinerary(db, ownerActor, trip.id, it.id, { notes: "changed notes" });
    },
    events: ["itinerary.update"],
  },
  {
    name: "deleteItinerary",
    seed: async () => {
      const it = await seedItinerary(trip.id);
      return (db) => deleteItinerary(db, ownerActor, trip.id, it.id);
    },
    events: ["itinerary.delete"],
  },
  // expenses
  {
    name: "createExpense",
    seed: async () => (db) =>
      createExpense(db, ownerActor, trip.id, {
        description: "Fake Dinner",
        amount: 12.5,
        currency: "USD",
        category: "Food",
        splitType: "EQUAL",
      }),
    events: ["expense.create"],
  },
  {
    name: "updateExpense",
    seed: async () => {
      const e = await seedExpense(trip.id);
      return (db) => updateExpense(db, ownerActor, trip.id, e.id, { description: "Changed Dinner" });
    },
    events: ["expense.update"],
  },
  {
    name: "deleteExpense",
    seed: async () => {
      const e = await seedExpense(trip.id);
      return (db) => deleteExpense(db, ownerActor, trip.id, e.id);
    },
    events: ["expense.delete"],
  },
  // participants
  {
    name: "createParticipant",
    seed: async () => (db) => createParticipant(db, ownerActor, trip.id, { name: "New Traveler", role: "Viewer" }),
    events: ["participant.create"],
  },
  {
    name: "updateParticipant",
    seed: async () => {
      const p = await addParticipant(trip.id, null, "Viewer", { name: "Guest" });
      return (db) => updateParticipant(db, ownerActor, trip.id, p.id, { name: "Renamed Guest" });
    },
    events: ["participant.update"],
  },
  {
    name: "deleteParticipant",
    seed: async () => {
      const p = await addParticipant(trip.id, null, "Viewer", { name: "Guest" });
      return (db) => deleteParticipant(db, ownerActor, trip.id, p.id);
    },
    events: ["participant.delete"],
  },
  // documents
  {
    name: "createDocument",
    seed: async () => (db) =>
      createDocument(db, ownerActor, trip.id, {
        fileUrl: "https://example.test/fake-ticket.pdf",
        documentType: "PDF_TICKET",
        name: "Fake Ticket",
      }),
    events: ["document.create"],
  },
  {
    name: "updateDocument",
    seed: async () => {
      const d = await seedDocument(trip.id);
      return (db) => updateDocument(db, ownerActor, trip.id, d.id, { name: "Renamed Receipt" });
    },
    events: ["document.update"],
  },
  {
    name: "deleteDocument",
    seed: async () => {
      const d = await seedDocument(trip.id);
      return (db) => deleteDocument(db, ownerActor, trip.id, d.id);
    },
    events: ["document.delete"],
  },
  // invites
  {
    name: "createInvite",
    seed: async () => (db) => createInvite(db, ownerActor, trip.id, { name: "Invitee" }),
    events: ["invite.create"],
  },
  {
    name: "deleteInvite",
    seed: async () => {
      const inv = await seedInvite(trip.id, owner.id);
      return (db) => deleteInvite(db, ownerActor, trip.id, inv.id);
    },
    events: ["invite.delete"],
  },
  {
    name: "acceptInvite (rename + new participant + status)",
    seed: async () => {
      // The invite names the user differently and the user is not yet on the trip, so the
      // batch holds all three data statements and all three events (TDD 7.2).
      const guest = await seedUser("guest@example.test", "viewer", { name: "Old Name" });
      const inv = await seedInvite(trip.id, owner.id, "Invite Name");
      return (db) => acceptInvite(db, toActor(guest), inv);
    },
    events: ["user.update", "participant.create", "invite.accept"],
  },
  // users (administration, TDD 7.3)
  {
    name: "createUser",
    seed: async () => (db) => createUser(db, adminActor, { email: "new@example.test", name: "New User", role: "viewer" }),
    events: ["user.create"],
  },
  {
    name: "updateUser",
    seed: async () => (db) => updateUser(db, adminActor, owner.id, { name: "Renamed Owner" }),
    events: ["user.update"],
  },
  {
    name: "updateProfile",
    seed: async () => (db) => updateProfile(db, ownerActor, { name: "Self Renamed" }),
    events: ["user.update"],
  },
  {
    name: "deleteUser",
    seed: async () => {
      const victim = await seedUser("victim@example.test", "viewer");
      return (db) => deleteUser(db, adminActor, victim.id, { revokedGrants: 0 });
    },
    events: ["user.delete"],
  },
  {
    name: "linkEmail",
    seed: async () => (db) => linkEmail(db, ownerActor, owner.id, "owner-alt@example.test"),
    events: ["user_email.link"],
  },
  {
    name: "unlinkEmail",
    seed: async () => {
      await addUserEmail(owner.id, "owner-alt@example.test");
      const alt = (await testDb().select().from(userEmails)).find((e) => e.email === "owner-alt@example.test")!;
      return (db) => unlinkEmail(db, ownerActor, alt.id);
    },
    events: ["user_email.unlink"],
  },
  {
    name: "setPrimaryEmail",
    seed: async () => {
      await addUserEmail(owner.id, "owner-alt@example.test");
      const alt = (await testDb().select().from(userEmails)).find((e) => e.email === "owner-alt@example.test")!;
      return (db) => setPrimaryEmail(db, ownerActor, alt.id);
    },
    events: ["user_email.set_primary"],
  },
  {
    name: "createServiceIdentity",
    seed: async () => (db) =>
      createServiceIdentity(db, adminActor, {
        cfAccessSubject: "fake-access-subject-0001",
        commonName: "fake-service.example.test",
        userId: owner.id,
      }),
    events: ["service_identity.create"],
  },
  {
    name: "deleteServiceIdentity",
    seed: async () => {
      const row = {
        id: crypto.randomUUID(),
        cfAccessSubject: "fake-access-subject-0002",
        commonName: "fake-service-2.example.test",
        userId: owner.id,
        createdAt: new Date().toISOString(),
      };
      await testDb().insert(serviceIdentities).values(row);
      return (db) => deleteServiceIdentity(db, adminActor, row.id);
    },
    events: ["service_identity.delete"],
  },
  {
    name: "mergeAccountsD1",
    seed: async () => {
      // Shared trip with a higher role on the merged user, an expense paid by the merged
      // user's participant row, and a second trip only the merged user is on: every branch
      // of the merge contributes a statement to the batch.
      const gone = await seedUser("gone@example.test", "editor");
      const goneP = await addParticipant(trip.id, gone.id, "Owner");
      await seedExpense(trip.id, { payerId: goneP.id, description: "Gone paid" });
      const other = (await seedTrip(gone.id, { name: "Gone Only Trip" })).trip;
      await seedInvite(other.id, gone.id);
      return (db) => mergeAccountsD1(db, adminActor, owner.id, gone.id);
    },
    events: ["user.merge"],
  },
];

// --- 0. The seam itself ---

describe("failingDb seam", () => {
  it("reads go through to the real D1 while batch rejects with boom", async () => {
    const db = failingDb(testDb());
    expect(await db.select().from(trips)).toHaveLength(1);
    expect(typeof db.insert).toBe("function");
    const err = await errorOf(db.batch([db.select().from(trips)]));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
  });
});

// --- 1. Failing batch: nothing changes ---

describe("when db.batch rejects, no data row and no audit row is written", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const run = await c.seed();
      const before = await snapshotAll();
      expect(JSON.parse(before).auditEvents).toHaveLength(0);

      const err = await errorOf(run(failingDb(testDb())));
      expect(err, `${c.name} should reject`).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("boom");

      const after = await snapshotAll();
      expect(after).toBe(before);
      expect(await auditRows()).toHaveLength(0);
    });
  }
});

// --- 2. Positive control: the real db writes exactly the documented events ---

describe("positive control: the same call on the real db succeeds and records its events", () => {
  for (const c of CASES) {
    it(`${c.name} records ${c.events.join(", ")}`, async () => {
      const run = await c.seed();
      const before = await snapshotAll();

      await run(testDb());

      const after = await snapshotAll();
      expect(after).not.toBe(before);
      const rows = await auditRows();
      expect(rows.map((r) => `${r.entityType}.${r.action}`)).toEqual(c.events);
    });
  }
});

// --- 3. D1-level rollback without the override ---
//
// The insert case ("a failing second statement rolls back the data insert") is in
// services.audit.test.ts and is not repeated here. These cover UPDATE and DELETE: a hand-built
// audit insert missing the NOT NULL `entity_label` fails inside the batch and D1 rolls back
// the data statement that preceded it.

function badAuditInsert(db: Db, tripId: string) {
  return db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    actorUserId: owner.id,
    actorName: "Owner User",
    actorEmail: "owner@example.test",
    actorRole: "editor",
    channel: "web",
    tripId,
    entityType: "trip",
    entityId: tripId,
    action: "update",
  } as unknown as typeof auditEvents.$inferInsert);
}

describe("D1 batch rollback (no override)", () => {
  it("a failing audit insert rolls back a preceding UPDATE", async () => {
    const db = testDb();
    const before = await snapshotAll();
    const err = await errorOf(
      db.batch([
        db.update(trips).set({ name: "Should Not Persist", updatedAt: new Date().toISOString() }),
        badAuditInsert(db, trip.id),
      ])
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/NOT NULL/i);
    expect(await snapshotAll()).toBe(before);
    expect((await db.select().from(trips))[0].name).toBe("Atomic Trip");
  });

  it("a failing audit insert rolls back a preceding DELETE", async () => {
    const db = testDb();
    const before = await snapshotAll();
    const err = await errorOf(db.batch([db.delete(trips), badAuditInsert(db, trip.id)]));
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/NOT NULL/i);
    expect(await snapshotAll()).toBe(before);
    expect(await db.select().from(trips)).toHaveLength(1);
  });
});

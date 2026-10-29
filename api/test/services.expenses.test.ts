// services/expenses.ts: listExpenses (payerName), createExpense, updateExpense, deleteExpense.
// Called directly (no requireTripEditor middleware in front), as the MCP tools call them.
// Every write records exactly one audit event in the same batch (TDD 7.2); the audit
// assertions live in the "audit events" block at the bottom.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor as AuthActor } from "../src/db";
import { expenses } from "../src/db/schema";
import { createExpense, deleteExpense, listExpenses, updateExpense, type CreateExpense } from "../src/services/expenses";
import {
  IDS,
  addParticipant,
  dbState,
  expectServiceError,
  seedExpense,
  seedRoleWorld,
  testDb,
  type Actor,
  type RoleWorld,
} from "./helpers";
import { auditRows, toActor } from "./helpers/audit";

let w: RoleWorld;
const auth = (a: Actor): AuthActor => toActor(w.users[a]);

const EX = {
  paidByEditor: "00000000-0000-4000-8000-0000000f0001",
  paidByGuest: "00000000-0000-4000-8000-0000000f0002",
  noPayer: "00000000-0000-4000-8000-0000000f0003",
  otherTrip: "00000000-0000-4000-8000-0000000f0004",
} as const;

const input: CreateExpense = { description: "Fake dinner", amount: 12.5, currency: "USD", category: "Food", splitType: "EQUAL" };

beforeEach(async () => {
  w = await seedRoleWorld();
  await seedExpense(IDS.trip, { id: EX.paidByEditor, description: "Taxi", payerId: IDS.editorP, category: "Transport" });
  await seedExpense(IDS.trip, { id: EX.paidByGuest, description: "Snacks", payerId: IDS.guestP });
  await seedExpense(IDS.trip, { id: EX.noPayer, description: "Tips", payerId: null });
  await seedExpense(IDS.otherTrip, { id: EX.otherTrip, description: "Elsewhere", payerId: IDS.outsiderP });
});

describe("listExpenses", () => {
  it("returns the trip's expenses with payerName (null when there is no payer)", async () => {
    const rows = await listExpenses(testDb(), auth("owner"), IDS.trip);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([EX.paidByEditor, EX.paidByGuest, EX.noPayer].sort());
    expect(byId[EX.paidByEditor]).toMatchObject({ description: "Taxi", payerId: IDS.editorP, payerName: "Editor User", tripId: IDS.trip });
    expect(byId[EX.paidByGuest].payerName).toBe("Guest Traveler");
    expect(byId[EX.noPayer]).toMatchObject({ payerId: null, payerName: null });
  });

  it("every member role can read; Viewers get the same rows and fields", async () => {
    const owner = await listExpenses(testDb(), auth("owner"), IDS.trip);
    for (const a of ["editor", "viewer", "admin"] as const) {
      const rows = await listExpenses(testDb(), auth(a), IDS.trip);
      expect(rows.sort((x, y) => x.id.localeCompare(y.id)), a).toEqual(owner.sort((x, y) => x.id.localeCompare(y.id)));
    }
  });

  it("a payer participant on another trip does not resolve its name (join is scoped to the trip)", async () => {
    await seedExpense(IDS.trip, { id: "00000000-0000-4000-8000-0000000f0009", payerId: IDS.outsiderP });
    const rows = await listExpenses(testDb(), auth("owner"), IDS.trip);
    expect(rows.find((r) => r.id === "00000000-0000-4000-8000-0000000f0009")?.payerName).toBeNull();
  });

  it("non-member is not_found; admin on a missing trip gets []", async () => {
    await expectServiceError(listExpenses(testDb(), auth("outsider"), IDS.trip), "not_found", "Trip not found");
    await expectServiceError(listExpenses(testDb(), auth("viewer"), IDS.missing), "not_found", "Trip not found");
    expect(await listExpenses(testDb(), auth("admin"), IDS.missing)).toEqual([]);
  });
});

describe("createExpense", () => {
  it("Editor, Owner and admin can create; the row is stored as returned", async () => {
    for (const a of ["editor", "owner", "admin"] as const) {
      const row = await createExpense(testDb(), auth(a), IDS.trip, { ...input, payerId: IDS.viewerP });
      expect(row).toMatchObject({ ...input, payerId: IDS.viewerP, tripId: IDS.trip });
      const [stored] = await testDb().select().from(expenses).where(eq(expenses.id, row.id));
      expect(stored).toEqual(row);
    }
  });

  it("payerId defaults to null", async () => {
    const row = await createExpense(testDb(), auth("editor"), IDS.trip, input);
    expect(row.payerId).toBeNull();
  });

  it("Viewer is forbidden and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createExpense(testDb(), auth("viewer"), IDS.trip, input), "forbidden", "Forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("an unknown stored participant role cannot create (treated as Viewer)", async () => {
    const { users } = w;
    await addParticipant(IDS.otherTrip, users.viewer.id, "editor" as never);
    const before = await dbState();
    await expectServiceError(createExpense(testDb(), auth("viewer"), IDS.otherTrip, input), "forbidden");
    expect(await dbState()).toEqual(before);
  });

  it("non-member is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createExpense(testDb(), auth("outsider"), IDS.trip, input), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("admin on a missing trip is not_found and nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(createExpense(testDb(), auth("admin"), IDS.missing, input), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });
});

describe("updateExpense", () => {
  it("Editor can patch; the merged row is stored", async () => {
    const row = await updateExpense(testDb(), auth("editor"), IDS.trip, EX.noPayer, { amount: 99, payerId: IDS.ownerP });
    expect(row).toMatchObject({ id: EX.noPayer, description: "Tips", amount: 99, payerId: IDS.ownerP });
    const [stored] = await testDb().select().from(expenses).where(eq(expenses.id, EX.noPayer));
    expect(stored).toEqual(row);
  });

  it("Viewer is forbidden; non-member is not_found; nothing is written", async () => {
    const before = await dbState();
    await expectServiceError(updateExpense(testDb(), auth("viewer"), IDS.trip, EX.noPayer, { amount: 1 }), "forbidden", "Forbidden");
    await expectServiceError(updateExpense(testDb(), auth("outsider"), IDS.trip, EX.noPayer, { amount: 1 }), "not_found", "Trip not found");
    expect(await dbState()).toEqual(before);
  });

  it("an expense addressed through the wrong trip is not_found and is not modified", async () => {
    const before = await dbState();
    // outsider is Owner of otherTrip, but EX.paidByEditor belongs to trip.
    await expectServiceError(
      updateExpense(testDb(), auth("outsider"), IDS.otherTrip, EX.paidByEditor, { amount: 1 }),
      "not_found",
      "Expense not found"
    );
    expect(await dbState()).toEqual(before);
  });
});

describe("deleteExpense", () => {
  it("Editor deletes the expense", async () => {
    await deleteExpense(testDb(), auth("editor"), IDS.trip, EX.noPayer);
    expect(await testDb().select().from(expenses).where(eq(expenses.id, EX.noPayer))).toEqual([]);
  });

  it("Viewer is forbidden; non-member is not_found; cross-trip id is not_found; nothing is deleted", async () => {
    const before = await dbState();
    await expectServiceError(deleteExpense(testDb(), auth("viewer"), IDS.trip, EX.noPayer), "forbidden", "Forbidden");
    await expectServiceError(deleteExpense(testDb(), auth("outsider"), IDS.trip, EX.noPayer), "not_found", "Trip not found");
    await expectServiceError(deleteExpense(testDb(), auth("outsider"), IDS.otherTrip, EX.noPayer), "not_found", "Expense not found");
    expect(await dbState()).toEqual(before);
  });
});

describe("audit events", () => {
  const SNAPSHOT_KEYS = ["amount", "category", "currency", "description", "id", "payerId", "payerName", "splitType", "tripId"];

  it("createExpense records one expense.create with payerName resolved from the payer participant", async () => {
    const actor = auth("editor");
    const row = await createExpense(testDb(), actor, IDS.trip, { ...input, payerId: IDS.viewerP });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [ev] = rows;
    expect(ev).toMatchObject({
      actorUserId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      channel: "web",
      requestId: "ray-test",
      tripId: IDS.trip,
      entityType: "expense",
      entityId: row.id,
      entityLabel: "Fake dinner",
      action: "create",
      before: null,
      changes: null,
      metadata: null,
    });
    expect(Object.keys(ev.after as object).sort()).toEqual(SNAPSHOT_KEYS);
    expect(ev.after).toMatchObject({ id: row.id, tripId: IDS.trip, payerId: IDS.viewerP, payerName: "Viewer User", amount: 12.5 });
  });

  it("createExpense with no payer stores payerName null", async () => {
    const row = await createExpense(testDb(), auth("owner"), IDS.trip, input);
    const [ev] = await auditRows();
    expect(ev.entityId).toBe(row.id);
    expect(ev.after).toMatchObject({ payerId: null, payerName: null });
  });

  it("a rejected create records nothing", async () => {
    await expectServiceError(createExpense(testDb(), auth("viewer"), IDS.trip, input), "forbidden");
    await expectServiceError(createExpense(testDb(), auth("admin"), IDS.missing, input), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("updateExpense records one expense.update; changing the payer lists both payerId and payerName", async () => {
    const actor = auth("owner");
    await updateExpense(testDb(), actor, IDS.trip, EX.paidByEditor, { payerId: IDS.guestP, amount: 7 });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [ev] = rows;
    expect(ev).toMatchObject({
      actorUserId: actor.id,
      tripId: IDS.trip,
      entityType: "expense",
      entityId: EX.paidByEditor,
      entityLabel: "Taxi",
      action: "update",
    });
    expect(Object.keys(ev.before as object).sort()).toEqual(SNAPSHOT_KEYS);
    expect(Object.keys(ev.after as object).sort()).toEqual(SNAPSHOT_KEYS);
    expect(ev.before).toMatchObject({ payerId: IDS.editorP, payerName: "Editor User", amount: 42.5 });
    expect(ev.after).toMatchObject({ payerId: IDS.guestP, payerName: "Guest Traveler", amount: 7 });
    expect(ev.changes).toEqual({
      amount: { from: 42.5, to: 7 },
      payerId: { from: IDS.editorP, to: IDS.guestP },
      payerName: { from: "Editor User", to: "Guest Traveler" },
    });
  });

  it("clearing the payer records payerName going to null; before and after never carry timestamps", async () => {
    await updateExpense(testDb(), auth("editor"), IDS.trip, EX.paidByGuest, { payerId: null });
    const [ev] = await auditRows();
    expect(ev.changes).toEqual({
      payerId: { from: IDS.guestP, to: null },
      payerName: { from: "Guest Traveler", to: null },
    });
    expect(ev.before).not.toHaveProperty("updatedAt");
    expect(ev.after).not.toHaveProperty("createdAt");
  });

  it("a payer that is not a participant of this trip snapshots payerName null (lookup is trip-scoped)", async () => {
    // expenses.payerId has a FK to participants, so a dangling payer cannot exist; a payer on
    // another trip is the reachable case, and it resolves to null exactly as listExpenses does.
    const crossTrip = await seedExpense(IDS.trip, { description: "Cross", payerId: IDS.outsiderP });
    await updateExpense(testDb(), auth("editor"), IDS.trip, crossTrip.id, { amount: 1 });
    const [ev] = await auditRows();
    expect(ev.before).toMatchObject({ payerId: IDS.outsiderP, payerName: null });
    expect(ev.after).toMatchObject({ payerId: IDS.outsiderP, payerName: null });
    expect(ev.changes).toEqual({ amount: { from: 42.5, to: 1 } });
  });

  it("a no-op update records nothing, writes nothing and returns the stored row with updatedAt untouched", async () => {
    const [stored] = await testDb().select().from(expenses).where(eq(expenses.id, EX.paidByEditor));
    const before = await dbState();
    const row = await updateExpense(testDb(), auth("editor"), IDS.trip, EX.paidByEditor, {
      description: stored.description,
      amount: stored.amount,
      payerId: stored.payerId,
    });
    expect(row).toEqual(stored);
    expect(row.updatedAt).toBe(stored.updatedAt);
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("an empty patch is a no-op too", async () => {
    const before = await dbState();
    await updateExpense(testDb(), auth("editor"), IDS.trip, EX.noPayer, {});
    expect(await dbState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
  });

  it("a rejected update records nothing", async () => {
    await expectServiceError(updateExpense(testDb(), auth("viewer"), IDS.trip, EX.noPayer, { amount: 1 }), "forbidden");
    await expectServiceError(updateExpense(testDb(), auth("outsider"), IDS.otherTrip, EX.noPayer, { amount: 1 }), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("deleteExpense records one expense.delete with the before snapshot including payerName", async () => {
    const actor = auth("admin");
    await deleteExpense(testDb(), actor, IDS.trip, EX.paidByGuest);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [ev] = rows;
    expect(ev).toMatchObject({
      actorUserId: actor.id,
      actorRole: "admin",
      tripId: IDS.trip,
      entityType: "expense",
      entityId: EX.paidByGuest,
      entityLabel: "Snacks",
      action: "delete",
      after: null,
      changes: null,
    });
    expect(Object.keys(ev.before as object).sort()).toEqual(SNAPSHOT_KEYS);
    expect(ev.before).toMatchObject({ id: EX.paidByGuest, payerId: IDS.guestP, payerName: "Guest Traveler" });
  });

  it("a rejected delete records nothing", async () => {
    await expectServiceError(deleteExpense(testDb(), auth("viewer"), IDS.trip, EX.noPayer), "forbidden");
    await expectServiceError(deleteExpense(testDb(), auth("outsider"), IDS.otherTrip, EX.noPayer), "not_found");
    expect(await auditRows()).toEqual([]);
  });

  it("actor channel and clientId are copied from the Actor (MCP OAuth caller)", async () => {
    const actor = toActor(w.users.editor, { channel: "mcp_oauth", clientId: "client-fake", requestId: null });
    await createExpense(testDb(), actor, IDS.trip, input);
    const [ev] = await auditRows();
    expect(ev).toMatchObject({ channel: "mcp_oauth", clientId: "client-fake", requestId: null });
  });
});

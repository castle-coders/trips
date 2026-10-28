// services/expenses.ts: listExpenses (payerName), createExpense, updateExpense, deleteExpense.
// Called directly (no requireTripEditor middleware in front), as the MCP tools call them.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "../src/db";
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
  toAuth,
  type Actor,
  type RoleWorld,
} from "./helpers";

let w: RoleWorld;
const auth = (a: Actor): AuthUser => toAuth(w.users[a]);

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

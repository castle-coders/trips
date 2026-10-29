import { and, eq, getTableColumns } from "drizzle-orm";
import type { z } from "@hono/zod-openapi";
import type { AuthUser } from "../db";
import { expenses, participants, trips } from "../db/schema";
import type { CreateExpenseSchema, ExpenseSchema, UpdateExpenseSchema } from "../schemas/expense";
import { requireTripRole, type Db } from "./access";
import { ServiceError } from "./errors";

export type Expense = z.infer<typeof ExpenseSchema>;
export type ExpenseWithPayer = Expense & { payerName: string | null };
export type CreateExpense = z.infer<typeof CreateExpenseSchema>;
export type UpdateExpense = z.infer<typeof UpdateExpenseSchema>;

/**
 * All expenses on a trip (Viewer+). Left-joins participants so each row carries the payer's
 * name (null when there is no payer, the participant row is gone, or the payer is not a
 * participant of this trip: the join is scoped to the expense's trip). REST strips `payerName`
 * to keep its response shape; MCP uses it.
 * Admins are Owner everywhere with no trip-existence check, so a missing trip lists as [].
 */
export async function listExpenses(db: Db, user: AuthUser, tripId: string): Promise<ExpenseWithPayer[]> {
  await requireTripRole(db, user, tripId, "Viewer");
  const rows = await db
    .select({ ...getTableColumns(expenses), payerName: participants.name })
    .from(expenses)
    .leftJoin(participants, and(eq(expenses.payerId, participants.id), eq(participants.tripId, expenses.tripId)))
    .where(eq(expenses.tripId, tripId));
  return rows as ExpenseWithPayer[];
}

/** Create an expense (Editor+). 404 "Trip not found" when the trip does not exist (reachable by admins). */
export async function createExpense(
  db: Db,
  user: AuthUser,
  tripId: string,
  input: CreateExpense
): Promise<Expense> {
  await requireTripRole(db, user, tripId, "Editor");
  const trip = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId));
  if (!trip.length) throw new ServiceError("not_found", "Trip not found");
  const now = new Date().toISOString();
  const row: Expense = {
    id: crypto.randomUUID(),
    tripId,
    description: input.description,
    amount: input.amount,
    currency: input.currency,
    category: input.category,
    payerId: input.payerId ?? null,
    splitType: input.splitType,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(expenses).values(row);
  return row;
}

async function findExpense(db: Db, tripId: string, expenseId: string): Promise<Expense> {
  const existing = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.tripId, tripId)));
  if (!existing.length) throw new ServiceError("not_found", "Expense not found");
  return existing[0] as Expense;
}

/** Patch an expense (Editor+). 404 "Expense not found" when it is missing or on another trip. */
export async function updateExpense(
  db: Db,
  user: AuthUser,
  tripId: string,
  expenseId: string,
  patch: UpdateExpense
): Promise<Expense> {
  await requireTripRole(db, user, tripId, "Editor");
  const existing = await findExpense(db, tripId, expenseId);
  const updated: Expense = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await db.update(expenses).set(updated).where(eq(expenses.id, expenseId));
  return updated;
}

/** Delete an expense (Editor+). 404 "Expense not found" when it is missing or on another trip. */
export async function deleteExpense(db: Db, user: AuthUser, tripId: string, expenseId: string): Promise<void> {
  await requireTripRole(db, user, tripId, "Editor");
  await findExpense(db, tripId, expenseId);
  await db.delete(expenses).where(eq(expenses.id, expenseId));
}

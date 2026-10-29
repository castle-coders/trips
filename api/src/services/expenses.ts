import { and, eq, getTableColumns } from "drizzle-orm";
import type { z } from "@hono/zod-openapi";
import type { Actor, AuthUser } from "../db";
import { expenses, participants, trips } from "../db/schema";
import type { CreateExpenseSchema, ExpenseSchema, UpdateExpenseSchema } from "../schemas/expense";
import { requireTripRole, type Db } from "./access";
import { auditInsert, type AuditStatement } from "./audit";
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

/**
 * The payer's name for an audit snapshot (TDD 6.4: `payerName` is joined at write time, not a
 * column). Same scoping as `listExpenses`: null when there is no payer, the participant row is
 * gone, or the participant belongs to another trip.
 */
async function payerNameFor(db: Db, tripId: string, payerId: string | null): Promise<string | null> {
  if (payerId === null) return null;
  const rows = await db
    .select({ name: participants.name })
    .from(participants)
    .where(and(eq(participants.id, payerId), eq(participants.tripId, tripId)));
  return rows.length ? rows[0].name : null;
}

/** `auditInsert` only returns null for an empty update diff; creates and deletes always get a statement. */
function requireAudit(stmt: AuditStatement | null): AuditStatement {
  if (stmt === null) throw new Error("auditInsert returned null for a non-update action");
  return stmt;
}

/**
 * Create an expense (Editor+). 404 "Trip not found" when the trip does not exist (reachable by
 * admins). The insert and its `expense.create` event run in one batch.
 */
export async function createExpense(db: Db, actor: Actor, tripId: string, input: CreateExpense): Promise<Expense> {
  await requireTripRole(db, actor, tripId, "Editor");
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
  const payerName = await payerNameFor(db, tripId, row.payerId);
  const audit = requireAudit(
    auditInsert(db, {
      actor,
      tripId,
      entityType: "expense",
      entityId: row.id,
      action: "create",
      after: { ...row, payerName },
    })
  );
  await db.batch([db.insert(expenses).values(row), audit]);
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

/**
 * Patch an expense (Editor+). 404 "Expense not found" when it is missing or on another trip.
 *
 * A patch whose allow-listed diff is empty writes nothing (no event, `updatedAt` untouched) and
 * returns the stored row (TDD 7.1, rollout note 12). That shortcut is only safe because every
 * column `UpdateExpense` can set is in the expense snapshot allow-list; keep both lists in step.
 */
export async function updateExpense(
  db: Db,
  actor: Actor,
  tripId: string,
  expenseId: string,
  patch: UpdateExpense
): Promise<Expense> {
  await requireTripRole(db, actor, tripId, "Editor");
  const existing = await findExpense(db, tripId, expenseId);
  const updated: Expense = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  const beforeName = await payerNameFor(db, tripId, existing.payerId);
  const afterName = updated.payerId === existing.payerId ? beforeName : await payerNameFor(db, tripId, updated.payerId);
  const audit = auditInsert(db, {
    actor,
    tripId,
    entityType: "expense",
    entityId: expenseId,
    action: "update",
    before: { ...existing, payerName: beforeName },
    after: { ...updated, payerName: afterName },
  });
  if (audit === null) return existing;
  await db.batch([db.update(expenses).set(updated).where(eq(expenses.id, expenseId)), audit]);
  return updated;
}

/**
 * Delete an expense (Editor+). 404 "Expense not found" when it is missing or on another trip.
 * The delete and its `expense.delete` event run in one batch.
 */
export async function deleteExpense(db: Db, actor: Actor, tripId: string, expenseId: string): Promise<void> {
  await requireTripRole(db, actor, tripId, "Editor");
  const existing = await findExpense(db, tripId, expenseId);
  const payerName = await payerNameFor(db, tripId, existing.payerId);
  const audit = requireAudit(
    auditInsert(db, {
      actor,
      tripId,
      entityType: "expense",
      entityId: expenseId,
      action: "delete",
      before: { ...existing, payerName },
    })
  );
  await db.batch([db.delete(expenses).where(eq(expenses.id, expenseId)), audit]);
}

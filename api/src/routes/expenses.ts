import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { expenses, trips } from "../db/schema";
import {
  ExpenseSchema,
  CreateExpenseSchema,
  UpdateExpenseSchema,
} from "../schemas/expense";

const app = new OpenAPIHono<Env>();

const tripParam = z.object({ tripId: z.string().uuid() });
const itemParams = z.object({
  tripId: z.string().uuid(),
  expenseId: z.string().uuid(),
});

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Expenses"],
    request: { params: tripParam },
    responses: {
      200: {
        description: "List of expenses",
        content: { "application/json": { schema: z.array(ExpenseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const result = await db
      .select()
      .from(expenses)
      .where(eq(expenses.tripId, tripId));
    return c.json(result as any, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Expenses"],
    request: {
      params: tripParam,
      body: {
        content: { "application/json": { schema: CreateExpenseSchema } },
      },
    },
    responses: {
      201: {
        description: "Created expense",
        content: { "application/json": { schema: ExpenseSchema } },
      },
      404: { description: "Trip not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId } = c.req.valid("param");
    const trip = await db.select().from(trips).where(eq(trips.id, tripId));
    if (!trip.length) return c.json({ error: "Trip not found" }, 404);
    const body = c.req.valid("json");
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      tripId,
      description: body.description,
      amount: body.amount,
      currency: body.currency,
      category: body.category,
      payerId: body.payerId ?? null,
      splitType: body.splitType,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(expenses).values(row);
    return c.json(row, 201);
  }
);

app.openapi(
  createRoute({
    method: "put",
    path: "/{expenseId}",
    tags: ["Expenses"],
    request: {
      params: itemParams,
      body: {
        content: { "application/json": { schema: UpdateExpenseSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated expense",
        content: { "application/json": { schema: ExpenseSchema } },
      },
      404: { description: "Expense not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId, expenseId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.tripId, tripId)));
    if (!existing.length) return c.json({ error: "Expense not found" }, 404);
    const updated = {
      ...existing[0],
      ...c.req.valid("json"),
      updatedAt: new Date().toISOString(),
    };
    await db.update(expenses).set(updated).where(eq(expenses.id, expenseId));
    return c.json(updated, 200);
  }
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/{expenseId}",
    tags: ["Expenses"],
    request: { params: itemParams },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Expense not found" },
    },
  }),
  async (c) => {
    const db = getDb(c.env.DB);
    const { tripId, expenseId } = c.req.valid("param");
    const existing = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.tripId, tripId)));
    if (!existing.length) return c.json({ error: "Expense not found" }, 404);
    await db.delete(expenses).where(eq(expenses.id, expenseId));
    return c.body(null, 204);
  }
);

export default app;

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb, type Env } from "../db";
import {
  ExpenseSchema,
  CreateExpenseSchema,
  UpdateExpenseSchema,
} from "../schemas/expense";
import { createExpense, deleteExpense, listExpenses, updateExpense } from "../services/expenses";

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
    const { tripId } = c.req.valid("param");
    const rows = await listExpenses(getDb(c.env.DB), c.get("user"), tripId);
    // REST keeps its payerId-only shape; payerName is for MCP.
    return c.json(rows.map(({ payerName: _payerName, ...row }) => row), 200);
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
    const { tripId } = c.req.valid("param");
    const row = await createExpense(getDb(c.env.DB), c.get("user"), tripId, c.req.valid("json"));
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
    const { tripId, expenseId } = c.req.valid("param");
    const updated = await updateExpense(getDb(c.env.DB), c.get("user"), tripId, expenseId, c.req.valid("json"));
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
    const { tripId, expenseId } = c.req.valid("param");
    await deleteExpense(getDb(c.env.DB), c.get("user"), tripId, expenseId);
    return c.body(null, 204);
  }
);

export default app;
